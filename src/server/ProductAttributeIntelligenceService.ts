/**
 * ADR-206 F5.9 — INTELIGÊNCIA DE PRODUTO por atributo (cor / tamanho) — COMPÕE o que já existe, sem motor novo (RN-F5-12).
 *
 * A pergunta do dono de moda: "que cor e que tamanho estão saindo, e o estoque acompanha?". Hoje só existe "mais vendidos por produto".
 * Aqui o desempenho é agregado por ATRIBUTO da variante, a partir de `retail_pdv_sale_items` (já resolvido para o catálogo pelo
 * `RetailPdvCatalogResolver`) × `product_variants` (cor/tamanho) × `retail_store_inventory` (estoque atual).
 *
 * Honestidade (o que manda neste serviço):
 *  - COBERTURA primeiro: só entram na tabela de atributo as linhas de venda resolvidas até a VARIANTE; o resto (produto sem grade,
 *    ambíguo, não encontrado) é contado e dito. Cobertura baixa (< 30%) → mostra os números e NÃO tira dica nenhuma.
 *  - Amostra mínima: valor de atributo com poucas linhas (< 30) aparece, mas sem variação nem dica (`insufficient_data`).
 *  - Variação vs período anterior só com amostra nos dois períodos; senão null (nunca 0%).
 *  - Dica = HIPÓTESE sobre diferença entre a fatia da procura e a fatia do estoque ("a cor X é 40% das saídas e 12% do estoque");
 *    pergunta para conferir, nunca ordem nem causa. Máx. 3, ordenadas pela maior diferença. Estoque negativo não entra na soma (é erro de dado, contado).
 *  - Dinheiro (R$) é do gestor (§73): sem `includeMoney` os valores saem; unidades e participação ficam.
 *  - Read-only, determinístico, sem LLM, isolado por organização.
 */
import db from "./db.js";

export const MIN_LINES = 30;
export const MIN_COVERAGE = 0.3;
export const HINT_RATIO = 1.5;
const MAX_HINTS = 3;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const norm = (s: any) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

type Dim = "color" | "size";
const DIM_LABEL: Record<Dim, string> = { color: "cor", size: "tamanho" };

