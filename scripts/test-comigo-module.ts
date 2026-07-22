/**
 * TEST — Comigo/copiloto: registro do módulo + schema (ADR-111/112/113, PR #1).
 *
 * Verifica que o módulo `copiloto` (marca Comigo) está registrado (OPTIONAL_MODULES,
 * MODULE_META, MODULE_BY_ROUTE), que é exclusivo do plano Autônomo (teto), e que o
 * schema do Comigo (fichas, Balcão, fiado, lista negra, cobrança) foi criado.
 *
 * Uso: npm run test:comigo-module
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { OPTIONAL_MODULES } = await import("../src/server/verticals.js");
  const { PLAN_GRADE } = await import("../src/server/plansGrade.js");
  const { applyPlanGrade } = await import("../src/server/plansGrade.js");

  // ===== 1. Registro do módulo =====
  check("copiloto está em OPTIONAL_MODULES", (OPTIONAL_MODULES as readonly string[]).includes("copiloto"));
  check("copiloto tem MODULE_META (label)", !!ModuleService.MODULE_META["copiloto"]?.label);
  check("rota comigo -> copiloto em MODULE_BY_ROUTE", ModuleService.MODULE_BY_ROUTE["comigo"] === "copiloto");

  // ===== 2. Exclusivo do plano Autônomo (teto) =====
  const autonomo = PLAN_GRADE.find((p) => p.id === "autonomo");
  const start = PLAN_GRADE.find((p) => p.id === "start");
  check("plano Autônomo inclui copiloto", !!autonomo?.features.modules.includes("copiloto"));
  check("plano Start NÃO inclui copiloto", !start?.features.modules.includes("copiloto"));

  // ===== 3. Gating: só liga onde o plano permite =====
  applyPlanGrade(db);
  function seedOrg(planId: string) {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, enabled_modules) VALUES (?, ?, 'X', 'active', ?, ?)`)
      .run(randomUUID(), orgId, planId, JSON.stringify(["copiloto"]));
    return orgId;
  }
  const orgAuto = seedOrg("autonomo");
  const orgStart = seedOrg("start");
  check("copiloto habilitado p/ org Autônomo", ModuleService.isEnabled(orgAuto, "copiloto") === true);
  check("copiloto BLOQUEADO p/ org Start (fura teto)", ModuleService.isEnabled(orgStart, "copiloto") === false);

  // ===== 4. Schema do Comigo criado =====
  const tables = [
    "comigo_recipes", "comigo_recipe_costs", "comigo_calibrations",
    "comigo_orders", "comigo_order_items", "comigo_customer_credit",
    "comigo_fiado_ledger", "comigo_fiado_reminders",
  ];
  for (const t of tables) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t) as any;
    check(`tabela ${t} existe`, !!row);
  }

  // ===== 5. Colunas de fiado/lista negra em comigo_customer_credit =====
  const creditCols = (db.prepare("PRAGMA table_info(comigo_customer_credit)").all() as any[]).map((c) => c.name);
  for (const col of ["credit_limit", "blacklisted", "block_all_sales", "blacklist_source"]) {
    check(`comigo_customer_credit.${col} existe`, creditCols.includes(col));
  }

  // ===== 6. paid_via/over_limit em comigo_orders (fiado) =====
  const orderCols = (db.prepare("PRAGMA table_info(comigo_orders)").all() as any[]).map((c) => c.name);
  check("comigo_orders.paid_via existe", orderCols.includes("paid_via"));
  check("comigo_orders.over_limit existe", orderCols.includes("over_limit"));

  // ===== 7. Settings do Comigo em organization_settings =====
  const osCols = (db.prepare("PRAGMA table_info(organization_settings)").all() as any[]).map((c) => c.name);
  for (const col of ["comigo_hour_value", "comigo_fiado_default_limit", "comigo_fiado_reminder_enabled", "comigo_blacklist_suggest_days"]) {
    check(`organization_settings.${col} existe`, osCols.includes(col));
  }

  // ===== 8. Razão do fiado: saldo = Σ debt − Σ payment =====
  const org = seedOrg("autonomo");
  const contactId = `ct_${randomUUID().slice(0, 8)}`;
  const led = (kind: string, amount: number) => db.prepare(
    `INSERT INTO comigo_fiado_ledger (id, organization_id, contact_id, kind, amount) VALUES (?, ?, ?, ?, ?)`
  ).run(randomUUID(), org, contactId, kind, amount);
  led("debt", 45); led("debt", 20); led("payment", 25);
  const debt = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id=? AND contact_id=? AND kind='debt'").get(org, contactId) as any).s;
  const paid = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id=? AND contact_id=? AND kind='payment'").get(org, contactId) as any).s;
  check("saldo fiado (65−25) = 40", debt - paid === 40);

  // --- Relatório ---
  console.log("\n=== TEST: Comigo/copiloto — registro + schema (ADR-111/112/113) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Módulo Comigo registrado e schema OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
