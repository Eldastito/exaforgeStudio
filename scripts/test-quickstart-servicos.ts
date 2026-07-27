/**
 * TEST — Quick-Start pack de PRESTADORES DE SERVIÇO (vertical `servicos`).
 *
 * Prova que o novo pack semeia áreas/personas + cadências + automações + marca
 * o Quick-Start como aplicado, e é idempotente. FAQ é pulado (skipFaq) para não
 * depender de embeddings/RAG no CI.
 *
 * Uso: npm run test:quickstart-servicos
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-qs-servicos-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-qs-servicos-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OnboardingTemplateService } = await import("../src/server/OnboardingTemplateService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Chaveiro', 'active', 'servicos')`).run(randomUUID(), orgId);
  const areasCount = () => (db.prepare(`SELECT COUNT(*) c FROM service_areas WHERE organization_id = ?`).get(orgId) as any).c;
  const cadCount = () => (db.prepare(`SELECT COUNT(*) c FROM cadences WHERE organization_id = ?`).get(orgId) as any).c;
  const applied = () => (db.prepare(`SELECT quickstart_applied FROM organization_settings WHERE organization_id = ?`).get(orgId) as any)?.quickstart_applied;

  // ===== 1. availablePacks inclui servicos com summary =====
  const pack = OnboardingTemplateService.availablePacks().find((p: any) => p.vertical === "servicos");
  check("pack de servicos existe com summary", !!pack && pack.summary.areas === 4 && pack.summary.cadences === 3, JSON.stringify(pack));

  // ===== 2. Aplicar semeia áreas + cadências + marca aplicado =====
  const rep = await OnboardingTemplateService.applyPack(orgId, "servicos", { skipFaq: true });
  check("cria 4 áreas (Orçamentos/Agendamento/OS/Pós-serviço)", rep.areas.created === 4, JSON.stringify(rep.areas));
  check("cria 3 cadências", rep.cadences.created === 3, JSON.stringify(rep.cadences));
  check("aplica automações do pack", rep.automations.applied > 0, JSON.stringify(rep.automations));
  check("quickstart_applied = 1", applied() === 1);
  check("áreas persistidas (4)", areasCount() === 4, String(areasCount()));
  check("Orçamentos existe como área", !!db.prepare(`SELECT 1 FROM service_areas WHERE organization_id = ? AND lower(name)='orçamentos'`).get(orgId));
  check("cadência de orçamento no estágio 'proposta'", !!db.prepare(`SELECT 1 FROM cadences WHERE organization_id = ? AND trigger_stage='proposta'`).get(orgId));

  // ===== 3. Automação coerente com serviço (sem carrinho/expiração) =====
  const s = db.prepare(`SELECT order_expiry_enabled, abandoned_cart_enabled, quote_validity_hours FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  check("serviço: sem expiração de pedido nem carrinho abandonado", Number(s.order_expiry_enabled) === 0 && Number(s.abandoned_cart_enabled) === 0, JSON.stringify(s));
  check("serviço: validade de orçamento definida", Number(s.quote_validity_hours) > 0);

  // ===== 4. Idempotência =====
  const rep2 = await OnboardingTemplateService.applyPack(orgId, "servicos", { skipFaq: true });
  check("reaplicar não duplica áreas (skipped=4)", rep2.areas.skipped === 4 && rep2.areas.created === 0, JSON.stringify(rep2.areas));
  check("reaplicar não duplica cadências", rep2.cadences.created === 0, JSON.stringify(rep2.cadences));
  check("total de áreas segue 4 / cadências segue 3", areasCount() === 4 && cadCount() === 3, `${areasCount()}/${cadCount()}`);

  console.log("\n=== Quick-Start Prestadores de Serviço ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
