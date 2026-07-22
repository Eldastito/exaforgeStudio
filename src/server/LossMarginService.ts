import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * Margem de Perda Aceitável (ADR-114) — indicador GLOBAL de perdas.
 *
 * O dono define quanto de perda aceita por mês (% do faturamento). As perdas
 * viram lançamento tipado por DRIVER (o vocabulário que a IA usa pra atribuir e
 * aprender). O indicador mensal diz "dentro" ou "acima" e guarda histórico —
 * base pra IA aprender a média do negócio e, no futuro, atribuir e sugerir
 * redução. Vale pra todas as verticais. Isolado por organization_id.
 */

export const LOSS_DRIVERS = [
  "merma", "quebra", "vencimento", "furto", "desconto", "devolucao", "calote", "divergencia", "retrabalho", "no_show", "outro",
] as const;

// Rótulo curto por driver (para as frases do diagnóstico).
const DRIVER_LABEL: Record<string, string> = {
  merma: "merma (perda no preparo)", quebra: "quebra", vencimento: "vencimento", furto: "furto/desvio",
  desconto: "desconto", devolucao: "devolução", calote: "calote (fiado não pago)", divergencia: "divergência de caixa",
  retrabalho: "retrabalho", no_show: "no-show", outro: "outros",
};

// Sugestão frugal (zero-token) de redução por driver — o "conselho" da IA.
const DRIVER_SUGGESTION: Record<string, string> = {
  merma: "Revise as porções da ficha técnica e o rendimento real; a calibração do Comigo ajusta o custo e reduz a sobra do preparo.",
  quebra: "Produto danificado no manuseio/transporte: reveja embalagem, empilhamento e o treino de quem manuseia.",
  vencimento: "Gire o estoque pelo PEPS (primeiro a vencer, primeiro a sair), reduza a compra dos itens parados e crie promoção de saída rápida.",
  furto: "Reforce a conferência de caixa, o controle de acesso ao estoque e a atenção aos pontos críticos.",
  desconto: "Defina uma alçada de desconto por vendedor e acompanhe quem mais concede — desconto alto some com a margem.",
  devolucao: "Investigue o motivo das devoluções (defeito, tamanho, expectativa) e ajuste descrição/qualidade — devolução é venda que virou custo.",
  calote: "Aperte o limite de crédito, exija cadastro e cobre os atrasados antes de liberar novo fiado.",
  divergencia: "Padronize a contagem do fechamento e investigue as lojas com mais diferença entre o informado e o conferido.",
  retrabalho: "Confira o pedido na entrada e padronize a execução para não precisar refazer.",
  no_show: "Confirme na véspera, cobre um sinal/antecipação e mantenha lista de espera para reocupar o horário.",
  outro: "Detalhe a causa no lançamento para a IA conseguir atribuir e sugerir a redução certa.",
};

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const nowPeriod = (iso?: string) => (iso || new Date().toISOString()).slice(0, 7);

