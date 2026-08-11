/**
 * TEST — PRD 2 F12.2 (§84, CA17): teto DIÁRIO de investigação profunda (LLM) por
 * DETECTOR. Um detector barulhento (storm) não pode drenar a verba de IA da org.
 * Conta por query sobre `ai_usage_log` (marcador leve) — sem tabela nova (CA1),
 * sem contador mutável (RN-004).
 *
 * Prova (determinístico, sem IA real — sintetizador injetado):
 *   - capFor: default embutido sem override; override por org quando >0;
 *   - consume incrementa; usedToday/check derivam o saldo; allowed flipa no teto;
 *   - janela do dia: marcador de ontem NÃO conta;
 *   - budget por detector é INDEPENDENTE (um esgotado não trava o outro);
 *   - investigateDeep: esgotado → aiGate 'budget_exhausted', sintetizador NÃO
 *     chamado; só consome quando a síntese de fato roda (ai_unavailable não gasta);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:detector-budget
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-detector-budget-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-detector-budget-1234567890";
delete process.env.OPENAI_API_KEY; // garante que o caminho default não chame IA

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { DetectorBudgetService: DB, DEFAULT_DAILY_CAP } = await import("../src/server/DetectorBudgetService.js");
  const { SignalInvestigationService: INV } = await import("../src/server/SignalInvestigationService.js");

  const mkOrg = (budget = 0) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, radar_detector_daily_budget) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, budget); return id; };

  // ===== 1. capFor =====
  const orgDef = mkOrg(0);
  const orgOv = mkOrg(3);
  check("1.1 sem override → default embutido", DB.capFor(orgDef) === DEFAULT_DAILY_CAP);
  check("1.2 override por org (>0) vale", DB.capFor(orgOv) === 3);

  // ===== 2. consume / usedToday / check =====
  const org = mkOrg(2);
  check("2.1 zero consumo → allowed, remaining = cap", (() => { const c = DB.check(org, "DetA"); return c.used === 0 && c.remaining === 2 && c.allowed === true; })());
  DB.consume(org, "DetA");
  check("2.2 após 1 consumo → used 1, remaining 1, ainda allowed", (() => { const c = DB.check(org, "DetA"); return c.used === 1 && c.remaining === 1 && c.allowed === true; })());
  DB.consume(org, "DetA");
  check("2.3 no teto → remaining 0, allowed false", (() => { const c = DB.check(org, "DetA"); return c.used === 2 && c.remaining === 0 && c.allowed === false; })());

  // ===== 3. Independência entre detectores =====
  check("3.1 outro detector tem saldo próprio", (() => { const c = DB.check(org, "DetB"); return c.used === 0 && c.allowed === true; })());

  // ===== 4. Janela do dia — marcador de ontem não conta =====
  const orgDay = mkOrg(5);
  DB.consume(orgDay, "DetOld");
  db.prepare(`UPDATE ai_usage_log SET created_at = datetime('now','-2 days') WHERE organization_id = ? AND kind = 'radar_investigation:DetOld'`).run(orgDay);
  check("4.1 consumo de 2 dias atrás não conta hoje", DB.usedToday(orgDay, "DetOld") === 0);

  // ===== 5. overview =====
  const ovw = DB.overview(org);
  check("5.1 overview lista o detector no teto", ovw.cap === 2 && ovw.detectors.some((d: any) => d.detector === "DetA" && d.used === 2 && d.allowed === false));

  // ===== 6. Integração com investigateDeep =====
  const orgInv = mkOrg(2);
  // Sinal com causas-candidatas (stockout_risk tem template) e detector fixo.
  const sig = BS.publish(orgInv, { domain: "inventory", signalType: "stockout_risk", severity: "risk", basis: "estimate", confidence: 0.7, sourceService: "StormDetector", impactAmount: 500, impactUnit: "BRL", evidence: {}, dedupeKey: "inv1" });
  let synthCalls = 0;
  const synthesize = async () => { synthCalls++; return "explicação sintetizada"; };
  const r1 = await INV.investigateDeep(orgInv, sig.id, { force: true, synthesize });
  const r2 = await INV.investigateDeep(orgInv, sig.id, { force: true, synthesize });
  check("6.1 as 2 primeiras rodam a IA e consomem (synthesized)", r1.aiGate === "synthesized" && r2.aiGate === "synthesized" && synthCalls === 2);
  const r3 = await INV.investigateDeep(orgInv, sig.id, { force: true, synthesize });
  check("6.2 3ª: teto estourado → budget_exhausted, sintetizador NÃO chamado", r3.aiGate === "budget_exhausted" && r3.aiUsed === false && synthCalls === 2);
  check("6.3 ainda entrega o determinístico (causas presentes)", Array.isArray(r3.candidateCauses) && r3.candidateCauses.length > 0);

  // ===== 7. ai_unavailable NÃO consome =====
  const orgNull = mkOrg(3);
  const sig2 = BS.publish(orgNull, { domain: "inventory", signalType: "stockout_risk", severity: "risk", basis: "estimate", confidence: 0.7, sourceService: "DetNull", evidence: {}, dedupeKey: "inv2" });
  const rn = await INV.investigateDeep(orgNull, sig2.id, { force: true, synthesize: async () => null });
  check("7.1 síntese null → ai_unavailable e NÃO consome budget", rn.aiGate === "ai_unavailable" && DB.usedToday(orgNull, "DetNull") === 0);

  // ===== 8. Isolamento =====
  const orgB = mkOrg(2);
  check("8.1 org B não vê consumo da org A", DB.usedToday(orgB, "DetA") === 0 && DB.overview(orgB).detectors.length === 0);

  console.log("\n=== TEST: Detector Budget F12.2 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Detector Budget F12.2 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
