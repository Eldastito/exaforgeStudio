/**
 * ZappFlow Comigo — Impact/Paywall (Gap E do levantamento autônomos).
 *
 * O paywall do Comigo não é banner de nag: é o **valor provado**. ADR-088 D8:
 * "when Comigo has shown it made the person earn/save R$X, we offer the paid
 * plan". Este service consolida essa métrica.
 *
 * Derived-only (sem tabela nova de eventos): agrega do estado atual, mesmo
 * padrão do ComigoHealthService / ComigoMonthlyReportService (evita "duas
 * verdades"). Guarda apenas o `comigo_impact_baseline_at` — o dia zero do
 * módulo — pra saber desde quando contar.
 *
 * Sem dupla contagem: o "lucro comprovado" já engloba vendas fechadas
 * (paid/done, incluindo fiado — ADR-112 D3 trata fiado como venda no ato).
 * O saldo do fiado NÃO soma no headline (é potencial, não realizado); mostra
 * separado como "grana ainda a receber".
 *
 * CTA condicional: quando `billing_status !== 'active'` E o lucro acumulado
 * ultrapassa o threshold (default R$500 ≈ 2× mensalidade anual do Autônomo),
 * a UI oferece assinar. Quem já paga vê a mesma métrica sem a CTA.
 *
 * Isolado por organization_id em toda leitura/escrita.
 */
import db from "./db.js";
import { ComigoHealthService } from "./ComigoHealthService.js";
import { PLAN_GRADE } from "./plansGrade.js";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Threshold pra o CTA aparecer: 2× a mensalidade do Autônomo anual (R$197 × 2 = R$394),
// arredondado pra R$400 (o pitch fica limpo — "você já ganhou R$X, o plano custa metade").
const CTA_MIN_PROVEN_BRL = 400;

// Estados de billing que consideramos "não pagante ativo" (mostra CTA se atingir threshold).
// - trialing: trial ativo — CTA reforça "faltam N dias pra você decidir".
// - past_due / suspended / blocked / cancelled: gates duros — CTA vira principal.
// - null / vazio: cortesia legada / sem plano — CTA pede assinatura.
const NON_PAYING_STATUSES = new Set(["trialing", "past_due", "suspended", "blocked", "cancelled", null, ""]);

export type ImpactCTA = {
  show: boolean;
  planId: string;
  planName: string;
  monthlyPrice: number;
  annualMonthPrice: number | null;
  reason: string;
};

export type ImpactSummary = {
  baselineAt: string;             // ISO
  now: string;                    // ISO
  sinceDays: number;
  // Fact: dinheiro que já entrou (ou já foi ganho no fiado, contado no ato).
  provenBRL: number;              // lucro acumulado desde baseline
  revenueBRL: number;             // faturamento acumulado
  ordersCount: number;
  // Potencial: grana ainda no ar (não conta como "provou", mas a UI mostra).
  fiadoBalanceBRL: number;
  // Estado de billing + CTA condicional.
  billingStatus: string;
  planId: string | null;
  cta: ImpactCTA;
};

function isoNow(nowMs?: number): string { return new Date(nowMs ?? Date.now()).toISOString(); }

function daysBetween(fromISO: string, toISO: string): number {
  const from = new Date(fromISO).getTime();
  const to = new Date(toISO).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 86400000));
}

function fiadoBalance(orgId: string): number {
  const debt = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND kind = 'debt'").get(orgId) as any)?.s || 0;
  const paid = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND kind = 'payment'").get(orgId) as any)?.s || 0;
  return round2(Math.max(0, debt - paid));
}

/** Autônomo é o plano-alvo do CTA (único que inclui `copiloto`). */
function targetPlan() {
  return PLAN_GRADE.find(p => p.id === "autonomo")!;
}

export class ComigoImpactService {
  /**
   * Garante um baseline pro org (idempotente). Chamado no primeiro GET /impact.
   * Se já existe, no-op — o baseline nunca é alterado depois (senão o "provado
   * desde X" viraria uma mentira móvel).
   */
  static captureBaselineIfNeeded(orgId: string, nowMs?: number): string {
    const row = db.prepare("SELECT comigo_impact_baseline_at FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    if (row?.comigo_impact_baseline_at) return row.comigo_impact_baseline_at;
    const iso = isoNow(nowMs);
    // UPDATE em vez de UPSERT — se o org não existe, a chamada é no-op (o
    // organization_settings precisa ter sido criado por outro fluxo antes).
    db.prepare("UPDATE organization_settings SET comigo_impact_baseline_at = ? WHERE organization_id = ?").run(iso, orgId);
    return iso;
  }

  /**
   * Consolida o impacto do Comigo desde o baseline. Zero-token: só aritmética
   * sobre os agregados que já servem o termômetro e o relatório mensal.
   */
  static summary(orgId: string, nowMs?: number): ImpactSummary {
    const baselineAt = this.captureBaselineIfNeeded(orgId, nowMs);
    const nowIso = isoNow(nowMs);
    const fromDate = baselineAt.slice(0, 10);
    const toDate = nowIso.slice(0, 10);

    // Reusa a MESMA aritmética do termômetro (paid/done, unit_cost_snapshot).
    // Se baseline > hoje (relógio pulou), o range vira negativo e o SQL devolve zeros.
    const sales = ComigoHealthService.rangeResult(orgId, fromDate, toDate);

    const org = db.prepare(
      "SELECT plan_id, billing_status FROM organization_settings WHERE organization_id = ?"
    ).get(orgId) as any || {};
    const billingStatus = org.billing_status || "active";
    const planId = org.plan_id || null;

    const target = targetPlan();
    const showCta = sales.profit >= CTA_MIN_PROVEN_BRL && NON_PAYING_STATUSES.has(billingStatus);
    let reason = "";
    if (!showCta) {
      if (!NON_PAYING_STATUSES.has(billingStatus)) reason = "Você já é assinante — o Comigo continua trabalhando por você.";
      else reason = `Ainda estamos provando o valor. Continue vendendo — o CTA aparece quando o lucro comprovado atinge R$${CTA_MIN_PROVEN_BRL}.`;
    } else {
      reason = billingStatus === "trialing"
        ? "Seu trial acaba em breve. O Comigo já entregou mais do que o plano custa."
        : "O Comigo já provou o valor. Ative pra continuar com tudo funcionando.";
    }

    return {
      baselineAt,
      now: nowIso,
      sinceDays: daysBetween(baselineAt, nowIso),
      provenBRL: sales.profit,
      revenueBRL: sales.revenue,
      ordersCount: sales.orders,
      fiadoBalanceBRL: fiadoBalance(orgId),
      billingStatus,
      planId,
      cta: {
        show: showCta,
        planId: target.id,
        planName: target.name,
        monthlyPrice: target.price,
        annualMonthPrice: target.features.price_annual_month,
        reason,
      },
    };
  }
}

export default ComigoImpactService;

// Exporta constantes pra teste.
export const _internals = { CTA_MIN_PROVEN_BRL, NON_PAYING_STATUSES };
