import { randomUUID } from "node:crypto";
import db from "./db.js";
import { RetailStoreService } from "./RetailStoreService.js";
import { RetailStoreCostService } from "./RetailStoreCostService.js";
import { logAuthEvent } from "./auditLog.js";
import { todaySP } from "./spDate.js";

/**
 * StoreBenchmarkService — ADR-205 F4.3: benchmark INTERNO normalizado entre as lojas da própria rede.
 *
 * O PRD proíbe "ranking de venda bruta": loja grande sempre ganha de loja pequena, e isso não diz nada. Comparar exige NORMALIZAR (por m², por pessoa, custo fixo sobre
 * faturamento) — e normalizar exige dado que só o dono tem (m² e equipe por loja). Aluguel/folha/custos já existem em `RetailStoreCostService`; faturamento vem dos fechamentos.
 * Por isso este serviço guarda só o que faltava (`store_opportunity_profiles`: m², equipe, data de abertura) e COMPÕE o resto — não recalcula nada financeiro (RN-F4-11).
 *
 * Regras:
 *  - Sem o dado, não compara: métrica sem insumo → null por loja (null ≠ 0) e a loja entra em `missing`. Faturamento 0 = "sem fechamento no mês", não "vendeu zero".
 *  - Amostra mínima (MIN_COMPARABLE=3 lojas comparáveis por métrica): abaixo disso `ranked:false` + motivo — com 2 lojas qualquer "ranking" é só uma subtração.
 *  - Só compara loja MADURA: aberta há <6 meses (`opened_on`) fica de fora do ranking e é dita. Abertura desconhecida entra, com aviso.
 *  - Mês corrente é incompleto (faturamento parcial contra custo fixo cheio) → não ranqueia; o padrão é o último mês fechado.
 *  - Confiança só `insuficiente`/`baixa`/`media` — um único mês não vê sazonalidade, então nunca "alta" (RN-F4-6).
 *  - Resultado = posição vs MEDIANA + PERGUNTAS neutras ("o que muda nessa loja?"). Nunca causa (RN-F4-8), nunca meta, nunca recomendação de fechar/contratar/demitir (RN-F4-12).
 *  - Ler = gestor; gravar o perfil = dono/admin. Isolado por organização. Perfil é atributo atual (upsert + auditoria), não série histórica.
 */
export const MIN_COMPARABLE = 3;
export const MATURITY_MONTHS = 6;
const NEAR_BAND_PCT = 10;
const QUESTION_GAP_PCT = 25;
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const isOwner = (actor: any) => !!actor?.userId && ["owner", "admin"].includes(String(actor?.role || ""));
const bad = (code: string, message: string) => Object.assign(new Error(message), { code });
const clean = (v: unknown, max: number): string | null => { const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); return s || null; };

type MetricKey = "revenue_per_m2" | "revenue_per_person" | "fixed_cost_pct";
const METRICS: { key: MetricKey; label: string; unit: string; higherIsBetter: boolean }[] = [
  { key: "revenue_per_m2", label: "Faturamento por m²", unit: "BRL/m²", higherIsBetter: true },
  { key: "revenue_per_person", label: "Faturamento por pessoa da equipe", unit: "BRL/pessoa", higherIsBetter: true },
  { key: "fixed_cost_pct", label: "Custo fixo sobre o faturamento", unit: "%", higherIsBetter: false },
];

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const monthsBetween = (from: string, period: string) => { const [fy, fm] = from.slice(0, 7).split("-").map(Number); const [py, pm] = period.split("-").map(Number); return (py - fy) * 12 + (pm - fm); };
const previousMonth = (today: string) => { const [y, m] = today.slice(0, 7).split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };

export class StoreBenchmarkService {
  static getProfile(orgId: string, storeId: string) {
    const r = db.prepare(`SELECT store_id, area_m2, team_size, opened_on, note, updated_at FROM store_opportunity_profiles WHERE organization_id = ? AND store_id = ?`).get(orgId, storeId) as any;
    return r ? { storeId: r.store_id, areaM2: r.area_m2 ?? null, teamSize: r.team_size ?? null, openedOn: r.opened_on ?? null, note: r.note ?? null, updatedAt: r.updated_at } : null;
  }

