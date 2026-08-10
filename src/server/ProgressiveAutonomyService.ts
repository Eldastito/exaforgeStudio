import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { ApprovalPolicyService } from "./ApprovalPolicyService.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * ProgressiveAutonomyService (ADR-159 F5 / D5).
 *
 * Fecha o loop do Autonomy Contract (F3): a IA olha o PRÓPRIO histórico e, quando
 * a evidência é forte, PROPÕE ao dono elevar a autonomia (ex.: "aprovou 97% em 90
 * dias, 0 reversões → liberar auto-aprovação até R$500?"). A IA **nunca** eleva a
 * própria autonomia sozinha (PRD 0 §42 / RN-014) — só publica a proposta em
 * `business_signals` (convenção nº 12, sem tabela de alerta nova); o humano
 * confirma via `accept` (com motivo, auditado); a mudança aplica uma banda F3.
 *
 * Tudo DERIVADO por query (RN-004) — nenhum contador mutável. Escopo `created_by
 * IN ('ai','rule')` (só o que a IA propôs) numa janela, e só propõe quando:
 *   - amostra suficiente (≥ minDecided decisões humanas);
 *   - taxa de aprovação ≥ minApprovalRate;
 *   - ZERO reversões (aprovada e depois cancelada);
 *   - há teto a subir (p90 dos valores aprovados > teto de auto atual).
 * Assim a proposta é honesta (nada fabricado) e conservadora.
 *
 * SEGURANÇA: aplicar libera AUTO-APROVAÇÃO até o teto (pula o passo humano de
 * aprovar valores pequenos) — a EXECUÇÃO externa segue governada pelo executor
 * (G1/G2: autonomy_level=execute + execution_mode≥approved_execution). 'allow' na
 * aprovação ≠ auto-executar. Isolado por org (convenção nº 1).
 */

const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_MIN_DECIDED = 10;
const DEFAULT_MIN_APPROVAL_RATE = 0.9;

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
function percentileAsc(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

export class ProgressiveAutonomyService {
  /** Teto de AUTO-aprovação atual da (domínio, tipo): maior banda `allow`, ou max_auto_amount, ou 0. `Infinity` se já há allow sem teto. */
  private static currentCap(orgId: string, domain: string, actionType: string): number {
    const cfg = db.prepare("SELECT max_auto_amount, config_json FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?").get(orgId, domain, actionType) as any;
    if (cfg?.config_json) {
      try {
        const c = JSON.parse(cfg.config_json);
        if (Array.isArray(c?.bands)) {
          const allow = c.bands.filter((b: any) => b?.state === "allow");
          if (allow.some((b: any) => b.upTo == null)) return Infinity; // allow ilimitado
          const caps = allow.map((b: any) => Number(b.upTo)).filter((n: number) => Number.isFinite(n));
          if (caps.length) return Math.max(...caps);
        }
      } catch { /* config torto → ignora */ }
    }
    return cfg?.max_auto_amount != null ? Number(cfg.max_auto_amount) : 0;
  }

  /**
   * Avalia o histórico da org e PUBLICA propostas de elevação (nunca aplica).
   * Idempotente por `dedupe_key` (uma proposta viva por domínio+tipo).
   */
  static evaluate(orgId: string, opts: { windowDays?: number; minDecided?: number; minApprovalRate?: number } = {}): { proposed: number; skipped: number } {
    const windowDays = Number(opts.windowDays ?? DEFAULT_WINDOW_DAYS);
    const minDecided = Number(opts.minDecided ?? DEFAULT_MIN_DECIDED);
    const minApprovalRate = Number(opts.minApprovalRate ?? DEFAULT_MIN_APPROVAL_RATE);
    const since = `-${windowDays} days`;

    const rows = db.prepare(`
      SELECT domain, action_type AS actionType,
        SUM(CASE WHEN status IN ('approved','done') THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN status = 'cancelled' AND approved_at IS NOT NULL THEN 1 ELSE 0 END) AS reversed,
        SUM(CASE WHEN status IN ('approved','done','rejected') THEN 1 ELSE 0 END) AS decided
      FROM decision_actions
      WHERE organization_id = ? AND created_by IN ('ai','rule') AND created_at >= datetime('now', ?)
      GROUP BY domain, action_type
    `).all(orgId, since) as any[];

    let proposed = 0, skipped = 0;
    for (const r of rows) {
      const decided = Number(r.decided), approved = Number(r.approved), rejected = Number(r.rejected), reversed = Number(r.reversed);
      if (decided < minDecided) { skipped++; continue; }
      const approvalRate = approved / decided;
      // Gate conservador: alta aprovação E zero reversões (o exemplo do D5).
      if (approvalRate < minApprovalRate || reversed > 0) { skipped++; continue; }

      // Teto proposto = p90 dos valores APROVADOS (derivado, não fabricado).
      const amounts = (db.prepare(`
        SELECT ABS(expected_impact) AS amt FROM decision_actions
        WHERE organization_id = ? AND domain = ? AND action_type = ?
          AND status IN ('approved','done') AND expected_impact IS NOT NULL AND created_at >= datetime('now', ?)
        ORDER BY amt ASC
      `).all(orgId, r.domain, r.actionType, since) as any[]).map((x) => Number(x.amt)).filter((n) => Number.isFinite(n));
      if (!amounts.length) { skipped++; continue; } // sem base de valor → nada a limitar

      const proposedCap = round2(percentileAsc(amounts, 0.9));
      const currentCap = this.currentCap(orgId, r.domain, r.actionType);
      if (!(proposedCap > currentCap)) { skipped++; continue; } // nada a subir

      BusinessSignalService.publish(orgId, {
        domain: "governance", signalType: "autonomy_raise_proposed", severity: "info",
        basis: "fact", confidence: round2(approvalRate),
        impactAmount: proposedCap, impactUnit: "BRL",
        sourceService: "ProgressiveAutonomyService",
        sourceEntityType: "agent_policy", sourceEntityId: `${r.domain}:${r.actionType}`,
        evidence: {
          domain: r.domain, actionType: r.actionType, windowDays,
          decided, approved, rejected, reversed,
          approvalRate: round3(approvalRate), reversalRate: 0,
          currentCap: currentCap === Infinity ? null : currentCap, proposedCap, sampleAmounts: amounts.length,
          nota: "A IA só PROPÕE elevação de autonomia — o humano confirma (com motivo). Aplicar libera AUTO-APROVAÇÃO até o teto; a execução externa segue governada pelo executor.",
        },
        dedupeKey: `autonomy:raise:${r.domain}:${r.actionType}`,
      });
      proposed++;
    }
    return { proposed, skipped };
  }

  /**
   * O HUMANO confirma uma proposta (nunca automático). Exige identidade + motivo
   * (mesma disciplina do AiGovernance). Aplica uma banda F3 (allow até o teto,
   * require_approval acima), audita e resolve o sinal. Idempotente: sinal já
   * resolvido → erro claro.
   */
  static accept(orgId: string, signalId: string, opts: { actorId?: string; reason?: string }): { ok: boolean; applied: { domain: string; actionType: string; from: number | null; to: number } } {
    if (!opts.actorId || !String(opts.reason || "").trim()) {
      throw new Error("human_decision_required: elevar autonomia exige usuário identificado e motivo.");
    }
    const sig = db.prepare("SELECT * FROM business_signals WHERE id = ? AND organization_id = ? AND domain = 'governance' AND signal_type = 'autonomy_raise_proposed'").get(signalId, orgId) as any;
    if (!sig) throw new Error("Proposta de autonomia não encontrada.");
    if (sig.status !== "open") throw new Error(`Proposta já resolvida (${sig.status}).`);
    const ev = sig.evidence_json ? JSON.parse(sig.evidence_json) : {};
    const domain = String(ev.domain || ""), actionType = String(ev.actionType || ""), proposedCap = Number(ev.proposedCap);
    if (!domain || !actionType || !(proposedCap > 0)) throw new Error("Proposta sem dados suficientes para aplicar.");

    const before = this.currentCap(orgId, domain, actionType);
    const cfg = db.prepare("SELECT approval_role FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?").get(orgId, domain, actionType) as any;
    const role = cfg?.approval_role || "gerente";
    // Banda F3: auto (allow) até o teto aprovado; acima disso, requer aprovação.
    ApprovalPolicyService.setBands(orgId, domain, actionType, [
      { upTo: proposedCap, state: "allow" },
      { upTo: null, state: "require_approval", role },
    ]);
    try { BusinessSignalService.resolveByDedupe(orgId, sig.dedupe_key); } catch { /* noop */ }
    try {
      logAuthEvent(orgId, opts.actorId, null, "AUTONOMY_RAISE_APPLIED", {
        domain, actionType, from: before === Infinity ? "unlimited" : before, to: proposedCap,
        reason: String(opts.reason).slice(0, 500), signalId,
        evidence: { approvalRate: ev.approvalRate, reversed: ev.reversed, decided: ev.decided, windowDays: ev.windowDays },
      });
    } catch { /* auditoria best-effort */ }
    return { ok: true, applied: { domain, actionType, from: before === Infinity ? null : before, to: proposedCap } };
  }

  /** Lista as propostas de autonomia ABERTAS da org (pro painel do dono). */
  static listProposals(orgId: string): any[] {
    return BusinessSignalService.list(orgId, { status: "open", domain: "governance" })
      .filter((s: any) => s.signal_type === "autonomy_raise_proposed");
  }

  /** Varre orgs opt-in (`progressive_autonomy_enabled=1`). Best-effort. */
  static runAll(): { orgs: number; proposed: number } {
    const orgs = db.prepare("SELECT organization_id AS orgId FROM organization_settings WHERE COALESCE(progressive_autonomy_enabled, 0) = 1").all() as any[];
    let proposed = 0;
    for (const o of orgs) {
      try { proposed += this.evaluate(String(o.orgId)).proposed; }
      catch (e) { console.error("[Autonomy F5] evaluate falhou pra org", o.orgId, e); }
    }
    return { orgs: orgs.length, proposed };
  }
}

export default ProgressiveAutonomyService;
