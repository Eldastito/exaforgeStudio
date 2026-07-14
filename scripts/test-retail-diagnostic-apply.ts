/**
 * TESTE — ADR-084 D3: aplicação do diagnóstico (confirmação → aplica)
 * ------------------------------------------------------------------
 * Prova, offline, que a recomendação vira configuração real:
 *   - TOULON (multi + metas + PDV externo) → retail habilitado + ativado +
 *     modo supervised;
 *   - loja única nativa (e-commerce, sem PDV) → sem retail + modo native +
 *     módulo loja; não ativa Retail Ops;
 *   - une aos módulos já habilitados (grandfather, não remove); isolamento.
 *
 * Uso:  npm run test:retail-diagnostic-apply
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-diag-apply-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-diag-apply-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { RetailStockModeService } = await import("../src/server/RetailStockModeService.js");
  const { RetailActivationService } = await import("../src/server/RetailActivationService.js");
  const { RetailDiagnosticService } = await import("../src/server/RetailDiagnosticService.js");

  // ---- 1. TOULON: rede + metas + PDV externo ----
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const rA = RetailDiagnosticService.apply(A, { units: "multi", storeOps: true, externalPdv: true, variants: true, channels: ["whatsapp", "balcao"] }, "u1");
  check("TOULON: retail habilitado no módulo", (ModuleService.enabledModules(A) || []).includes("retail"));
  check("TOULON: Retail Ops ATIVADO (módulo + automações)", rA.applied.retailActivated === true && RetailActivationService.status(A).active === true);
  check("TOULON: modo de estoque supervised", RetailStockModeService.getOrgMode(A) === "supervised");

  // ---- 2. Loja única nativa ----
  const C = `org_C_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'C', 'active')`).run(randomUUID(), C);
  const rC = RetailDiagnosticService.apply(C, { units: "single", storeOps: false, externalPdv: false, channels: ["whatsapp", "ecommerce"] }, "u1");
  check("Loja única: retail NÃO ativado", rC.applied.retailActivated === false && !(ModuleService.enabledModules(C) || []).includes("retail"));
  check("Loja única: modo native", RetailStockModeService.getOrgMode(C) === "native");
  check("Loja única: módulo loja habilitado (e-commerce)", (ModuleService.enabledModules(C) || []).includes("loja"));

  // ---- 3. Grandfather: não remove módulo já habilitado ----
  const G = `org_G_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'G', 'active')`).run(randomUUID(), G);
  ModuleService.setModules(G, ["clinica", "vendas"]); // já tinha clínica
  RetailDiagnosticService.apply(G, { units: "single", channels: ["whatsapp"] }, "u1");
  check("Grandfather: módulo pré-existente (clinica) preservado", (ModuleService.enabledModules(G) || []).includes("clinica"));

  // ---- 4. Isolamento ----
  check("Isolamento: C não virou supervised por causa de A", RetailStockModeService.getOrgMode(C) === "native");

  console.log("\n=== ADR-084 D3: aplicação do diagnóstico (confirmação) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
