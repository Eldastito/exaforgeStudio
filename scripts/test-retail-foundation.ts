/**
 * TESTE — Retail Ops Fase A: fundação (ADR-083)
 * --------------------------------------------
 * Prova, offline, a base do módulo Retail Ops (contrato pós-ADR-084 D2):
 *   - módulo `retail` registrado (OPTIONAL_MODULES, rota→módulo) mas OPT-IN:
 *     a vertical `varejo` NÃO o liga e o Quick-Start base cria só as 2 áreas
 *     comerciais, sem semear áreas/automações retail_* para varejo comum;
 *   - aplicar o pack é idempotente (reaplicar não duplica);
 *   - cadastro de lojas (CRUD) isolado por organização; resolução por WhatsApp.
 *   (o opt-in/grandfather do Retail Network Ops é coberto por test-retail-decouple.)
 *
 * Uso:  npm run test:retail-foundation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-a-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-a-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OPTIONAL_MODULES, VERTICALS } = await import("../src/server/verticals.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { OnboardingTemplateService } = await import("../src/server/OnboardingTemplateService.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");

  // ---- 1. Registro do módulo ----
  check("Módulo 'retail' em OPTIONAL_MODULES", (OPTIONAL_MODULES as readonly string[]).includes("retail"));
  const varejo = VERTICALS.find((v: any) => v.key === "varejo");
  check("Vertical varejo NÃO liga o módulo 'retail' (opt-in, ADR-084 D2)", !!varejo && !varejo.modules.includes("retail"));
  check("Rota /retailops mapeia para o módulo 'retail'", ModuleService.MODULE_BY_ROUTE["retailops"] === "retail");

  // ---- 2. Quick-Start base: varejo comum NÃO vira rede de lojas ----
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  await OnboardingTemplateService.applyPack(A, "varejo", { skipFaq: true });
  const areas = db.prepare(`SELECT name FROM service_areas WHERE organization_id = ? ORDER BY position`).all(A).map((r: any) => r.name);
  check("Quick-Start varejo cria as 2 áreas comerciais (Vendas, Suporte/SAC)", areas.length === 2 && areas.includes("Vendas") && areas.includes("Suporte / SAC"), areas.join(","));
  for (const a of ["Fechamento de Loja", "Malote e Escalas", "Auditoria de Estoque", "Premiação e Comissão"]) {
    check(`Corte: área '${a}' NÃO criada para varejo comum`, !areas.includes(a));
  }
  const settings = db.prepare(`SELECT retail_daily_closing_enabled, retail_quota_enabled, retail_commission_enabled FROM organization_settings WHERE organization_id = ?`).get(A) as any;
  check("Corte: automações retail_* não semeadas pelo pack base", settings.retail_daily_closing_enabled === 0 && settings.retail_quota_enabled === 0 && settings.retail_commission_enabled === 0);
  check("Corte: módulo 'retail' NÃO habilitado por varejo", ModuleService.enabledModules(A)?.includes("retail") !== true);

  // ---- 3. Idempotência do pack ----
  const rep2 = await OnboardingTemplateService.applyPack(A, "varejo", { skipFaq: true });
  const areas2 = db.prepare(`SELECT COUNT(*) AS c FROM service_areas WHERE organization_id = ?`).get(A) as any;
  check("Reaplicar o pack não duplica áreas", areas2.c === 2 && rep2.areas.skipped >= 2);

  // ---- 4. Cadastro de lojas (CRUD + isolamento) ----
  const s1 = RetailStoreService.create(A, { name: "Loja Barra", code: "BR", whatsappIdentifier: "5511999990001" }, "u1");
  check("Cria loja", !!s1?.id && s1.name === "Loja Barra" && s1.active === 1);
  const upd = RetailStoreService.update(A, s1.id, { code: "BAR", active: false }, "u1");
  check("Atualiza loja (code + active)", upd.code === "BAR" && upd.active === 0);
  check("Lista lojas da org", RetailStoreService.list(A).length === 1);
  check("Resolve loja pelo WhatsApp (só ativa)", RetailStoreService.findByWhatsapp(A, "5511999990001") === null); // desativada acima
  RetailStoreService.update(A, s1.id, { active: true }, "u1");
  check("Resolve loja ativa pelo WhatsApp", RetailStoreService.findByWhatsapp(A, "5511999990001")?.id === s1.id);

  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  RetailStoreService.create(B, { name: "Loja de B" }, "u2");
  check("Isolamento: org B não vê a loja de A", RetailStoreService.get(B, s1.id) === null && RetailStoreService.list(B).length === 1);

  console.log("\n=== Retail Ops — Fase A: fundação (ADR-083) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
