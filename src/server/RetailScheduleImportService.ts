/**
 * Retail Ops — Importação da ESCALA por FOTO (Fase G2+).
 *
 * As lojas mandam a escala da semana no fim de semana (grade DOM→SÁB, turnos
 * com o nome do vendedor, linha FOLGA). Aqui a IA lê a foto e devolve, por
 * vendedor, trabalha/folga em cada dia — e o gestor CONFERE antes de salvar
 * (a IA nunca salva sozinha; o salvamento continua sendo o PUT /schedule).
 *
 * Decisões:
 *  - A IA NÃO adivinha datas: devolve por DIA DA SEMANA (dom..sab). Quem casa
 *    com as datas reais é o servidor, usando a semana que o gestor está vendo
 *    (weekDates). Elimina erro de ano/data na leitura.
 *  - O nome manuscrito é casado com o CADASTRO da loja (resolveMatriculaByName):
 *    bateu → sellerKey mat:<matrícula>; não bateu → nom:<nome> (ainda salvável,
 *    mas sinalizado em `unmatched` pra conferência).
 *  - Férias/atestado entram como 'off' (não trabalha aquele dia).
 */
import db from "./db.js";
import { resolveMatriculaByName } from "./RetailOpsService.js";
import { extractScheduleFromImage } from "./llm.js";

const DOW_KEYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"] as const;

export type ScheduleEntry = { date: string; sellerKey: string; sellerName: string; status: "work" | "off" };
export type ScheduleImportResult = {
  entries: ScheduleEntry[];
  grid: Record<string, Record<string, "work" | "off">>;
  matched: number;
  unmatched: string[];
  confidence: number;
};

/** Lê "trabalha/folga/férias" (ou work/off) → status normalizado, ou null. */
function normStatus(raw: unknown): "work" | "off" | null {
  const s = String(raw ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  if (!s) return null;
  if (/trab|work|sim/.test(s)) return "work";
  if (/folg|off|fer|atest|falta|nao/.test(s)) return "off";
  return null;
}

/**
 * Transformador PURO: JSON da IA + cadastro da loja + as 7 datas da semana
 * (domingo→sábado) → entradas prontas pra saveSchedule + grade pra UI. Testável
 * sem IA nem rede.
 */
export function buildScheduleFromExtraction(
  parsed: any,
  sellers: Array<{ matricula: any; name: any }>,
  weekDates: string[]
): Omit<ScheduleImportResult, "confidence"> {
  const entries: ScheduleEntry[] = [];
  const grid: Record<string, Record<string, "work" | "off">> = {};
  const unmatched = new Set<string>();
  let matched = 0;
  const vendedores = Array.isArray(parsed?.vendedores) ? parsed.vendedores : [];
  const seenSeller = new Set<string>();
  for (const v of vendedores) {
    const nome = String(v?.nome || "").trim();
    if (!nome) continue;
    const mat = resolveMatriculaByName(sellers, nome);
    const sellerKey = mat ? `mat:${mat}` : `nom:${nome.toLowerCase()}`;
    if (!seenSeller.has(sellerKey)) { seenSeller.add(sellerKey); if (mat) matched++; else unmatched.add(nome); }
    const dias = (v && typeof v.dias === "object" && v.dias) || {};
    for (let i = 0; i < 7; i++) {
      const status = normStatus(dias[DOW_KEYS[i]]);
      if (!status) continue;
      const date = weekDates[i];
      if (!date) continue;
      entries.push({ date, sellerKey, sellerName: nome, status });
      (grid[date] = grid[date] || {})[sellerKey] = status;
    }
  }
  return { entries, grid, matched, unmatched: [...unmatched] };
}

/** Roster da loja (matrícula+nome) pra casar o nome da foto; fallback: org. */
function storeRoster(orgId: string, storeId: string): Array<{ matricula: string; name: string }> {
  let rows: any[] = [];
  try {
    rows = db.prepare(
      `SELECT s.matricula, s.name FROM retail_seller_store_assignments a
         JOIN retail_sellers s ON s.organization_id = a.organization_id AND s.id = a.seller_id
        WHERE a.organization_id = ? AND a.store_id = ? AND a.active = 1 AND s.active = 1`
    ).all(orgId, storeId) as any[];
  } catch { rows = []; }
  if (!rows.length) {
    try { rows = db.prepare(`SELECT matricula, name FROM retail_sellers WHERE organization_id = ? AND active = 1`).all(orgId) as any[]; } catch { rows = []; }
  }
  return rows.map((r) => ({ matricula: String(r.matricula), name: String(r.name || "") }));
}

/** Extrator injetável (teste offline sem provedor de visão). */
type ScheduleExtractor = (base64: string, mimetype: string, names: string[]) => Promise<string>;
let _scheduleExtractor: ScheduleExtractor | null = null;
export function _setScheduleExtractor(fn: ScheduleExtractor | null) { _scheduleExtractor = fn; }

export class RetailScheduleImportService {
  /**
   * Lê a foto da escala e devolve a grade pra CONFERÊNCIA (não salva). weekDates
   * = as 7 datas (domingo→sábado) da semana que o gestor está vendo.
   */
  static async extractFromImage(orgId: string, storeId: string, base64: string, mimetype: string, weekDates: string[]): Promise<ScheduleImportResult> {
    const sellers = storeRoster(orgId, storeId);
    const names = sellers.map((s) => s.name).filter(Boolean);
    const extractor = _scheduleExtractor || ((b: string, m: string, n: string[]) => extractScheduleFromImage(b, m, n));
    let parsed: any = {};
    try { parsed = JSON.parse((await extractor(base64, mimetype, names)) || "{}"); } catch { parsed = {}; }
    const built = buildScheduleFromExtraction(parsed, sellers, weekDates);
    return { ...built, confidence: Number(parsed?.confidence ?? 0) || 0 };
  }
}
