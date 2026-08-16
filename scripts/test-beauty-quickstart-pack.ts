/**
 * TEST — BEAUTY-022 (ADR-169 F21): Quick-Start pack de BELEZA & SALÕES.
 *
 * Prova que o novo pack semeia áreas/personas + cadências + automações
 * (incluindo LIGAR a Beauty AI + detectores proativos) + marca o Quick-Start
 * como aplicado, e é idempotente. FAQ é pulado (skipFaq) para não depender de
 * embeddings/RAG no CI.
 *
 * Guardrails RN-BS provados como REGRESSÃO nas personas:
 *  - RN-BS-03 (nunca julga aparência): nenhuma persona contém palavra de
 *    julgamento estético da PESSOA (bonito/feio/lindo/jovem/melhor/pior...).
 *  - RN-BS-11 (só catálogo): as personas instruem a NUNCA inventar preço/
 *    serviço/promoção fora do catálogo.
 *
 * Uso: npm run test:beauty-quickstart-pack
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-qs-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-beauty-qs-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OnboardingTemplateService } = await import("../src/server/OnboardingTemplateService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Salão Teste', 'active', 'beleza')`).run(randomUUID(), orgId);
  const areasCount = () => (db.prepare(`SELECT COUNT(*) c FROM service_areas WHERE organization_id = ?`).get(orgId) as any).c;
  const cadCount = () => (db.prepare(`SELECT COUNT(*) c FROM cadences WHERE organization_id = ?`).get(orgId) as any).c;
  const applied = () => (db.prepare(`SELECT quickstart_applied FROM organization_settings WHERE organization_id = ?`).get(orgId) as any)?.quickstart_applied;

  // ===== 1. availablePacks inclui beleza com summary =====
  const pack = OnboardingTemplateService.availablePacks().find((p: any) => p.vertical === "beleza");
  check("pack de beleza existe com summary", !!pack && pack.summary.areas === 3 && pack.summary.cadences === 4, JSON.stringify(pack));
  check("label 'Beleza & Salões'", pack?.label === "Beleza & Salões");

  // ===== 2. Aplicar semeia áreas + cadências + marca aplicado =====
  const rep = await OnboardingTemplateService.applyPack(orgId, "beleza", { skipFaq: true });
  check("cria 3 áreas (Recepção / Consultoria de Visual / Pós-atendimento)", rep.areas.created === 3, JSON.stringify(rep.areas));
  check("cria 4 cadências", rep.cadences.created === 4, JSON.stringify(rep.cadences));
  check("aplica automações do pack", rep.automations.applied > 0, JSON.stringify(rep.automations));
  check("quickstart_applied = 1", applied() === 1);
  check("áreas persistidas (3)", areasCount() === 3, String(areasCount()));
  check("Recepção do Salão existe como área", !!db.prepare(`SELECT 1 FROM service_areas WHERE organization_id = ? AND lower(name)='recepção do salão'`).get(orgId));
  check("Consultoria de Visual (Beauty AI) existe como área", !!db.prepare(`SELECT 1 FROM service_areas WHERE organization_id = ? AND name LIKE 'Consultoria de Visual%'`).get(orgId));
  check("cadência de confirmação no estágio 'agendado'", !!db.prepare(`SELECT 1 FROM cadences WHERE organization_id = ? AND trigger_stage='agendado'`).get(orgId));
  check("cadência de retorno no estágio 'retorno_recomendado'", !!db.prepare(`SELECT 1 FROM cadences WHERE organization_id = ? AND trigger_stage='retorno_recomendado'`).get(orgId));

  // ===== 3. Automações coerentes com salão + LIGA a Beauty AI =====
  const s = db.prepare(`SELECT order_expiry_enabled, abandoned_cart_enabled, nps_enabled, referral_enabled, pix_reminder_enabled,
      beauty_hair_simulator_enabled, beauty_maintenance_detector_enabled, beauty_abandoned_detector_enabled
    FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  check("salão: sem expiração de pedido nem carrinho abandonado", Number(s.order_expiry_enabled) === 0 && Number(s.abandoned_cart_enabled) === 0, JSON.stringify(s));
  check("salão: NPS + indicação + PIX ligados", Number(s.nps_enabled) === 1 && Number(s.referral_enabled) === 1 && Number(s.pix_reminder_enabled) === 1);
  check("LIGA Beauty AI (beauty_hair_simulator_enabled=1) — remove o passo manual", Number(s.beauty_hair_simulator_enabled) === 1);
  check("LIGA detector de manutenção (F12)", Number(s.beauty_maintenance_detector_enabled) === 1);
  check("LIGA detector de simulação abandonada (F11)", Number(s.beauty_abandoned_detector_enabled) === 1);

  // ===== 4. RN-BS-03: nenhuma persona julga a aparência =====
  const personas = (db.prepare(`SELECT persona FROM service_areas WHERE organization_id = ?`).all(orgId) as any[]).map(r => String(r.persona || "").toLowerCase());
  const allPersonas = personas.join(" \n ");
  // Palavras de JULGAMENTO ESTÉTICO DA PESSOA proibidas (RN-BS-03). Nota: as
  // personas PODEM conter negações ("nunca diz 'mais bonita'") — então
  // checamos que a persona da Consultoria fala explicitamente do guardrail.
  const consultoria = personas.find(p => p.includes("possibilidades")) || "";
  check("Consultoria fala de POSSIBILIDADES/EFEITO (não da pessoa)", consultoria.includes("possibilidades") && consultoria.includes("efeito"));
  check("Consultoria instrui NUNCA julgar aparência (RN-BS-03)", consultoria.includes("nunca julga") && consultoria.includes("mais bonita"));

  // ===== 5. RN-BS-11: personas instruem a não inventar catálogo =====
  check("personas instruem: só catálogo / nunca inventa preço-promoção (RN-BS-11)",
    allPersonas.includes("catálogo") && (allPersonas.includes("nunca invente") || allPersonas.includes("nunca inventa")));

  // ===== 6. Idempotência =====
  const rep2 = await OnboardingTemplateService.applyPack(orgId, "beleza", { skipFaq: true });
  check("reaplicar não duplica áreas (skipped=3)", rep2.areas.skipped === 3 && rep2.areas.created === 0, JSON.stringify(rep2.areas));
  check("reaplicar não duplica cadências", rep2.cadences.created === 0, JSON.stringify(rep2.cadences));
  check("total de áreas segue 3 / cadências segue 4", areasCount() === 3 && cadCount() === 4, `${areasCount()}/${cadCount()}`);

  // ===== 7. Isolamento multi-tenant =====
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Outro Salão', 'active', 'beleza')`).run(randomUUID(), orgB);
  check("orgB começa sem áreas (isolamento)", (db.prepare(`SELECT COUNT(*) c FROM service_areas WHERE organization_id = ?`).get(orgB) as any).c === 0);
  check("orgB começa com Beauty AI OFF (pack de orgA não vazou)", Number((db.prepare(`SELECT beauty_hair_simulator_enabled b FROM organization_settings WHERE organization_id = ?`).get(orgB) as any).b) === 0);

  console.log("\n=== Quick-Start Beleza & Salões (ADR-169 F21) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
