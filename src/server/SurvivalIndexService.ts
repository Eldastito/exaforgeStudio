import db from "./db.js";
import { randomUUID } from "crypto";
import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { CashForecastService } from "./CashForecastService.js";
import { BusinessHealthService } from "./BusinessHealthService.js";
import { AnalyticsService } from "./AnalyticsService.js";
import { RevenueIntelligenceService } from "./RevenueIntelligenceService.js";
import { LossMarginService } from "./LossMarginService.js";

/**
 * Índice de Sobrevivência Empresarial (ADR-127) — placar único 0-100.
 *
 * Composição PONDERADA e transparente (pesos do PRD §18) dos sinais que já
 * calculamos — não recalcula nada. Cada componente pontua 0-100 por regra
 * explícita; sem dado entra NEUTRO (não pune) e baixa a confiança. ORIENTATIVO:
 * não prevê fechamento, aponta o que puxa o índice para baixo. Zero-token,
 * isolado por organization_id.
 */

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round1 = (n: number) => Math.round((Number(n) || 0) * 10) / 10;
const brl = (n: number) => `R$ ${(Number(n) || 0).toFixed(2).replace(".", ",")}`;
const NEUTRAL = 50;

interface Comp { key: string; label: string; weight: number; score: number; hasData: boolean; note: string }

export class SurvivalIndexService {
  private static nowPeriod() { return new Date().toISOString().slice(0, 7); }

  private static cashEventsCount(orgId: string): number {
    try { return (db.prepare("SELECT COUNT(*) c FROM cash_events WHERE organization_id = ?").get(orgId) as any).c; } catch { return 0; }
  }

  /** Capital parado no estoque (ADR-127 Fatia 2): Σ quantidade × custo médio. */
  private static inventoryCapital(orgId: string): { hasData: boolean; parado: number } {
    try {
      const total = (db.prepare("SELECT COUNT(*) c FROM inventory_items WHERE organization_id = ?").get(orgId) as any).c;
      if (!total) return { hasData: false, parado: 0 };
      const p = (db.prepare("SELECT COALESCE(SUM(quantity_available * avg_cost),0) s FROM inventory_items WHERE organization_id = ? AND quantity_available > 0").get(orgId) as any).s;
      return { hasData: true, parado: Math.round((Number(p) || 0) * 100) / 100 };
    } catch { return { hasData: false, parado: 0 }; }
  }

  /** Calcula os 7 componentes ponderados. */
  private static components(orgId: string): Comp[] {
    const cash = FinancialLedgerService.summary(orgId);
    const fc = CashForecastService.forecast(orgId, { minCash: 0 });
    const hasCash = cash.caixaAtual !== 0 || this.cashEventsCount(orgId) > 0;

    // 1) Caixa e dias de sobrevivência (25%)
    let caixaScore = NEUTRAL;
    if (hasCash) {
      if (cash.caixaAtual < 0) caixaScore = 0;
      else if (fc.firstRisk && fc.firstRisk.weeksAhead <= 2) caixaScore = 20;
      else if (fc.survivalDays == null) caixaScore = 90; // caixa positivo, sem saídas recentes
      else caixaScore = clamp((fc.survivalDays / 60) * 100);
      if (fc.firstRisk && fc.firstRisk.weeksAhead > 2) caixaScore = Math.min(caixaScore, 60);
    }

    // 2) Margem e rentabilidade (20%)
    let margemScore = NEUTRAL, margemData = false;
    try { const p = AnalyticsService.getProfit(orgId, { period: "month" } as any); if (p?.hasCostData) { margemData = true; margemScore = clamp((Number(p.margin) / 30) * 100); } } catch { /* neutro */ }

    // 3) Vendas / conversão / recompra (20%) — proxy: IQR do RIE.
    // Só conta como DADO quando há faturamento real no mês; sem vendas, o IQR de
    // uma conta vazia sai artificialmente alto — então fica neutro.
    let vendasScore = NEUTRAL, vendasData = false, operScore = NEUTRAL, operData = false;
    const temVendas = LossMarginService.monthlyRevenue(orgId, this.nowPeriod()) > 0;
    if (temVendas) {
      try {
        const s = RevenueIntelligenceService.getSnapshot(orgId);
        if (s?.iqr?.score > 0) { vendasData = true; vendasScore = clamp(Number(s.iqr.score)); }
        const op = Number(s?.drivers?.operacional?.score);
        if (Number.isFinite(op) && op > 0) { operData = true; operScore = clamp(op); }
      } catch { /* neutro */ }
    }

    // 4) Recebíveis e inadimplência (12%)
    let recebScore = NEUTRAL, recebData = false;
    if (hasCash || cash.aReceber > 0) {
      recebData = true;
      const ratio = cash.aReceber / (cash.aReceber + Math.max(0, cash.caixaAtual) + 1);
      recebScore = clamp(100 * (1 - ratio));
    }

    // 5) Estoque e capital parado (10%) — ADR-127 Fatia 2
    const inv = this.inventoryCapital(orgId);
    let estoqueScore = NEUTRAL;
    if (inv.hasData) {
      const receita = LossMarginService.monthlyRevenue(orgId, this.nowPeriod());
      if (inv.parado <= 0) estoqueScore = 100;
      else if (receita > 0) estoqueScore = clamp(100 - ((inv.parado / receita - 1) / 3) * 100); // ~1 mês de estoque ok; 4 meses ruim
      else estoqueScore = 30; // capital parado sem vendas para girar
    }

    // 7) Dependência do dono e qualidade dos dados (5%)
    const dq = BusinessHealthService.dataQuality(orgId);

    return [
      { key: "caixa", label: "Caixa e dias de sobrevivência", weight: 25, score: round1(caixaScore), hasData: hasCash, note: hasCash ? "" : "Informe o saldo/movimento de caixa." },
      { key: "margem", label: "Margem e rentabilidade", weight: 20, score: round1(margemScore), hasData: margemData, note: margemData ? "" : "Cadastre custos para calcular a margem." },
      { key: "vendas", label: "Vendas, conversão e recompra", weight: 20, score: round1(vendasScore), hasData: vendasData, note: vendasData ? "" : "Sem sinal de vendas suficiente ainda." },
      { key: "recebiveis", label: "Recebíveis e inadimplência", weight: 12, score: round1(recebScore), hasData: recebData, note: recebData ? "" : "Sem recebíveis/caixa para avaliar." },
      { key: "estoque", label: "Estoque e capital parado", weight: 10, score: round1(estoqueScore), hasData: inv.hasData, note: inv.hasData ? (inv.parado > 0 ? `${brl(inv.parado)} parados no estoque.` : "") : "Sem controle de estoque para avaliar." },
      { key: "operacao", label: "Execução operacional", weight: 8, score: round1(operScore), hasData: operData, note: operData ? "" : "Sem sinal operacional ainda." },
      { key: "dados", label: "Qualidade dos dados", weight: 5, score: round1(dq.pct), hasData: true, note: dq.pct < 100 ? "Complete o checklist da Central de Saúde." : "" },
    ];
  }

