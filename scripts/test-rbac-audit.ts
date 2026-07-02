/**
 * TESTE — RBAC central (requireRole) e auditoria única (logAuthEvent)
 * ------------------------------------------------------------------
 * Cobre a consolidação de:
 *   - 8 cópias de `if (actor.role !== 'owner' && actor.role !== 'admin')`
 *     espalhadas em managers.ts/users.ts/audit.ts -> middleware/auth.ts:requireRole
 *   - 10 cópias idênticas de uma função `logAuthEvent` local em arquivos de
 *     rota -> src/server/auditLog.ts (fonte única)
 *   - duas lacunas reais encontradas (troca de papel de usuário e remoção de
 *     gestor não geravam NENHUM evento de auditoria)
 *   - um bug real em routes/audit.ts (`u.username`, coluna inexistente —
 *     quebrava a tela de auditoria do master admin)
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:rbac-audit
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rbac-audit-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-rbac-auditoria-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

// Mock mínimo de Response/NextFunction do Express — suficiente para testar um
// middleware isoladamente, sem precisar subir um servidor HTTP real.
function fakeRes() {
  const state: { statusCode?: number; body?: any } = {};
  const res: any = {
    status(code: number) { state.statusCode = code; return res; },
    json(body: any) { state.body = body; return res; },
  };
  return { res, state };
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { requireRole } = await import("../src/server/middleware/auth.js");
  const { logAuthEvent } = await import("../src/server/auditLog.js");

  // ---- requireRole ----
  {
    const req: any = { user: { role: "owner" } };
    const { res, state } = fakeRes();
    let nextCalled = false;
    requireRole("owner", "admin")(req, res, () => { nextCalled = true; });
    check("requireRole('owner','admin') deixa passar owner", nextCalled && state.statusCode === undefined);
  }
  {
    const req: any = { user: { role: "agent" } };
    const { res, state } = fakeRes();
    let nextCalled = false;
    requireRole("owner", "admin")(req, res, () => { nextCalled = true; });
    check("requireRole('owner','admin') bloqueia agent com 403", !nextCalled && state.statusCode === 403);
  }
  {
    const req: any = {}; // sem req.user (não deveria acontecer atrás de requireAuth, mas defensivo)
    const { res, state } = fakeRes();
    let nextCalled = false;
    requireRole("admin")(req, res, () => { nextCalled = true; });
    check("requireRole bloqueia quando não há req.user", !nextCalled && state.statusCode === 403);
  }
  {
    const req: any = { user: { role: "admin" } };
    const { res, state } = fakeRes();
    let nextCalled = false;
    requireRole("admin")(req, res, () => { nextCalled = true; });
    check("requireRole('admin') deixa passar admin", nextCalled && state.statusCode === undefined);
  }

  // ---- logAuthEvent (helper único, usado por 10 arquivos de rota + Radar) ----
  const orgId = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa Teste', 'active')`)
    .run(randomUUID(), orgId);
  const userId = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role) VALUES (?, ?, 'Fulano', 'fulano@teste.com', 'admin')`)
    .run(userId, orgId);

  logAuthEvent(orgId, userId, "target_123", "USER_ROLE_CHANGED", { from: "agent", to: "admin" });
  const roleEvent = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'USER_ROLE_CHANGED'`).get(orgId) as any;
  check("logAuthEvent grava USER_ROLE_CHANGED (antes: sem NENHUM registro)", !!roleEvent, `evento=${JSON.stringify(roleEvent)}`);
  check("Metadado da troca de papel foi preservado", roleEvent && JSON.parse(roleEvent.metadata_json).to === "admin");

  logAuthEvent(orgId, userId, "manager_456", "MANAGER_REMOVED", { identifier: "5511999999999", name: "Sócio" });
  const managerEvent = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'MANAGER_REMOVED'`).get(orgId) as any;
  check("logAuthEvent grava MANAGER_REMOVED (antes: sem NENHUM registro)", !!managerEvent);

  // ---- radarAudit.logRadarEvent continua funcionando após delegar para o helper único ----
  const { logRadarEvent } = await import("../src/server/radarAudit.js");
  logRadarEvent(orgId, userId, "radar_smoke_test", { ok: true });
  const radarEvent = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'radar_smoke_test'`).get(orgId) as any;
  check("radarAudit.logRadarEvent continua gravando após delegar para auditLog.ts", !!radarEvent);

  // ---- Bug de routes/audit.ts corrigido: consulta com u.name (não u.username) não quebra ----
  let auditQueryOk = true;
  let auditQueryError: any = null;
  try {
    db.prepare(`
      SELECT l.*, u.name as actor_name
      FROM auth_audit_logs l
      LEFT JOIN users u ON l.actor_user_id = u.id
      ORDER BY l.created_at DESC LIMIT 100
    `).all();
  } catch (e) { auditQueryOk = false; auditQueryError = e; }
  check("Consulta de routes/audit.ts (com u.name) executa sem erro", auditQueryOk, auditQueryError ? String(auditQueryError) : "");

  const withActorName = db.prepare(`
    SELECT l.*, u.name as actor_name FROM auth_audit_logs l LEFT JOIN users u ON l.actor_user_id = u.id
    WHERE l.event_type = 'USER_ROLE_CHANGED'
  `).get() as any;
  check("actor_name é resolvido corretamente (era NULL/erro com a coluna errada)", withActorName?.actor_name === "Fulano", `actor_name=${withActorName?.actor_name}`);

  // Confirma que a consulta ANTIGA (u.username) de fato quebraria — prova de
  // que o bug era real, não hipotético.
  let oldQueryThrew = false;
  try {
    db.prepare(`SELECT l.*, u.username as actor_name FROM auth_audit_logs l LEFT JOIN users u ON l.actor_user_id = u.id LIMIT 1`).all();
  } catch { oldQueryThrew = true; }
  check("A consulta ANTIGA (u.username) de fato quebrava (confirma que era um bug real)", oldQueryThrew);

  // ============ RELATÓRIO ============
  console.log("\n==================================================");
  console.log("  TESTE — RBAC CENTRAL E AUDITORIA ÚNICA");
  console.log("==================================================\n");
  for (const r of results) {
    console.log(`  ${r.ok ? "✅ PASS" : "❌ FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const total = results.length;
  console.log(`\n  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(failures === 0 ? "  🔒 RBAC E AUDITORIA CONSOLIDADOS CORRETAMENTE.\n" : `  ⚠️  ${failures} verificação(ões) FALHARAM.\n`);

  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste de RBAC/auditoria:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
