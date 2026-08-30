/**
 * Retail Ops — Corrida de comissão (ADR-083, Fase G2) — modelo "CARIOCA".
 *
 * Implementa o padrão de premiação da planilha do cliente (corrida mensal +
 * semanal por loja) e a ESCALA semanal de vendedores:
 *
 *  - Faixas NÃO cumulativas sobre o atingimento da cota individual: bateu a
 *    cota → 1% da própria venda; +10% → 1,5%; +20% → 2%; +30% → 3% (vale a
 *    MAIOR faixa alcançada, nunca a soma — "o percentual não é acumulativo").
 *  - Prêmio de P.A (peças ÷ atendimentos ≥ 2,50) só com cota batida.
 *  - Corrida SEMANAL por loja: 1º do ranking da semana COM cota batida ganha
 *    faixa sobre a venda da semana (+P.A); 2º com cota ganha 0,5%.
 *  - Prêmio de DESVIO DE COTA da REDE (mensal): 1º/2º maiores desvios
 *    ((venda/cota)−1) entre vendedores com cota batida, valor fixo.
 *  - GERENTE: 1% sobre a venda da loja COM OU SEM cota (faixa base min:0);
 *    faixas maiores e P.A só com cota batida; faixas sobre a venda própria;
 *    corrida semanal da loja; desvio de cota entre LOJAS (1º/2º fixo).
 *
 * Decisões:
 *  - RN-G2-001: TUDO é derivado por query na hora da consulta (nenhum contador
 *    mutável — lição RN-004). Persistir = gerar RUN draft da Fase G; a
 *    aprovação segue humana (D7).
 *  - RN-G2-002: cota individual é a cadastrada por semana em
 *    `retail_seller_quotas`; SEM cadastro, deriva da escala: cota diária da
 *    loja ÷ nº de escalados no dia (o "COTA ÷ 4" da folha de fechamento).
 *    Sem cota resolvível (nem cadastro nem escala) NÃO há prêmio condicionado
 *    à cota — a linha sai marcada `quotaSource:'none'` pro gestor corrigir.
 *  - RN-G2-003: semanas fecham no SÁBADO (padrão da planilha); um começo de
 *    mês quebrado com menos de 4 dias cola na semana seguinte (01/08 sábado
 *    pertence à "1ª semana 01→08/08").
 *  - RN-G2-004: "paga só quem trabalhou o mês inteiro" NÃO é automático — a
 *    apuração expõe dias escalados/folgas da escala e o gestor decide na
 *    aprovação (o sistema não mede ausência real).
 *  - RN-G2-005: P.A usa atendimentos do lançamento manual/foto
 *    (`retail_seller_sales.atendimentos`) somados aos atendimentos ENCERRADOS
 *    do Retail Floor (ADR-150) quando a loja usa a lista da vez.
 *  - Plano por loja: `retail_commission_plans.store_id` específico tem
 *    precedência sobre o da rede ('*'), que cai no DEFAULT_PLAN (números da
 *    planilha CARIOCA). Config é editável na UI — os valores NÃO são fixos.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { RetailCommissionService } from "./RetailCommissionService.js";
import { RetailMonthWeeksService } from "./RetailMonthWeeksService.js";

const round2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;
const norm = (s: any) => String(s || "").trim().toLowerCase();
function safeParse(s: any): any { try { return JSON.parse(s ?? "null"); } catch { return null; } }

export type Tier = { min: number; percent: number };
/**
 * Prêmios de podium (1º/2º/3º) por dimensão do "Ranking da Rede" (Fase G3).
 * Cada array define os prêmios em R$ nas posições 1/2/3 (vazio = não paga).
 * Só entra quem bateu a própria cota do mês (RN-G3-001).
 */
export type NetworkChampionPrizes = {
  monthlySales: number[];      // "melhor vendedor da rede no mês"
  monthlyPa: number[];         // maior P.A com min. de atendimentos
  monthlyPieces: number[];     // quem vendeu mais peças
  bestWeekSales: number[];     // melhor semana ISOLADA do mês
  bestFortnightSales: number[];// melhor quinzena (1ª quinzena OU 2ª — o melhor bloco)
  minAttendancesForPa: number; // piso pra entrar no ranking de P.A (evita "1 AT + 5 peças")
};
export type RacePlan = {
  name: string;
  seller: {
    monthlyTiers: Tier[];
    monthlyPa: { min: number; amount: number };
    weeklyFirstTiers: Tier[];
    weeklyFirstPa: { min: number; amount: number };
    weeklySecondPercent: number;
    networkDeviationPrizes: number[];
    requiresFullMonth: boolean;
    networkChampions?: NetworkChampionPrizes;
  };
  manager: {
    storeMonthlyTiers: Tier[];
    ownMonthlyTiers: Tier[];
    monthlyPa: { min: number; amount: number };
    weeklyStoreTiers: Tier[];
    weeklyOwnTiers: Tier[];
    weeklyPa: { min: number; amount: number };
    networkDeviationPrizes: number[];
  };
};

/** Números da planilha "CARIOCA AGOSTO 26" — ponto de partida editável. */
export const DEFAULT_RACE_PLAN: RacePlan = {
  name: "Corrida padrão (planilha CARIOCA)",
  seller: {
    monthlyTiers: [
      { min: 1.0, percent: 1 }, { min: 1.1, percent: 1.5 }, { min: 1.2, percent: 2 }, { min: 1.3, percent: 3 },
    ],
    monthlyPa: { min: 2.5, amount: 50 },
    weeklyFirstTiers: [{ min: 1.0, percent: 1 }, { min: 1.2, percent: 2 }, { min: 1.3, percent: 3 }],
    weeklyFirstPa: { min: 2.5, amount: 30 },
    weeklySecondPercent: 0.5,
    networkDeviationPrizes: [250, 100],
    requiresFullMonth: true,
    // Ranking da Rede (Fase G3) — números de partida, editáveis. Só entra quem
    // bateu a própria cota do mês (RN-G3-001). O prêmio soma no total, não
    // substitui as outras faixas — é uma camada extra de "campeão do longo".
    networkChampions: {
      monthlySales: [500, 300, 150],
      monthlyPa: [200, 100, 50],
      monthlyPieces: [200, 100, 50],
      bestWeekSales: [150, 100, 50],
      bestFortnightSales: [200, 100, 50],
      minAttendancesForPa: 20,
    },
  },
  manager: {
    // min:0 = o 1% da loja sai COM OU SEM cota batida; as faixas maiores só
    // se alcançam com atingimento ≥ 110% (cota batida por definição).
    storeMonthlyTiers: [
      { min: 0, percent: 1 }, { min: 1.1, percent: 1.5 }, { min: 1.2, percent: 2 }, { min: 1.3, percent: 3 },
    ],
    ownMonthlyTiers: [
      { min: 1.0, percent: 1 }, { min: 1.15, percent: 1.5 }, { min: 1.2, percent: 2 }, { min: 1.3, percent: 3 },
    ],
    monthlyPa: { min: 2.5, amount: 50 },
    weeklyStoreTiers: [{ min: 1.0, percent: 1 }, { min: 1.3, percent: 2 }],
    weeklyOwnTiers: [{ min: 1.15, percent: 1 }, { min: 1.3, percent: 2 }],
    weeklyPa: { min: 2.5, amount: 30 },
    networkDeviationPrizes: [300, 150],
  },
};

