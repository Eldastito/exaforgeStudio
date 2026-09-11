import { RecoveryDebtService } from "./RecoveryDebtService.js";
import { RecoveryViabilityService } from "./RecoveryViabilityService.js";

/**
 * ProfessionalEscalationService — Escalonamento Profissional (Financial Recovery OS,
 * PRD-ZF-UNIFIED-GAP-CLOSURE-03 F3.17 / PR-10). Read-only, determinístico, sem tabela nova.
 *
 * Detecta gatilhos que ULTRAPASSAM o planejamento financeiro operacional e exigem validação
 * de contador e/ou advogado habilitado ANTES das próximas medidas. Compõe o Mapa da Dívida
 * (PR-5) + o diagnóstico de viabilidade (PR-6). NÃO dá parecer jurídico nem recomenda
 * automaticamente recuperação judicial/falência (RN §23 / RN-FR-3): apenas SINALIZA e remete
 * ao profissional. Cada gatilho carrega o que o disparou (evidência = o que o operador
 * cadastrou) como HIPÓTESE — nunca como determinação jurídica.
 */

export type TriggerSeverity = "high" | "medium";
export interface EscalationTrigger {
  key: string;
  label: string;
  present: boolean;
  severity: TriggerSeverity;
  evidence: string;
}

const STANDARD_MESSAGE =
  "Esta situação ultrapassa planejamento financeiro operacional. Recomenda-se validação de contador e/ou profissional jurídico habilitado antes da execução das próximas medidas.";

function safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }

export class ProfessionalEscalationService {
  /** Avalia os gatilhos de escalonamento. Determinístico. Não expõe R$ (contagens/labels). */
  static assess(orgId: string): {
    generatedAt: string;
    professionalReviewRequired: boolean;
    triggers: EscalationTrigger[];
    message: string | null;
    disclaimer: string;
  } {
    const debts = safe(() => RecoveryDebtService.list(orgId).filter((d: any) => d.status === "open" || d.status === "renegotiating"), [] as any[]);
    const viability = safe(() => RecoveryViabilityService.viability(orgId), null as any);

    const byCat = (c: string) => debts.filter((d: any) => d.category === c);
    const payrollOverdue = byCat("payroll").filter((d: any) => (Number(d.amount_overdue) || 0) > 0);
    const taxDebts = byCat("tax");
    const judicialDebts = byCat("judicial");
    const securedDebts = debts.filter((d: any) => Number(d.secured) === 1);
    const legalHigh = debts.filter((d: any) => d.legal_risk === "high");

    const crisis = viability?.crisis?.shape || "undetermined";
    const faixa = viability?.faixa || "indefinido";

    const triggers: EscalationTrigger[] = [
      { key: "salary_arrears", label: "Salários/folha em atraso", present: payrollOverdue.length > 0, severity: "high",
        evidence: payrollOverdue.length ? `${payrollOverdue.length} obrigação(ões) de folha com valor vencido cadastrada(s).` : "Sem folha vencida cadastrada." },
      { key: "tax_debt", label: "Dívida tributária relevante", present: taxDebts.some((d: any) => (Number(d.amount_overdue) || 0) > 0) , severity: "high",
        evidence: taxDebts.length ? `${taxDebts.length} dívida(s) tributária(s) cadastrada(s).` : "Sem dívida tributária cadastrada." },
      { key: "judicial", label: "Passivo judicial / execução / bloqueio (potencial)", present: judicialDebts.length > 0, severity: "high",
        evidence: judicialDebts.length ? `${judicialDebts.length} obrigação(ões) categoria 'judicial' cadastrada(s) — natureza a confirmar com profissional.` : "Sem passivo judicial cadastrado." },
      { key: "multiple_actions", label: "Múltiplas ações judiciais", present: judicialDebts.length >= 2, severity: "high",
        evidence: judicialDebts.length >= 2 ? `${judicialDebts.length} obrigações judiciais.` : "Menos de 2 obrigações judiciais." },
      { key: "secured_guarantees", label: "Garantias reais em dívida", present: securedDebts.length > 0, severity: "medium",
        evidence: securedDebts.length ? `${securedDebts.length} dívida(s) com garantia real cadastrada(s).` : "Sem garantia real cadastrada." },
      { key: "high_legal_risk", label: "Dívida com risco jurídico alto (rótulo do operador)", present: legalHigh.length > 0, severity: "medium",
        evidence: legalHigh.length ? `${legalHigh.length} dívida(s) marcada(s) risco jurídico alto.` : "Sem dívida de risco jurídico alto." },
      { key: "potential_insolvency", label: "Sinais de insolvência potencial", present: faixa === "critico" || crisis === "mixed", severity: "high",
        evidence: `IRF faixa "${faixa}", diagnóstico de crise "${crisis}" (hipótese — não é parecer).` },
    ];

    const professionalReviewRequired = triggers.some((t) => t.present && t.severity === "high");

    return {
      generatedAt: new Date().toISOString(),
      professionalReviewRequired,
      triggers,
      message: professionalReviewRequired ? STANDARD_MESSAGE : null,
      disclaimer: "Sinalização orientativa, não é parecer contábil/jurídico. O ZapFlow nunca recomenda automaticamente falência/recuperação judicial — a decisão é do profissional habilitado.",
    };
  }
}

export default ProfessionalEscalationService;
