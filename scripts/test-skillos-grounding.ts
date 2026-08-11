/**
 * TEST — PRD 4 F6 (Grounding + Confidence): gate UNSUPPORTED_CLAIM + Confidence
 * Engine. DB-backed, isolado por tmpDir. Determinístico (sem IA real). Prova:
 *
 *   GROUNDING (§19, checkGrounding puro):
 *     - fato sem evidência que exista → unsupported (RN-GND-1);
 *     - fato citando evidência AUSENTE do contexto → unsupported (RN-GND-2, não inventa);
 *     - fato citando evidência presente → grounded (casa por chave OU sourceId);
 *     - hipótese/recomendação isentas (§20); sem fato/estimativa → skipped;
 *     - evidenceFromPacket compõe a evidência disponível a partir dos fatos.
 *   CONFIDENCE (§21, assessConfidence):
 *     - alta→continue, média→seek_context, baixa→fallback;
 *     - grounding unsupported DERRUBA a confiança → fallback (RN-CONF-2);
 *     - thresholds configuráveis (RN-CONF-4);
 *     - fromSignal compõe sobre ImpactPrioritizationService (reusa, não recalcula).
 *   KERNEL (F4+F6): grounding opt-in grava groundingStatus real na AI Run;
 *     blockOnUnsupported → status fallback + failure grounding; sem `ground` → skipped.
 *
 * Uso: npm run test:skillos-grounding
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-skillos-gnd-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-skillos-gnd-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const M = await import("../src/server/skillosModel.js");
  const { SkillOsGroundingService: G } = await import("../src/server/SkillOsGroundingService.js");
  const { SkillOsConfidenceService: C } = await import("../src/server/SkillOsConfidenceService.js");
  const { AiReliabilityKernel: K } = await import("../src/server/AiReliabilityKernel.js");
  const { BusinessSignalService: SIG } = await import("../src/server/BusinessSignalService.js");

  const ev = (sourceType: string, sourceId: string, field?: string) => ({ sourceType, sourceId, service: "svc", field: field ?? null } as any);
  const claim = (statement: string, responseType: string, evidence: any[] = []) => ({ statement, responseType, evidence } as any);

  // evidência disponível no contexto.
  const available = [ev("INTERNAL_DB", "sale:1", "revenue"), ev("APPROVED_DOCUMENT", "doc-9", "chunk:2")];

  // ═══════════════ 1. grounding gate (§19) ═══════════════
  const g1 = M.checkGrounding([claim("Receita caiu 17%", "fact", [ev("INTERNAL_DB", "sale:1", "revenue")])], available);
  check("1.1 fato com evidência presente → grounded", g1.status === "grounded" && g1.groundedClaims === 1);
  const g2 = M.checkGrounding([claim("Receita caiu 17%", "fact", [])], available);
  check("1.2 fato SEM evidência → unsupported (RN-GND-1)", g2.status === "unsupported" && g2.unsupported.length === 1);
  const g3 = M.checkGrounding([claim("Margem é 40%", "fact", [ev("INTERNAL_DB", "inventado:99")])], available);
  check("1.3 fato citando evidência AUSENTE → unsupported (RN-GND-2, não inventa)", g3.status === "unsupported");
  const g4 = M.checkGrounding([claim("Talvez a promoção ajude", "hypothesis"), claim("Recomendo baixar preço", "recommendation")], available);
  check("1.4 hipótese/recomendação isentas → skipped (§20)", g4.status === "skipped" && g4.checkedClaims === 0);
  // casa por sourceId mesmo com field diferente.
  const g5 = M.checkGrounding([claim("x", "fact", [ev("INTERNAL_DB", "sale:1", "outro_campo")])], available);
  check("1.5 casa por (sourceType,sourceId) mesmo com field diferente", g5.status === "grounded");
  // estimativa também exige evidência.
  const g6 = M.checkGrounding([claim("Estimo ~30 vendas", "estimate", [])], available);
  check("1.6 estimativa também precisa citar (unsupported sem evidência)", g6.status === "unsupported");

  // evidenceFromPacket.
  const packet = { facts: [{ evidence: [ev("INTERNAL_DB", "sale:1", "revenue")] }, { evidence: [ev("INTERNAL_DB", "cust:2", "debt")] }] };
  check("1.7 evidenceFromPacket coleta a evidência dos fatos", G.evidenceFromPacket(packet as any).length === 2);
  check("1.8 gate via serviço bate com a primitiva pura", G.check([claim("x", "fact", [ev("INTERNAL_DB", "cust:2", "debt")])], G.evidenceFromPacket(packet as any)).status === "grounded");

  // ═══════════════ 2. confidence engine (§21) ═══════════════
  check("2.1 alta → continue", C.assess(0.9).action === "continue" && C.assess(0.9).band === "very_high");
  check("2.2 média → seek_context", C.assess(0.6).action === "seek_context");
  check("2.3 baixa → fallback", C.assess(0.2).action === "fallback");
  check("2.4 grounding unsupported DERRUBA confiança → fallback (RN-CONF-2)", C.assess(0.95, { grounding: "unsupported" }).action === "fallback");
  check("2.5 grounding grounded não penaliza", C.assess(0.95, { grounding: "grounded" }).action === "continue");
  check("2.6 thresholds configuráveis (RN-CONF-4)", C.assess(0.6, { thresholds: { low: 0.5, high: 0.55 } }).action === "continue");

  // fromSignal compõe sobre ImpactPrioritizationService.
  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const sig = SIG.publish(org, { domain: "sales", signalType: "s", severity: "risk", basis: "fact", confidence: 0.9, subjectType: "customer", subjectId: "c1", sourceService: "t", evidence: {}, dedupeKey: "d1" });
  const fromSig = C.fromSignal(org, sig.id);
  check("2.7 fromSignal compõe sobre scoreOne (confiança derivada)", fromSig !== null && typeof fromSig!.score === "number" && !!fromSig!.action);
  check("2.8 fromSignal de sinal inexistente → null (não inventa)", C.fromSignal(org, "nope") === null);

  // ═══════════════ 3. KERNEL integra grounding (F4+F6) ═══════════════
  // sem `ground` → groundingStatus skipped (comportamento F4 inalterado).
  const noGround = await K.run(org, { skillId: "sg1" }, async () => ({ output: {}, usage: {} }));
  check("3.1 sem ground → groundingStatus skipped (F4 inalterado)", noGround.reliability.groundingStatus === "skipped");
  // grounded → status real.
  const grounded = await K.run(org, { skillId: "sg2", ground: { claims: [claim("ok", "fact", [ev("INTERNAL_DB", "sale:1")])], evidence: [ev("INTERNAL_DB", "sale:1")] } },
    async () => ({ output: {}, usage: {} }));
  check("3.2 grounded gravado na AI Run", grounded.reliability.groundingStatus === "grounded" && K.getRun(org, grounded.runId).grounding_status === "grounded");
  // unsupported sem block → ok mas grounding unsupported.
  const unsup = await K.run(org, { skillId: "sg3", ground: { claims: [claim("inventado", "fact", [])], evidence: [ev("INTERNAL_DB", "sale:1")] } },
    async () => ({ output: {}, usage: {} }));
  check("3.3 unsupported sem block → status ok, grounding unsupported", unsup.reliability.status === "ok" && unsup.reliability.groundingStatus === "unsupported");
  // unsupported COM block → fallback + failure grounding (AI-FAIL-3).
  const blocked = await K.run(org, { skillId: "sg4", ground: { claims: [claim("inventado", "fact", [])], evidence: [ev("INTERNAL_DB", "sale:1")], blockOnUnsupported: true } },
    async () => ({ output: {}, usage: {} }));
  check("3.4 unsupported + block → fallback + failureClass grounding", blocked.reliability.status === "fallback" && blocked.reliability.failureClass === "grounding" && blocked.reliability.groundingStatus === "unsupported");
  check("3.5 AI Run do bloqueio gravada", K.getRun(org, blocked.runId).grounding_status === "unsupported" && K.getRun(org, blocked.runId).run_status === "fallback");

  console.log("\n=== TEST: SkillOS Grounding + Confidence (PRD 4 F6) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ SkillOS Grounding + Confidence (F6) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
