/**
 * TEST — Radar B2B, overlay de fibra (Fatia 3). Valida:
 *  1. kmlToGeoJson: Point/LineString/Polygon/MultiGeometry, ordem lon,lat,
 *     altitude descartada, anel de polígono fechado, name/description/cor,
 *     namespaces (kml:) e Placemark aninhado em Folder.
 *  2. parseGeoJsonText: passthrough de FeatureCollection/Feature/Geometry.
 *  3. bboxOf.
 *  4. RadarFiberService: KML em disco, GeoJSON em disco, "não instalado" e
 *     arquivo inválido (erro sem estourar).
 * Uso: npm run test:radar-b2b-fiber
 */
import os from "os";
import path from "path";
import fs from "fs";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fibra-"));

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Rede Fibra Demo</name>
    <Style id="backbone"><LineStyle><color>ff0000ff</color></LineStyle></Style>
    <Folder>
      <name>Backbone</name>
      <Placemark>
        <name>Trecho Centro</name>
        <description>Cabo tronco</description>
        <styleUrl>#backbone</styleUrl>
        <LineString><coordinates>
          -43.1800,-22.9700,0 -43.1850,-22.9750,0 -43.1900,-22.9800,0
        </coordinates></LineString>
      </Placemark>
    </Folder>
    <Placemark>
      <name>POP Barra</name>
      <Point><coordinates>-43.3600,-23.0000,12</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Cobertura A</name>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>
        -43.20,-22.90 -43.19,-22.90 -43.19,-22.91 -43.20,-22.91
      </coordinates></LinearRing></outerBoundaryIs></Polygon>
    </Placemark>
    <Placemark>
      <name>Anel</name>
      <MultiGeometry>
        <LineString><coordinates>-43.10,-22.80 -43.11,-22.81</coordinates></LineString>
        <LineString><coordinates>-43.12,-22.82 -43.13,-22.83</coordinates></LineString>
      </MultiGeometry>
    </Placemark>
  </Document>
</kml>`;

const KML_NS = `<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2"><kml:Document><kml:Placemark><kml:name>NS</kml:name><kml:LineString><kml:coordinates>-43.1,-22.9 -43.2,-22.95</kml:coordinates></kml:LineString></kml:Placemark></kml:Document></kml:kml>`;

async function main() {
  const { kmlToGeoJson, parseGeoJsonText, bboxOf } = await import("../src/server/kmlToGeoJson.js");

  // 1. Parser KML.
  const fc = kmlToGeoJson(KML);
  check("1.1 4 features (line+point+polygon+multi)", fc.features.length === 4);

  const line = fc.features.find((f: any) => f.geometry?.type === "LineString") as any;
  check("1.2 LineString com 3 vértices", line?.geometry.coordinates.length === 3);
  check("1.3 ordem lon,lat preservada", line?.geometry.coordinates[0][0] === -43.18 && line?.geometry.coordinates[0][1] === -22.97);
  check("1.4 name + description no properties", line?.properties.name === "Trecho Centro" && line?.properties.description === "Cabo tronco");
  check("1.5 cor resolvida do styleUrl (aabbggrr→#rrggbb)", line?.properties.color === "#ff0000");

  const point = fc.features.find((f: any) => f.geometry?.type === "Point") as any;
  check("1.6 Point [lon,lat] com altitude descartada", Array.isArray(point?.geometry.coordinates) && point.geometry.coordinates.length === 2 && point.geometry.coordinates[0] === -43.36);

  const poly = fc.features.find((f: any) => f.geometry?.type === "Polygon") as any;
  const ring = poly?.geometry.coordinates[0];
  check("1.7 Polygon com anel fechado (1º == último)", ring?.length === 5 && ring[0][0] === ring[4][0] && ring[0][1] === ring[4][1]);

  const multi = fc.features.find((f: any) => f.geometry?.type === "MultiLineString") as any;
  check("1.8 MultiGeometry homogêneo vira MultiLineString", !!multi && multi.geometry.coordinates.length === 2);

  // Namespaces + Placemark fora de Folder direto.
  const fcNs = kmlToGeoJson(KML_NS);
  check("1.9 namespace kml: é ignorado (1 feature)", fcNs.features.length === 1 && fcNs.features[0].geometry?.type === "LineString");

  // 2. GeoJSON passthrough.
  const passFC = parseGeoJsonText(JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-43, -22] }, properties: {} }] }));
  check("2.1 FeatureCollection passa direto", passFC.features.length === 1);
  const passFeat = parseGeoJsonText(JSON.stringify({ type: "Feature", geometry: { type: "Point", coordinates: [-43, -22] }, properties: {} }));
  check("2.2 Feature solto vira FeatureCollection", passFeat.type === "FeatureCollection" && passFeat.features.length === 1);
  const passGeom = parseGeoJsonText(JSON.stringify({ type: "LineString", coordinates: [[-43, -22], [-43.1, -22.1]] }));
  check("2.3 Geometry solta vira FeatureCollection", passGeom.features.length === 1 && passGeom.features[0].geometry?.type === "LineString");
  let threw = false;
  try { parseGeoJsonText("{ not json"); } catch { threw = true; }
  check("2.4 JSON inválido lança erro claro", threw);

  // 3. bbox.
  const bbox = bboxOf(fc);
  check("3.1 bbox cobre todos os pontos", !!bbox && bbox[0] <= -43.36 && bbox[2] >= -43.1 && bbox[1] <= -23.0 && bbox[3] >= -22.8);

  // 4. Service.
  const kmlPath = path.join(tmpDir, "radar_fibra.kml");
  fs.writeFileSync(kmlPath, KML);
  process.env.RADAR_FIBER_PATH = kmlPath;
  const { RadarFiberService } = await import("../src/server/RadarFiberService.js");
  RadarFiberService.reload();
  const st = RadarFiberService.status();
  check("4.1 status instalado + formato kml", st.instalado === true && st.formato === "kml");
  check("4.2 status conta 4 features", st.features === 4);
  check("4.3 geojson() devolve a FeatureCollection", RadarFiberService.geojson()?.features.length === 4);

  // GeoJSON em disco (provedor entrega .geojson pronto).
  const geoPath = path.join(tmpDir, "rede.geojson");
  fs.writeFileSync(geoPath, JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-43.2, -22.9] }, properties: { name: "POP" } }] }));
  process.env.RADAR_FIBER_PATH = geoPath;
  RadarFiberService.reload();
  const st2 = RadarFiberService.status();
  check("4.4 aceita GeoJSON direto (formato geojson)", st2.instalado === true && st2.formato === "geojson" && st2.features === 1);

  // Não instalado.
  process.env.RADAR_FIBER_PATH = path.join(tmpDir, "nao-existe.kml");
  RadarFiberService.reload();
  const st3 = RadarFiberService.status();
  check("4.5 arquivo ausente → não instalado, geojson null", st3.instalado === false && RadarFiberService.geojson() === null);

  // Arquivo inválido (não estoura; devolve erro).
  const badPath = path.join(tmpDir, "quebrado.geojson");
  fs.writeFileSync(badPath, "{ isto não é json");
  process.env.RADAR_FIBER_PATH = badPath;
  RadarFiberService.reload();
  const st4 = RadarFiberService.status();
  check("4.6 arquivo inválido → instalado:false + erro (sem throw)", st4.instalado === false && !!st4.erro);

  console.log("\n=== test:radar-b2b-fiber ===");
  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s).`); process.exit(1); }
  console.log("\n✅ Radar B2B fibra: KML/GeoJSON → overlay OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
