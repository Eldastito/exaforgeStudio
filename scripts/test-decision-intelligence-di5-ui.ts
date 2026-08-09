/**
 * TEST — Decision Intelligence DI-5.5 (ADR-157): contrato de dados da UI de
 * automação. Valida o que as rotas master enriquecem/servem para o
 * NicheIntelligenceView: flag `automated` (isAutomated) e a TENDÊNCIA (delta da
 * última versão) que a UI mostra em cada pesquisa publicada. Offline, sem IA.
 *
 * Uso: npm run test:decision-intelligence-di5-ui
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-di5ui-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-di5ui-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { VerticalIntelligenceService: VIS, researchFingerprint } = await import("../src/server/VerticalIntelligenceService.js");
  const { VerticalIntelligenceResearchService: Research } = await import("../src/server/VerticalIntelligenceResearchService.js");

  const fp = researchFingerprint("moda", "inverno");

  // ===================== flag `automated` (isAutomated) =====================
  check("isAutomated=false sem agenda", Research.isAutomated(fp) === false);
  Research.upsert({ vertical: "moda", topic: "inverno", intervalDays: 5 });
  check("isAutomated=true após registrar (enabled)", Research.isAutomated(fp) === true);
  Research.setNicheEnabled(fp, false);
  check("isAutomated=false quando pausado", Research.isAutomated(fp) === false);
  Research.setNicheEnabled(fp, true);

  // ===================== tendência (delta) que a UI mostra =====================
  VIS.runManual({ userId: "admin" }, { vertical: "moda", topic: "inverno", summary: "V1.", drivers: ["a", "b"], confidence: 0.5 });
  const d1 = VIS.latestDelta(fp);
  check("1ª versão: delta isFirst (a UI não mostra tendência)", d1?.isFirst === true);

  VIS.runManual({ userId: "admin" }, { vertical: "moda", topic: "inverno", summary: "V2.", drivers: ["b", "c"], confidence: 0.7 });
  const d2 = VIS.latestDelta(fp);
  check("2ª versão: delta com tendência (isFirst=false)", d2?.isFirst === false);
  check("tendência tem 'novo' (c) e 'saiu' (a)", d2.new.includes("c") && d2.gone.includes("a"));
  check("tendência tem 'cresceu' (b subiu no ranking)", d2.grew.includes("b"));

  // ===================== enriquecimento da lista (como a rota monta) =====================
  const enriched = VIS.list({ vertical: "moda" }).map((it: any) => ({ ...it, delta: VIS.latestDelta(it.fingerprint), automated: Research.isAutomated(it.fingerprint) }));
  const row = enriched.find((r: any) => r.fingerprint === fp);
  check("item enriquecido carrega delta + automated", !!row && !!row.delta && row.automated === true);
  check("history() devolve as 2 versões pra UI", VIS.history(fp).length === 2);

  console.log("\n=== TEST: Decision Intelligence DI-5.5 (contrato da UI de automação) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision Intelligence DI-5.5 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
