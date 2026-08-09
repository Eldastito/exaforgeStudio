import { XMLParser } from "fast-xml-parser";

/**
 * kmlToGeoJson — converte KML (o formato XML padrão de exportação de mapas de
 * rede: Google Earth, QGIS, OSS de telecom) em GeoJSON, usando o mesmo parser
 * de XML que já roda no projeto (fast-xml-parser, ver nfeParser.ts) — sem
 * acrescentar dependência de geo.
 *
 * Radar B2B / Fatia 3 (overlay de fibra). O provedor entrega o traçado da
 * PRÓPRIA rede; a recepção sobrepõe no mapa da busca pra enxergar quais
 * empresas caem em cima / perto da fibra. É só geometria da rede DELE — não é
 * dado de cliente/tenant, então a camada é de plataforma (sem organization_id),
 * igual à base pública radar_rio.db. (RN: dado de referência, read-only, não
 * multi-tenant — não fere a convenção de isolamento porque não há dado de org.)
 *
 * Decisões:
 * - removeNSPrefix: aceita <kml:Placemark>, <gx:...> etc. (o schema varia por
 *   ferramenta que exporta) — mesmo motivo do nfeParser.
 * - Coordenada KML é "lon,lat[,alt]" separada por espaço; GeoJSON é [lon,lat].
 *   A altitude é descartada (o mapa é 2D).
 * - MultiGeometry vira Multi* quando homogêneo, senão GeometryCollection —
 *   ambos o Leaflet (L.geoJSON) desenha direto.
 * - Cor: best-effort a partir de <Style id> + <styleUrl>#id (LineStyle/PolyStyle,
 *   formato KML aabbggrr → #rrggbb). StyleMap não é resolvido (cai no default do
 *   mapa) — evita complexidade que a Fatia 3 não precisa.
 */

export type Position = [number, number];
export interface GeoGeometry {
  type: string;
  coordinates?: any;
  geometries?: GeoGeometry[];
}
export interface GeoFeature {
  type: "Feature";
  geometry: GeoGeometry | null;
  properties: Record<string, any>;
}
export interface GeoFeatureCollection {
  type: "FeatureCollection";
  features: GeoFeature[];
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// fast-xml-parser devolve string quando a tag não tem atributos, mas objeto com
// "#text" quando tem — normaliza os dois casos.
function textOf(v: any): string {
  if (v == null) return "";
  if (typeof v === "object") return String(v["#text"] ?? "");
  return String(v);
}

function parseCoords(raw: any): Position[] {
  const s = textOf(raw).trim();
  if (!s) return [];
  const out: Position[] = [];
  for (const tok of s.split(/\s+/)) {
    const parts = tok.split(",");
    if (parts.length < 2) continue;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) out.push([lon, lat]);
  }
  return out;
}

// Fecha o anel do polígono (GeoJSON exige 1º ponto == último; KML nem sempre traz).
function closeRing(r: Position[]): Position[] {
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) return [...r, r[0]];
  return r;
}

function pointGeom(p: any): GeoGeometry | null {
  const c = parseCoords(p?.coordinates);
  return c.length ? { type: "Point", coordinates: c[0] } : null;
}

function lineGeom(l: any): GeoGeometry | null {
  const c = parseCoords(l?.coordinates);
  return c.length >= 2 ? { type: "LineString", coordinates: c } : null;
}

function polyGeom(pg: any): GeoGeometry | null {
  const outer = parseCoords(pg?.outerBoundaryIs?.LinearRing?.coordinates);
  if (outer.length < 3) return null;
  const rings: Position[][] = [closeRing(outer)];
  for (const inner of asArray(pg?.innerBoundaryIs)) {
    const ic = parseCoords(inner?.LinearRing?.coordinates);
    if (ic.length >= 3) rings.push(closeRing(ic));
  }
  return { type: "Polygon", coordinates: rings };
}

function multiGeom(mg: any): GeoGeometry | null {
  const geoms: GeoGeometry[] = [];
  for (const p of asArray(mg?.Point)) { const g = pointGeom(p); if (g) geoms.push(g); }
  for (const l of asArray(mg?.LineString)) { const g = lineGeom(l); if (g) geoms.push(g); }
  for (const pg of asArray(mg?.Polygon)) { const g = polyGeom(pg); if (g) geoms.push(g); }
  for (const nm of asArray(mg?.MultiGeometry)) { const g = multiGeom(nm); if (g) geoms.push(g); }
  if (!geoms.length) return null;
  if (geoms.length === 1) return geoms[0];
  const types = new Set(geoms.map((g) => g.type));
  if (types.size === 1) {
    const t = geoms[0].type;
    if (t === "Point") return { type: "MultiPoint", coordinates: geoms.map((g) => g.coordinates) };
    if (t === "LineString") return { type: "MultiLineString", coordinates: geoms.map((g) => g.coordinates) };
    if (t === "Polygon") return { type: "MultiPolygon", coordinates: geoms.map((g) => g.coordinates) };
  }
  return { type: "GeometryCollection", geometries: geoms };
}

