/**
 * TEST — Hardening de segurança/governança (auditoria 2026).
 *
 * Cobre as correções MED do audit de auth/governança:
 *   - logAuthEvent grava os atos de master admin com o eventType correto
 *     (antes: bug de ordem de argumentos → nenhum registro);
 *   - requireOrganizationAccess revoga em tempo real usuário blocked/deleted
 *     (antes: acesso mantido até o token de 24h expirar);
 *   - org bloqueada continua barrada; usuário ativo passa.
 *
 * Uso: npm run test:security-hardening
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sec-hard-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-sec-hardening-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

// Mock de res/next para exercitar o middleware.
function mockRes() { return { _code: 0, _json: null as any, status(c: number) { this._code = c; return this; }, json(o: any) { this._json = o; return this; } }; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { logAuthEvent } = await import("../src/server/auditLog.js");
  const { requireOrganizationAccess } = await import("../src/server/middleware/auth.js");

  // ===== 1. Auditoria dos atos de master admin (fix do bug de args) =====
  const actor = "master_" + randomUUID().slice(0, 6);
  const target = "user_" + randomUUID().slice(0, 6);
  logAuthEvent(null, actor, target, "ADMIN_PASSWORD_RESET", { by_master: "eldastito@gmail.com", target_email: "x@y.com" });
  const row = db.prepare(`SELECT * FROM auth_audit_logs WHERE event_type = 'ADMIN_PASSWORD_RESET' AND actor_user_id = ?`).get(actor) as any;
  check("ADMIN_PASSWORD_RESET registrado com eventType correto", !!row && row.target_user_id === target);
  check("metadata do evento preservado", !!row && /by_master/.test(row.metadata_json));

  // ===== 2. Revogação em tempo real: usuário blocked/deleted → 403 =====
  const org = "org_" + randomUUID().slice(0, 8);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), org);
  const mkUser = (status: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, password_hash, role, global_status) VALUES (?, ?, 'U', ?, 'x', 'agent', ?)`)
      .run(id, org, id + "@t.com", status);
    return id;
  };
  const activeU = mkUser("active");
  const deletedU = mkUser("deleted");
  const blockedU = mkUser("blocked");

  const run = (userId: string) => { const res = mockRes(); let nexted = false; requireOrganizationAccess({ organizationId: org, user: { userId } } as any, res as any, () => { nexted = true; }); return { res, nexted }; };

  const rActive = run(activeU);
  check("usuário ativo passa (next chamado)", rActive.nexted === true && rActive.res._code === 0);
  const rDeleted = run(deletedU);
  check("usuário deleted é barrado (403)", rDeleted.nexted === false && rDeleted.res._code === 403);
  const rBlocked = run(blockedU);
  check("usuário blocked é barrado (403)", rBlocked.nexted === false && rBlocked.res._code === 403);

  // ===== 3. Org bloqueada continua barrada (comportamento preservado) =====
  const orgB = "org_" + randomUUID().slice(0, 8);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'blocked')`).run(randomUUID(), orgB);
  const uB = (() => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, password_hash, role, global_status) VALUES (?, ?, 'U', ?, 'x', 'agent', 'active')`).run(id, orgB, id + "@t.com"); return id; })();
  const resB = mockRes(); let nextedB = false;
  requireOrganizationAccess({ organizationId: orgB, user: { userId: uB } } as any, resB as any, () => { nextedB = true; });
  check("org bloqueada barra mesmo usuário ativo", nextedB === false && resB._code === 403);

  console.log("\n=== TEST: Hardening de segurança (auditoria 2026) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
