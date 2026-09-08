/**
 * HealthyReserveService — ADR-201: Reserva Saudável (método das 4 contas / Profit First).
 *
 * O DRE (ADR-128) responde "o que ACONTECEU" (faturamento − despesa = sobra). Este serviço
 * responde a pergunta PRESCRITIVA que o dono realmente faz: "de cada real que entra, quanto
 * DEVERIA ir pra cada bolso, e onde eu estou estourando?". É a lógica do "método das 4 contas":
 *
 *   Lucro (reserva)   — meta piso  (default 10%)
 *   Pró-labore        — meta teto  (default 50%)
 *   Impostos (reserva)— meta       (default 18%)
 *   Operação          — meta teto  (default 22%)
 *
 * BASE DO RATEIO (o coração da honestidade pro varejo, RN-HR-2): os 10/50/18/22 assumem um
 * negócio de SERVIÇO, onde o maior custo é "operação". Numa loja (moda/varejo) o maior custo é o
 * CMV (comprar a mercadoria) — que NÃO está nas 4 contas. Aplicar "operação ≤ 22% do faturamento"
 * cru numa rede de moda acusaria falso estouro. Então o rateio corre sobre a MARGEM BRUTA
 * (receita − CMV) no varejo, e sobre o faturamento (receita líquida) nos demais — configurável.
 *
 * REALIZADO × META só onde dá pra MEDIR com honestidade (RN-HR-3):
 *   - Operação  = despesas por competência (a DRE já agrega). Mensurável. (pode conter impostos)
 *   - Pró-labore= retiradas do tipo `pro_labore` no mês. Mensurável.
 *   - Lucro     = a sobra (resultado − retiradas). Mensurável (o que de fato sobrou pra reservar).
 *   - Impostos  = NÃO medido (misturado nas despesas) → só a META de reserva, com aviso. Nunca finge.
 *
 * Guardrails RN-HR: 1 (advisory — sugere reserva, NUNCA move dinheiro) · 2 (base honesta por
 * setor) · 3 (só compara o que mede; impostos = reserva sugerida, não medição) · 4 (derivado/
 * RN-004, zero tabela nova) · 5 (nunca inventa dinheiro — base ≤ 0 → sem rateio, null≠0) ·
 * 6 (isolado/determinístico) · 7 (reusa a DRE + as retiradas; sem 2º motor financeiro).
 */
import db from "./db.js";
import { ManagerialDreService } from "./ManagerialDreService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const pct2 = (num: number, den: number): number | null => (den > 0 ? round2((num / den) * 100) : null);
const brl = (n: number) => `R$ ${n.toFixed(2).replace(".", ",")}`;

// Alvos padrão do método das 4 contas (% da base).
export const DEFAULT_TARGETS = { profit: 10, prolabore: 50, taxes: 18, ops: 22 } as const;
// Verticais que vendem MERCADORIA com CMV material → base = margem bruta (RN-HR-2).
const RETAIL_VERTICALS = new Set(["varejo", "moda", "food", "hospitalidade", "beleza", "petshop"]);
export type ReserveBaseMode = "revenue" | "gross_margin";
export type ReserveStatus = "ok" | "atencao" | "excesso" | "baixo" | "reserva" | "no_data";

export interface ReserveConfig {
  enabled: boolean;
  targets: { profit: number; prolabore: number; taxes: number; ops: number };
  baseMode: ReserveBaseMode | null;   // null = auto por vertical
}

export interface ReserveAccount {
  key: "lucro" | "prolabore" | "impostos" | "operacao";
  label: string;
  targetPct: number;
  targetAmount: number;               // R$ que DEVERIA ir/reservar
  actualAmount: number | null;        // R$ realizado (null = não medido)
  actualPct: number | null;
  status: ReserveStatus;
  kind: "reserve" | "ceiling" | "floor"; // reserva | teto | piso
  note: string;
}

export interface HealthyReservePlan {
  period: string;
  vertical: string | null;
  baseMode: ReserveBaseMode;
  base: number | null;                // faturamento OU margem bruta
  baseLabel: string;
  available: boolean;
  accounts: ReserveAccount[];
  overallStatus: ReserveStatus;
  caveats: string[];
  disclaimer: string;
}

const DISCLAIMER = "Método das 4 contas — orientação gerencial de reserva, não substitui a contabilidade oficial. Você decide.";