/** Maior faixa alcançada (não cumulativo). attainment = venda/cota; use -1 quando não há cota. */
function tierFor(tiers: Tier[], attainment: number): Tier | null {
  let chosen: Tier | null = null;
  for (const t of [...(tiers || [])].sort((a, b) => Number(a.min) - Number(b.min))) {
    if (attainment >= Number(t.min)) chosen = t;
  }
  return chosen;
}

type SellerRow = {
  storeId: string | null; storeName: string; sellerUserId: string | null; sellerName: string;
  matricula: string | null; sales: number; pecas: number; orders: number; source: string;
};

function aliasesOf(userId: string | null, matricula: string | null, name: string): string[] {
  const out: string[] = [];
  if (userId) out.push(`user:${userId}`);
  if (matricula) out.push(`mat:${matricula}`);
  if (name) out.push(`nom:${norm(name)}`);
  return out;
}
function primaryKeyOf(userId: string | null, matricula: string | null, name: string): string {
  return aliasesOf(userId, matricula, name)[0] || `nom:${norm(name)}`;
}

export class RetailCommissionRaceService {
  // ── Semanas da corrida (RN-G2-003) ─────────────────────────────────────────
  static weeksOfMonth(month: string): Array<{ start: string; end: string }> {
    const [y, m] = month.split("-").map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const weeks: Array<{ start: string; end: string }> = [];
    let cur: string[] = [];
    for (let d = 1; d <= days; d++) {
      const date = `${month}-${String(d).padStart(2, "0")}`;
      if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0 && cur.length) {
        weeks.push({ start: cur[0], end: cur[cur.length - 1] });
        cur = [];
      }
      cur.push(date);
    }
    if (cur.length) weeks.push({ start: cur[0], end: cur[cur.length - 1] });
    if (weeks.length > 1) {
      const firstLen = (Date.parse(weeks[0].end) - Date.parse(weeks[0].start)) / 86400000 + 1;
      if (firstLen < 4) { weeks[1] = { start: weeks[0].start, end: weeks[1].end }; weeks.shift(); }
    }
    return weeks;
  }

  static monthRange(month: string): { start: string; end: string } {
    const [y, m] = month.split("-").map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, "0")}` };
  }

  /**
   * Semanas efetivas do mês pra ESTA org: override em `retail_month_weeks`
   * (RN-G2c-001) tem precedência sobre o padrão CARIOCA. Fallback silencioso
   * (RN-G2c-002) — org sem override continua com `weeksOfMonth(month)` clássico.
   */
  static weeksOfMonthFor(orgId: string, month: string): Array<{ start: string; end: string }> {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month deve ser YYYY-MM");
    const override = RetailMonthWeeksService.getOverride(orgId, month);
    if (override && override.length > 0) return override;
    return this.weeksOfMonth(month);
  }

  // ── Plano ──────────────────────────────────────────────────────────────────
  /** Plano efetivo: loja específica > rede ('*') > default CARIOCA. */
  static getPlan(orgId: string, storeId?: string | null): { plan: RacePlan; source: "store" | "network" | "default" } {
    if (storeId) {
      const sp = db.prepare(`SELECT config_json FROM retail_commission_plans WHERE organization_id = ? AND store_id = ? AND active = 1`).get(orgId, storeId) as any;
      const cfg = safeParse(sp?.config_json);
      if (cfg) return { plan: cfg, source: "store" };
    }
    const net = db.prepare(`SELECT config_json FROM retail_commission_plans WHERE organization_id = ? AND store_id = '*' AND active = 1`).get(orgId) as any;
    const cfg = safeParse(net?.config_json);
    if (cfg) return { plan: cfg, source: "network" };
    return { plan: DEFAULT_RACE_PLAN, source: "default" };
  }

  static savePlan(orgId: string, storeId: string | null, config: RacePlan, actorId?: string): any {
    const sid = storeId || "*";
    // Validação de forma mínima: precisa das duas metades; números viram Number.
    if (!config || typeof config !== "object" || !config.seller || !config.manager) {
      throw new Error("config inválida: precisa de { seller, manager }");
    }
    db.prepare(
      `INSERT INTO retail_commission_plans (id, organization_id, store_id, config_json, active, created_by)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(organization_id, store_id) DO UPDATE SET config_json = excluded.config_json, active = 1, updated_at = CURRENT_TIMESTAMP`
    ).run(randomUUID(), orgId, sid, JSON.stringify(config), actorId || null);
    try { logAuthEvent(orgId, actorId || "system", sid, "RETAIL_COMMISSION_PLAN_SAVED", { storeId: sid }); } catch { /* noop */ }
    return this.getPlan(orgId, storeId);
  }

  // ── Escala semanal ─────────────────────────────────────────────────────────
  static getSchedule(orgId: string, storeId: string, start: string, end: string): any[] {
    return db.prepare(
      `SELECT work_date, seller_key, seller_name, status FROM retail_schedule_entries
        WHERE organization_id = ? AND store_id = ? AND work_date BETWEEN ? AND ?
        ORDER BY work_date, seller_name`
    ).all(orgId, storeId, start, end) as any[];
  }

  /**
   * Regrava a escala do intervalo (grade da semana): apaga o intervalo e insere
   * o payload — é planejamento, não documento (ver header da tabela).
   */
  static saveSchedule(orgId: string, storeId: string, start: string, end: string, entries: Array<{ date: string; sellerKey: string; sellerName?: string; status: "work" | "off" }>, actorId?: string): any[] {
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM retail_schedule_entries WHERE organization_id = ? AND store_id = ? AND work_date BETWEEN ? AND ?`).run(orgId, storeId, start, end);
      const ins = db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const e of entries) {
        if (!e?.date || !e?.sellerKey) continue;
        if (e.date < start || e.date > end) continue;
        ins.run(randomUUID(), orgId, storeId, e.date, String(e.sellerKey), e.sellerName || null, e.status === "off" ? "off" : "work", actorId || null);
      }
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_SCHEDULE_SAVED", { storeId, start, end, entries: entries.length }); } catch { /* noop */ }
    return this.getSchedule(orgId, storeId, start, end);
  }

  /** Copia a escala de uma semana pra outra (mesmos dias-da-semana, offset em dias). */
  static copyScheduleWeek(orgId: string, storeId: string, fromStart: string, toStart: string, days = 7, actorId?: string): any[] {
    const offset = Math.round((Date.parse(toStart) - Date.parse(fromStart)) / 86400000);
    const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
    const fromEnd = addDays(fromStart, days - 1);
    const src = this.getSchedule(orgId, storeId, fromStart, fromEnd);
    const entries = src.map((e: any) => ({ date: addDays(e.work_date, offset), sellerKey: e.seller_key, sellerName: e.seller_name, status: e.status }));
    return this.saveSchedule(orgId, storeId, toStart, addDays(toStart, days - 1), entries as any, actorId);
  }

  // ── Cota individual ────────────────────────────────────────────────────────
  static listSellerQuotas(orgId: string, storeId: string, weekStarts: string[]): any[] {
    if (!weekStarts.length) return [];
    const ph = weekStarts.map(() => "?").join(",");
    return db.prepare(
      `SELECT store_id, seller_key, seller_name, week_start, quota_amount FROM retail_seller_quotas
        WHERE organization_id = ? AND store_id = ? AND week_start IN (${ph})`
    ).all(orgId, storeId, ...weekStarts) as any[];
  }

  static setSellerQuotas(orgId: string, storeId: string, weekStart: string, quotas: Array<{ sellerKey: string; sellerName?: string; amount: number }>, actorId?: string): any[] {
    const up = db.prepare(
      `INSERT INTO retail_seller_quotas (id, organization_id, store_id, seller_key, seller_name, week_start, quota_amount, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, store_id, seller_key, week_start) DO UPDATE SET quota_amount = excluded.quota_amount, seller_name = COALESCE(excluded.seller_name, retail_seller_quotas.seller_name), updated_at = CURRENT_TIMESTAMP`
    );
    const tx = db.transaction(() => {
      for (const q of quotas) {
        if (!q?.sellerKey) continue;
        up.run(randomUUID(), orgId, storeId, String(q.sellerKey), q.sellerName || null, weekStart, round2(q.amount), actorId || null);
      }
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_SELLER_QUOTA_SAVED", { storeId, weekStart, quotas: quotas.length }); } catch { /* noop */ }
    return this.listSellerQuotas(orgId, storeId, [weekStart]);
  }

  // ── Bases derivadas ────────────────────────────────────────────────────────
  /** Cotas diárias da loja no intervalo (retail_store_quotas). */
  private static storeDailyQuotas(orgId: string, storeId: string, start: string, end: string): Map<string, number> {
    const rows = db.prepare(`SELECT quota_date, quota_amount FROM retail_store_quotas WHERE organization_id = ? AND store_id = ? AND quota_date BETWEEN ? AND ?`).all(orgId, storeId, start, end) as any[];
    return new Map(rows.map((r) => [String(r.quota_date), Number(r.quota_amount) || 0]));
  }

  /** Venda oficial da loja no intervalo = fechamentos diários (Fase G). */
  private static storeSales(orgId: string, storeId: string, start: string, end: string): number {
    const q = db.prepare(`SELECT COALESCE(SUM(informed_total),0) AS s FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND closing_date BETWEEN ? AND ? AND status != 'rejected'`).get(orgId, storeId, start, end) as any;
    return Number(q?.s || 0);
  }

  /**
   * Atendimentos por (loja, vendedor) no intervalo (RN-G2-005): lançamento
   * manual/foto (`atendimentos` da folha) + atendimentos ENCERRADOS do Retail
   * Floor. Chave = aliases (user:/mat:/nom:) → soma.
   */
  private static attendancesByStoreSeller(orgId: string, start: string, end: string): Map<string, number> {
    const map = new Map<string, number>();
    const put = (storeId: string | null, aliases: string[], count: number) => {
      if (!count) return;
      for (const a of aliases) {
        const k = `${storeId || "?"}::${a}`;
        map.set(k, (map.get(k) || 0) + count);
      }
    };
    try {
      const manual = db.prepare(
        `SELECT ss.store_id, ss.matricula, ss.seller_name, rs.user_id, SUM(COALESCE(ss.atendimentos,0)) AS at
           FROM retail_seller_sales ss
           LEFT JOIN retail_sellers rs ON rs.organization_id = ss.organization_id AND rs.matricula = ss.matricula
          WHERE ss.organization_id = ? AND ss.sale_date BETWEEN ? AND ?
          GROUP BY ss.store_id, COALESCE(NULLIF(ss.matricula,''), LOWER(TRIM(ss.seller_name)))`
      ).all(orgId, start, end) as any[];
      for (const r of manual) put(r.store_id || null, aliasesOf(r.user_id || null, r.matricula || null, r.seller_name), Number(r.at) || 0);
    } catch { /* coluna pode não existir em DB antigo entre deploy e migração */ }
    try {
      const floor = db.prepare(
        `SELECT a.store_id, rs.matricula, rs.name, rs.user_id, COUNT(*) AS at
           FROM retail_floor_attendances a
           JOIN retail_sellers rs ON rs.id = a.seller_id AND rs.organization_id = a.organization_id
          WHERE a.organization_id = ? AND date(a.started_at) BETWEEN ? AND ? AND a.ended_at IS NOT NULL
          GROUP BY a.store_id, a.seller_id`
      ).all(orgId, start, end) as any[];
      for (const r of floor) put(r.store_id || null, aliasesOf(r.user_id || null, r.matricula || null, r.name), Number(r.at) || 0);
    } catch { /* módulo retail_floor pode não ter tabelas em orgs antigas */ }
    return map;
  }

  /**
   * Maior valor entre os aliases: as fontes acumulam em todos os aliases que
   * conhecem (manual conhece mat:/nom:, floor conhece user:/mat:/nom:), então
   * o alias compartilhado carrega a soma completa — o máximo é o total certo
   * (nunca soma entre aliases, que contaria duas vezes).
   */
  private static lookupByAlias(map: Map<string, number>, storeId: string | null, aliases: string[]): number {
    let best = 0;
    for (const a of aliases) {
      const v = map.get(`${storeId || "?"}::${a}`);
      if (typeof v === "number" && v > best) best = v;
    }
    return best;
  }

  /**
   * Cota SEMANAL do vendedor (RN-G2-002): cadastrada > derivada da escala
   * (cota diária da loja ÷ escalados 'work' do dia) > none.
   */
  private static resolveWeeklyQuota(
    orgId: string, storeId: string, week: { start: string; end: string }, aliases: string[],
    explicit: Map<string, { amount: number }>, schedule: any[], daily: Map<string, number>
  ): { amount: number; source: "explicit" | "schedule" | "none" } {
    for (const a of aliases) {
      const hit = explicit.get(`${week.start}::${a}`);
      if (hit) return { amount: hit.amount, source: "explicit" };
    }
    // Derivada da escala: pra cada dia da semana em que ESTE vendedor está
    // escalado 'work', soma cotaDiária ÷ nºEscalados(dia).
    const aliasSet = new Set(aliases);
    let sum = 0, any = false;
    const byDate = new Map<string, any[]>();
    for (const e of schedule) {
      if (e.work_date < week.start || e.work_date > week.end) continue;
      const arr = byDate.get(e.work_date) || [];
      arr.push(e); byDate.set(e.work_date, arr);
    }
    for (const [date, entries] of byDate) {
      const working = entries.filter((e) => e.status === "work");
      if (!working.length) continue;
      const mine = working.some((e) => aliasSet.has(e.seller_key));
      if (!mine) continue;
      const dq = daily.get(date) || 0;
      if (dq > 0) { sum += dq / working.length; any = true; }
    }
    return any ? { amount: round2(sum), source: "schedule" } : { amount: 0, source: "none" };
  }

  // ── A corrida ──────────────────────────────────────────────────────────────
  /**
   * Apuração da corrida do mês (só leitura — nada persiste). storeId opcional
   * restringe a UMA loja, mas o prêmio de desvio da REDE sempre considera
   * todas (senão o ranking mentiria).
   */
  static raceMonth(orgId: string, month: string, opts?: { storeId?: string | null }): any {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month deve ser YYYY-MM");
    const weeks = this.weeksOfMonthFor(orgId, month);
    const { start: mStart, end: mEnd } = this.monthRange(month);
    const stores = db.prepare(`SELECT id, name, manager_user_id FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`).all(orgId) as any[];

    const monthRows = RetailCommissionService.salesBySellerStore(orgId, mStart, mEnd);
    const weekRowsCache = weeks.map((w) => RetailCommissionService.salesBySellerStore(orgId, w.start, w.end));
    const atMonth = this.attendancesByStoreSeller(orgId, mStart, mEnd);
    const atWeeks = weeks.map((w) => this.attendancesByStoreSeller(orgId, w.start, w.end));
    const daysInMonth = Number(mEnd.slice(-2));

    const storeReports: any[] = [];
    for (const st of stores) {
      const { plan } = this.getPlan(orgId, st.id);
      const sPlan = plan.seller || DEFAULT_RACE_PLAN.seller;
      const mPlan = plan.manager || DEFAULT_RACE_PLAN.manager;
      const schedule = this.getSchedule(orgId, st.id, mStart, mEnd);
      const daily = this.storeDailyQuotas(orgId, st.id, mStart, mEnd);
      const quotaRows = this.listSellerQuotas(orgId, st.id, weeks.map((w) => w.start));
      const explicit = new Map<string, { amount: number }>();
      for (const q of quotaRows) explicit.set(`${q.week_start}::${q.seller_key}`, { amount: Number(q.quota_amount) || 0 });

      // Roster do mês: vendas ∪ escala ∪ cotas cadastradas (vendedor com cota e
      // sem venda precisa aparecer — cota não batida também é informação).
      type Roster = { aliases: string[]; name: string; userId: string | null; matricula: string | null };
      const roster = new Map<string, Roster>();
      const addRoster = (userId: string | null, matricula: string | null, name: string) => {
        const aliases = aliasesOf(userId, matricula, name);
        for (const a of aliases) if (roster.has(a)) {
          const r = roster.get(a)!;
          for (const al of aliases) if (!r.aliases.includes(al)) r.aliases.push(al);
          if (!r.userId && userId) r.userId = userId;
          if (!r.matricula && matricula) r.matricula = matricula;
          return r;
        }
        const r: Roster = { aliases, name, userId, matricula };
        for (const a of aliases) roster.set(a, r);
        return r;
      };
      for (const row of monthRows.filter((r: SellerRow) => r.storeId === st.id)) addRoster(row.sellerUserId, row.matricula, row.sellerName);
      for (const e of schedule) {
        const mat = e.seller_key.startsWith("mat:") ? e.seller_key.slice(4) : null;
        const uid = e.seller_key.startsWith("user:") ? e.seller_key.slice(5) : null;
        addRoster(uid, mat, e.seller_name || e.seller_key);
      }
      for (const q of quotaRows) {
        const mat = q.seller_key.startsWith("mat:") ? q.seller_key.slice(4) : null;
        const uid = q.seller_key.startsWith("user:") ? q.seller_key.slice(5) : null;
        addRoster(uid, mat, q.seller_name || q.seller_key);
      }
      const rosterList = Array.from(new Set(roster.values()));

      const findRow = (rows: SellerRow[], r: Roster): SellerRow | null => {
        const set = new Set(r.aliases);
        return rows.find((x) => x.storeId === st.id && aliasesOf(x.sellerUserId, x.matricula, x.sellerName).some((a) => set.has(a))) || null;
      };

      // ── Semanal ──
      const weekly = weeks.map((w, wi) => {
        const rows = weekRowsCache[wi];
        const perSeller = rosterList.map((r) => {
          const row = findRow(rows as any, r);
          const sales = round2(row?.sales || 0);
          const pecas = Number(row?.pecas || 0);
          const at = Number(this.lookupByAlias(atWeeks[wi], st.id, r.aliases) || 0);
          const quota = this.resolveWeeklyQuota(orgId, st.id, w, r.aliases, explicit, schedule, daily);
          const pa = at > 0 ? round2(pecas / at) : 0;
          const deviation = quota.amount > 0 ? round2((sales / quota.amount - 1) * 10000) / 100 : null; // %
          return { sellerKey: primaryKeyOf(r.userId, r.matricula, r.name), sellerName: r.name, sales, pecas, at, pa, quota: quota.amount, quotaSource: quota.source, deviation, rank: 0, prize: { percent: 0, amount: 0, paBonus: 0, total: 0, reasons: [] as string[] } };
        }).sort((a, b) => b.sales - a.sales);
        perSeller.forEach((s, i) => { s.rank = i + 1; });

        // 1º e 2º da semana — prêmio SÓ com cota batida (e cota resolvível).
        const apply = (s: any, pos: 1 | 2) => {
          if (!s || s.sales <= 0) return;
          if (s.quotaSource === "none") { s.prize.reasons.push("sem_cota"); return; }
          if (s.quota <= 0 || s.sales < s.quota) { s.prize.reasons.push("cota_nao_batida"); return; }
          if (pos === 1) {
            const t = tierFor(sPlan.weeklyFirstTiers, s.sales / s.quota);
            s.prize.percent = t?.percent || 0;
            s.prize.amount = round2(s.sales * (t?.percent || 0) / 100);
            if (s.at > 0 && s.pa >= Number(sPlan.weeklyFirstPa?.min ?? 2.5)) s.prize.paBonus = Number(sPlan.weeklyFirstPa?.amount || 0);
          } else {
            s.prize.percent = Number(sPlan.weeklySecondPercent || 0);
            s.prize.amount = round2(s.sales * s.prize.percent / 100);
          }
          s.prize.total = round2(s.prize.amount + s.prize.paBonus);
        };
        apply(perSeller[0], 1);
        apply(perSeller[1], 2);

        const storeWeekQuota = round2(Array.from(daily.entries()).filter(([d]) => d >= w.start && d <= w.end).reduce((a, [, v]) => a + v, 0));
        const storeWeekSales = round2(this.storeSales(orgId, st.id, w.start, w.end));
        return { ...w, sellers: perSeller, storeQuota: storeWeekQuota, storeSales: storeWeekSales };
      });

      // ── Mensal por vendedor ──
      const monthly = rosterList.map((r) => {
        const row = findRow(monthRows as any, r);
        const sales = round2(row?.sales || 0);
        const pecas = Number(row?.pecas || 0);
        const at = Number(this.lookupByAlias(atMonth, st.id, r.aliases) || 0);
        const pa = at > 0 ? round2(pecas / at) : 0;
        const key = primaryKeyOf(r.userId, r.matricula, r.name);
        // Cota mensal = soma das semanais resolvidas (cadastrada ou derivada).
        let quota = 0; let anyExplicit = false; let anyResolved = false;
        for (const w of weeks) {
          const q = this.resolveWeeklyQuota(orgId, st.id, w, r.aliases, explicit, schedule, daily);
          quota += q.amount;
          if (q.source === "explicit") anyExplicit = true;
          if (q.source !== "none") anyResolved = true;
        }
        quota = round2(quota);
        const quotaSource = anyExplicit ? "explicit" : (anyResolved ? "schedule" : "none");
        const attainment = quota > 0 ? sales / quota : 0;
        const quotaHit = quota > 0 && sales >= quota;
        const t = quotaHit ? tierFor(sPlan.monthlyTiers, attainment) : null;
        const tierAmount = round2(sales * (t?.percent || 0) / 100);
        const paBonus = quotaHit && at > 0 && pa >= Number(sPlan.monthlyPa?.min ?? 2.5) ? Number(sPlan.monthlyPa?.amount || 0) : 0;
        const weeklyTotal = round2(weekly.reduce((acc, w) => acc + (w.sellers.find((s: any) => s.sellerKey === key)?.prize.total || 0), 0));
        const aliasSet = new Set(r.aliases);
        const scheduledDays = schedule.filter((e) => e.status === "work" && aliasSet.has(e.seller_key)).length;
        const offDays = schedule.filter((e) => e.status === "off" && aliasSet.has(e.seller_key)).length;
        return {
          sellerKey: key, sellerName: r.name, matricula: r.matricula, sellerUserId: r.userId,
          sales, pecas, at, pa, quota, quotaSource,
          attainment: quota > 0 ? round2(attainment * 10000) / 100 : null, // %
          quotaHit, tierPercent: t?.percent || 0, tierAmount, paBonus, weeklyTotal,
          deviationPrize: 0, // preenchido no ranking da rede
          scheduledDays, offDays, daysInMonth,
          total: 0, // fechado depois do desvio
        };
      }).sort((a, b) => b.sales - a.sales);

      // ── Gerente ──
      const storeQuotaMonth = round2(Array.from(daily.values()).reduce((a, v) => a + v, 0));
      const storeSalesMonth = round2(this.storeSales(orgId, st.id, mStart, mEnd));
      let manager: any = null;
      if (st.manager_user_id) {
        const u = db.prepare(`SELECT name, email FROM users WHERE id = ? AND organization_id = ?`).get(st.manager_user_id, orgId) as any;
        const own = monthly.find((s) => s.sellerUserId === st.manager_user_id) || null;
        const storeAtt = storeQuotaMonth > 0 ? storeSalesMonth / storeQuotaMonth : 0;
        const storeQuotaHit = storeQuotaMonth > 0 && storeSalesMonth >= storeQuotaMonth;
        // Faixa base min:0 sai sempre; faixas com min ≥ 1 só valem com cota.
        const stTier = tierFor((mPlan.storeMonthlyTiers || []).filter((t) => Number(t.min) === 0 || storeQuotaHit), storeAtt);
        const storeTierAmount = round2(storeSalesMonth * (stTier?.percent || 0) / 100);
        const ownTier = own && own.quotaHit ? tierFor(mPlan.ownMonthlyTiers, own.quota > 0 ? own.sales / own.quota : 0) : null;
        const ownTierAmount = own ? round2(own.sales * (ownTier?.percent || 0) / 100) : 0;
        // P.A da LOJA (peças/atendimentos somados) com cota da loja batida.
        const storePecas = monthly.reduce((a, s) => a + s.pecas, 0);
        const storeAt = monthly.reduce((a, s) => a + s.at, 0);
        const storePa = storeAt > 0 ? round2(storePecas / storeAt) : 0;
        const paBonus = storeQuotaHit && storeAt > 0 && storePa >= Number(mPlan.monthlyPa?.min ?? 2.5) ? Number(mPlan.monthlyPa?.amount || 0) : 0;
        const weeklyPrizes = weekly.map((w) => {
          const hit = w.storeQuota > 0 && w.storeSales >= w.storeQuota;
          const t = hit ? tierFor(mPlan.weeklyStoreTiers, w.storeSales / w.storeQuota) : null;
          const amount = round2(w.storeSales * (t?.percent || 0) / 100);
          const ownWeek = own ? w.sellers.find((s: any) => s.sellerKey === own.sellerKey) : null;
          const ownHit = ownWeek && ownWeek.quota > 0 && ownWeek.sales >= ownWeek.quota;
          const ot = ownHit ? tierFor(mPlan.weeklyOwnTiers, ownWeek.sales / ownWeek.quota) : null;
          const ownAmount = ownWeek ? round2(ownWeek.sales * (ot?.percent || 0) / 100) : 0;
          const wPecas = w.sellers.reduce((a: number, s: any) => a + s.pecas, 0);
          const wAt = w.sellers.reduce((a: number, s: any) => a + s.at, 0);
          const wPa = wAt > 0 ? round2(wPecas / wAt) : 0;
          const wPaBonus = hit && wAt > 0 && wPa >= Number(mPlan.weeklyPa?.min ?? 2.5) ? Number(mPlan.weeklyPa?.amount || 0) : 0;
          return { start: w.start, end: w.end, storeQuota: w.storeQuota, storeSales: w.storeSales, storePercent: t?.percent || 0, storeAmount: amount, ownPercent: ot?.percent || 0, ownAmount, paBonus: wPaBonus };
        });
        const weeklyTotal = round2(weeklyPrizes.reduce((a, w) => a + w.storeAmount + w.ownAmount + w.paBonus, 0));
        manager = {
          userId: st.manager_user_id, name: u?.name || u?.email || st.manager_user_id,
          storeQuota: storeQuotaMonth, storeSales: storeSalesMonth,
          storeAttainment: storeQuotaMonth > 0 ? round2(storeAtt * 10000) / 100 : null,
          storeQuotaHit, storeTierPercent: stTier?.percent || 0, storeTierAmount,
          ownSales: own?.sales || 0, ownQuota: own?.quota || 0, ownTierPercent: ownTier?.percent || 0, ownTierAmount,
          storePa, paBonus, weekly: weeklyPrizes, weeklyTotal,
          deviationPrize: 0,
          total: 0,
        };
      }
      storeReports.push({
        storeId: st.id, storeName: st.name, weeks: weekly, monthly,
        store: { quota: storeQuotaMonth, sales: storeSalesMonth, deviation: storeQuotaMonth > 0 ? round2((storeSalesMonth / storeQuotaMonth - 1) * 10000) / 100 : null },
        manager,
      });
    }

    // ── Desvio de cota da REDE (sempre considera todas as lojas) ──
    const netPlan = this.getPlan(orgId, null).plan;
    const sellerPrizes = (netPlan.seller?.networkDeviationPrizes || []).map(Number);
    const eligibleSellers = storeReports
      .flatMap((sr) => sr.monthly.map((s: any) => ({ ...s, storeId: sr.storeId, storeName: sr.storeName })))
      .filter((s: any) => s.quotaHit)
      .sort((a: any, b: any) => (b.attainment || 0) - (a.attainment || 0));
    eligibleSellers.forEach((s: any, i: number) => {
      if (i < sellerPrizes.length && sellerPrizes[i] > 0) {
        s.deviationPrize = sellerPrizes[i];
        const sr = storeReports.find((x) => x.storeId === s.storeId);
        const row = sr?.monthly.find((m: any) => m.sellerKey === s.sellerKey);
        if (row) row.deviationPrize = sellerPrizes[i];
      }
    });
    const managerPrizes = (netPlan.manager?.networkDeviationPrizes || []).map(Number);
    const eligibleStores = storeReports
      .filter((sr) => sr.manager && sr.store.quota > 0 && sr.store.sales >= sr.store.quota)
      .sort((a, b) => (b.store.deviation || 0) - (a.store.deviation || 0));
    eligibleStores.forEach((sr, i) => {
      if (i < managerPrizes.length && managerPrizes[i] > 0) sr.manager.deviationPrize = managerPrizes[i];
    });

    // ── Ranking da REDE (Fase G3) — 5 dimensões × podium 1º/2º/3º ──
    // O "campeão do longo": o melhor vendedor da rede em cada dimensão ganha
    // prêmio EXTRA em cima do que já ganharia pela cota/PA/semanal/desvio.
    // Elegibilidade dura (RN-G3-001): só vendedor que bateu a própria cota do
    // mês entra — evita coroar top de loja fraca por acaso, alinhado à regra
    // da planilha CARIOCA ("prêmio semanal e desvio SÓ com cota batida").
    // Prêmios (`networkChampions`) são configuráveis por loja OU rede — sem
    // config, cai em `DEFAULT_RACE_PLAN.seller.networkChampions`.
    const champCfg: NetworkChampionPrizes = (netPlan.seller as any)?.networkChampions
      || DEFAULT_RACE_PLAN.seller.networkChampions!;
    const eligibleAll = storeReports
      .flatMap((sr) => sr.monthly.map((s: any) => ({ s, sr })))
      .filter(({ s }) => s.quotaHit);

    // Pré-cálculo por vendedor: melhor semana + melhor quinzena isolados.
    // Semana e quinzena vêm da mesma segmentação da corrida (RN-G2-003).
    const bestWeekOf = new Map<string, number>();
    const bestFortnightOf = new Map<string, number>();
    for (const sr of storeReports) {
      // Melhor SEMANA isolada — o pico do mês (a "explosão de sábado").
      for (const s of sr.monthly) {
        let best = 0;
        for (const w of sr.weeks) {
          const row = w.sellers.find((x: any) => x.sellerKey === s.sellerKey);
          if (row && row.sales > best) best = row.sales;
        }
        bestWeekOf.set(`${sr.storeId}::${s.sellerKey}`, round2(best));
      }
      // Melhor QUINZENA — soma da 1ª metade das semanas VS soma da 2ª metade.
      const half = Math.max(1, Math.floor(sr.weeks.length / 2));
      for (const s of sr.monthly) {
        let firstHalf = 0, secondHalf = 0;
        sr.weeks.forEach((w: any, i: number) => {
          const row = w.sellers.find((x: any) => x.sellerKey === s.sellerKey);
          const v = row?.sales || 0;
          if (i < half) firstHalf += v; else secondHalf += v;
        });
        bestFortnightOf.set(`${sr.storeId}::${s.sellerKey}`, round2(Math.max(firstHalf, secondHalf)));
      }
    }

    // Aplica prêmios de podium numa dimensão. `metric` extrai o valor
    // ordenado; `filter` (opcional) restringe elegibilidade adicional
    // (ex.: min. de atendimentos pra ranking de P.A). Empate: preserva
    // a ordem estável do sort (first-in wins) — coerente com a planilha
    // que também não trata empate (posição vale).
    const applyPodium = (
      metric: (item: { s: any; sr: any }) => number,
      prizes: number[],
      filter?: (item: { s: any; sr: any }) => boolean,
      key?: string,
    ) => {
      const pool = filter ? eligibleAll.filter(filter) : eligibleAll.slice();
      pool.sort((a, b) => metric(b) - metric(a));
      const podium: any[] = [];
      pool.slice(0, Math.max(prizes.length, 3)).forEach((item, i) => {
        const prize = i < prizes.length ? Number(prizes[i] || 0) : 0;
        const rank = i + 1;
        if (prize > 0) {
          item.s.championPrize = round2((item.s.championPrize || 0) + prize);
          item.s.championWins = item.s.championWins || [];
          item.s.championWins.push({ dimension: key || "", rank, prize });
        }
        podium.push({
          rank, sellerKey: item.s.sellerKey, sellerName: item.s.sellerName,
          storeId: item.sr.storeId, storeName: item.sr.storeName,
          metric: round2(metric(item)), prize,
        });
      });
      return podium;
    };

    for (const { s } of eligibleAll) { s.championPrize = 0; s.championWins = []; }
    const networkChampions = {
      monthlySales: applyPodium(({ s }) => s.sales, champCfg.monthlySales || [], undefined, "monthlySales"),
      monthlyPa: applyPodium(({ s }) => s.pa, champCfg.monthlyPa || [], ({ s }) => s.at >= Number(champCfg.minAttendancesForPa || 0), "monthlyPa"),
      monthlyPieces: applyPodium(({ s }) => s.pecas, champCfg.monthlyPieces || [], undefined, "monthlyPieces"),
      bestWeekSales: applyPodium(({ s, sr }) => bestWeekOf.get(`${sr.storeId}::${s.sellerKey}`) || 0, champCfg.bestWeekSales || [], undefined, "bestWeekSales"),
      bestFortnightSales: applyPodium(({ s, sr }) => bestFortnightOf.get(`${sr.storeId}::${s.sellerKey}`) || 0, champCfg.bestFortnightSales || [], undefined, "bestFortnightSales"),
      minAttendancesForPa: Number(champCfg.minAttendancesForPa || 0),
    };

    // Totais fechados só depois do desvio + campeões da rede.
    for (const sr of storeReports) {
      for (const s of sr.monthly) s.total = round2(s.tierAmount + s.paBonus + s.weeklyTotal + s.deviationPrize + (s.championPrize || 0));
      if (sr.manager) sr.manager.total = round2(sr.manager.storeTierAmount + sr.manager.ownTierAmount + sr.manager.paBonus + sr.manager.weeklyTotal + sr.manager.deviationPrize);
      sr.totals = {
        sellers: round2(sr.monthly.reduce((a: number, s: any) => a + s.total, 0)),
        manager: sr.manager?.total || 0,
      };
    }

    const visible = opts?.storeId ? storeReports.filter((sr) => sr.storeId === opts.storeId) : storeReports;
    return {
      month, weeks, stores: visible,
      networkDeviation: {
        sellers: eligibleSellers.slice(0, Math.max(sellerPrizes.length, 3)).map((s: any) => ({ sellerKey: s.sellerKey, sellerName: s.sellerName, storeName: s.storeName, attainment: s.attainment, prize: s.deviationPrize })),
        stores: eligibleStores.slice(0, Math.max(managerPrizes.length, 3)).map((sr) => ({ storeId: sr.storeId, storeName: sr.storeName, deviation: sr.store.deviation, prize: sr.manager.deviationPrize })),
      },
      networkChampions,
      totals: {
        sellers: round2(storeReports.reduce((a, sr) => a + sr.totals.sellers, 0)),
        managers: round2(storeReports.reduce((a, sr) => a + (sr.totals.manager || 0), 0)),
        grand: round2(storeReports.reduce((a, sr) => a + sr.totals.sellers + (sr.totals.manager || 0), 0)),
      },
    };
  }

  /**
   * PLACAR POR VENDEDOR (pedido do lojista): por vendedor da loja, o REALIZADO
   * vs a COTA em quatro janelas — DIA / SEMANA / QUINZENA / MÊS — com a cota
   * SEMANAL como BASE (decisão do dono):
   *   - semana:   cota semanal resolvida (cadastrada > derivada da escala);
   *   - dia:      cota da semana ÷ dias escalados 'work' do vendedor na semana
   *               (fallback 6 quando não há escala);
   *   - quinzena: 2 × cota semanal (semana atual + anterior); realizado = 14 dias;
   *   - mês:      soma das cotas semanais do mês; realizado = mês inteiro.
   * Só leitura, nada persiste. Isolado por org/loja. `refDate` = dia de referência.
   */
  static sellerPeriodScoreboard(orgId: string, storeId: string, refDate: string): any {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(refDate)) throw new Error("refDate deve ser YYYY-MM-DD");
    const store = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    if (!store) throw new Error("Loja não encontrada.");
    const addDays = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
    const dow = new Date(refDate + "T12:00:00Z").getUTCDay(); // 0 = domingo
    const weekStart = addDays(refDate, -dow);
    const weekEnd = addDays(weekStart, 6);
    const prevWeekStart = addDays(weekStart, -7);
    const month = refDate.slice(0, 7);
    const { start: mStart, end: mEnd } = this.monthRange(month);
    // Semanas domingo→sábado que TOCAM o mês — mesma régua da grade de cotas
    // (o lojista cadastra a cota semanal por domingo), para o total do mês bater.
    const monthWeekStarts: string[] = [];
    { let ws = addDays(mStart, -new Date(mStart + "T12:00:00Z").getUTCDay()); while (ws <= mEnd) { monthWeekStarts.push(ws); ws = addDays(ws, 7); } }
    const monthWeeks = monthWeekStarts.map((s) => ({ start: s, end: addDays(s, 6) }));

    const schedule = this.getSchedule(orgId, storeId, mStart, mEnd);
    const daily = this.storeDailyQuotas(orgId, storeId, mStart, mEnd);
    const quotaWeekStarts = Array.from(new Set([weekStart, prevWeekStart, ...monthWeekStarts]));
    const quotaRows = this.listSellerQuotas(orgId, storeId, quotaWeekStarts);
    const explicit = new Map<string, { amount: number }>();
    for (const q of quotaRows) explicit.set(`${q.week_start}::${q.seller_key}`, { amount: Number(q.quota_amount) || 0 });

    const dayRows = RetailCommissionService.salesBySellerStore(orgId, refDate, refDate);
    const weekRows = RetailCommissionService.salesBySellerStore(orgId, weekStart, weekEnd);
    const fortRows = RetailCommissionService.salesBySellerStore(orgId, prevWeekStart, weekEnd);
    const monthRows = RetailCommissionService.salesBySellerStore(orgId, mStart, mEnd);

    // Roster: união de vendas do mês ∪ escala ∪ cotas (vendedor com cota e sem
    // venda também aparece — cota não batida é informação).
    type Roster = { aliases: string[]; name: string; userId: string | null; matricula: string | null };
    const roster = new Map<string, Roster>();
    const addRoster = (userId: string | null, matricula: string | null, name: string) => {
      const aliases = aliasesOf(userId, matricula, name);
      for (const a of aliases) if (roster.has(a)) { const r = roster.get(a)!; for (const al of aliases) if (!r.aliases.includes(al)) r.aliases.push(al); if (!r.userId && userId) r.userId = userId; if (!r.matricula && matricula) r.matricula = matricula; return; }
      const r: Roster = { aliases, name, userId, matricula };
      for (const a of aliases) roster.set(a, r);
    };
    for (const row of monthRows.filter((r) => r.storeId === storeId)) addRoster(row.sellerUserId, row.matricula, row.sellerName);
    for (const e of schedule) { const mat = e.seller_key.startsWith("mat:") ? e.seller_key.slice(4) : null; const uid = e.seller_key.startsWith("user:") ? e.seller_key.slice(5) : null; addRoster(uid, mat, e.seller_name || e.seller_key); }
    for (const q of quotaRows) { const mat = q.seller_key.startsWith("mat:") ? q.seller_key.slice(4) : null; const uid = q.seller_key.startsWith("user:") ? q.seller_key.slice(5) : null; addRoster(uid, mat, q.seller_name || q.seller_key); }
    const rosterList = Array.from(new Set(roster.values()));

    const salesOf = (rows: any[], r: Roster): number => {
      const set = new Set(r.aliases);
      const row = rows.find((x: any) => x.storeId === storeId && aliasesOf(x.sellerUserId, x.matricula, x.sellerName).some((a: string) => set.has(a)));
      return round2(row?.sales || 0);
    };
    const pct = (sales: number, quota: number): number | null => (quota > 0 ? round2((sales / quota) * 10000) / 100 : null);
    const curWeek = { start: weekStart, end: weekEnd };
    const prevWeek = { start: prevWeekStart, end: addDays(prevWeekStart, 6) };

    const sellers = rosterList.map((r) => {
      const wq = this.resolveWeeklyQuota(orgId, storeId, curWeek, r.aliases, explicit, schedule, daily);
      const pq = this.resolveWeeklyQuota(orgId, storeId, prevWeek, r.aliases, explicit, schedule, daily);
      const aliasSet = new Set(r.aliases);
      const scheduledDays = schedule.filter((e: any) => e.status === "work" && e.work_date >= weekStart && e.work_date <= weekEnd && aliasSet.has(e.seller_key)).length;
      const dayDivisor = scheduledDays > 0 ? scheduledDays : 6;
      const weekQuota = round2(wq.amount);
      const dayQuota = round2(weekQuota / dayDivisor);
      const fortnightQuota = round2(weekQuota + pq.amount);
      let monthQuota = 0, anyExplicit = false, anyResolved = false;
      for (const w of monthWeeks) { const q = this.resolveWeeklyQuota(orgId, storeId, w, r.aliases, explicit, schedule, daily); monthQuota += q.amount; if (q.source === "explicit") anyExplicit = true; if (q.source !== "none") anyResolved = true; }
      monthQuota = round2(monthQuota);
      const daySales = salesOf(dayRows, r), weekSales = salesOf(weekRows, r), fortSales = salesOf(fortRows, r), monthSales = salesOf(monthRows, r);
      return {
        sellerKey: primaryKeyOf(r.userId, r.matricula, r.name), sellerName: r.name, matricula: r.matricula,
        quotaSource: wq.source, monthQuotaSource: anyExplicit ? "explicit" : (anyResolved ? "schedule" : "none"), scheduledDaysThisWeek: scheduledDays,
        day: { sales: daySales, quota: dayQuota, attainment: pct(daySales, dayQuota) },
        week: { sales: weekSales, quota: weekQuota, attainment: pct(weekSales, weekQuota) },
        fortnight: { sales: fortSales, quota: fortnightQuota, attainment: pct(fortSales, fortnightQuota) },
        month: { sales: monthSales, quota: monthQuota, attainment: pct(monthSales, monthQuota) },
      };
    }).sort((a, b) => b.month.sales - a.month.sales);

    return {
      storeId, storeName: store.name, refDate, month,
      periods: { day: { start: refDate, end: refDate }, week: { start: weekStart, end: weekEnd }, fortnight: { start: prevWeekStart, end: weekEnd }, month: { start: mStart, end: mEnd } },
      sellers,
    };
  }

  /**
   * Materializa a corrida do mês num RUN draft da Fase G (aprovação humana —
   * D7). Um item por vendedor (com o detalhamento no JSON) + um por gerente.
   */
  static createRaceRun(orgId: string, month: string, actorId?: string): any {
    const race = this.raceMonth(orgId, month);
    const { start, end } = this.monthRange(month);
    const runId = randomUUID();
    let totalSales = 0, totalCommission = 0;
    const insertItem = db.prepare(
      `INSERT INTO retail_commission_items (id, organization_id, run_id, store_id, seller_user_id, seller_name, base_amount, commission_amount, rule_id, calculation_details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    );
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO retail_commission_runs (id, organization_id, period_start, period_end, status, total_sales, total_commission, created_by) VALUES (?, ?, ?, ?, 'draft', 0, 0, ?)`)
        .run(runId, orgId, start, end, actorId || null);
      for (const sr of race.stores) {
        for (const s of sr.monthly) {
          if (s.total <= 0 && s.sales <= 0) continue;
          insertItem.run(randomUUID(), orgId, runId, sr.storeId, s.sellerUserId || null, s.sellerName, s.sales, s.total,
            JSON.stringify({ type: "race", month, tierPercent: s.tierPercent, tierAmount: s.tierAmount, paBonus: s.paBonus, weeklyTotal: s.weeklyTotal, deviationPrize: s.deviationPrize, championPrize: s.championPrize || 0, championWins: s.championWins || [], quota: s.quota, quotaSource: s.quotaSource, pa: s.pa, scheduledDays: s.scheduledDays, offDays: s.offDays, daysInMonth: s.daysInMonth }));
          totalSales += s.sales; totalCommission += s.total;
        }
        if (sr.manager && sr.manager.total > 0) {
          insertItem.run(randomUUID(), orgId, runId, sr.storeId, sr.manager.userId, `${sr.manager.name} (gerente)`, sr.manager.storeSales, sr.manager.total,
            JSON.stringify({ type: "race_manager", month, storeTierPercent: sr.manager.storeTierPercent, storeTierAmount: sr.manager.storeTierAmount, ownTierAmount: sr.manager.ownTierAmount, paBonus: sr.manager.paBonus, weeklyTotal: sr.manager.weeklyTotal, deviationPrize: sr.manager.deviationPrize }));
          totalCommission += sr.manager.total;
        }
      }
      db.prepare(`UPDATE retail_commission_runs SET total_sales = ?, total_commission = ? WHERE id = ?`).run(round2(totalSales), round2(totalCommission), runId);
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", runId, "RETAIL_COMMISSION_RACE_RUN_CREATED", { month, totalCommission: round2(totalCommission) }); } catch { /* noop */ }
    return RetailCommissionService.getRun(orgId, runId);
  }
}