  /** Grava só o que veio no patch (undefined = mantém; null/"" = limpa). Informação do DONO — a IA nunca preenche. */
  static setProfile(orgId: string, actor: any, storeId: string, patch: any) {
    if (!isOwner(actor)) throw bad("forbidden", "Só o dono ou o administrador informa os dados da loja.");
    if (!RetailStoreService.get(orgId, storeId)) throw bad("not_found", "Loja não encontrada.");
    const cur = this.getProfile(orgId, storeId);
    let area = cur?.areaM2 ?? null, team = cur?.teamSize ?? null, opened = cur?.openedOn ?? null, note = cur?.note ?? null;
    const empty = (v: any) => v === null || v === "";
    if (patch?.areaM2 !== undefined) {
      if (empty(patch.areaM2)) area = null;
      else { const n = Number(patch.areaM2); if (!Number.isFinite(n) || n <= 0 || n > 100000) throw bad("invalid_area", "A área deve ser um número maior que zero (m²)."); area = round2(n); }
    }
    if (patch?.teamSize !== undefined) {
      if (empty(patch.teamSize)) team = null;
      else { const n = Number(patch.teamSize); if (!Number.isInteger(n) || n < 1 || n > 500) throw bad("invalid_team", "A equipe deve ser um número inteiro de pessoas (1 ou mais)."); team = n; }
    }
    if (patch?.openedOn !== undefined) {
      if (empty(patch.openedOn)) opened = null;
      else { const s = String(patch.openedOn); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw bad("invalid_opened_on", "Data de abertura inválida (use AAAA-MM-DD)."); if (s > todaySP()) throw bad("invalid_opened_on", "A abertura não pode estar no futuro."); opened = s; }
    }
    if (patch?.note !== undefined) note = clean(patch.note, 300);
    db.prepare(
      `INSERT INTO store_opportunity_profiles (id, organization_id, store_id, area_m2, team_size, opened_on, note, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(organization_id, store_id) DO UPDATE SET area_m2 = excluded.area_m2, team_size = excluded.team_size, opened_on = excluded.opened_on, note = excluded.note, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
    ).run(randomUUID(), orgId, storeId, area, team, opened, note, actor.userId);
    try { logAuthEvent(orgId, actor.userId, storeId, "STORE_OPPORTUNITY_PROFILE_SET", { fromArea: cur?.areaM2 ?? null, toArea: area, fromTeam: cur?.teamSize ?? null, toTeam: team }); } catch { /* noop */ }
    return this.getProfile(orgId, storeId);
  }

  static listProfiles(orgId: string) {
    const stores = RetailStoreService.list(orgId).filter((s: any) => s.active !== 0);
    return stores.map((s: any) => ({ storeId: s.id, storeName: s.name, profile: this.getProfile(orgId, s.id) }));
  }

  /** Benchmark normalizado do mês fechado (padrão: o mês anterior). Compõe faturamento e custo fixo existentes; não recalcula finanças. */
  static benchmark(orgId: string, opts: { period?: string } = {}) {
    const today = todaySP();
    let period = opts.period ? String(opts.period) : previousMonth(today);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw bad("invalid_period", "Período inválido (use AAAA-MM).");
    const periodComplete = period < today.slice(0, 7);
    if (period > today.slice(0, 7)) throw bad("invalid_period", "O período não pode estar no futuro.");

    const stores = RetailStoreService.list(orgId).filter((s: any) => s.active !== 0);
    const revenues = RetailStoreCostService.monthlyRevenueAll(orgId, period);
    const costs = RetailStoreCostService.listAll(orgId);
    const profiles = new Map<string, any>();
    for (const s of stores) profiles.set(s.id, this.getProfile(orgId, s.id));

    const rows = stores.map((s: any) => {
      const p = profiles.get(s.id);
      const rev = revenues.get(s.id) || 0;
      const revenue = rev > 0 ? round2(rev) : null; // 0 = sem fechamento no mês, não "vendeu zero"
      const fixed = costs.get(s.id)?.total || 0;
      const fixedCosts = fixed > 0 ? round2(fixed) : null;
      const age = p?.openedOn ? monthsBetween(p.openedOn, period) : null;
      const maturity: "mature" | "new" | "unknown" = age == null ? "unknown" : age >= MATURITY_MONTHS ? "mature" : "new";
      const values: Record<MetricKey, number | null> = {
        revenue_per_m2: revenue != null && p?.areaM2 ? round2(revenue / p.areaM2) : null,
        revenue_per_person: revenue != null && p?.teamSize ? round2(revenue / p.teamSize) : null,
        fixed_cost_pct: revenue != null && fixedCosts != null ? round2((fixedCosts / revenue) * 100) : null,
      };
      const missing: string[] = [];
      if (revenue == null) missing.push("faturamento_do_mes");
      if (!p?.areaM2) missing.push("area_m2");
      if (!p?.teamSize) missing.push("equipe");
      if (fixedCosts == null) missing.push("custos_fixos");
      if (!p?.openedOn) missing.push("data_de_abertura");
      return { storeId: s.id, storeName: s.name, revenue, fixedCosts, areaM2: p?.areaM2 ?? null, teamSize: p?.teamSize ?? null, openedOn: p?.openedOn ?? null, maturity, values, missing };
    });

    const metrics = METRICS.map((m) => {
      const comparable = rows.filter((r) => r.values[m.key] != null && r.maturity !== "new");
      const excludedNew = rows.filter((r) => r.values[m.key] != null && r.maturity === "new").map((r) => r.storeName);
      const base = { key: m.key, label: m.label, unit: m.unit, comparableStores: comparable.length, excludedNewStores: excludedNew };
      let reason: string | null = null;
      if (!periodComplete) reason = "mes_incompleto";
      else if (comparable.length < MIN_COMPARABLE) reason = "amostra_minima";
      if (reason) {
        return { ...base, ranked: false, reason, minRequired: MIN_COMPARABLE, median: null, confidence: "insuficiente" as const, stores: rows.map((r) => ({ storeId: r.storeId, storeName: r.storeName, value: r.values[m.key], gapVsMedianPct: null, position: null, rank: null })), questions: [] as string[] };
      }
      const med = median(comparable.map((r) => r.values[m.key] as number));
      const ordered = [...comparable].sort((a, b) => m.higherIsBetter ? (b.values[m.key] as number) - (a.values[m.key] as number) : (a.values[m.key] as number) - (b.values[m.key] as number));
      const stores2 = rows.map((r) => {
        const v = r.values[m.key];
        const inSample = v != null && r.maturity !== "new";
        if (!inSample) return { storeId: r.storeId, storeName: r.storeName, value: v, gapVsMedianPct: null, position: null, rank: null };
        const gap = med !== 0 ? round2((((v as number) - med) / Math.abs(med)) * 100) : null;
        const better = gap == null ? 0 : m.higherIsBetter ? gap : -gap; // >0 = melhor que a mediana
        const position = gap == null ? null : Math.abs(better) <= NEAR_BAND_PCT ? "near_median" : better > 0 ? "above_median" : "below_median";
        return { storeId: r.storeId, storeName: r.storeName, value: v, gapVsMedianPct: gap, position, rank: ordered.findIndex((o) => o.storeId === r.storeId) + 1 };
      });
      const questions = stores2.filter((x) => x.position === "below_median" && x.gapVsMedianPct != null && Math.abs(x.gapVsMedianPct) >= QUESTION_GAP_PCT)
        .map((x) => `${x.storeName} está ${Math.abs(x.gapVsMedianPct as number).toFixed(0)}% ${m.higherIsBetter ? "abaixo" : "acima"} da mediana da rede em "${m.label}". O que é diferente nessa loja (ponto, equipe, mix, horário)?`);
      return { ...base, ranked: true, reason: null, minRequired: MIN_COMPARABLE, median: round2(med), confidence: comparable.length >= 5 ? ("media" as const) : ("baixa" as const), stores: stores2, questions };
    });

    const caveats = [
      "Comparação entre lojas é um ponto de partida para PERGUNTAR, não uma conclusão: diferença de resultado não prova causa (ponto, clientela e equipe mudam).",
      "Baseado em um único mês: não enxerga sazonalidade. Por isso a confiança nunca passa de média.",
      "Não é meta e não recomenda fechar loja, contratar nem demitir — essas decisões são humanas e exigem análise própria.",
    ];
    if (!periodComplete) caveats.push("O mês ainda não fechou: faturamento parcial contra custo fixo cheio distorceria a comparação, então não há ranking.");
    const withMissing = rows.filter((r) => r.missing.some((x) => x !== "data_de_abertura")).length;
    if (withMissing) caveats.push(`${withMissing} de ${rows.length} loja(s) com dado faltando — sem m², equipe, faturamento ou custo fixo a loja não entra naquela comparação.`);

    return {
      type: "benchmark" as const, isForecast: false, executes: false, scope: "internal_network", period, periodComplete,
      assumptions: { minComparable: MIN_COMPARABLE, maturityMonths: MATURITY_MONTHS, nearMedianBandPct: NEAR_BAND_PCT, questionGapPct: QUESTION_GAP_PCT },
      stores: rows, metrics, caveats,
    };
  }
}
export default StoreBenchmarkService;