export class HealthyReserveService {
  /** Config por org (alvos + base + flag), com defaults resolvidos. */
  static getConfig(orgId: string): ReserveConfig & { vertical: string | null } {
    let row: any = {};
    try {
      row = db.prepare(`SELECT healthy_reserve_enabled AS enabled, reserve_target_profit AS profit,
        reserve_target_prolabore AS prolabore, reserve_target_taxes AS taxes, reserve_target_ops AS ops,
        reserve_base_mode AS baseMode, vertical FROM organization_settings WHERE organization_id = ?`).get(orgId) as any || {};
    } catch { row = {}; }
    const num = (v: any, d: number) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
    const baseMode = (row.baseMode === "revenue" || row.baseMode === "gross_margin") ? row.baseMode : null;
    return {
      enabled: Number(row.enabled) === 1,
      targets: {
        profit: num(row.profit, DEFAULT_TARGETS.profit),
        prolabore: num(row.prolabore, DEFAULT_TARGETS.prolabore),
        taxes: num(row.taxes, DEFAULT_TARGETS.taxes),
        ops: num(row.ops, DEFAULT_TARGETS.ops),
      },
      baseMode,
      vertical: row.vertical || null,
    };
  }

  /** Atualiza a config (só o que veio; valida forma). Retorna a config resultante. */
  static setConfig(orgId: string, patch: Partial<{ enabled: boolean; profit: number; prolabore: number; taxes: number; ops: number; baseMode: ReserveBaseMode | null }>): ReserveConfig & { vertical: string | null } {
    const sets: string[] = [], vals: any[] = [];
    const pushPct = (col: string, v: any) => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 100) { sets.push(`${col} = ?`); vals.push(round2(n)); }
    };
    if (patch.enabled != null) { sets.push("healthy_reserve_enabled = ?"); vals.push(patch.enabled ? 1 : 0); }
    if (patch.profit != null) pushPct("reserve_target_profit", patch.profit);
    if (patch.prolabore != null) pushPct("reserve_target_prolabore", patch.prolabore);
    if (patch.taxes != null) pushPct("reserve_target_taxes", patch.taxes);
    if (patch.ops != null) pushPct("reserve_target_ops", patch.ops);
    if (patch.baseMode !== undefined) {
      const bm = (patch.baseMode === "revenue" || patch.baseMode === "gross_margin") ? patch.baseMode : null;
      sets.push("reserve_base_mode = ?"); vals.push(bm);
    }
    if (sets.length) {
      try { db.prepare(`UPDATE organization_settings SET ${sets.join(", ")} WHERE organization_id = ?`).run(...vals, orgId); } catch { /* best-effort */ }
    }
    return this.getConfig(orgId);
  }

  /** Pró-labore REALIZADO no mês (retiradas tipadas). Determinístico, isolado. */
  private static proLaboreReal(orgId: string, period: string): number {
    try {
      const r = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM owner_draws WHERE organization_id = ? AND kind = 'pro_labore' AND strftime('%Y-%m', draw_date) = ?`).get(orgId, period) as any;
      return round2(r?.s);
    } catch { return 0; }
  }

  private static resolveBaseMode(cfg: ReserveConfig & { vertical: string | null }): ReserveBaseMode {
    if (cfg.baseMode) return cfg.baseMode;
    return RETAIL_VERTICALS.has(String(cfg.vertical || "").toLowerCase()) ? "gross_margin" : "revenue";
  }

  /** O plano de reserva do mês: metas × realizado × status, com base honesta por setor. */
  static plan(orgId: string, period = new Date().toISOString().slice(0, 7)): HealthyReservePlan {
    const cfg = this.getConfig(orgId);
    const baseMode = this.resolveBaseMode(cfg);
    const dre = ManagerialDreService.monthly(orgId, period);
    const L = dre.linhas as any;
    const receitaLiquida = Number(L.receitaLiquida) || 0;
    const cmv = Number(L.cmv) || 0;
    const margemBruta = Number(L.margemBruta) || 0;
    const despesas = Number(L.despesas) || 0;
    const resultado = Number(L.resultadoOperacional) || 0;
    const retiradas = Number(L.retiradas) || 0;
    const sobra = round2(resultado - retiradas);
    const proLabore = this.proLaboreReal(orgId, period);

    const base = baseMode === "gross_margin" ? margemBruta : receitaLiquida;
    const baseLabel = baseMode === "gross_margin" ? "margem bruta (receita − CMV)" : "faturamento (receita líquida)";
    const caveats: string[] = [];
    if (baseMode === "gross_margin") caveats.push("No varejo o rateio corre sobre a MARGEM BRUTA (receita − CMV), porque comprar mercadoria (CMV) não é uma das 4 contas.");
    if ((dre as any).retailCostPartial) caveats.push("O CMV da loja física ainda é parcial — a margem bruta (e portanto a base) pode estar superestimada até o custo vir completo.");
    caveats.push("Impostos não são medidos separadamente (podem estar dentro de Operação) — a coluna de impostos é a RESERVA sugerida, não o realizado.");

    // ── Sem base positiva → não rateia (RN-HR-5, null≠0) ──
    if (!(base > 0)) {
      return {
        period, vertical: cfg.vertical, baseMode, base: base > 0 ? round2(base) : null, baseLabel,
        available: false, accounts: [], overallStatus: "no_data",
        caveats: [baseMode === "gross_margin" ? "Sem margem bruta positiva no mês — sem base pra ratear as 4 contas." : "Sem faturamento no mês — sem base pra ratear as 4 contas.", ...caveats],
        disclaimer: DISCLAIMER,
      };
    }

    const t = cfg.targets;
    const tgt = (p: number) => round2((base * p) / 100);

    // Operação (teto): despesas / base.
    const opsPct = pct2(despesas, base);
    const opsStatus: ReserveStatus = opsPct == null ? "no_data" : opsPct > t.ops * 1.25 ? "excesso" : opsPct > t.ops ? "atencao" : "ok";
    // Pró-labore (teto): pro_labore / base.
    const plPct = pct2(proLabore, base);
    const plStatus: ReserveStatus = plPct == null ? "no_data" : plPct > t.prolabore * 1.25 ? "excesso" : plPct > t.prolabore ? "atencao" : "ok";
    // Lucro (piso): sobra vs meta.
    const lucroTarget = tgt(t.profit);
    const lucroPct = pct2(sobra, base);
    const lucroStatus: ReserveStatus = sobra >= lucroTarget ? "ok" : sobra >= lucroTarget * 0.5 ? "atencao" : "baixo";

    const accounts: ReserveAccount[] = [
      {
        key: "lucro", label: "Lucro (reserva)", kind: "floor",
        targetPct: t.profit, targetAmount: lucroTarget, actualAmount: sobra, actualPct: lucroPct, status: lucroStatus,
        note: sobra >= lucroTarget
          ? `Sobrou ${brl(sobra)} — dentro ou acima da meta de ${brl(lucroTarget)}.`
          : `Sobrou ${brl(sobra)}, abaixo da meta de reserva de lucro (${brl(lucroTarget)}). Reserve o lucro ANTES de gastar.`,
      },
      {
        key: "prolabore", label: "Pró-labore (teto)", kind: "ceiling",
        targetPct: t.prolabore, targetAmount: tgt(t.prolabore), actualAmount: proLabore, actualPct: plPct, status: plStatus,
        note: plStatus === "ok"
          ? `Pró-labore de ${brl(proLabore)} dentro do teto (${brl(tgt(t.prolabore))}).`
          : `Pró-labore de ${brl(proLabore)} (${plPct}%) acima do teto de ${t.prolabore}% (${brl(tgt(t.prolabore))}).`,
      },
      {
        key: "impostos", label: "Impostos (reserva)", kind: "reserve",
        targetPct: t.taxes, targetAmount: tgt(t.taxes), actualAmount: null, actualPct: null, status: "reserva",
        note: `Reserve ${brl(tgt(t.taxes))} pra impostos — esse dinheiro nunca foi seu. (O sistema não mede o imposto realizado ainda.)`,
      },
      {
        key: "operacao", label: "Operação (teto)", kind: "ceiling",
        targetPct: t.ops, targetAmount: tgt(t.ops), actualAmount: despesas, actualPct: opsPct, status: opsStatus,
        note: opsStatus === "ok"
          ? `Operação de ${brl(despesas)} dentro do teto (${brl(tgt(t.ops))}).`
          : `Operação de ${brl(despesas)} (${opsPct}%) acima do teto de ${t.ops}% (${brl(tgt(t.ops))}). É o contrário do lucro reservado primeiro.`,
      },
    ];

    // Status geral = o pior entre as contas MENSURÁVEIS (impostos é info).
    const rank: Record<string, number> = { ok: 0, reserva: 0, atencao: 1, baixo: 2, excesso: 2, no_data: 0 };
    const overallStatus = accounts
      .filter((a) => a.key !== "impostos")
      .reduce<ReserveStatus>((worst, a) => (rank[a.status] > rank[worst] ? a.status : worst), "ok");

    return {
      period, vertical: cfg.vertical, baseMode, base: round2(base), baseLabel,
      available: true, accounts, overallStatus, caveats, disclaimer: DISCLAIMER,
    };
  }

  /**
   * Sinal PROATIVO advisory (RN-HR-1) — publica um `business_signal` quando a alocação está
   * FORA do saudável (operação ou pró-labore estourando o teto, ou lucro abaixo da meta). Hipótese
   * (impactAmount null — nunca inventa dinheiro medido, RN-HR-5). Self-healing por dedupe. OPT-IN:
   * só publica quando a flag `healthy_reserve_enabled` está ligada (não estreia um sinal em todo
   * mundo). Best-effort.
   */
  static publishReserveSignal(orgId: string, opts: { period?: string } = {}): { published: boolean; resolved: boolean } {
    const dedupeKey = "healthy_reserve:allocation_off";
    let published = false, resolved = false;
    try {
      const cfg = this.getConfig(orgId);
      if (!cfg.enabled) return { published: false, resolved: false }; // opt-in
      const p = this.plan(orgId, opts.period);
      const off = p.available && (p.overallStatus === "excesso" || p.overallStatus === "baixo");
      if (off) {
        const problemas = p.accounts
          .filter((a) => a.status === "excesso" || a.status === "baixo")
          .map((a) => a.note);
        BusinessSignalService.publish(orgId, {
          domain: "healthy_reserve",
          signalType: "allocation_off",
          severity: "attention",
          basis: "hypothesis",
          confidence: 0.5,
          impactAmount: null,               // RN-HR-5
          sourceService: "HealthyReserveService",
          evidence: {
            period: p.period, baseMode: p.baseMode, base: p.base,
            accounts: p.accounts.map((a) => ({ key: a.key, targetPct: a.targetPct, actualPct: a.actualPct, status: a.status })),
            message: `Sua alocação do mês está fora do saudável (método das 4 contas): ${problemas.join(" ")}`.trim(),
          },
          dedupeKey,
        });
        try { BusinessSignalService.reopenByDedupe(orgId, dedupeKey); } catch { /* noop */ }
        published = true;
      } else {
        try { const rr = BusinessSignalService.resolveByDedupe(orgId, dedupeKey); resolved = !!rr?.ok; } catch { /* noop */ }
      }
    } catch { /* best-effort */ }
    return { published, resolved };
  }

  /**
   * Passe do Scheduler: só orgs que OPTARAM (flag) e com receita no mês corrente — os DOIS fluxos
   * (online + loja física), espelhando `ResultProjectionService.pass` pra a rede física não ficar
   * de fora. Cada fonte no seu try/catch.
   */
  static pass(): void {
    const period = new Date().toISOString().slice(0, 7);
    let enabled: Set<string>;
    try {
      enabled = new Set((db.prepare(`SELECT organization_id FROM organization_settings WHERE healthy_reserve_enabled = 1`).all() as any[]).map((o) => o.organization_id).filter(Boolean));
    } catch { return; }
    if (enabled.size === 0) return;
    const withRevenue = new Set<string>();
    try {
      for (const o of db.prepare(`SELECT DISTINCT organization_id FROM orders WHERE strftime('%Y-%m', created_at) = ? AND status IN ('pago','em_preparo','entregue','concluido')`).all(period) as any[]) if (o?.organization_id) withRevenue.add(o.organization_id);
    } catch { /* noop */ }
    try {
      for (const o of db.prepare(`SELECT DISTINCT organization_id FROM retail_pdv_sales WHERE substr(sale_date,1,7) = ? AND (status IS NULL OR status = 'N')`).all(period) as any[]) if (o?.organization_id) withRevenue.add(o.organization_id);
    } catch { /* noop */ }
    try {
      for (const o of db.prepare(`SELECT DISTINCT organization_id FROM retail_daily_closings WHERE substr(closing_date,1,7) = ? AND COALESCE(informed_total,0) > 0 AND status != 'rejected'`).all(period) as any[]) if (o?.organization_id) withRevenue.add(o.organization_id);
    } catch { /* noop */ }
    for (const orgId of enabled) {
      if (!withRevenue.has(orgId)) continue;
      try { this.publishReserveSignal(orgId); }
      catch (e) { console.error("[HealthyReserve] pass falhou", orgId, e); }
    }
  }
}

export default HealthyReserveService;
