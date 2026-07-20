/**
 * TEST — Enforcement global do RBAC na API (ADR-095 Bloco 5).
 *
 * Exercita o middleware enforceModulePermission diretamente (req/res/next
 * simulados): usuário COM perfil é barrado conforme o nível por módulo; usuário
 * SEM perfil (legado) e master admin passam; segmento fora do mapa (core/infra)
 * nunca é barrado.
 *
 * Uso: npm run test:rbac-enforcement
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rbac-enf-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-rbac-enf-1234567890";
process.env.MASTER_ADMIN_EMAIL = "master@zappflow.test";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { enforceModulePermission } = await import("../src/server/middleware/auth.js");

  const orgId = `org_enf_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
    .run(randomUUID(), orgId, "Enforcement Test");
  PermissionService.seedSystemProfiles(orgId);
  const profileId = (key: string) =>
    (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(orgId, key) as any).id;

  // Usuário Vendedor (vendas=write, catalogo=read, pagamentos=none).
  const vendId = `u_vend_${randomUUID().slice(0, 5)}`;
  db.prepare(`INSERT INTO users (id, organization_id, email, role, role_profile_id) VALUES (?, ?, ?, 'agent', ?)`)
    .run(vendId, orgId, `${vendId}@t.com`, profileId("vendedor"));
  const vendedor = { userId: vendId, organizationId: orgId, role: "agent", email: `${vendId}@t.com` };

  // Simula o middleware; devolve { allowed, code }.
  const run = (user: any, method: string, reqPath: string) => {
    let allowed = false; let code: number | null = null;
    const req: any = { user, organizationId: user.organizationId, path: reqPath, method };
    const res: any = { status: (c: number) => ({ json: () => { code = c; } }) };
    enforceModulePermission(req, res, () => { allowed = true; });
    return { allowed, code };
  };

  // ===== Vendedor: vendas =====
  check("Vendedor GET /orders (ler venda) → passa", run(vendedor, "GET", "/orders/123").allowed);
  check("Vendedor POST /orders (criar venda) → passa", run(vendedor, "POST", "/orders").allowed);
  const delOrder = run(vendedor, "DELETE", "/orders/123");
  check("Vendedor DELETE /orders (excluir) → 403", !delOrder.allowed && delOrder.code === 403);

  // ===== Vendedor: catálogo (read) =====
  check("Vendedor GET /products (ler catálogo) → passa", run(vendedor, "GET", "/products").allowed);
  const postProd = run(vendedor, "POST", "/products");
  check("Vendedor POST /products (editar catálogo) → 403", !postProd.allowed && postProd.code === 403);

  // ===== Vendedor: pagamentos (none) =====
  const getPay = run(vendedor, "GET", "/payments");
  check("Vendedor GET /payments (sem acesso) → 403", !getPay.allowed && getPay.code === 403);

  // ===== Segmento fora do mapa (core) nunca é barrado =====
  check("Vendedor GET /tickets (core) → passa", run(vendedor, "GET", "/tickets").allowed);
  check("Vendedor POST /contacts (core) → passa", run(vendedor, "POST", "/contacts").allowed);
  check("Vendedor DELETE /clinic (add-on auto-gated) → passa", run(vendedor, "DELETE", "/clinic/x").allowed);

  // ===== Usuário legado (sem perfil) passa em tudo (opt-in) =====
  const legado = { userId: "u_legado", organizationId: orgId, role: "agent", email: "legado@t.com" };
  check("Legado DELETE /orders → passa (sem perfil)", run(legado, "DELETE", "/orders/1").allowed);
  check("Legado GET /payments → passa (sem perfil)", run(legado, "GET", "/payments").allowed);

  // ===== Master admin nunca é barrado =====
  const master = { userId: "u_master", organizationId: orgId, role: "agent", email: "master@zappflow.test", role_profile_id: profileId("vendedor") };
  check("Master admin DELETE /orders → passa", run(master, "DELETE", "/orders/1").allowed);

  // ===== Financeiro: pagamentos full, vendas read =====
  const finId = `u_fin_${randomUUID().slice(0, 5)}`;
  db.prepare(`INSERT INTO users (id, organization_id, email, role, role_profile_id) VALUES (?, ?, ?, 'agent', ?)`)
    .run(finId, orgId, `${finId}@t.com`, profileId("financeiro"));
  const financeiro = { userId: finId, organizationId: orgId, role: "agent", email: `${finId}@t.com` };
  check("Financeiro DELETE /payments (full) → passa", run(financeiro, "DELETE", "/payments/1").allowed);
  const finPostOrder = run(financeiro, "POST", "/orders");
  check("Financeiro POST /orders (só lê vendas) → 403", !finPostOrder.allowed && finPostOrder.code === 403);
  check("Financeiro GET /orders (ler venda) → passa", run(financeiro, "GET", "/orders").allowed);

  // --- Relatório ---
  console.log("\n=== TEST: Enforcement RBAC na API (ADR-095 Bloco 5) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Enforcement RBAC OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
