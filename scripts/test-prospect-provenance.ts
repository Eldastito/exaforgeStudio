/**
 * TEST — F4 (GAP-CLOSURE-03): procedência do Prospect alinhada ao vocabulário canônico
 * do PRD 9. Prova o mapa determinístico provider→procedência (fonte única), a derivação
 * de `retrievedAt` (só em `live`), a persistência nos data sources, a honestidade dura
 * (dado declarado → null, nunca `live` fabricado), legado nulo e isolamento multi-tenant.
 *
 * Uso: npm run test:prospect-provenance
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-prov-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-prov-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { provenanceForProvider, describeSourceProvenance } = await import("../src/server/prospectProvenance.js");
  const { ProspectService } = await import("../src/server/ProspectService.js");

  // ── 1. Mapa puro provider→procedência ──
  check("1.1 rfb_open_data → live/A (registro oficial)", (() => { const p = provenanceForProvider("rfb_open_data"); return p.evidenceMode === "live" && p.tier === "A"; })());
  check("1.2 osm_overpass → live/B (recuperado verificável)", (() => { const p = provenanceForProvider("osm_overpass"); return p.evidenceMode === "live" && p.tier === "B"; })());
  check("1.3 google_places → live/B", (() => { const p = provenanceForProvider("google_places"); return p.evidenceMode === "live" && p.tier === "B"; })());
  check("1.4 csv_import → null/null (declarado, não é recuperação viva)", (() => { const p = provenanceForProvider("csv_import"); return p.evidenceMode === null && p.tier === null; })());
  check("1.5 user_input → null/null", (() => { const p = provenanceForProvider("user_input"); return p.evidenceMode === null && p.tier === null; })());
  check("1.6 provider desconhecido → null/null (nunca inventa modo)", (() => { const p = provenanceForProvider("qualquer_coisa"); return p.evidenceMode === null && p.tier === null; })());
  check("1.7 provider vazio/undefined → null/null", (() => { const p = provenanceForProvider(undefined as any); return p.evidenceMode === null && p.tier === null; })());

  // ── 2. describeSourceProvenance: retrievedAt derivado só em live ──
  check("2.1 live → retrievedAt = collected_at", (() => { const d = describeSourceProvenance({ evidence_mode: "live", source_tier: "B", collected_at: "2026-09-11 10:00:00" }); return d.evidenceMode === "live" && d.tier === "B" && d.retrievedAt === "2026-09-11 10:00:00"; })());
  check("2.2 origem declarada (null) → retrievedAt null", (() => { const d = describeSourceProvenance({ evidence_mode: null, source_tier: null, collected_at: "2026-09-11 10:00:00" }); return d.evidenceMode === null && d.tier === null && d.retrievedAt === null; })());
  check("2.3 legado sem colunas → tudo null (honesto)", (() => { const d = describeSourceProvenance({ collected_at: "2026-09-11 10:00:00" }); return d.evidenceMode === null && d.tier === null && d.retrievedAt === null; })());
  check("2.4 valor inválido em evidence_mode → null (não confia em lixo)", (() => { const d = describeSourceProvenance({ evidence_mode: "banana" as any, source_tier: "Z" as any, collected_at: "x" }); return d.evidenceMode === null && d.tier === null; })());

  // ── 3. Persistência real via importRecords (site de INSERT genérico) ──
  const orgA = "org-A";
  const csv = ProspectService.importRecords(orgA, { sourceRef: "lote csv", records: [{ company: "ACME", domain: "acme.com" }] });
  const csvProv = ProspectService.sourceProvenance(orgA, csv.sourceId);
  check("3.1 import CSV (default) persiste procedência null (declarado)", !!csvProv && csvProv.evidenceMode === null && csvProv.tier === null && csvProv.retrievedAt === null);

  const live = ProspectService.importRecords(orgA, { provider: "google_places", sourceRef: "área X", records: [{ company: "Loja Y" }] });
  const liveProv = ProspectService.sourceProvenance(orgA, live.sourceId);
  check("3.2 import provider live persiste live/B + retrievedAt derivado", !!liveProv && liveProv.evidenceMode === "live" && liveProv.tier === "B" && !!liveProv.retrievedAt);

  const rfb = ProspectService.importRecords(orgA, { provider: "rfb_open_data", sourceRef: "rfb", records: [{ company: "Empresa Z", cnpj: "12345678000199" }] });
  const rfbProv = ProspectService.sourceProvenance(orgA, rfb.sourceId);
  check("3.3 import rfb_open_data persiste live/A", !!rfbProv && rfbProv.evidenceMode === "live" && rfbProv.tier === "A");

  // ── 4. listDataSources devolve a procedência derivada ──
  const listed = ProspectService.listDataSources(orgA);
  check("4.1 listDataSources traz as 3 fontes com bloco provenance", listed.length === 3 && listed.every((s: any) => "provenance" in s));
  check("4.2 a fonte csv aparece com provenance.evidenceMode null", (() => { const s = listed.find((x: any) => x.id === csv.sourceId); return s && s.provenance.evidenceMode === null; })());

  // ── 5. Legado: linha antiga sem colunas → null (0-regressão) ──
  db.prepare("INSERT INTO prospect_data_sources (id, organization_id, provider, source_reference, terms_profile, retention_policy, confidence) VALUES ('legacy-1', ?, 'osm_overpass', 'antiga', 'public', 'tenant_policy', 0.6)").run(orgA);
  const legacy = ProspectService.sourceProvenance(orgA, "legacy-1");
  check("5.1 linha legada (sem evidence_mode gravado) → provenance null honesto", !!legacy && legacy.evidenceMode === null && legacy.tier === null && legacy.retrievedAt === null);

  // ── 6. Isolamento multi-tenant ──
  const orgB = "org-B";
  check("6.1 fonte de outra org não vaza", ProspectService.sourceProvenance(orgB, csv.sourceId) === null);
  check("6.2 listDataSources de org vazia é []", ProspectService.listDataSources(orgB).length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} prospect-provenance: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
