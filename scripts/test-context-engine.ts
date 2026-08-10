/**
 * TEST — ADR-160 F3 (Onda A / D3): Context Engine — contrato único de contexto.
 *
 * Prova, determinístico:
 *   - build() funde NARRATIVA (BusinessContextService) + SNAPSHOT V2 num contrato
 *     só, com proveniência (sources) e schemaVersion;
 *   - flag `diretor_snapshot_v2` OFF (default): snapshot=null, snapshotEnabled=false,
 *     render() == narrativa pura (0 regressão vs. comportamento antigo);
 *   - flag ON: snapshot presente (forma do build/read V2), render() ANEXA o bloco
 *     "PANORAMA EMPRESARIAL V2" byte-a-byte como o Advisor colava antes;
 *   - render() é o TEXTO que buildPanorama consome — equivalência preservada;
 *   - sources distingue cache vs fresco (herdado do _cache da F2);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:context-engine
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ctx-engine-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ctx-engine-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ContextEngineService: CTX } = await import("../src/server/ContextEngineService.js");
  const { BusinessContextService: BCS } = await import("../src/server/BusinessContextService.js");
  const { BusinessSnapshotV2Service: SNAP } = await import("../src/server/BusinessSnapshotV2Service.js");

  const mkOrg = (v2: boolean, evidence = false) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, diretor_snapshot_v2, evidence_layer_enabled) VALUES (?, ?, 'X', 'active', ?, ?)`).run(randomUUID(), id, v2 ? 1 : 0, evidence ? 1 : 0);
    return id;
  };

  // Reconstrói o bloco V2 EXATAMENTE como o Advisor colava antes (prova de
  // equivalência byte-a-byte da convergência).
  const expectedV2Block = (snap: any) => `\n\n=== PANORAMA EMPRESARIAL V2 (determinístico, por domínio) ===
Use EXATAMENTE estes números (finanças, vendas, estoque, compras, operação, tarefas). NUNCA invente valores; se um campo faltar ou vier available:false, diga explicitamente que o dado não está disponível.
DOMÍNIOS: ${JSON.stringify(snap.domains || {})}
PRIORIDADES: ${JSON.stringify(snap.topPriorities || [])}
QUALIDADE DOS DADOS: ${JSON.stringify(snap.dataQuality || {})}`;

  // ===== 1. Flag OFF → narrativa pura, sem snapshot =====
  const orgOff = mkOrg(false);
  const cOff = CTX.build(orgOff);
  check("OFF: narrative == BusinessContextService.build (mesma fonte)", cOff.narrative === BCS.build(orgOff));
  check("OFF: snapshot=null, snapshotEnabled=false", cOff.snapshot === null && cOff.snapshotEnabled === false);
  check("OFF: sources = ['business_context'] só", JSON.stringify(cOff.sources) === JSON.stringify(["business_context"]));
  check("OFF: schemaVersion + generatedAt presentes", cOff.schemaVersion === 1 && typeof cOff.generatedAt === "string" && cOff.generatedAt.length > 0);
  check("OFF: render() == narrativa pura (sem bloco V2 — 0 regressão)", CTX.render(orgOff) === BCS.build(orgOff));

  // ===== 2. Flag ON → contrato unificado (narrativa + snapshot) =====
  const orgOn = mkOrg(true);
  const cOn = CTX.build(orgOn);
  check("ON: snapshotEnabled=true + snapshot presente", cOn.snapshotEnabled === true && !!cOn.snapshot);
  check("ON: snapshot tem a forma do V2 (domains/topPriorities/dataQuality)", !!cOn.snapshot.domains && Array.isArray(cOn.snapshot.topPriorities) && ("dataQuality" in cOn.snapshot));
  check("ON: narrativa preservada junto do snapshot", cOn.narrative === BCS.build(orgOn));
  check("ON: sources inclui a proveniência do snapshot", cOn.sources.includes("business_context") && cOn.sources.some((s: string) => s.startsWith("snapshot_v2")));

  // ===== 3. render() ON == narrativa + bloco V2 byte-a-byte (equivalência) =====
  const snapForBlock = SNAP.read(orgOn);
  const expected = BCS.build(orgOn) + expectedV2Block(snapForBlock);
  check("ON: render() == narrativa + bloco V2 (equivalente à colagem antiga do Advisor)", CTX.render(orgOn) === expected);
  check("ON: render() contém o rótulo do PANORAMA V2", CTX.render(orgOn).includes("PANORAMA EMPRESARIAL V2 (determinístico, por domínio)"));

  // ===== 4. Evidence Layer ligado → snapshot vem do cache (source cache) =====
  const orgCache = mkOrg(true, true);
  CTX.build(orgCache);                 // 1ª: MISS (persiste)
  const cCache = CTX.build(orgCache);  // 2ª: HIT
  check("cache: 2ª build marca source snapshot_v2_cache", cCache.sources.includes("snapshot_v2_cache"));

  // ===== 5. Isolamento =====
  const cIsoOff = CTX.build(orgOff);
  check("isolamento: org OFF continua sem snapshot mesmo após orgs ON existirem", cIsoOff.snapshot === null && cIsoOff.snapshotEnabled === false);
  check("isolamento: narrativa de org distinta não vaza (build por orgId)", CTX.build(orgOn).narrative !== "" && CTX.build(orgOff).narrative === BCS.build(orgOff));

  console.log("\n=== TEST: Context Engine — contrato único (ADR-160 F3) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Context Engine (F3) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
