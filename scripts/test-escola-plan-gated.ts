/**
 * TEST — Escola VENDÁVEL e travada por PLANO. Determinístico.
 * A tela de Escola (ADR-144 UI) é gated pelo módulo `escola` (MODULE_BY_ROUTE),
 * mas o módulo NÃO estava em nenhum tier de plano NEM no catálogo de add-ons —
 * então nenhum cliente pagante conseguia habilitá-lo (só orgs de cortesia sem
 * teto). Esta fatia coloca `escola` no tier Enterprise + add-on Scale (espelha
 * clinica/advocacia). Trocar/assinar a vertical educacao só libera quem tem no
 * plano; sem direito, a rota /api/escola recusa (403).
 *
 * Uso: npm run test:escola-plan-gated
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-esc-gate-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-esc-gate-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { EntitlementService } = await import("../src/server/EntitlementService.js");
  const { PLAN_GRADE } = await import("../src/server/plansGrade.js");
  const { AddonService } = await import("../src/server/AddonService.js");

  // ═══ 1. escola é módulo gated por rota + vendável ═══
  check("1.1 MODULE_BY_ROUTE.escola = 'escola' (rota /api/escola gated)", (ModuleService.MODULE_BY_ROUTE as any).escola === "escola");
  const ent = PLAN_GRADE.find((p) => p.id === "enterprise");
  check("1.2 plano Enterprise inclui escola", !!ent && ent.features.modules.includes("escola"));
  check("1.3 add-on Scale vende escola", (AddonService.ADDON_CATALOG.scale || []).some((a) => a.key === "escola"));
  const growth = PLAN_GRADE.find((p) => p.id === "growth");
  check("1.4 Growth NÃO inclui escola (não é base)", !!growth && !growth.features.modules.includes("escola"));

  // ═══ 2. comportamento: assinar educacao num plano sem escola NÃO libera ═══
  const seed = db.prepare(`INSERT OR IGNORE INTO plans (id, name, price, features) VALUES (?, ?, ?, ?)`);
  for (const p of PLAN_GRADE) seed.run(p.id, p.name, p.price, JSON.stringify(p.features));

  const A = `org_${randomUUID().slice(0, 8)}`; // Growth
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'Curso do Bairro', 'active', 'growth')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "educacao");
  const emA: string[] = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id=?`).get(A) as any).enabled_modules || "[]");
  check("2.1 Growth: educacao NÃO liga o módulo escola (teto do plano)", !emA.includes("escola"));
  check("2.2 Growth: /api/escola recusado (isModuleAvailable=false)", EntitlementService.isModuleAvailable(A, "escola").available === false);
  check("2.3 Growth: reason = plan_ceiling", EntitlementService.isModuleAvailable(A, "escola").reason === "plan_ceiling");

  const B = `org_${randomUUID().slice(0, 8)}`; // Enterprise
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'Colégio Alfa', 'active', 'enterprise')`).run(randomUUID(), B);
  ModuleService.applyVertical(B, "educacao");
  const emB: string[] = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id=?`).get(B) as any).enabled_modules || "[]");
  check("2.4 Enterprise: educacao liga o módulo escola", emB.includes("escola"));
  check("2.5 Enterprise: /api/escola liberado", EntitlementService.isModuleAvailable(B, "escola").available === true);

  // ═══ 3. add-on Scale destrava mesmo fora do teto base ═══
  const C = `org_${randomUUID().slice(0, 8)}`; // Scale + add-on
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'Escola Beta', 'active', 'scale')`).run(randomUUID(), C);
  ModuleService.applyVertical(C, "educacao");
  check("3.1 Scale sem add-on: bloqueado", EntitlementService.isModuleAvailable(C, "escola").available === false);
  db.prepare(`INSERT INTO org_addons (id, organization_id, addon_key, price, status) VALUES (?, ?, 'escola', 3000, 'active')`).run(randomUUID(), C);
  ModuleService.applyVertical(C, "educacao");
  const emC: string[] = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id=?`).get(C) as any).enabled_modules || "[]");
  check("3.2 Scale + add-on: módulo ligado", emC.includes("escola"));
  check("3.3 Scale + add-on: liberado", EntitlementService.isModuleAvailable(C, "escola").available === true);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} escola-plan-gated: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