  static faixaOf(score: number): "saudavel" | "atencao" | "risco" | "critico" {
    return score >= 75 ? "saudavel" : score >= 55 ? "atencao" : score >= 35 ? "risco" : "critico";
  }

  /** Placar 0-100 + faixa + confiança + composição + tendência vs último snapshot. */
  static score(orgId: string) {
    const components = this.components(orgId);
    const totalWeight = components.reduce((s, c) => s + c.weight, 0); // = 100
    const score = round1(components.reduce((s, c) => s + (c.weight * c.score) / totalWeight, 0));
    const faixa = this.faixaOf(score);
    const dataWeight = components.filter((c) => c.hasData).reduce((s, c) => s + c.weight, 0);
    const confidence = dataWeight >= 80 ? "alta" : dataWeight >= 50 ? "media" : "baixa";
    const label: Record<string, string> = { saudavel: "Saudável", atencao: "Atenção", risco: "Risco", critico: "Crítico" };

    // Tendência vs snapshot anterior (mês passado ou mais recente ≠ atual).
    const prev = db.prepare("SELECT score FROM survival_index_snapshots WHERE organization_id = ? AND period < ? ORDER BY period DESC LIMIT 1").get(orgId, this.nowPeriod()) as any;
    let trend: "subindo" | "estavel" | "caindo" | "sem_base" = "sem_base";
    if (prev) { const d = score - Number(prev.score); trend = d > 1.5 ? "subindo" : d < -1.5 ? "caindo" : "estavel"; }

    const weak = components.filter((c) => c.hasData).sort((a, b) => a.score - b.score).slice(0, 2).map((c) => c.label);
    return { score, faixa, faixaLabel: label[faixa], confidence, components, trend, weakest: weak };
  }

  /** Persiste o snapshot do mês (idempotente) — base da tendência. */
  static snapshot(orgId: string, period = this.nowPeriod()) {
    const s = this.score(orgId);
    db.prepare(`
      INSERT INTO survival_index_snapshots (id, organization_id, period, score, faixa, confidence, components)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, period) DO UPDATE SET score=excluded.score, faixa=excluded.faixa, confidence=excluded.confidence, components=excluded.components
    `).run(randomUUID(), orgId, period, s.score, s.faixa, s.confidence, JSON.stringify(s.components));
    return s;
  }

  /** Histórico do placar (últimos N meses) para o gráfico de tendência. */
  static history(orgId: string, months = 6) {
    const rows = db.prepare("SELECT period, score, faixa FROM survival_index_snapshots WHERE organization_id = ? ORDER BY period DESC LIMIT ?").all(orgId, months) as any[];
    return rows.reverse().map((r) => ({ period: r.period, score: round1(r.score), faixa: r.faixa }));
  }

  /** Fecha o snapshot do mês e devolve o placar + o histórico (para a tela). */
  static scoreWithHistory(orgId: string) {
    const s = this.snapshot(orgId); // upsert idempotente do mês corrente
    return { ...s, history: this.history(orgId) };
  }
}

export default SurvivalIndexService;
