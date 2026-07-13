/**
 * TESTE — ADR-084 Fatia 2: ativação opt-in do Retail Network Ops
 * --------------------------------------------------------------
 * O par do corte da Fatia 1. Prova, offline:
 *   - estado inicial pós-corte: varejo comum NÃO tem retail ligado;
 *   - ativação: liga o módulo `retail` + as automações retail_* (defaults);
 *   - idempotência da ativação;
 *   - caso legado (enabled_modules nulo): ativar torna o conjunto explícito a
 *     partir do preset da vertical, SEM perder módulos, e adiciona `retail`;
 *   - desativação desliga as automações mas mantém o módulo/dados;
 *   - isolamento por organização.
 *
 * Uso:  npm run test:retail-activation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-activation-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-activation-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { RetailActivationService } = await import("../src/server/RetailActivationService.js");

  const mods = (orgId: string): string[] => ModuleService.enabledModules(orgId) || [];
  const flag = (orgId: string, col: string): number =>
    Number((db.prepare(`SELECT ${col} AS v FROM organization_settings WHERE organization_id = ?`).get(orgId) as any)?.v || 0);

  // ---- 1. Estado inicial pós-corte (Fatia 1) ----
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "varejo");
  check("Pós-corte: varejo não tem retail ligado", !RetailActivationService.status(A).active);
  check("Pós-corte: automação daily_closing off", flag(A, "retail_daily_closing_enabled") === 0);

  // ---- 2. Ativação opt-in ----
  const act = RetailActivationService.activate(A, "u1");
  check("Ativação: status.active = true", act.active === true);
  check("Ativação: módulo retail habilitado", mods(A).includes("retail") && ModuleService.isEnabled(A, "retail"));
  check("Ativação: mantém módulos comerciais (vendas)", mods(A).includes("vendas"));
  check("Ativação: liga as 7 automações retail_*", Object.values(act.automations).every((v) => v === 1) && Object.keys(act.automations).length === 7);
  check("Ativação: due_hour permanece no default 21", flag(A, "retail_daily_closing_due_hour") === 21);

  // ---- 3. Idempotência ----
  const act2 = RetailActivationService.activate(A, "u1");
  check("Ativar de novo é idempotente", act2.active === true && mods(A).filter((m) => m === "retail").length === 1);

  // ---- 4. Caso legado: enabled_modules nulo ----
  const L = `org_L_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, vertical, status, enabled_modules) VALUES (?, ?, 'L', 'varejo', 'active', NULL)`).run(randomUUID(), L);
  RetailActivationService.activate(L, "u1");
  check("Legado nulo: vira explícito com o preset da vertical (vendas)", mods(L).includes("vendas"));
  check("Legado nulo: adiciona retail sem perder módulos", mods(L).includes("retail") && mods(L).length > 1);

  // ---- 5. Desativação ----
  const deact = RetailActivationService.deactivate(A, "u1");
  check("Desativação: automações off", Object.values(deact.automations).every((v) => v === 0));
  check("Desativação: módulo retail permanece habilitado", mods(A).includes("retail"));

  // ---- 6. Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  ModuleService.applyVertical(B, "varejo");
  check("Isolamento: B não foi ativado por A", !RetailActivationService.status(B).active && !mods(B).includes("retail"));

  console.log("\n=== ADR-084 Fatia 2: ativação opt-in do Retail Network Ops ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
