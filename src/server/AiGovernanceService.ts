import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * Governança de IA (ADR-130) — a camada que decide se o agente vai a produção.
 *
 * Consolida os controles que já existem no produto (LGPD, auditoria de decisão,
 * IA-sugere/humano-decide, kill-switch por billing) e torna EXPLÍCITO o controle
 * de viés: para sugestões que AFETAM PESSOAS, a IA nunca executa sozinha — o
 * humano decide, com um MOTIVO registrado, baseado em comportamento (não em
 * característica pessoal). Determinístico, isolado por organization_id.
 */

export interface PeopleAffecting { label: string; basis: string; fairnessNote: string }

// Registro das sugestões de IA que afetam PESSOAS — cada uma exige decisão
// humana com motivo, e uma nota de fairness (base legítima = comportamento).
export const PEOPLE_AFFECTING: Record<string, PeopleAffecting> = {
  fiado_blacklist: {
    label: "Lista negra de fiado",
    basis: "comportamento de pagamento (dias em atraso), nunca característica pessoal",
    fairnessNote: "A IA só SUGERE após N dias de dívida em aberto; bloquear alguém é decisão humana, com motivo registrado. Proibido bloquear por perfil, origem ou qualquer traço pessoal.",
  },
  fiado_limit: {
    label: "Limite de crédito (fiado)",
    basis: "histórico de pagamento e saldo, não perfil pessoal",
    fairnessNote: "Sugestão de limite é orientativa; o dono define o valor. Baseia-se no histórico, não em características do cliente.",
  },
  prospect_targeting: {
    label: "Segmentação de prospecção",
    basis: "critérios de negócio (ICP, evidências), não atributos pessoais",
    fairnessNote: "Alvos são empresas/critérios de negócio; o humano aprova a lista antes de qualquer contato.",
  },
};

export class AiGovernanceService {
  static isPeopleAffecting(kind: string): boolean {
    return Object.prototype.hasOwnProperty.call(PEOPLE_AFFECTING, kind);
  }

  /**
   * Guarda de viés/segurança: uma decisão que AFETA PESSOA e é APLICADA exige
   * ator humano + motivo. Lança se faltar — nada que afeta pessoa executa
   * "sozinho". (Para `dismissed` ou tipos que não afetam pessoa, não trava.)
   */
  static guardApplied(kind: string, opts: { decision?: "applied" | "dismissed"; actorId?: string | null; reason?: string | null }): void {
    if (opts.decision === "dismissed") return;
    if (!this.isPeopleAffecting(kind)) return;
    if (!opts.actorId || !String(opts.reason || "").trim()) {
      const err: any = new Error("human_decision_required");
      err.code = "human_decision_required";
      throw err;
    }
  }

  /**
   * Registra a decisão sobre uma sugestão de IA (auditoria de decisão). Aplica o
   * guardrail antes de gravar. `suggestedBy='ai'` marca que a IA propôs.
   */
  static recordDecision(orgId: string, p: { kind: string; subjectId?: string | null; decision: "applied" | "dismissed"; actorId?: string | null; reason?: string | null; suggestedBy?: "ai" | "human" }): { ok: true; id: string } {
    this.guardApplied(p.kind, { decision: p.decision, actorId: p.actorId, reason: p.reason });
    const id = randomUUID();
    db.prepare(
      `INSERT INTO ai_decisions (id, organization_id, kind, subject_id, decision, suggested_by, actor_user_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, p.kind, p.subjectId || null, p.decision, p.suggestedBy || "human", p.actorId || null, String(p.reason || "").trim() || null);
    return { ok: true, id };
  }

  /** Histórico de decisões de IA (auditoria) — isolado por org. */
  static decisions(orgId: string, limit = 50) {
    return db.prepare("SELECT id, kind, subject_id, decision, suggested_by, actor_user_id, reason, created_at FROM ai_decisions WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?").all(orgId, limit) as any[];
  }

  /**
   * Política de Governança de IA (ADR-130) — resumo dos controles vigentes, para
   * a UI/onboarding mostrar (a governança é camada central, não borda opcional).
   */
  static policy() {
    return {
      principios: [
        "A IA SUGERE, o humano DECIDE (ADR-091 §6) — nada sensível executa sozinho.",
        "Toda recomendação é auditável (o antes, a decisão e o resultado).",
        "Grounded: a IA não inventa número nem lei; sem base, recusa.",
        "Frugalidade: zero-token onde dá; LLM só na borda.",
      ],
      controles: [
        { area: "LGPD", como: "Consentimento granular, exportação e direito ao esquecimento, retenção configurável (LgpdService)." },
        { area: "Auditoria de decisão", como: "ai_interactions_log (prompt/resposta/confiança/needs_human) + auth_audit_logs + Impact Ledger + ai_decisions." },
        { area: "Erro do agente", como: "Aprovação humana em ação sensível; kill-switch por billing (somente-leitura); guardrails de grounding e anti-injeção." },
        { area: "Viés / dignidade", como: "Decisão que afeta pessoa exige humano + motivo, baseada em comportamento; provador nunca julga corpo/aparência; cobrança sem constranger (art. 42)." },
        { area: "Isolamento / escala", como: "Multi-tenant por organization_id, RBAC granular, security-hardening — testados no CI." },
        { area: "Ética", como: "Radar de Manipulação (anti-dark-pattern), Manifesto da Marca, disclaimers obrigatórios." },
      ],
      peopleAffecting: Object.entries(PEOPLE_AFFECTING).map(([kind, v]) => ({ kind, ...v })),
      checklistFairness: [
        "A decisão final é humana? (a IA só sugere)",
        "Há um motivo registrado?",
        "A base é comportamento/critério de negócio — não característica pessoal?",
        "A pessoa afetada pode ser revista/reabilitada?",
      ],
    };
  }
}

export default AiGovernanceService;