function geomFromPlacemark(pm: any): GeoGeometry | null {
  if (pm?.MultiGeometry) return multiGeom(asArray(pm.MultiGeometry)[0]);
  if (pm?.Point) return pointGeom(asArray(pm.Point)[0]);
  if (pm?.LineString) return lineGeom(asArray(pm.LineString)[0]);
  if (pm?.Polygon) return polyGeom(asArray(pm.Polygon)[0]);
  return null;
}

// Placemarks e Styles podem estar em qualquer nível (Document > Folder > Folder…);
// varremos a árvore inteira recursivamente ao invés de assumir a hierarquia.
function collectByKey(node: any, key: string, out: any[]) {
  if (node == null || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k === key) {
      for (const item of asArray(v)) out.push(item);
    } else if (v && typeof v === "object") {
      for (const child of asArray(v)) collectByKey(child, key, out);
    }
  }
}

// KML: cor é aabbggrr (alpha, blue, green, red). GeoJSON/CSS quer #rrggbb.
function kmlColor(raw: any): string | null {
  const s = textOf(raw).trim();
  if (!/^[0-9a-fA-F]{8}$/.test(s)) return null;
  const bb = s.slice(2, 4);
  const gg = s.slice(4, 6);
  const rr = s.slice(6, 8);
  return `#${rr}${gg}${bb}`.toLowerCase();
}

export function kmlToGeoJson(xml: string): GeoFeatureCollection {
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error("Não foi possível ler o arquivo como XML/KML válido.");
  }

  // Mapa styleUrl (#id) → cor, resolvido a partir dos <Style id="…"> do documento.
  const styleNodes: any[] = [];
  collectByKey(doc, "Style", styleNodes);
  const styleColors: Record<string, string> = {};
  for (const st of styleNodes) {
    const id = st?.["@_id"];
    if (!id) continue;
    const color = kmlColor(st?.LineStyle?.color ?? st?.PolyStyle?.color);
    if (color) styleColors["#" + id] = color;
  }

  const placemarks: any[] = [];
  collectByKey(doc, "Placemark", placemarks);

  const features: GeoFeature[] = [];
  for (const pm of placemarks) {
    const geometry = geomFromPlacemark(pm);
    if (!geometry) continue; // placemark sem geometria (só ponto de vista/tour) é ignorado
    const properties: Record<string, any> = {};
    const name = textOf(pm?.name).trim();
    if (name) properties.name = name;
    const desc = textOf(pm?.description).trim();
    if (desc) properties.description = desc.slice(0, 500);
    const inline = kmlColor(pm?.Style?.LineStyle?.color ?? pm?.Style?.PolyStyle?.color);
    const su = textOf(pm?.styleUrl).trim();
    const color = inline || (su && styleColors[su]) || undefined;
    if (color) properties.color = color;
    features.push({ type: "Feature", geometry, properties });
  }

  return { type: "FeatureCollection", features };
}

// Passa GeoJSON adiante (quando o provedor já entrega .geojson em vez de KML),
// normalizando Feature/Geometry soltos para FeatureCollection.
export function parseGeoJsonText(text: string): GeoFeatureCollection {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("GeoJSON inválido (não é JSON).");
  }
  if (j?.type === "FeatureCollection" && Array.isArray(j.features)) return j;
  if (j?.type === "Feature") return { type: "FeatureCollection", features: [j] };
  if (j?.type && j.coordinates) return { type: "FeatureCollection", features: [{ type: "Feature", geometry: j, properties: {} }] };
  throw new Error("GeoJSON não reconhecido (esperado FeatureCollection, Feature ou Geometry).");
}

// Bounding box [minLon, minLat, maxLon, maxLat] pra a UI (contagem/enquadramento).
export function bboxOf(fc: GeoFeatureCollection): [number, number, number, number] | null {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity, any = false;
  const walk = (c: any) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      const [lon, lat] = c;
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
      any = true;
      return;
    }
    for (const x of c) walk(x);
  };
  for (const f of fc.features) {
    if (!f.geometry) continue;
    if (f.geometry.type === "GeometryCollection") {
      for (const g of f.geometry.geometries || []) walk((g as any).coordinates);
    } else {
      walk((f.geometry as any).coordinates);
    }
  }
  return any ? [minLon, minLat, maxLon, maxLat] : null;
}
