/**
 * TEST — Session credential version (SEC-F7 / SEC-08, achado A14). DB-backed, determinístico.
 *
 * Prova que `security_version` REVOGA tokens antigos: um token cujo `sv` diverge da linha do DB
 * (após reset de senha / desativar MFA / bloqueio, que incrementam a versão) é barrado com 401;
 * tokens SEM `sv` (emitidos antes desta fatia) NÃO são barrados (sem lockout de sessão legada).
 *
 * Uso: npm run test:security-session
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sec-sess-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-sec-sess-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { requireOrganizationAccess, bumpSecurityVersion } = await import("../src/server/middleware/auth.js");

  const org = "org_sess";
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
  const uid = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, email, role, security_version) VALUES (?, ?, 'a@b.com', 'owner', 1)`).run(uid, org);

  // harness de req/res/next
  const run = (user: any) => {
    let status = 200; let body: any = null; let nexted = false;
    const req: any = { user, organizationId: org, headers: {} };
    const res: any = { status(c: number) { status = c; return this; }, json(b: any) { body = b; return this; } };
    requireOrganizationAccess(req, res, () => { nexted = true; });
    return { status, body, nexted };
  };

  // ── 1. sv casando → passa ──
  check("1.1 token com sv igual ao DB → passa", run({ userId: uid, sv: 1 }).nexted === true);

  // ── 2. após bump (reset/MFA/bloqueio), token antigo (sv defasado) → 401 revogado ──
  bumpSecurityVersion(uid);
  check("2.1 bump incrementou a coluna", (db.prepare(`SELECT security_version AS v FROM users WHERE id = ?`).get(uid) as any).v === 2);
  const stale = run({ userId: uid, sv: 1 });
  check("2.2 token sv defasado → 401 (sessão revogada)", stale.status === 401 && !stale.nexted);
  check("2.3 token com sv novo (2) → volta a passar", run({ userId: uid, sv: 2 }).nexted === true);

  // ── 3. Token LEGADO (sem sv) NÃO é barrado (sem lockout de sessões antigas) ──
  check("3.1 token sem sv (legado) → passa", run({ userId: uid }).nexted === true);

  // ── 4. Usuário bloqueado segue barrado (revogação por status, independente do sv) ──
  db.prepare(`UPDATE users SET global_status = 'blocked' WHERE id = ?`).run(uid);
  const blocked = run({ userId: uid, sv: 2 });
  check("4.1 usuário bloqueado → 403", blocked.status === 403 && !blocked.nexted);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} security-session: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
