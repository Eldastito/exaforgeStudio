/**
 * TEST — BEAUTY-025 (ADR-169 F24): Visagismo — subtom→cor + formato rosto→corte.
 *
 * Prova a recomendação TÉCNICA (determinística) e os guardrails RN-BS-03:
 *  1. subtom quente → cores quentes (dourados/mel/acobreados), evita frias.
 *  2. subtom frio → cores frias (pérola/acinzentado/platinado).
 *  3. rosto redondo → cortes que alongam (FEMININO e MASCULINO — perfis
 *     distintos geram cortes distintos).
 *  4. governança RN-BS-03: sem actor+reason → lança (human_decision_required).
 *  5. narrativa NUNCA contém palavra de julgamento/nota (RN-BS-03) e SEMPRE
 *     tem o disclaimer.
 *  6. consent hair_simulation obrigatório.
 *  7. indeterminado (sem manual, sem IA) → recomendações vazias (nunca inventa).
 *  8. isolamento multi-tenant.
 *  9. NÃO existe pontuação/score de atratividade em lugar nenhum do retorno.
 *
 * Sem chave de IA no ambiente do teste → o path é sempre manual/indeterminado
 * (determinístico, roda em CI).
 *
 * Uso: npm run test:beauty-visagism
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-visagism-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-visagism-1234567890";
delete process.env.GOOGLE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) { results.push({ name, ok, note }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));

  const { BeautyVisagismService, VISAGISM_DISCLAIMER } = await import("../src/server/BeautyVisagismService.js");
  const { BeautyVisualConsultationService } = await import("../src/server/BeautyVisualConsultationService.js");

  const seedOrg = () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Salão', 'active', 'beleza')`).run(randomUUID(), orgId);
    return orgId;
  };
  const seedContact = (orgId: string) => {
    const id = `c_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente', ?)`).run(id, orgId, `${orgId}:${id}`);
    return id;
  };
  const startConsult = (orgId: string, contactId: string, withConsent = true) => {
    if (withConsent) BeautyVisualConsultationService.grantConsent(orgId, contactId, "hair_simulation");
    return BeautyVisualConsultationService.startConsultation(orgId, { contactId, goal: "coloração" });
  };

  try {
    const orgA = seedOrg();
    const ana = seedContact(orgA);
    const cons = startConsult(orgA, ana);

    // ===== 4. Governança: sem actor+reason → lança =====
    let threw = false;
    try { await BeautyVisagismService.analyze(orgA, cons.id, { undertone: "quente", faceShape: "oval" }); }
    catch { threw = true; }
    check("sem actor+reason → lança (RN-BS-03)", threw);

    // ===== 1. Subtom quente → cores quentes =====
    const rQuente = await BeautyVisagismService.analyze(orgA, cons.id, {
      actorId: "u1", reason: "orientar cor", undertone: "quente", faceShape: "oval", profile: "feminino",
    });
    check("quente → source=manual", rQuente.source === "manual");
    check("quente recomenda cores quentes (dourado/mel/acobreado)",
      rQuente.recommendedColors.some(c => /dourado|mel|acobreado|caramelo|chocolate/.test(c)), JSON.stringify(rQuente.recommendedColors));
    check("quente NÃO recomenda platinado/acinzentado",
      !rQuente.recommendedColors.some(c => /platinado|acinzentado|prateado/.test(c)));

    // ===== 2. Subtom frio → cores frias =====
    const rFrio = await BeautyVisagismService.analyze(orgA, cons.id, {
      actorId: "u1", reason: "orientar cor", undertone: "frio", faceShape: "oval", profile: "feminino",
    });
    check("frio recomenda cores frias (pérola/acinzentado/platinado/borgonha)",
      rFrio.recommendedColors.some(c => /perola|acinzentado|platinado|borgonha|prateado|cinza/.test(c)), JSON.stringify(rFrio.recommendedColors));

    // ===== 3. Rosto redondo → cortes que alongam, fem × masc distintos =====
    const rRedFem = await BeautyVisagismService.analyze(orgA, cons.id, {
      actorId: "u1", reason: "corte", faceShape: "redondo", profile: "feminino",
    });
    const rRedMasc = await BeautyVisagismService.analyze(orgA, cons.id, {
      actorId: "u1", reason: "corte", faceShape: "redondo", profile: "masculino",
    });
    check("rosto redondo (fem) recomenda cortes que alongam", rRedFem.recommendedCuts.length > 0 && rRedFem.recommendedCuts.some(c => /longo|camadas|corte_v|repicado|franja_lateral/.test(c)), JSON.stringify(rRedFem.recommendedCuts));
    check("rosto redondo (masc) recomenda cortes masculinos", rRedMasc.recommendedCuts.some(c => /topete|undercut|moicano/.test(c)), JSON.stringify(rRedMasc.recommendedCuts));
    check("fem e masc geram cortes DISTINTOS pro mesmo rosto", JSON.stringify(rRedFem.recommendedCuts) !== JSON.stringify(rRedMasc.recommendedCuts));

    // ===== 5. Narrativa: sem palavra de julgamento + disclaimer =====
    const FORBIDDEN = ["bonit", "fei", "atraente", "atrativ", "lind", "nota", "score", "melhor", "pior", "pontuaç"];
    const narrOk = !FORBIDDEN.some(w => rQuente.narrative.toLowerCase().includes(w));
    check("narrativa NÃO contém palavra de julgamento/nota (RN-BS-03)", narrOk, rQuente.narrative);
    check("narrativa inclui o disclaimer", rQuente.narrative.includes(VISAGISM_DISCLAIMER.slice(0, 30)));

    // ===== 9. NENHUM score de atratividade no retorno =====
    const asStr = JSON.stringify(rQuente).toLowerCase();
    check("retorno NÃO tem score/pontuação/atratividade", !/score|atrativ|pontuac|pontuaç|\/10/.test(asStr));

    // ===== 7. Indeterminado (sem manual, sem IA) → vazio, não inventa =====
    const rInd = await BeautyVisagismService.analyze(orgA, cons.id, { actorId: "u1", reason: "x" });
    check("sem manual + sem IA → source=pending", rInd.source === "pending");
    check("indeterminado → recomendações vazias (nunca inventa)", rInd.recommendedColors.length === 0 && rInd.recommendedCuts.length === 0);
    check("indeterminado → narrativa honesta (não determinado)", /não determinado|nao determinado/.test(rInd.narrative.toLowerCase()));

    // ===== 6. Consent obrigatório =====
    const contactSemConsent = seedContact(orgA);
    const consSem = BeautyVisualConsultationService.startConsultation(orgA, { contactId: contactSemConsent, goal: "x" });
    let threwConsent = false;
    try { await BeautyVisagismService.analyze(orgA, consSem.id, { actorId: "u1", reason: "x", undertone: "quente" }); }
    catch { threwConsent = true; }
    check("sem consent hair_simulation → lança", threwConsent);

    // ===== 8. Isolamento multi-tenant =====
    const orgB = seedOrg();
    const list = BeautyVisagismService.listForConsultation(orgB, cons.id);
    check("orgB não vê análises da consulta de orgA (isolamento)", list.length === 0);
    check("orgA vê seu histórico", BeautyVisagismService.listForConsultation(orgA, cons.id).length > 0);
  } finally { /* tmpDir cleanup */ }

  console.log("\n=== TEST — BEAUTY-025 (ADR-169 F24): Visagismo ===");
  for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.note ? ` — ${r.note}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} PASS`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
