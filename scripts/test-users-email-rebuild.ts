/**
 * TEST — ADR-199 F0c-1: rebuild UNIQUE(email) → UNIQUE(organization_id, email).
 * DB-backed, isolado. PROVA que NENHUM dado se perde e que a nova constraint vale.
 *
 * Cobre: detecção de escopo; snapshot criado; contagem preservada; TODAS as colunas e
 * valores intactos (deep-equal linha a linha, incl. colunas de ALTER); índices recriados;
 * integrity/fk ok; idempotência (2ª passada = no-op); nova constraint (mesmo email em 2
 * orgs OK, mesmo email 2× na MESMA org bloqueado).
 *
 * Uso: npm run test:users-email-rebuild
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-email-rebuild-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rebuild-123456";
// IMPORTANTE: não ligamos FEATURE_ORG_GROUPS — queremos users em estado LEGADO
// (UNIQUE(email) global) e disparar o rebuild manualmente pra checar cada garantia.

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function seed(db: any, org: string, email: string, extra: Record<string, any> = {}) {
  const base: Record<string, any> = {
    id: randomUUID(), organization_id: org, name: "Nome " + email, email,
    password_hash: "hash-" + email, role: "owner", global_status: "active",
  };
  const row = { ...base, ...extra };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO users (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => row[c]));
  return base.id;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const MIG = await import("../src/server/migrations/usersEmailConstraint.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;

  // 0. Estado inicial: legado (global).
  check("0.1 escopo inicial = global", MIG.emailConstraintScope(db) === "global");

  // 1. Semeia dados variados, exercitando colunas de ALTER (identity_id, security_version,
  //    platform_role, mfa_*). Guarda o snapshot COMPLETO de cada linha pra comparar depois.
  const idA = seed(db, A, "dono@toulon.com", { identity_id: "idt-1", security_version: 3, platform_role: null, mfa_enabled: 1, mfa_secret: "S1", phone: "1199" });
  const idB = seed(db, B, "dono@democrata.com", { identity_id: "idt-2", security_version: 1, avatar_url: "http://x/a.png" });
  const idC = seed(db, A, "gerente@toulon.com", { role: "admin" });
  const before: Record<string, any> = {};
  for (const id of [idA, idB, idC]) before[id] = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  const colsBefore = (db.prepare("PRAGMA table_info(users)").all() as any[]).map((c) => c.name).sort();

  // 2. Rebuild.
  const r = MIG.migrateUsersEmailConstraint(db);
  check("2.1 não pulou (era global)", r.skipped === false);
  check("2.2 contagem preservada (3→3)", r.rowsBefore === 3 && r.rowsAfter === 3);
  check("2.3 integridade ok pós-rebuild", r.integrityOk === true);
  check("2.4 foreign_key_check ok", r.fkOk === true);
  check("2.5 snapshot de backup criado em disco", !!r.backupPath && fs.existsSync(r.backupPath!) && fs.statSync(r.backupPath!).size > 0);

  // 3. NENHUMA coluna perdida + TODOS os valores intactos (deep-equal linha a linha).
  const colsAfter = (db.prepare("PRAGMA table_info(users)").all() as any[]).map((c) => c.name).sort();
  check("3.1 conjunto de colunas idêntico (nada dropado)", JSON.stringify(colsBefore) === JSON.stringify(colsAfter));
  let allEqual = true; let mismatch = "";
  for (const id of [idA, idB, idC]) {
    const now = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
    for (const k of Object.keys(before[id])) {
      if (String(before[id][k]) !== String(now[k])) { allEqual = false; mismatch = `${id}.${k}: '${before[id][k]}' → '${now[k]}'`; }
    }
  }
  check("3.2 todos os valores de todas as colunas preservados" + (allEqual ? "" : ` (${mismatch})`), allEqual);
  check("3.3 coluna de ALTER preservada (identity_id/security_version)", (db.prepare("SELECT identity_id, security_version FROM users WHERE id = ?").get(idA) as any).identity_id === "idt-1" && (db.prepare("SELECT security_version FROM users WHERE id = ?").get(idA) as any).security_version === 3);

  // 4. Índices próprios recriados (ex.: idx_users_identity da F0a).
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='users' AND name = 'idx_users_identity'").get();
  check("4.1 índice idx_users_identity recriado", !!idx);

  // 5. Escopo agora org + idempotência.
  check("5.1 escopo agora = org", MIG.emailConstraintScope(db) === "org");
  const r2 = MIG.migrateUsersEmailConstraint(db);
  check("5.2 2ª passada = no-op (idempotente)", r2.skipped === true && r2.reason === "already_org_scoped");

  // 6. Nova constraint: mesmo email em 2 ORGS diferentes agora é PERMITIDO...
  let okCross = true; try { seed(db, B, "dono@toulon.com", { identity_id: "idt-1" }); } catch { okCross = false; }
  check("6.1 mesmo email em orgs diferentes: PERMITIDO", okCross);
  // ...e o mesmo email DUAS vezes na MESMA org continua BLOQUEADO.
  let blockedSameOrg = false; try { seed(db, A, "dono@toulon.com"); } catch { blockedSameOrg = true; }
  check("6.2 mesmo email 2× na mesma org: BLOQUEADO", blockedSameOrg);

  // Resultado.
  console.log("\n=== ADR-199 F0c-1 — rebuild da constraint de email (integridade dos dados) ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S)`); process.exit(1); }
  console.log("\n✅ TODOS OS CHECKS PASSARAM");
}

main().catch((e) => { console.error(e); process.exit(1); });