// YYYY-MM menos k meses (aritmética de calendário estável).
function periodMinus(period: string, k: number): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, (m - 1) - k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export class LossMarginService {
  static config(orgId: string) {
    const o = db.prepare("SELECT acceptable_loss_pct, acceptable_loss_basis FROM organization_settings WHERE organization_id = ?").get(orgId) as any || {};
    return { acceptablePct: round2(o.acceptable_loss_pct || 0), basis: o.acceptable_loss_basis || "faturamento" };
  }

  static setConfig(orgId: string, pct: number, basis?: string) {
    const b = basis === "custo" ? "custo" : "faturamento";
    db.prepare("UPDATE organization_settings SET acceptable_loss_pct = ?, acceptable_loss_basis = ? WHERE organization_id = ?")
      .run(Math.max(0, round2(pct)), b, orgId);
    return this.config(orgId);
  }

  /** Faturamento do mês: vendas do core (orders) + do Comigo (comigo_orders). */
  static monthlyRevenue(orgId: string, period: string): number {
    const a = (db.prepare(
      "SELECT COALESCE(SUM(total_amount),0) s FROM orders WHERE organization_id = ? AND status IN ('pago','em_preparo','entregue','concluido') AND strftime('%Y-%m', created_at) = ?"
    ).get(orgId, period) as any).s;
    const b = (db.prepare(
      "SELECT COALESCE(SUM(total),0) s FROM comigo_orders WHERE organization_id = ? AND status IN ('paid','done') AND strftime('%Y-%m', created_at) = ?"
    ).get(orgId, period) as any).s;
    return round2(a + b);
  }

  static recordLoss(orgId: string, p: { driver: string; amount: number; period?: string; source?: string; isEstimate?: boolean; note?: string; createdBy?: string }) {
    const driver = (LOSS_DRIVERS as readonly string[]).includes(p.driver) ? p.driver : "outro";
    const amount = round2(p.amount);
    if (!(amount > 0)) return { ok: false, error: "invalid_amount" };
    const period = /^\d{4}-\d{2}$/.test(p.period || "") ? p.period! : nowPeriod();
    const id = randomUUID();
    db.prepare(`INSERT INTO loss_events (id, organization_id, period, driver, amount, source, is_estimate, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, period, driver, amount, p.source || "manual", p.isEstimate ? 1 : 0, p.note || null, p.createdBy || null);
    return { ok: true, id, period, driver, amount };
  }

  /** Lançamento automático idempotente por `source` (ganchos — ADR-114 Fatia 2). */
  static recordLossUnique(orgId: string, source: string, p: { driver: string; amount: number; period?: string; note?: string }) {
    const exists = db.prepare("SELECT 1 FROM loss_events WHERE organization_id = ? AND source = ? LIMIT 1").get(orgId, source);
    if (exists) return { ok: true, deduped: true };
    return this.recordLoss(orgId, { ...p, source, isEstimate: false });
  }

  static lossesByDriver(orgId: string, period: string) {
    const rows = db.prepare("SELECT driver, COALESCE(SUM(amount),0) amount FROM loss_events WHERE organization_id = ? AND period = ? GROUP BY driver ORDER BY amount DESC").all(orgId, period) as any[];
    const byDriver = rows.map((r) => ({ driver: r.driver, amount: round2(r.amount) }));
    const total = round2(byDriver.reduce((s, d) => s + d.amount, 0));
    return { total, byDriver };
  }

  /** Resumo do mês: perda vs base, dentro/acima, decomposição por driver. */
  static monthlySummary(orgId: string, period = nowPeriod()) {
    const base = this.monthlyRevenue(orgId, period);
    const { total, byDriver } = this.lossesByDriver(orgId, period);
    const cfg = this.config(orgId);
    const lossPct = base > 0 ? round2((total / base) * 100) : 0;
    const status = cfg.acceptablePct > 0 ? (lossPct <= cfg.acceptablePct ? "dentro" : "acima") : "sem_meta";
    const topDriver = byDriver[0] || null;
    return { period, base, lossAmount: total, lossPct, acceptablePct: cfg.acceptablePct, status, byDriver, topDriver };
  }

  /** Persiste o snapshot do mês (idempotente) — base pra IA aprender barato. */
  static snapshotMonth(orgId: string, period = nowPeriod()) {
    const s = this.monthlySummary(orgId, period);
    db.prepare(`
      INSERT INTO loss_monthly_snapshots (id, organization_id, period, loss_amount, base_amount, loss_pct, acceptable_pct, status, by_driver)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, period) DO UPDATE SET
        loss_amount=excluded.loss_amount, base_amount=excluded.base_amount, loss_pct=excluded.loss_pct,
        acceptable_pct=excluded.acceptable_pct, status=excluded.status, by_driver=excluded.by_driver
    `).run(randomUUID(), orgId, period, s.lossAmount, s.base, s.lossPct, s.acceptablePct, s.status, JSON.stringify(s.byDriver));
    return s;
  }

  static history(orgId: string, months = 6, until = nowPeriod()) {
    const out = [];
    for (let k = months - 1; k >= 0; k--) out.push(this.monthlySummary(orgId, periodMinus(until, k)));
    return out;
  }

  /** Média do indicador (o que a IA aprende) sobre os meses com faturamento. */
  static trailingAverage(orgId: string, months = 3, until = nowPeriod()) {
    const hist = this.history(orgId, months, until).filter((h) => h.base > 0);
    if (!hist.length) return 0;
    return round2(hist.reduce((s, h) => s + h.lossPct, 0) / hist.length);
  }

  /**
   * Diagnóstico frugal (ADR-114 Fatia 3): a IA atribui ONDE a perda se
   * concentra e SUGERE como reduzir — sem custo de token. Baseia-se no mês
   * corrente (onde está) e na média histórica (tendência).
   */
  static diagnosis(orgId: string, period = nowPeriod()) {
    const s = this.monthlySummary(orgId, period);
    const avg = this.trailingAverage(orgId, 3, period);
    const total = s.lossAmount;

    // Tendência do indicador contra a própria média (o que a IA "aprendeu").
    let trend: "piorando" | "melhorando" | "estavel" | "sem_base" = "sem_base";
    if (avg > 0) {
      if (s.lossPct > avg + 0.5) trend = "piorando";
      else if (s.lossPct < avg - 0.5) trend = "melhorando";
      else trend = "estavel";
    }

    // Atribuição: top drivers com participação e conselho.
    const findings = s.byDriver.slice(0, 3).map((d) => ({
      driver: d.driver,
      label: DRIVER_LABEL[d.driver] || d.driver,
      amount: d.amount,
      share: total > 0 ? round2((d.amount / total) * 100) : 0,
      suggestion: DRIVER_SUGGESTION[d.driver] || DRIVER_SUGGESTION.outro,
    }));
    const dominant = findings[0] || null;

    // Manchete conforme o estado.
    let headline: string;
    if (s.acceptablePct <= 0) {
      headline = "Defina sua margem de perda aceitável para eu comparar o mês com a sua meta.";
    } else if (total <= 0) {
      headline = `Nenhuma perda lançada em ${period}. Continue registrando para eu acompanhar.`;
    } else if (s.status === "dentro") {
      headline = `Perda de ${s.lossPct}% em ${period} — dentro da sua meta de ${s.acceptablePct}%.`;
    } else {
      headline = `Perda de ${s.lossPct}% em ${period} — acima da meta de ${s.acceptablePct}%.`;
    }
    if (dominant && total > 0) headline += ` Concentra em ${dominant.label} (${dominant.share}% das perdas).`;

    // Próximos passos: o conselho do maior ofensor + leitura da tendência.
    const actions: string[] = [];
    if (dominant) actions.push(dominant.suggestion);
    if (trend === "piorando") actions.push(`As perdas estão acima da sua média recente (${avg}%). Priorize o item acima nesta semana.`);
    else if (trend === "melhorando") actions.push(`Você está abaixo da sua média recente (${avg}%). O que mudou está funcionando — mantenha.`);
    if (s.acceptablePct <= 0) actions.push("Cadastre a margem aceitável (%) para o indicador virar meta.");

    return { period, status: s.status, lossPct: s.lossPct, acceptablePct: s.acceptablePct, lossAmount: total, trailingAverage: avg, trend, headline, dominant, findings, actions };
  }

  /** Payload para a tela: config + mês atual + histórico + média + drivers + diagnóstico. */
  static overview(orgId: string) {
    return {
      config: this.config(orgId),
      current: this.monthlySummary(orgId),
      history: this.history(orgId, 6),
      trailingAverage: this.trailingAverage(orgId, 3),
      diagnosis: this.diagnosis(orgId),
      drivers: LOSS_DRIVERS,
    };
  }
}

export default LossMarginService;