export class ProductAttributeIntelligenceService {
  static performance(orgId: string, opts: { days?: number; asOf?: string; includeMoney?: boolean } = {}): any {
    const days = Math.max(7, Math.min(365, Number(opts.days) || 90));
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOf || "")) ? String(opts.asOf) : new Date().toISOString().slice(0, 10);
    const dayMs = 86400000, end = Date.parse(asOf);
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    const curFrom = iso(end - (days - 1) * dayMs), prevTo = iso(end - days * dayMs), prevFrom = iso(end - (2 * days - 1) * dayMs);
    const money = opts.includeMoney === true;

    const lines = (from: string, to: string) => db.prepare(`
      SELECT i.variant_id AS variantId, i.quantidade AS q, i.valor AS v
        FROM retail_pdv_sale_items i
        JOIN retail_pdv_sales s ON s.organization_id = i.organization_id AND s.filial = i.filial AND s.boleta = i.boleta AND s.sale_date = i.sale_date
       WHERE i.organization_id = ? AND i.sale_date >= ? AND i.sale_date <= ? AND (s.status IS NULL OR s.status = 'N')`).all(orgId, from, to) as any[];
    const cur = lines(curFrom, asOf), prev = lines(prevFrom, prevTo);

    const variants = new Map<string, { color: string | null; size: string | null }>();
    for (const v of db.prepare("SELECT id, color, size FROM product_variants WHERE organization_id = ?").all(orgId) as any[]) {
      variants.set(v.id, { color: norm(v.color) || null, size: norm(v.size) || null });
    }
    const resolved = (l: any) => !!l.variantId && variants.has(l.variantId);
    const totalLines = cur.length, resolvedLines = cur.filter(resolved).length;
    const totalValue = cur.reduce((a, l) => a + (Number(l.v) || 0), 0), resolvedValue = cur.filter(resolved).reduce((a, l) => a + (Number(l.v) || 0), 0);
    const coverage = {
      lines: totalLines, resolvedToVariant: resolvedLines, unresolved: totalLines - resolvedLines,
      linesPct: totalLines ? round1((resolvedLines / totalLines) * 100) : null,
      valuePct: totalValue > 0 ? round1((resolvedValue / totalValue) * 100) : null,
    };
    const reliable = totalLines > 0 && resolvedLines / totalLines >= MIN_COVERAGE;

    // Estoque atual por variante (só positivo; negativo é erro de dado e fica de fora da soma).
    const stockRows = db.prepare("SELECT variant_id AS variantId, SUM(CASE WHEN quantity_available > 0 THEN quantity_available ELSE 0 END) AS q, SUM(CASE WHEN quantity_available < 0 THEN 1 ELSE 0 END) AS neg FROM retail_store_inventory WHERE organization_id = ? AND variant_id IS NOT NULL AND variant_id <> '' GROUP BY variant_id").all(orgId) as any[];
    let negativeRows = 0; const stockBy = new Map<string, number>();
    for (const r of stockRows) { negativeRows += Number(r.neg) || 0; const q = Number(r.q) || 0; if (q > 0) stockBy.set(r.variantId, q); }

    const dims: Record<string, any> = {}; const hintsAll: any[] = [];
    (["color", "size"] as Dim[]).forEach((dim) => {
      const agg = (rows: any[]) => { const m = new Map<string, { lines: number; units: number; value: number }>(); for (const l of rows) { if (!resolved(l)) continue; const a = variants.get(l.variantId)![dim]; if (!a) continue; const e = m.get(a) || { lines: 0, units: 0, value: 0 }; e.lines++; e.units += Number(l.q) || 0; e.value += Number(l.v) || 0; m.set(a, e); } return m; };
      const c = agg(cur), p = agg(prev);
      const stock = new Map<string, number>(); let stockTotal = 0;
      for (const [vid, q] of stockBy) { const a = variants.get(vid)?.[dim]; if (!a) continue; stock.set(a, (stock.get(a) || 0) + q); stockTotal += q; }
      const unitsTotal = [...c.values()].reduce((a, e) => a + e.units, 0);
      const items = [...c.entries()].map(([value, e]) => {
        const pe = p.get(value);
        const enough = e.lines >= MIN_LINES;
        const prevEnough = !!pe && pe.lines >= MIN_LINES && pe.units > 0;
        const demandShare = unitsTotal > 0 ? e.units / unitsTotal : null;
        const stockShare = stockTotal > 0 ? (stock.get(value) || 0) / stockTotal : null;
        return {
          value, lines: e.lines, units: round1(e.units), unitsSharePct: demandShare != null ? round1(demandShare * 100) : null,
          ...(money ? { revenue: Math.round(e.value * 100) / 100 } : {}),
          changeUnitsPct: enough && prevEnough ? round1(((e.units - pe!.units) / pe!.units) * 100) : null,
          stockUnits: stock.get(value) || 0, stockSharePct: stockShare != null ? round1(stockShare * 100) : null,
          status: enough ? "ok" : "insufficient_data",
          _d: demandShare, _s: stockShare, _enough: enough,
        };
      }).sort((a, b) => b.units - a.units || a.value.localeCompare(b.value));

      if (reliable) {
        for (const it of items) {
          if (!it._enough || it._d == null || it._s == null) continue;
          const sFloor = Math.max(it._s, 0.0001);
          if (it._d >= HINT_RATIO * sFloor && it._d - it._s >= 0.1) {
            hintsAll.push({ kind: "demand_above_stock", dimension: DIM_LABEL[dim], value: it.value, gap: it._d - it._s, demandSharePct: it.unitsSharePct, stockSharePct: it.stockSharePct, basis: "hypothesis", text: `${DIM_LABEL[dim]} "${it.value}" é ${it.unitsSharePct}% das saídas e ${it.stockSharePct}% do estoque — vale conferir se a reposição acompanha.` });
          } else if (it._s >= HINT_RATIO * Math.max(it._d, 0.0001) && it._s - it._d >= 0.1) {
            hintsAll.push({ kind: "stock_above_demand", dimension: DIM_LABEL[dim], value: it.value, gap: it._s - it._d, demandSharePct: it.unitsSharePct, stockSharePct: it.stockSharePct, basis: "hypothesis", text: `${DIM_LABEL[dim]} "${it.value}" é ${it.stockSharePct}% do estoque e ${it.unitsSharePct}% das saídas — vale conferir se há estoque parado.` });
          }
        }
      }
      dims[dim] = { label: DIM_LABEL[dim], values: items.map(({ _d, _s, _enough, ...rest }) => rest), stockUnitsTotal: stockTotal, withoutAttributeLines: cur.filter((l) => resolved(l) && !variants.get(l.variantId)![dim]).length };
    });
    const hints = hintsAll.sort((a, b) => b.gap - a.gap || a.value.localeCompare(b.value)).slice(0, MAX_HINTS).map(({ gap, ...h }) => h);

    return {
      window: { from: curFrom, to: asOf, days, previousFrom: prevFrom, previousTo: prevTo },
      coverage, reliable, thresholds: { minLines: MIN_LINES, minCoveragePct: MIN_COVERAGE * 100, hintRatio: HINT_RATIO },
      negativeStockRowsIgnored: negativeRows,
      color: dims.color, size: dims.size,
      hints,
      notes: [
        "Só entram vendas já ligadas a uma variante (cor/tamanho) do catálogo; o restante aparece em 'cobertura'.",
        "Dica é hipótese sobre a fatia da procura × a do estoque — não prova causa nem manda comprar.",
        ...(reliable ? [] : ["Cobertura baixa: os números abaixo são mostrados, mas nenhuma dica é gerada."]),
        ...(money ? [] : ["Valores em R$ ocultos (só dono/administrador)."]),
      ],
    };
  }
}

export default ProductAttributeIntelligenceService;
