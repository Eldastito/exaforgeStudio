/**
 * TEST — RBAC granular (ADR-095): perfis por org com nível por módulo.
 *
 * Cobre: seed dos 6 templates (idempotente); semântica de cada template
 * (vendedor lê catálogo mas opera vendas sem excluir; estoquista mexe em
 * catálogo/compras; financeiro tem pagamentos full; Dono é full em tudo);
 * fallback dos papéis legados quando o usuário não tem perfil atribuído.
 *
 * Uso: npm run test:rbac-granular
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rbac-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-rbac-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PermissionService, SYSTEM_PROFILES } = await import("../src/server/PermissionService.js");

  const orgId = `org_rbac_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
    .run(randomUUID(), orgId, "RBAC Test");

  // ===== 1. Seed idempotente dos 6 templates =====
  const created = PermissionService.seedSystemProfiles(orgId);
  check("seed cria os 6 templates de sistema", created === 6);
  const again = PermissionService.seedSystemProfiles(orgId);
  check("re-seed é idempotente (0 novos)", again === 0);
  const total = (db.prepare(`SELECT COUNT(*) c FROM role_profiles WHERE organization_id = ?`).get(orgId) as any).c;
  check("apenas 6 perfis persistidos", total === 6);

  const profileId = (key: string) =>
    (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(orgId, key) as any).id;

  // Helper: cria um usuário atribuído a um perfil e devolve o objeto "user" (como no JWT).
  const userWithProfile = (key: string) => {
    const uid = `u_${key}_${randomUUID().slice(0, 5)}`;
    db.prepare(`INSERT INTO users (id, organization_id, email, role, role_profile_id) VALUES (?, ?, ?, ?, ?)`)
      .run(uid, orgId, `${uid}@t.com`, "agent", profileId(key));
    return { userId: uid, organizationId: orgId, role: "agent" };
  };
  const can = (user: any, m: string, a: "read" | "write" | "delete") => PermissionService.can(orgId, user, m, a);

  // ===== 2. Dono (owner) — full em tudo, inclusive excluir =====
  const owner = userWithProfile("owner");
  check("Dono: vendas full (pode excluir)", can(owner, "vendas", "delete"));
  check("Dono: cobranca full", can(owner, "cobranca", "delete"));
  check("Dono: configuracoes full", can(owner, "configuracoes", "delete"));

  // ===== 3. Vendedor — vendas write (sem excluir), catálogo só leitura, resto none =====
  const vend = userWithProfile("vendedor");
  check("Vendedor: cria/edita venda (write)", can(vend, "vendas", "write"));
  check("Vendedor: NÃO exclui venda", !can(vend, "vendas", "delete"));
  check("Vendedor: lê catálogo", can(vend, "catalogo", "read"));
  check("Vendedor: NÃO edita catálogo", !can(vend, "catalogo", "write"));
  check("Vendedor: sem acesso a pagamentos", !can(vend, "pagamentos", "read"));

  // ===== 4. Estoquista — catálogo e compras write; vendas/pagamentos ocultos =====
  const estoq = userWithProfile("estoquista");
  check("Estoquista: edita catálogo (write)", can(estoq, "catalogo", "write"));
  check("Estoquista: NÃO exclui catálogo", !can(estoq, "catalogo", "delete"));
  check("Estoquista: opera compras", can(estoq, "compras", "write"));
  check("Estoquista: sem acesso a vendas", !can(estoq, "vendas", "read"));

  // ===== 5. Financeiro — pagamentos full; vendas/relatórios read =====
  const fin = userWithProfile("financeiro");
  check("Financeiro: pagamentos full (exclui)", can(fin, "pagamentos", "delete"));
  check("Financeiro: lê vendas", can(fin, "vendas", "read"));
  check("Financeiro: NÃO edita vendas", !can(fin, "vendas", "write"));
  check("Financeiro: cobrança full", can(fin, "cobranca", "delete"));

  // ===== 6. Gerente — quase tudo full, cobrança/config só leitura =====
  const ger = userWithProfile("gerente");
  check("Gerente: vendas full", can(ger, "vendas", "delete"));
  check("Gerente: lê cobrança", can(ger, "cobranca", "read"));
  check("Gerente: NÃO edita cobrança", !can(ger, "cobranca", "write"));

  // ===== 7. Fallback legado — usuário SEM perfil cai no papel (users.role/JWT) =====
  const legacyOwner = { userId: "legacy_owner", organizationId: orgId, role: "owner" };   // sem role_profile_id
  check("Legado owner: full em vendas", can(legacyOwner, "vendas", "delete"));
  const legacyAgent = { userId: "legacy_agent", organizationId: orgId, role: "agent" };
  check("Legado agent: opera atendimento", can(legacyAgent, "atendimento", "write"));
  check("Legado agent: sem acesso a vendas", !can(legacyAgent, "vendas", "read"));
  const legacyAdmin = { userId: "legacy_admin", organizationId: orgId, role: "admin" };
  check("Legado admin: full em vendas (gerente)", can(legacyAdmin, "vendas", "delete"));
  check("Legado admin: NÃO edita cobrança (gerente)", !can(legacyAdmin, "cobranca", "write"));

  // --- Relatório ---
  console.log("\n=== TEST: RBAC granular (ADR-095) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ RBAC granular OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
