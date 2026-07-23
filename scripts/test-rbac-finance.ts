/**
 * TEST — RBAC financeiro (Epic 0). Gate opt-in por organização dos módulos
 * financeiro/saúde; negação para vendedor/atendente/estoquista; parque legado
 * intacto. Determinístico, sem chave de IA.
 *
 * Uso: npm run test:rbac-finance
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
  const { PermissionService: P } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  // usuário com um perfil de sistema atribuído (por system_key).
  const profId = (org: string, key: string) => (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?").get(org, key) as any)?.id;
  const userWith = (org: string, key: string) => ({ userId: `u_${key}`, organizationId: org, role: "agent", role_profile_id: profId(org, key) });
  const allow = (org: string, user: any, seg: string, method = "GET") => P.checkRouteAccess(org, user, seg, method);

  // ===== Org COM RBAC financeiro ligado (ex.: Toulon) =====
  const orgT = mkOrg();
  P.setFinanceRbac(orgT, true);
  P.seedSystemProfiles(orgT);

  // Perfis que PODEM ver finanças.
  check("owner vê caixa (financeiro)", allow(orgT, userWith(orgT, "owner"), "cash").allow === true);
  check("gerente vê DRE (financeiro)", allow(orgT, userWith(orgT, "gerente"), "dre").allow === true);
  check("financeiro vê retiradas (/owner → financeiro)", allow(orgT, userWith(orgT, "financeiro"), "owner").allow === true);

  // Perfis que NÃO podem (PRD: atendente e vendedor não veem DRE/retiradas).
  check("vendedor NÃO vê DRE", allow(orgT, userWith(orgT, "vendedor"), "dre").allow === false);
  check("atendente NÃO vê retiradas", allow(orgT, userWith(orgT, "atendente"), "owner").allow === false);
  check("estoquista NÃO vê caixa", allow(orgT, userWith(orgT, "estoquista"), "cash").allow === false);
  check("acesso negado é marcado como financeiro (auditável)", allow(orgT, userWith(orgT, "vendedor"), "cash").finance === true && allow(orgT, userWith(orgT, "vendedor"), "cash").gated === true);

  // Saúde do negócio: financeiro tem só leitura → GET ok, POST negado.
  check("financeiro LÊ saúde (health-center GET)", allow(orgT, userWith(orgT, "financeiro"), "health-center", "GET").allow === true);
  check("financeiro NÃO escreve saúde (POST)", allow(orgT, userWith(orgT, "financeiro"), "health-center", "POST").allow === false);
  check("vendedor NÃO vê saúde do negócio", allow(orgT, userWith(orgT, "vendedor"), "health-center").allow === false);

  // Fallback legado numa org com flag: sem perfil, o papel decide.
  check("legado owner (sem perfil) vê caixa", allow(orgT, { userId: "x", role: "owner" }, "cash").allow === true);
  check("legado agent (sem perfil) NÃO vê caixa", allow(orgT, { userId: "y", role: "agent" }, "cash").allow === false);

  // Módulo NÃO-financeiro segue a regra atual (opt-in por perfil): vendedor escreve em vendas.
  check("vendedor escreve em vendas (orders, não-financeiro)", allow(orgT, userWith(orgT, "vendedor"), "orders", "POST").allow === true);

  // ===== Org SEM o flag (parque legado) — finanças INTACTAS =====
  const orgLegacy = mkOrg();
  P.seedSystemProfiles(orgLegacy);
  check("sem flag: caixa NÃO é gateado (intacto)", allow(orgLegacy, userWith(orgLegacy, "vendedor"), "cash").gated === false && allow(orgLegacy, userWith(orgLegacy, "vendedor"), "cash").allow === true);
  check("sem flag: DRE liberado até p/ atendente", allow(orgLegacy, userWith(orgLegacy, "atendente"), "dre").allow === true);
  check("sem flag: health-center intacto", allow(orgLegacy, userWith(orgLegacy, "vendedor"), "health-center").gated === false);

  // ===== Top-up: perfil já semeado ANTES do módulo novo recebe o módulo =====
  const orgOld = mkOrg();
  // Simula org semeada antes: cria o perfil financeiro sem o módulo 'financeiro'.
  const pid = randomUUID();
  db.prepare("INSERT INTO role_profiles (id, organization_id, name, system_key, is_system) VALUES (?, ?, 'Financeiro', 'financeiro', 1)").run(pid, orgOld);
  db.prepare("INSERT INTO role_permissions (role_profile_id, module, level) VALUES (?, 'pagamentos', 'full')").run(pid);
  P.setFinanceRbac(orgOld, true);
  P.seedSystemProfiles(orgOld); // top-up deve adicionar 'financeiro' = full ao perfil existente
  check("top-up dá acesso financeiro ao perfil já semeado", allow(orgOld, userWith(orgOld, "financeiro"), "cash").allow === true);
  check("top-up NÃO sobrescreve edição existente (pagamentos segue full)", P.levelFor(orgOld, userWith(orgOld, "financeiro"), "pagamentos") === "full");

  // ===== Flag helpers =====
  check("financeRbacEnabled reflete o estado", P.financeRbacEnabled(orgT) === true && P.financeRbacEnabled(orgLegacy) === false);

  console.log("\n=== TEST: RBAC financeiro (Epic 0) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ RBAC financeiro OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
