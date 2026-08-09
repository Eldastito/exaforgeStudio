import fs from "fs";
import path from "path";
import { kmlToGeoJson, parseGeoJsonText, bboxOf, GeoFeatureCollection } from "./kmlToGeoJson.js";

/**
 * RadarFiberService — overlay do traçado de fibra no mapa do Radar B2B (Fatia 3).
 *
 * Segue o MESMO padrão da base radar_rio.db (RadarB2BService): um arquivo em
 * disco, read-only, provisionado pelo admin (não vem do banco principal, não
 * grava nada no banco principal). Opt-in por presença do arquivo — sem ele, a
 * tela mostra "overlay não instalado" e o resto do Radar segue funcionando.
 *
 * O arquivo é convertido pra GeoJSON UMA vez e cacheado em memória (o traçado é
 * estático por deploy, igual à base da RFB). Aceita KML (XML, o formato padrão
 * de exportação de rede) ou GeoJSON já pronto — o provedor manda o que tiver.
 *
 * RN (isolamento): é geometria da rede DO PROVEDOR, dado de referência de
 * plataforma — não há organization_id porque não há dado de tenant. Não viola a
 * convenção multi-tenant (não existe query por org aqui).
 */

export interface FiberStatus {
  instalado: boolean;
  formato: string | null;
  features: number;
  bbox: [number, number, number, number] | null;
  dataBase: string | null;
  erro?: string;
}

// Ordem de resolução: RADAR_FIBER_PATH explícito vence; senão tenta os nomes
// padrão em data/ (KML primeiro, depois GeoJSON).
function candidates(): string[] {
  if (process.env.RADAR_FIBER_PATH) return [process.env.RADAR_FIBER_PATH];
  return ["data/radar_fibra.kml", "data/radar_fibra.geojson", "data/radar_fibra.json"];
}

export class RadarFiberService {
  private static _fc: GeoFeatureCollection | null = null;
  private static _status: FiberStatus | null = null;
  private static _loaded = false;

  // Reprocessa do disco. Idempotente (cacheado). Público pra: (a) os testes
  // trocarem de fixture no mesmo processo; (b) ops recarregar um traçado novo
  // sem reiniciar o servidor.
  static reload(): void {
    this._loaded = false;
    this._fc = null;
    this._status = null;
    this.load();
  }

  private static fileMonth(p: string): string | null {
    try {
      const d = fs.statSync(p).mtime;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    } catch {
      return null;
    }
  }

  private static load(): void {
    if (this._loaded) return;
    this._loaded = true;
    this._fc = null;
    this._status = { instalado: false, formato: null, features: 0, bbox: null, dataBase: null };

    for (const p of candidates()) {
      let text: string;
      try {
        text = fs.readFileSync(p, "utf8");
      } catch {
        continue; // candidato não existe — tenta o próximo
      }
      // O primeiro candidato que EXISTE decide o resultado (inclusive erro de
      // parse) — não faz sentido cair pro próximo se o admin apontou este.
      try {
        const ext = path.extname(p).toLowerCase();
        const looksJson = ext === ".geojson" || ext === ".json" || /^\s*[{[]/.test(text);
        const fc = looksJson ? parseGeoJsonText(text) : kmlToGeoJson(text);
        this._fc = fc;
        this._status = {
          instalado: fc.features.length > 0,
          formato: looksJson ? "geojson" : "kml",
          features: fc.features.length,
          bbox: bboxOf(fc),
          dataBase: this.fileMonth(p),
          ...(fc.features.length === 0 ? { erro: "Arquivo lido, mas sem nenhuma geometria reconhecida." } : {}),
        };
      } catch (e: any) {
        this._fc = null;
        this._status = { instalado: false, formato: null, features: 0, bbox: null, dataBase: null, erro: e?.message || "Falha ao ler o arquivo de fibra." };
      }
      return;
    }
    // nenhum candidato existe → segue não instalado (estado inicial já setado)
  }

  static status(): FiberStatus {
    this.load();
    return this._status!;
  }

  static isInstalled(): boolean {
    return this.status().instalado;
  }

  static geojson(): GeoFeatureCollection | null {
    this.load();
    return this._fc;
  }
}
