/**
 * TEST — Master Admin authority hardening (SEC-F3 / SEC-03, achado A6). DB-backed, determinístico.
 *
 * Prova que a autoridade master é a LINHA do usuário no DB (por userId), NÃO o claim de e-mail do
 * JWT: um token com o e-mail master mas apontando pra outro usuário NÃO vira master; o master real
 * é revalidado e o `platform_role` é backfillado; usuário bloqueado nunca é master.
 *
 * Uso: npm run test:security-master
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sec-master-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-sec-master-1";
process.env.MASTER_ADMIN_EMAIL = "master@test.zap";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { isPlatformMaster } = await import("../src/server/middleware/auth.js");
  const MASTER = "master@test.zap";

  const mkUser = (email: string, opts: { platform_role?: string; global_status?: string } = {}) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, password_hash, role, platform_role, global_status) VALUES (?, 'default_org', 'U', ?, 'x', 'owner', ?, ?)`)
      .run(id, email, opts.platform_role ?? null, opts.global_status ?? "active");
    return id;
  };
  const req = (user: any) => ({ user } as any);

  const masterId = mkUser(MASTER);                       // master real (platform_role null ainda)
  const regularId = mkUser("joe@loja.com");              // usuário comum
  const blockedMasterId = mkUser("boss@test.zap", { platform_role: "master_admin", global_status: "blocked" });

  // ── 1. Usuário comum → nunca master (e sem custo de DB pelo fast-path) ──
  check("1.1 usuário comum não é master", isPlatformMaster(req({ userId: regularId, email: "joe@loja.com" })) === false);

  // ── 2. Master real (e-mail master, validado no DB) → é master + backfill do platform_role ──
  check("2.1 master por e-mail (validado no DB) → true", isPlatformMaster(req({ userId: masterId, email: MASTER })) === true);
  const backfilled = (db.prepare(`SELECT platform_role AS p FROM users WHERE id = ?`).get(masterId) as any).p;
  check("2.2 platform_role foi backfillado p/ 'master_admin'", backfilled === "master_admin");
  check("2.3 depois do backfill segue master (agora pela coluna)", isPlatformMaster(req({ userId: masterId, email: MASTER })) === true);

  // ── 3. A6 FECHADO: claim com e-mail master mas userId de OUTRO usuário → NÃO é master ──
  //     (a autoridade é o e-mail REAL do DB por userId, não o claim forjável.)
  check("3.1 claim forjado (email master, userId comum) → NÃO master", isPlatformMaster(req({ userId: regularId, email: MASTER })) === false);
  check("3.2 e o usuário comum não ganhou platform_role", !(db.prepare(`SELECT platform_role AS p FROM users WHERE id = ?`).get(regularId) as any).p);

  // ── 4. Claim diz platform_role=master_admin mas o DB não confirma → NÃO master ──
  check("4.1 platform_role só no claim (DB não confirma) → NÃO master", isPlatformMaster(req({ userId: regularId, email: "joe@loja.com", platform_role: "master_admin" })) === false);

  // ── 5. Master bloqueado nunca é master ──
  check("5.1 master bloqueado → NÃO master", isPlatformMaster(req({ userId: blockedMasterId, email: "boss@test.zap", platform_role: "master_admin" })) === false);

  // ── 6. Sem userId / sem user → false ──
  check("6.1 sem userId → false", isPlatformMaster(req({ email: MASTER })) === false);
  check("6.2 sem user → false", isPlatformMaster(req(undefined)) === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} security-master: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
