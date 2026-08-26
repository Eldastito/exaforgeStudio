/**
 * TEST — Advocacia travada por PLANO (fecha o furo do seletor de ramo). Det.
 * Antes, a tela/rotas de Advocacia eram liberadas só pela string da vertical
 * (`vertical === 'advocacia'`), SEM gate de plano — então qualquer owner/admin
 * trocava o ramo e usava o escritório de graça. Agora `advocacia` é MÓDULO
 * (como clinica/escola): entra no MODULE_BY_ROUTE + preset + plano; o Sidebar
 * usa mod('advocacia'). Trocar o ramo só libera se o PLANO incluir o módulo.
 *
 * Uso: npm run test:advocacia-plan-gated
 */
import os from "os"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-adv-gate-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-adv-gate-123456";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { EntitlementService } = await import("../src/server/EntitlementService.js");
  const { OPTIONAL_MODULES, ADDON_MODULES } = await import("../src/server/verticals.js");
  const { PLAN_GRADE } = await import("../src/server/plansGrade.js");
  const { AddonService } = await import("../src/server/AddonService.js");

  // ═══ 1. advocacia é MÓDULO conhecido e gated por rota ═══
  check("1.1 MODULE_BY_ROUTE.advocacia = 'advocacia' (rota /api/advocacia gated)", (ModuleService.MODULE_BY_ROUTE as any).advocacia === "advocacia");
  check("1.2 advocacia em OPTIONAL_MODULES", (OPTIONAL_MODULES as readonly string[]).includes("advocacia"));
  check("1.3 advocacia em ADDON_MODULES (nenhuma vertical genérica liga)", (ADDON_MODULES as readonly string[]).includes("advocacia"));

  // ═══ 2. concedido por PLANO: Enterprise inclui, add-on Scale vende ═══
  const ent = PLAN_GRADE.find((p) => p.id === "enterprise");
  check("2.1 plano Enterprise inclui advocacia", !!ent && ent.features.modules.includes("advocacia"));
  const growth = PLAN_GRADE.find((p) => p.id === "growth");
  check("2.2 plano Growth NÃO inclui advocacia (não é base)", !!growth && !growth.features.modules.includes("advocacia"));
  check("2.3 add-on Scale vende advocacia", (AddonService.ADDON_CATALOG.scale || []).some((a) => a.key === "advocacia"));

  // ═══ 3. COMPORTAMENTO: trocar o ramo num plano sem advocacia NÃO libera ═══
  // Semeia a grade de planos e cria plano org.
  const plansSeed = db.prepare(`INSERT OR IGNORE INTO plans (id, name, price, features) VALUES (?, ?, ?, ?)`);
  for (const p of PLAN_GRADE) plansSeed.run(p.id, p.name, p.price, JSON.stringify(p.features));

  const A = `org_${randomUUID().slice(0, 8)}`; // Growth (sem advocacia)
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'Padaria do Zé', 'active', 'growth')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "advocacia");
  const emA: string[] = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id=?`).get(A) as any).enabled_modules || "[]");
  check("3.1 Growth: applyVertical('advocacia') NÃO liga o módulo (teto do plano)", !emA.includes("advocacia"));
  check("3.2 Growth: /api/advocacia recusado (isModuleAvailable=false)", EntitlementService.isModuleAvailable(A, "advocacia").available === false);
  check("3.3 Growth: reason = plan_ceiling (precisa upgrade/add-on)", EntitlementService.isModuleAvailable(A, "advocacia").reason === "plan_ceiling");

  const B = `org_${randomUUID().slice(0, 8)}`; // Enterprise (inclui advocacia)
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'Silva Advogados', 'active', 'enterprise')`).run(randomUUID(), B);
  ModuleService.applyVertical(B, "advocacia");
  const emB: string[] = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id=?`).get(B) as any).enabled_modules || "[]");
  check("3.4 Enterprise: applyVertical liga o módulo advocacia", emB.includes("advocacia"));
  check("3.5 Enterprise: /api/advocacia liberado", EntitlementService.isModuleAvailable(B, "advocacia").available === true);

  // ═══ 4. add-on Scale destrava mesmo sem estar no teto base ═══
  const C = `org_${randomUUID().slice(0, 8)}`; // Scale + add-on advocacia
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'Costa Advocacia', 'active', 'scale')`).run(randomUUID(), C);
  ModuleService.applyVertical(C, "advocacia");
  check("4.1 Scale sem add-on: bloqueado", EntitlementService.isModuleAvailable(C, "advocacia").available === false);
  db.prepare(`INSERT INTO org_addons (id, organization_id, addon_key, price, status) VALUES (?, ?, 'advocacia', 3000, 'active')`).run(randomUUID(), C);
  ModuleService.applyVertical(C, "advocacia"); // re-aplica: agora o teto inclui o add-on
  const emC: string[] = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id=?`).get(C) as any).enabled_modules || "[]");
  check("4.2 Scale + add-on: módulo ligado", emC.includes("advocacia"));
  check("4.3 Scale + add-on: liberado", EntitlementService.isModuleAvailable(C, "advocacia").available === true);

  // ═══ 5. o Sidebar passou a gatear por módulo (não pela vertical) ═══
  const sidebar = fs.readFileSync(path.join(repoRoot, "src/features/Sidebar.tsx"), "utf8");
  check("5.1 Sidebar usa mod('advocacia'), não vertical==='advocacia'", sidebar.includes("mod('advocacia')") && !sidebar.includes("vertical === 'advocacia'"));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} advocacia-plan-gated: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
