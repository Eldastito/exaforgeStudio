/**
 * TEST — ADR-199 F0b: identidade como fonte de verdade da credencial. DB-backed, isolado.
 *
 * Prova: resolveLogin resolve linha+credencial (da identidade, fallback legado);
 * lazy-ensure cria a identidade no 1º login; setCredentialByUser espelha em users E
 * revoga TODAS as sessões do humano (bump de sv em cada linha ligada — RN-GRP-03);
 * consumo de backup-code NÃO bumpa sv; email nulo escreve só na linha (RN-GRP-04);
 * dup-check via identidade (RN-GRP-02). 0-regressão: usuário legado sem identidade loga.
 *
 * Uso: npm run test:org-group-auth
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-oga-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-oga-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function mkUser(db: any, org: string, email: string | null, opts: { pwd?: string; mfaSecret?: string; mfaEnabled?: boolean; backups?: string; identityId?: string } = {}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, organization_id, name, email, password_hash, mfa_secret, mfa_enabled, mfa_backup_codes, identity_id, role, global_status, security_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner', 'active', 1)`
  ).run(id, org, "U " + id.slice(0, 4), email, opts.pwd ?? null, opts.mfaSecret ?? null, opts.mfaEnabled ? 1 : 0, opts.backups ?? null, opts.identityId ?? null);
  return id;
}
const sv = (db: any, id: string) => (db.prepare("SELECT security_version FROM users WHERE id = ?").get(id) as any).security_version;
const uPwd = (db: any, id: string) => (db.prepare("SELECT password_hash FROM users WHERE id = ?").get(id) as any).password_hash;

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { AccountIdentityService: IDS } = await import("../src/server/AccountIdentityService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;

  // 1. Usuário legado (sem identity_id) — resolveLogin faz lazy-ensure e credencial confere.
  const uA = mkUser(db, A, "dono@toulon.com", { pwd: "hash-A", mfaEnabled: true, mfaSecret: "S1" });
  check("1.1 legado começa sem identidade", (db.prepare("SELECT identity_id FROM users WHERE id = ?").get(uA) as any).identity_id == null);
  const rec = IDS.resolveLogin("dono@toulon.com");
  check("1.2 resolveLogin acha a linha", !!rec && rec.user.id === uA);
  check("1.3 lazy-ensure criou a identidade", !!rec && !!rec.identityId);
  check("1.4 credencial (senha/MFA) vem correta", !!rec && rec.credential.password_hash === "hash-A" && rec.credential.mfa_enabled === 1 && rec.credential.mfa_secret === "S1");
  check("1.5 users.identity_id agora ligado", (db.prepare("SELECT identity_id FROM users WHERE id = ?").get(uA) as any).identity_id === rec!.identityId);
  const idA = rec!.identityId!;

  // 2. Match exato (0-regressão) e email inexistente.
  check("2.1 email inexistente → null", IDS.resolveLogin("naoexiste@x.com") === null);
  check("2.2 usersByEmail match exato (case-sensitive)", IDS.usersByEmail("dono@toulon.com").length === 1 && IDS.usersByEmail("DONO@toulon.com").length === 0);

  // 3. Dup-check via identidade (RN-GRP-02).
  check("3.1 userExistsByEmail true p/ existente", IDS.userExistsByEmail("dono@toulon.com") === true);
  check("3.2 userExistsByEmail false p/ novo", IDS.userExistsByEmail("novo@x.com") === false);

  // 4. Multi-org: liga uma 2ª linha (org B) à MESMA identidade.
  const uB = mkUser(db, B, "dono-b@toulon.com", { pwd: "hash-A", identityId: idA });
  const svA0 = sv(db, uA), svB0 = sv(db, uB);

  // 5. Troca de senha → escreve na identidade + espelha nas DUAS linhas + bumpa sv nas DUAS (RN-GRP-03).
  const affected = IDS.setCredentialByUser(uA, { passwordHash: "hash-NEW" });
  check("5.1 afeta as 2 linhas ligadas", affected.length === 2 && affected.includes(uA) && affected.includes(uB));
  check("5.2 espelha a senha nas 2 linhas de users", uPwd(db, uA) === "hash-NEW" && uPwd(db, uB) === "hash-NEW");
  check("5.3 escreve na identidade", (db.prepare("SELECT password_hash FROM account_identities WHERE id = ?").get(idA) as any).password_hash === "hash-NEW");
  check("5.4 bump de sv nas DUAS orgs (revoga todas as sessões do humano)", sv(db, uA) === svA0 + 1 && sv(db, uB) === svB0 + 1);
  check("5.5 login pós-troca usa a nova credencial", IDS.resolveLogin("dono@toulon.com")!.credential.password_hash === "hash-NEW");

  // 6. Consumo de backup-code (login) NÃO bumpa sv (não é troca de credencial).
  const svA1 = sv(db, uA);
  IDS.setCredentialByUser(uA, { mfaBackupCodes: "enc-remaining" }, { bumpSv: false });
  check("6.1 backup-code consumido escreve na identidade", (db.prepare("SELECT mfa_backup_codes FROM account_identities WHERE id = ?").get(idA) as any).mfa_backup_codes === "enc-remaining");
  check("6.2 consumo NÃO bumpa sv", sv(db, uA) === svA1);

  // 7. MFA disable via chokepoint → limpa e bumpa sv nas duas.
  const svA2 = sv(db, uA), svB2 = sv(db, uB);
  IDS.setCredentialByUser(uA, { mfaEnabled: 0, mfaSecret: null, mfaBackupCodes: null });
  check("7.1 MFA desligado na identidade", (db.prepare("SELECT mfa_enabled FROM account_identities WHERE id = ?").get(idA) as any).mfa_enabled === 0);
  check("7.2 disable revoga (bump sv nas duas)", sv(db, uA) === svA2 + 1 && sv(db, uB) === svB2 + 1);

  // 8. RN-GRP-04: usuário com email nulo (bot) — sem identidade; escrita fica só na linha.
  const uBot = mkUser(db, A, null, { pwd: "bot-hash" });
  check("8.1 ensureForUser(email nulo) → null", IDS.ensureForUser(uBot) === null);
  const botAff = IDS.setCredentialByUser(uBot, { passwordHash: "bot-new" });
  check("8.2 escreve só na linha do bot (legado)", botAff.length === 1 && botAff[0] === uBot && uPwd(db, uBot) === "bot-new");
  check("8.3 nenhuma identidade criada p/ email nulo", (db.prepare("SELECT COUNT(*) c FROM account_identities WHERE email IS NULL").get() as any).c === 0);

  // Resultado.
  console.log("\n=== ADR-199 F0b — identidade como fonte de verdade da credencial ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S)`); process.exit(1); }
  console.log("\n✅ TODOS OS CHECKS PASSARAM");
}

main().catch((e) => { console.error(e); process.exit(1); });
