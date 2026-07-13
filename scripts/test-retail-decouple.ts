/**
 * TESTE — ADR-084 Fatia 1: desacoplar Retail Network Ops do Varejo Base
 * ---------------------------------------------------------------------
 * Prova, offline, o corte cirúrgico e a guarda de compatibilidade:
 *   - CORTE: a vertical `varejo` NÃO habilita mais o módulo `retail` nem as
 *     automações retail_*, e as áreas/FAQ de Retail Ops não são semeadas para
 *     uma loja de varejo comum;
 *   - GRANDFATHER: uma org que já tem `retail` habilitado NÃO perde o módulo ao
 *     (re)aplicar a vertical, e uma automação retail_* já ligada é preservada
 *     (o pack não a desliga) — a TOULON continua intacta;
 *   - OPT-IN: com o `retail` habilitado, as áreas de Retail Ops passam a ser
 *     semeadas normalmente. Isolamento por organização.
 *
 * Uso:  npm run test:retail-decouple
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-decouple-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-decouple-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { OnboardingTemplateService } = await import("../src/server/OnboardingTemplateService.js");

  const mods = (orgId: string): string[] => ModuleService.enabledModules(orgId) || [];
  const hasArea = (orgId: string, name: string): boolean =>
    !!db.prepare(`SELECT 1 FROM service_areas WHERE organization_id = ? AND lower(name) = lower(?)`).get(orgId, name);
  const settingBool = (orgId: string, col: string): number =>
    Number((db.prepare(`SELECT ${col} AS v FROM organization_settings WHERE organization_id = ?`).get(orgId) as any)?.v || 0);

  // ---- 1. CORTE: varejo comum não vira rede de lojas ----
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "varejo");
  check("Corte: varejo NÃO habilita o módulo retail", !mods(A).includes("retail"));
  check("Varejo mantém os módulos comerciais (vendas/catalogo)", mods(A).includes("vendas") && mods(A).includes("catalogo"));
  await OnboardingTemplateService.applyPack(A, "varejo", { skipFaq: true });
  check("Pack varejo semeia área comercial (Vendas)", hasArea(A, "Vendas"));
  check("Corte: pack varejo NÃO semeia área de Retail Ops (Fechamento de Loja)", !hasArea(A, "Fechamento de Loja"));
  check("Corte: pack varejo NÃO liga automação retail (daily_closing)", settingBool(A, "retail_daily_closing_enabled") === 0);

  // ---- 2. GRANDFATHER: quem já usa retail não perde nada ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  // Simula a TOULON: já com retail habilitado + automação ligada manualmente.
  ModuleService.setModules(B, ["vendas", "catalogo", "retail"]);
  db.prepare(`UPDATE organization_settings SET retail_daily_closing_enabled = 1 WHERE organization_id = ?`).run(B);
  ModuleService.applyVertical(B, "varejo"); // re-aplica a vertical (cenário de re-onboarding/backfill)
  check("Grandfather: retail preservado ao re-aplicar a vertical", mods(B).includes("retail"));
  await OnboardingTemplateService.applyPack(B, "varejo", { skipFaq: true });
  check("Grandfather: automação retail já ligada não é desligada pelo pack", settingBool(B, "retail_daily_closing_enabled") === 1);
  check("Opt-in: com retail ligado, área de Retail Ops é semeada", hasArea(B, "Fechamento de Loja"));

  // ---- 3. Isolamento ----
  check("Isolamento: A não recebeu retail por causa de B", !mods(A).includes("retail"));

  console.log("\n=== ADR-084 Fatia 1: desacoplar Retail Network Ops do Varejo Base ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
