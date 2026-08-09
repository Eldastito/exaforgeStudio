/**
 * TEST — Decision Intelligence DI-5.2 (ADR-157): base longitudinal + motor de delta.
 *
 * A `vertical_intelligence` guarda só a "cabeça" (versão fresca); o histórico
 * `vertical_intelligence_history` versiona cada publicação por fingerprint e
 * grava o `delta` (novo/saiu/cresceu/retraiu + tendência de confiança). O
 * motor de delta (ResearchCuratorService.computeDelta) é DETERMINÍSTICO — usa a
 * POSIÇÃO do driver no ranking como magnitude de "cresceu/retraiu".
 *
 * Tudo offline, sem chave de IA. Uso: npm run test:decision-intelligence-di5-history
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-di5h-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-di5h-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const eqSet = (a: string[], b: string[]) => Array.isArray(a) && a.length === b.length && b.every((x) => a.includes(x));

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { VerticalIntelligenceService: VIS, researchFingerprint } = await import("../src/server/VerticalIntelligenceService.js");
  const { ResearchCuratorService: Curator } = await import("../src/server/ResearchCuratorService.js");
  const { containsPII } = await import("../src/server/researchAnonymize.js");

  // ===================== Motor de delta (função pura) =====================
  const first = Curator.computeDelta(null, { drivers: ["a", "b"], confidence: 0.5 });
  check("delta 1ª versão: isFirst + tudo novo", first.isFirst === true && eqSet(first.new, ["a", "b"]) && first.gone.length === 0);

  // b sobe (1→0 = cresceu), a desce (0→1 = retraiu), c é novo, e some.
  const d = Curator.computeDelta(
    { drivers: ["a", "b", "e"], confidence: 0.5 },
    { drivers: ["b", "a", "c"], confidence: 0.8 },
  );
  check("delta: driver que subiu no ranking = cresceu", eqSet(d.grew, ["b"]));
  check("delta: driver que desceu no ranking = retraiu", eqSet(d.shrank, ["a"]));
  check("delta: driver inédito = novo", eqSet(d.new, ["c"]));
  check("delta: driver que sumiu = saiu", eqSet(d.gone, ["e"]));
  check("delta: tendência de confiança (0.5→0.8 = +0.3)", d.confidenceDelta === 0.3);
  check("delta: isMaterial quando há mudança", Curator.isMaterial(d) === true);
  check("delta: NÃO material quando nada muda", Curator.isMaterial(Curator.computeDelta({ drivers: ["a"], confidence: 0.5 }, { drivers: ["a"], confidence: 0.5 })) === false);

  // determinismo: mesmo input → mesmo output (ordem estável)
  const d2 = Curator.computeDelta({ drivers: ["a", "b", "e"], confidence: 0.5 }, { drivers: ["b", "a", "c"], confidence: 0.8 });
  check("delta é determinístico (mesmo input → mesmo output)", JSON.stringify(d) === JSON.stringify(d2));

  // ===================== Versionamento no persistShared =====================
  const fp = researchFingerprint("moda", "inverno", "brasil");
  VIS.runManual({ userId: "admin1" }, { vertical: "moda", topic: "inverno", region: "brasil", summary: "Inverno aquecido.", drivers: ["frio antecipado", "retomada"], confidence: 0.6 });
  let hist = VIS.history(fp);
  check("publicar cria versão 1 no histórico", hist.length === 1 && hist[0].version === 1);
  check("versão 1: delta isFirst (tudo novo)", hist[0].delta?.isFirst === true && eqSet(hist[0].delta.new, ["frio antecipado", "retomada"]));

  // 2ª publicação do MESMO nicho: "retomada" sobe, "alfaiataria" novo, "frio antecipado" some
  VIS.runManual({ userId: "admin1" }, { vertical: "moda", topic: "inverno", region: "brasil", summary: "Alfaiataria em alta.", drivers: ["retomada", "alfaiataria"], confidence: 0.75 });
  hist = VIS.history(fp);
  check("republicar cria versão 2 (histórico cresce, não sobrescreve)", hist.length === 2 && hist[0].version === 2);
  const lastDelta = VIS.latestDelta(fp);
  check("delta v2: 'alfaiataria' novo, 'frio antecipado' saiu", eqSet(lastDelta.new, ["alfaiataria"]) && eqSet(lastDelta.gone, ["frio antecipado"]));
  check("delta v2: 'retomada' cresceu (subiu de índice 1→0)", eqSet(lastDelta.grew, ["retomada"]));
  check("delta v2: confiança subiu (+0.15)", lastDelta.confidenceDelta === 0.15);

  // head continua sendo só a versão fresca (1 linha por fingerprint)
  const headCount = (db.prepare("SELECT COUNT(*) c FROM vertical_intelligence WHERE fingerprint = ?").get(fp) as any).c;
  check("head (vertical_intelligence) segue com 1 linha (não duplica)", headCount === 1);

  // ===================== Isolamento/anonimização do histórico =====================
  VIS.runManual({ userId: "admin1" }, { vertical: "food", topic: "pii", summary: "Contato joao@acme.com CPF 123.456.789-00." });
  const fpPii = researchFingerprint("food", "pii");
  const histPii = VIS.history(fpPii);
  check("histórico anonimiza PII do conteúdo", histPii.length === 1 && !containsPII(JSON.stringify(histPii[0].content)));
  const rawHist = db.prepare("SELECT * FROM vertical_intelligence_history LIMIT 1").get() as any;
  check("histórico compartilhado NÃO tem organization_id", !!rawHist && !("organization_id" in rawHist));

  console.log("\n=== TEST: Decision Intelligence DI-5.2 (base longitudinal + delta) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision Intelligence DI-5.2 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
