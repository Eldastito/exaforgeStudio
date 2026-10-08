import db from "./db.js";
import { OrgGroupService } from "./OrgGroupService.js";
import { StoreBenchmarkService } from "./StoreBenchmarkService.js";
import { todaySP } from "./spDate.js";

/**
 * GroupIntelligenceService — ADR-205 F4.8 (comparação ENTRE as operações de um grupo, ADR-199).
 *
 * Responde ao dono de várias marcas/CNPJs: "como cada operação se sai por m², por pessoa e por custo fixo, lado a lado?" — sem misturar nada.
 * COMPÕE por FAN-OUT (RN-GRP-01/RN-F4-10): para cada operação chama, UMA org por vez, o `StoreBenchmarkService.benchmark` (F4.3) já isolado por
 * organização e agrega os números que ele devolve. NUNCA faz SQL de negócio cruzando organizações (a única leitura direta é o nicho/nome da
 * própria org, uma por vez) e NÃO lê cliente, contato, venda individual nem vendedor — só faturamento, m², equipe e custo fixo agregados por loja.
 *
 * Regras:
 *  - RN-F4-9: ranking só com amostra mínima (MIN_OPERATIONS) e só entre operações do MESMO nicho conhecido; senão mostra os valores lado a lado
 *    com o motivo (`ranked:false`). Valor de loja nova (< maturidade do F4.3) fica fora do cálculo da operação.
 *  - Razão por operação = soma dos numeradores ÷ soma dos denominadores das MESMAS lojas que têm os dois; a cobertura (lojas usadas × elegíveis)
 *    é dita e cobertura incompleta limita a confiança. Sem dado → null (nunca 0).
 *  - Operação que falha vira `partial` e sai dos totais — o painel não cai (degradação graciosa, como a consolidação F2).
 *  - RN-F4-8/12: posição vs mediana + perguntas neutras; nunca causa, meta, nem recomenda fechar/vender/trocar operação.
 *  - Confiança: `insuficiente` sem ranking, `baixa` com ranking, `media` só com ≥5 operações de cobertura completa — nunca alta (um mês não vê sazonalidade).
 *  - Dinheiro → a rota é owner/admin do grupo e atrás de FEATURE_ORG_GROUPS (sem a flag a feature não existe). Read-only.
 */
export const MIN_OPERATIONS = 3;
const NEAR_BAND_PCT = 10, QUESTION_GAP_PCT = 25;
type MetricKey = "revenue_per_m2" | "revenue_per_person" | "fixed_cost_pct";
const METRICS: Array<{ key: MetricKey; label: string; unit: string; higherIsBetter: boolean }> = [
  { key: "revenue_per_m2", label: "Faturamento por m²", unit: "BRL/m²", higherIsBetter: true },
  { key: "revenue_per_person", label: "Faturamento por pessoa da equipe", unit: "BRL/pessoa", higherIsBetter: true },
  { key: "fixed_cost_pct", label: "Custo fixo sobre o faturamento", unit: "%", higherIsBetter: false },
];

const bad = (code: string, message: string) => Object.assign(new Error(message), { code });
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const previousMonth = (today: string) => { const [y, m] = today.slice(0, 7).split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };

type BenchmarkFn = (orgId: string, opts: { period: string }) => any;

