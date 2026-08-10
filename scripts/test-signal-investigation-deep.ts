/**
 * TEST — PRD 2 F6.2 (§81-83): gate de LLM na investigação. Sobre as causas-
 * candidatas determinísticas (F6.1), o LLM SINTETIZA — mas só quando o nível de
 * impacto justifica (L3+, reusa a DI-1) e a IA está disponível. IA nunca é o
 * loop principal; sintetizador INJETÁVEL (roda em CI sem chave).
 *
 * Uso: npm run test:signal-investigation-deep
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-invest-deep-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-invest-deep-1234567890";
delete process.env.OPENAI_API_KEY; // garante IA NÃO configurada (CI-safe)

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { SignalInvestigationService: INV } = await import("../src/server/SignalInvestigationService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const org = mkOrg();
  const pub = (over: any) => BS.publish(org, { basis: "fact", confidence: 0.9, sourceService: "test", evidence: {}, ...over });

  // Sinal ALTO impacto (critical → L3) com apoio; e um BAIXO (info → L0).
  const hi = pub({ domain: "sales", signalType: "conversion_drop", severity: "critical", dedupeKey: "hi", subjectType: "product", subjectId: "sku-HI" });
  pub({ domain: "sales", signalType: "response_delay", severity: "attention", dedupeKey: "hi-resp", subjectType: "product", subjectId: "sku-HI" });
  const lo = pub({ domain: "sales", signalType: "conversion_drop", severity: "info", dedupeKey: "lo", subjectType: "product", subjectId: "sku-LO" });
  pub({ domain: "sales", signalType: "response_delay", severity: "info", dedupeKey: "lo-resp", subjectType: "product", subjectId: "sku-LO" });

  // Sintetizador injetado: conta chamadas + registra o payload recebido.
  let calls = 0; let seen: any = null;
  const fakeSynth = async (payload: any) => { calls++; seen = payload; return "Explicação IA: a causa mais provável é a demora no follow-up."; };

  // ===== 1. Alto impacto → gate abre, LLM sintetiza =====
  const r1 = await INV.investigateDeep(org, hi.id, { synthesize: fakeSynth });
  check("1.1 L3 abre o gate → aiUsed + aiGate synthesized", r1.aiUsed === true && r1.aiGate === "synthesized" && r1.impactLevel === "L3");
  check("1.2 síntese preenchida pelo sintetizador", /follow-up/i.test(r1.synthesis || ""));
  check("1.3 o LLM recebeu as causas-candidatas determinísticas", calls === 1 && Array.isArray(seen.candidateCauses) && seen.candidateCauses.some((c: any) => /follow-up/i.test(c.cause)));
  check("1.4 base determinística preservada (candidateCauses + basis hypothesis)", r1.candidateCauses.length > 0 && r1.candidateCauses.every((c: any) => c.basis === "hypothesis"));

  // ===== 2. Baixo impacto → gate NÃO abre (LLM nem é chamado) =====
  calls = 0;
  const r2 = await INV.investigateDeep(org, lo.id, { synthesize: fakeSynth });
  check("2.1 L0 → below_threshold, sem síntese, LLM não chamado", r2.aiGate === "below_threshold" && r2.synthesis == null && r2.aiUsed === false && calls === 0);
  check("2.2 mesmo baixo, o determinístico segue completo", r2.candidateCauses.length > 0);

  // ===== 3. force ignora o gate =====
  calls = 0;
  const r3 = await INV.investigateDeep(org, lo.id, { synthesize: fakeSynth, force: true });
  check("3.1 force → sintetiza mesmo em L0", r3.aiUsed === true && calls === 1);

  // ===== 4. Sem sintetizador + IA não configurada (default) → só determinístico =====
  const r4 = await INV.investigateDeep(org, hi.id);
  check("4.1 default sem chave → ai_unavailable, aiUsed false, síntese null", r4.aiUsed === false && r4.aiGate === "ai_unavailable" && r4.synthesis == null);
  check("4.2 mas as causas-candidatas continuam lá (IA não é o loop principal)", r4.candidateCauses.length > 0);

  // ===== 5. Not found =====
  const r5 = await INV.investigateDeep(org, "inexistente");
  check("5.1 sinal inexistente → found false, aiGate not_found", r5.found === false && r5.aiGate === "not_found");

  console.log("\n=== TEST: Investigation LLM gate F6.2 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Investigation LLM gate F6.2 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
