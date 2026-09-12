/**
 * TEST — normalização do papel "manager" → "admin" (papel canônico).
 *
 * Prova: o helper normalizeUserRole; a migração de boot (converte + bump de
 * security_version, idempotente, não toca outros papéis); e a rede de segurança
 * do fallback RBAC (manager → gerente, não atendente).
 *
 * Uso: npm run test:manager-role-normalize
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mgrrole-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mgrrole-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { normalizeUserRole } = await import("../src/server/middleware/auth.js");
  const { normalizeManagerRole } = await import("../src/server/migrations/normalizeManagerRole.js");
  const { PermissionService: PERM } = await import("../src/server/PermissionService.js");

  const ORG = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'T', 'active')`).run(randomUUID(), ORG);

  // ── 1. helper ──
  check("1.1 normalizeUserRole('manager') → 'admin'", normalizeUserRole("manager") === "admin");
  check("1.2 case-insensível ('Manager')", normalizeUserRole("Manager") === "admin");
  check("1.3 'admin' inalterado", normalizeUserRole("admin") === "admin");
  check("1.4 'owner' inalterado", normalizeUserRole("owner") === "owner");
  check("1.5 'agent' inalterado", normalizeUserRole("agent") === "agent");
  check("1.6 null passa igual (não força papel)", normalizeUserRole(null) === null);

  // ── 2. migração de boot ──
  const mk = (role: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status, security_version) VALUES (?, ?, ?, ?, ?, 'active', 1)`)
      .run(id, ORG, `U ${id.slice(0, 4)}`, `${id.slice(0, 6)}@t.com`, role);
    return id;
  };
  const uMgr1 = mk("manager"), uMgr2 = mk("manager"), uAdmin = mk("admin"), uAgent = mk("agent"), uOwner = mk("owner");

  const r = normalizeManagerRole();
  check("2.1 converte os 2 managers", r.converted === 2);
  check("2.2 manager1 virou admin", (db.prepare("SELECT role FROM users WHERE id = ?").get(uMgr1) as any).role === "admin");
  check("2.3 manager2 virou admin", (db.prepare("SELECT role FROM users WHERE id = ?").get(uMgr2) as any).role === "admin");
  check("2.4 security_version incrementado (revoga token antigo)", (db.prepare("SELECT security_version FROM users WHERE id = ?").get(uMgr1) as any).security_version === 2);
  check("2.5 admin intacto (role + sv)", (() => { const x = db.prepare("SELECT role, security_version FROM users WHERE id = ?").get(uAdmin) as any; return x.role === "admin" && x.security_version === 1; })());
  check("2.6 agent intacto", (db.prepare("SELECT role FROM users WHERE id = ?").get(uAgent) as any).role === "agent");
  check("2.7 owner intacto", (db.prepare("SELECT role FROM users WHERE id = ?").get(uOwner) as any).role === "owner");

  // ── 3. idempotência ──
  const r2 = normalizeManagerRole();
  check("3.1 2ª passada não converte nada", r2.converted === 0);
  check("3.2 sv não incrementa de novo", (db.prepare("SELECT security_version FROM users WHERE id = ?").get(uMgr1) as any).security_version === 2);

  // ── 4. rede de segurança do fallback RBAC (manager transitório → gerente, não atendente) ──
  const mgrUser = { userId: "transitorio", organizationId: ORG, role: "manager" }; // sem perfil atribuído
  // 'gerente' (default full) enxerga 'vendas'; 'atendente' (default none) não.
  check("4.1 manager (fallback) opera vendas como gerente", PERM.can(ORG, mgrUser, "vendas", "write") === true);
  check("4.2 manager (fallback) NÃO é tratado como atendente", PERM.can(ORG, mgrUser, "retail", "read") === true);

  console.log("\n=== normalização role manager → admin ===");
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} manager-role-normalize: ${results.length - failures}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
