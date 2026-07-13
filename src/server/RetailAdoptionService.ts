/**
 * Retail Ops — Adoção / uso correto (ADR-085 D5, fatia factual determinística).
 *
 * Responde à pergunta do dono: "onde o lojista ainda não configurou / usa
 * errado?". É o denominador honesto do Impact Ledger — não dá para afirmar
 * resultado sem provar adoção. Aqui só o SINAL determinístico (barato, sem IA,
 * sem premissa): checa, de fato, as etapas de implantação e o uso recorrente,
 * e devolve os BLOQUEIOS acionáveis (ex.: loja sem número → cobrança não sai).
 *
 * O tom de parceiro/narrativa da IA (ADR-085 D5) fica para fatia futura — aqui
 * entregamos os fatos que ela vai narrar. Só leitura; isolado por organização.
 */
import db from "./db.js";
import { RetailActivationService } from "./RetailActivationService.js";

function num(v: any): number { return Number(v || 0); }

type Severity = "critical" | "important" | "info";
type Step = { key: string; label: string; severity: Severity; done: boolean; detail: string };

export class RetailAdoptionService {
  /** Índice de implantação + bloqueios acionáveis (factual). */
  static status(orgId: string): {
    score: { completed: number; total: number; percent: number };
    steps: Step[];
    blockers: Step[];
  } {
    const activeStores = db.prepare(
      `SELECT id, name, whatsapp_identifier FROM retail_stores WHERE organization_id = ? AND active = 1`
    ).all(orgId) as any[];
    const storesMissingWa = activeStores.filter((s) => !s.whatsapp_identifier);

    const channelOk = num((db.prepare(
      `SELECT COUNT(*) AS c FROM channels WHERE organization_id = ? AND status NOT IN ('disabled','disconnected')`
    ).get(orgId) as any)?.c) > 0;

    const activation = RetailActivationService.status(orgId);

    const quotasThisMonth = num((db.prepare(
      `SELECT COUNT(*) AS c FROM retail_store_quotas WHERE organization_id = ? AND quota_date >= date('now','start of month')`
    ).get(orgId) as any)?.c);

    const closingsRecent = num((db.prepare(
      `SELECT COUNT(*) AS c FROM retail_daily_closings WHERE organization_id = ? AND status IN ('received','extracted','approved') AND closing_date >= date('now','-7 days')`
    ).get(orgId) as any)?.c);

    const commissionRules = num((db.prepare(
      `SELECT COUNT(*) AS c FROM retail_commission_rules WHERE organization_id = ? AND active = 1`
    ).get(orgId) as any)?.c);

    const steps: Step[] = [
      { key: "channel_connected", label: "Canal de WhatsApp conectado", severity: "critical", done: channelOk,
        detail: channelOk ? "" : "Conecte um canal — sem ele o ZappFlow não atende nem cobra." },
      { key: "retail_activated", label: "Retail Network Ops ativado", severity: "critical", done: activation.active,
        detail: activation.active ? "" : "Ative o Retail Ops (módulo + automações) em Configurações." },
      { key: "stores_registered", label: "Lojas cadastradas", severity: "critical", done: activeStores.length > 0,
        detail: activeStores.length > 0 ? `${activeStores.length} loja(s) ativa(s)` : "Cadastre ao menos uma loja." },
      { key: "stores_have_whatsapp", label: "Número de WhatsApp por loja", severity: "critical",
        done: activeStores.length > 0 && storesMissingWa.length === 0,
        detail: storesMissingWa.length ? `Sem número: ${storesMissingWa.map((s) => s.name).join(", ")} — a cobrança não sai para essa(s) loja(s).` : "" },
      { key: "quotas_set", label: "Cotas do mês lançadas", severity: "important", done: quotasThisMonth > 0,
        detail: quotasThisMonth > 0 ? "" : "Sem cotas do mês, não há cálculo de desvio vs meta." },
      { key: "closings_flowing", label: "Fechamentos chegando", severity: "important", done: closingsRecent > 0,
        detail: closingsRecent > 0 ? `${closingsRecent} nos últimos 7 dias` : "Nenhum fechamento recebido em 7 dias — a equipe pode não estar enviando." },
      { key: "commission_rules", label: "Regras de premiação definidas", severity: "info", done: commissionRules > 0,
        detail: commissionRules > 0 ? `${commissionRules} regra(s) ativa(s)` : "Defina regras se for usar premiação/comissão." },
    ];

    const completed = steps.filter((s) => s.done).length;
    const blockers = steps.filter((s) => !s.done && s.severity !== "info");
    return {
      score: { completed, total: steps.length, percent: Math.round((completed / steps.length) * 100) },
      steps,
      blockers,
    };
  }
}