export class GroupIntelligenceService {
  static compare(groupId: string, opts: { period?: string; benchmarkFn?: BenchmarkFn } = {}) {
    const group = OrgGroupService.getGroup(groupId);
    if (!group) throw bad("not_found", "Grupo não encontrado.");
    const today = todaySP();
    const period = opts.period ? String(opts.period) : previousMonth(today);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw bad("invalid_period", "Período inválido (use AAAA-MM).");
    if (period > today.slice(0, 7)) throw bad("invalid_period", "O período não pode estar no futuro.");
    const periodComplete = period < today.slice(0, 7);
    const bench: BenchmarkFn = opts.benchmarkFn || ((orgId, o) => StoreBenchmarkService.benchmark(orgId, o));

    const members = OrgGroupService.membersOf(groupId).map((m) => m.organizationId);
    const operations: any[] = [], partial: string[] = [];
    for (const orgId of members) {
      // FAN-OUT: uma operação por chamada; só o nome/nicho da PRÓPRIA org é lido diretamente.
      const meta = db.prepare("SELECT business_name, vertical FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      const base = { organizationId: orgId, businessName: meta?.business_name ?? null, vertical: meta?.vertical ?? null };
      try {
        const b = bench(orgId, { period }) || {};
        const stores: any[] = Array.isArray(b.stores) ? b.stores : [];
        const mature = stores.filter((s) => s.maturity !== "new");
        const ratio = (num: (s: any) => number | null, den: (s: any) => number | null, scale = 1) => {
          const used = mature.filter((s) => num(s) != null && den(s) != null && (den(s) as number) > 0);
          const d = used.reduce((a, s) => a + (den(s) as number), 0);
          const n = used.reduce((a, s) => a + (num(s) as number), 0);
          return { value: used.length && d > 0 ? round2((n / d) * scale) : null, used: used.length, of: mature.length };
        };
        const m2 = ratio((s) => s.revenue, (s) => s.areaM2), pp = ratio((s) => s.revenue, (s) => s.teamSize), fc = ratio((s) => s.fixedCosts, (s) => s.revenue, 100);
        const withRevenue = stores.filter((s) => s.revenue != null);
        operations.push({
          ...base, partial: false, stores: stores.length, newStoresExcluded: stores.length - mature.length,
          revenue: withRevenue.length ? round2(withRevenue.reduce((a, s) => a + s.revenue, 0)) : null,
          values: { revenue_per_m2: m2.value, revenue_per_person: pp.value, fixed_cost_pct: fc.value },
          coverage: { revenue_per_m2: { used: m2.used, of: m2.of }, revenue_per_person: { used: pp.used, of: pp.of }, fixed_cost_pct: { used: fc.used, of: fc.of } },
        });
      } catch {
        operations.push({ ...base, partial: true });
        partial.push(orgId);
      }
    }

    const live = operations.filter((o) => !o.partial);
    const verticals = [...new Set(live.map((o) => o.vertical))];
    const sameVertical = verticals.length === 1 && verticals[0] != null;
    const metrics = METRICS.map((m) => {
      const comparable = live.filter((o) => o.values[m.key] != null);
      const full = comparable.every((o) => o.coverage[m.key].used === o.coverage[m.key].of);
      const rows = live.map((o) => ({ organizationId: o.organizationId, businessName: o.businessName, value: o.values[m.key], coverage: o.coverage[m.key], gapVsMedianPct: null as number | null, position: null as string | null, rank: null as number | null }));
      const base = { key: m.key, label: m.label, unit: m.unit, comparableOperations: comparable.length, minRequired: MIN_OPERATIONS };
      let reason: string | null = null;
      if (!periodComplete) reason = "mes_incompleto";
      else if (!sameVertical) reason = verticals.some((v) => v == null) ? "nicho_desconhecido" : "nichos_diferentes";
      else if (comparable.length < MIN_OPERATIONS) reason = "amostra_minima";
      if (reason) return { ...base, ranked: false, reason, median: null, confidence: "insuficiente" as const, operations: rows, questions: [] as string[] };
      const med = median(comparable.map((o) => o.values[m.key]));
      const ordered = [...comparable].sort((a, b) => m.higherIsBetter ? b.values[m.key] - a.values[m.key] : a.values[m.key] - b.values[m.key]);
      for (const r of rows) {
        if (r.value == null) continue;
        const gap = med !== 0 ? round2(((r.value - med) / Math.abs(med)) * 100) : null;
        const better = gap == null ? 0 : m.higherIsBetter ? gap : -gap;
        r.gapVsMedianPct = gap; r.position = gap == null ? null : Math.abs(better) <= NEAR_BAND_PCT ? "near_median" : better > 0 ? "above_median" : "below_median";
        r.rank = ordered.findIndex((o) => o.organizationId === r.organizationId) + 1;
      }
      const questions = rows.filter((r) => r.position === "below_median" && r.gapVsMedianPct != null && Math.abs(r.gapVsMedianPct) >= QUESTION_GAP_PCT)
        .map((r) => `${r.businessName || "Uma operação"} está ${Math.abs(r.gapVsMedianPct as number).toFixed(0)}% ${m.higherIsBetter ? "abaixo" : "acima"} da mediana do grupo em "${m.label}". O que é diferente nessa operação (praça, formato da loja, equipe, mix)?`);
      return { ...base, ranked: true, reason: null, median: round2(med), confidence: comparable.length >= 5 && full ? ("media" as const) : ("baixa" as const), operations: rows, questions };
    });

    const withRev = live.filter((o) => o.revenue != null);
    const caveats = [
      "Comparação entre operações é um ponto de partida para PERGUNTAR, não uma conclusão: praça, formato de loja e público diferem e diferença de resultado não prova causa.",
      "Baseado em um único mês: não enxerga sazonalidade. Não é meta e não recomenda fechar, vender, trocar nem investir em nenhuma operação.",
      "Só entram números agregados por loja (faturamento, m², equipe, custo fixo). Nada de cliente, contato, venda individual ou vendedor — cada operação continua isolada.",
      "Loja nova (abaixo da maturidade) fica de fora da razão da operação; operação sem m²/equipe/custo fixo cadastrados não entra naquela comparação.",
    ];
    if (!periodComplete) caveats.push("O mês ainda não fechou: faturamento parcial contra custo fixo cheio distorceria a comparação, então não há ranking.");
    if (!sameVertical && live.length > 1) caveats.push("As operações são de nichos diferentes (ou o nicho não está cadastrado): não há ranking, só os valores lado a lado.");
    if (live.length < MIN_OPERATIONS) caveats.push(`O grupo tem ${live.length} operação(ões) com leitura; para posicionar contra a mediana preciso de pelo menos ${MIN_OPERATIONS} do mesmo nicho.`);
    if (partial.length) caveats.push(`${partial.length} operação(ões) indisponível(is) agora: ficaram de fora dos totais.`);
    return {
      type: "group_intelligence" as const, isForecast: false, executes: false, scope: "group_operations", groupId, period, periodComplete,
      operations, partial, verticals, sameVertical,
      totals: { revenue: withRev.length ? round2(withRev.reduce((a, o) => a + o.revenue, 0)) : null, operationsWithRevenue: withRev.length, operationsTotal: members.length, source: "StoreBenchmarkService (faturamento por loja dos fechamentos aceitos)" },
      assumptions: { minOperations: MIN_OPERATIONS, nearMedianBandPct: NEAR_BAND_PCT, questionGapPct: QUESTION_GAP_PCT },
      metrics, caveats,
    };
  }
}
export default GroupIntelligenceService;
