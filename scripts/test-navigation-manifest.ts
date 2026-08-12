/**
 * TEST — Navigation Manifest (PRD 6 / ADR-163 F2). DB-backed, det., isolado.
 * Prova (§6-7, §55-56, §97):
 *   - nav por NECESSIDADE: primary = Hoje/Fala Tu/Executando/Resultados/Empresa,
 *     com Fala Tu (flag falatu) e Empresa (papel gestor) gated;
 *   - Explorar só traz módulos ATIVOS e visíveis; fora do plano (available_to_buy) e
 *     escondidos NÃO aparecem (§56 — sem catálogo de cadeados); módulo no plano mas
 *     desligado vira CONTAGEM (moreInPlan), não item;
 *   - RBAC respeitado (§97/CA14): perfil sem acesso reduz o Explorar;
 *   - flag simplified_navigation_enabled só reportada (não altera o cálculo);
 *   - multi-tenant.
 *
 * Uso: npm run test:navigation-manifest
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-nav-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "test"; process.env.JWT_SECRET = "test-secret-nav-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { NavigationManifestService: NAV } = await import("../src/server/NavigationManifestService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const orgV = `org_${randomUUID().slice(0, 8)}`; // varejo autonomo, falatu ON, nav ON
  const orgC = `org_${randomUUID().slice(0, 8)}`; // saude enterprise, falatu OFF, nav OFF
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status, falatu_enabled, simplified_navigation_enabled) VALUES (?, ?, 'Peixaria Ana', 'active', 'varejo', 'autonomo', ?, 'active', 1, 1)`)
    .run(randomUUID(), orgV, JSON.stringify(["catalogo", "vendas", "copiloto", "pagamentos"]));
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status, falatu_enabled, simplified_navigation_enabled) VALUES (?, ?, 'Clinica Multi', 'active', 'saude', 'enterprise', ?, 'active', 0, 0)`)
    .run(randomUUID(), orgC, JSON.stringify(["agenda", "clinica", "pagamentos", "cadencias"]));
  PermissionService.seedSystemProfiles(orgV); PermissionService.seedSystemProfiles(orgC);
  const prof = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any).id;

  const ownerV = { userId: "u1", email: "dono@peixaria.com", role: "owner", role_profile_id: prof(orgV, "owner"), organizationId: orgV };
  const atendenteV = { userId: "u3", email: "vend@peixaria.com", role: "agent", role_profile_id: prof(orgV, "atendente"), organizationId: orgV };
  const ownerC = { userId: "u5", email: "dono@clinica.com", role: "owner", role_profile_id: prof(orgC, "owner"), organizationId: orgC };

  const pKeys = (m: any) => m.primary.map((p: any) => p.key);
  const eKeys = (m: any) => m.explore.map((e: any) => e.key);

  // ═══════════════ 1. Primary por necessidade ═══════════════
  const mV = NAV.forUser(orgV, ownerV);
  check("1.1 primary tem Hoje/Executando/Resultados sempre", ["hoje", "executando", "resultados"].every((k) => pKeys(mV).includes(k)));
  check("1.2 Fala Tu presente (flag ON)", pKeys(mV).includes("falatu"));
  check("1.3 Empresa presente (owner)", pKeys(mV).includes("empresa"));
  check("1.4 flag simplifiedNavEnabled refletida", mV.simplifiedNavEnabled === true);

  // ═══════════════ 2. Explorar: só ativos; fora-do-plano/desligado não vira item ═══════════════
  check("2.1 módulos ATIVOS aparecem (catalogo/vendas/copiloto/pagamentos)", ["catalogo", "vendas", "copiloto", "pagamentos"].every((k) => eKeys(mV).includes(k)));
  check("2.2 fora do plano NÃO aparece (cadencias = available_to_buy, §56)", !eKeys(mV).includes("cadencias"));
  check("2.3 no plano mas desligado NÃO é item (agenda)", !eKeys(mV).includes("agenda"));
  check("2.4 desligados viram CONTAGEM (moreInPlan ≥ 1)", mV.moreInPlan >= 1);
  check("2.5 'configuracoes' fora do Explorar (vai pra Empresa)", !eKeys(mV).includes("configuracoes"));
  check("2.6 itens do Explorar têm rótulo humano", mV.explore.every((e: any) => typeof e.label === "string" && e.label.length > 0));

  // ═══════════════ 3. RBAC + papel (§97/CA14) ═══════════════
  const mAt = NAV.forUser(orgV, atendenteV);
  check("3.1 atendente NÃO vê 'Empresa' (não é gestor)", !pKeys(mAt).includes("empresa"));
  check("3.2 RBAC reduz o Explorar (atendente ⊆ owner)", eKeys(mAt).every((k: string) => eKeys(mV).includes(k)) && mAt.explore.length <= mV.explore.length);
  check("3.3 atendente ainda vê as superfícies-necessidade (Hoje/Executando/Resultados)", ["hoje", "executando", "resultados"].every((k) => pKeys(mAt).includes(k)));

  // ═══════════════ 4. Fala Tu / flag por org ═══════════════
  const mC = NAV.forUser(orgC, ownerC);
  check("4.1 Fala Tu ausente quando flag OFF (orgC)", !pKeys(mC).includes("falatu"));
  check("4.2 simplifiedNavEnabled=false (orgC)", mC.simplifiedNavEnabled === false);

  // ═══════════════ 5. multi-tenant ═══════════════
  check("5.1 Explorar difere por org (catalogo em V, não em C)", eKeys(mV).includes("catalogo") && !eKeys(mC).includes("catalogo"));
  check("5.2 orgC reflete seus módulos (agenda/clinica ativos)", eKeys(mC).includes("agenda") && eKeys(mC).includes("clinica"));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} navigation-manifest: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
