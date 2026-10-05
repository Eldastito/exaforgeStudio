import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";

/**
 * AutonomyKillSwitchService (ADR-204 F3.1c, RN-F3-10 — PRD Fase 3 §37 e checklist "kill switch").
 *
 * Botão de PAUSA da autonomia: enquanto ativo, o executor RECUSA todo efeito externo — inclusive de ação já aprovada
 * por pessoa — e a recusa é auditada com "Não executei porque…". Duas abrangências:
 *   - EMPRESA inteira (domain/actionType nulos);
 *   - um TIPO de ação ((domain, actionType)).
 * Só bloqueia EFEITO (execute). Propor, preparar, aprovar e explicar seguem funcionando — pausar não esconde nada.
 *
 * Por que uma tabela própria (e não uma linha em `agent_policies`): inserir política para pausar mudaria o que o
 * `dispatchGoverned` faz quando o tipo ainda não tem política (ele só semeia se NÃO existir) e, ao retomar, deixaria uma
 * linha restritiva para sempre. A pausa é uma camada SOBRE a política, consultada pelo mesmo executor — não é um 2º
 * motor de governança (RN-159-4).
 * Histórico preservado (convenção nº 9): retomar marca `resumed_at`, nunca apaga. Isolado por organização.
 * Quem aciona é decidido na rota (dono); o serviço exige identidade (ator) e motivo para auditar.
 */

export interface PauseScope { domain?: string | null; actionType?: string | null }
export interface ActivePause { id: string; scope: "org" | "type"; domain: string | null; actionType: string | null; reason: string; pausedBy: string | null; pausedAt: string }

const norm = (v: any): string | null => { const s = String(v ?? "").trim(); return s ? s : null; };

function rowToPause(r: any): ActivePause {
  return { id: r.id, scope: r.action_type ? "type" : "org", domain: r.domain || null, actionType: r.action_type || null, reason: r.reason, pausedBy: r.paused_by || null, pausedAt: r.paused_at };
}

export class AutonomyKillSwitchService {
  /**
   * Pausa a autonomia. Idempotente por abrangência (pausar de novo devolve a pausa que já valia).
   * `actionType` exige `domain` (um tipo só existe dentro de um domínio).
   */
  static pause(orgId: string, input: PauseScope & { reason: string; by: string }): ActivePause {
    const domain = norm(input.domain), actionType = norm(input.actionType), reason = norm(input.reason), by = norm(input.by);
    if (!by) throw new Error("Pausar a autonomia exige um usuário identificado.");
    if (!reason || reason.length < 3) throw new Error("Informe o motivo da pausa (fica registrado na auditoria).");
    if (actionType && !domain) throw new Error("Para pausar um tipo de ação informe também o domínio.");
    if (domain && !actionType) throw new Error("Pausar só o domínio não é suportado: pause a empresa inteira ou um tipo de ação.");
    const cur = db.prepare("SELECT * FROM autonomy_pauses WHERE organization_id = ? AND resumed_at IS NULL AND COALESCE(domain,'') = ? AND COALESCE(action_type,'') = ?")
      .get(orgId, domain || "", actionType || "") as any;
    if (cur) return rowToPause(cur);
    const id = randomUUID();
    db.prepare("INSERT INTO autonomy_pauses (id, organization_id, domain, action_type, reason, paused_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, orgId, domain, actionType, reason.slice(0, 500), by);
    logAuthEvent(orgId, by, null, "AUTONOMY_PAUSED", { scope: actionType ? "type" : "org", domain, actionType, reason: reason.slice(0, 200) });
    return rowToPause(db.prepare("SELECT * FROM autonomy_pauses WHERE id = ?").get(id));
  }

  /** Retoma a abrangência indicada. Devolve quantas pausas foram encerradas (0 = não havia pausa ativa). */
  static resume(orgId: string, input: PauseScope & { by: string }): { resumed: number } {
    const domain = norm(input.domain), actionType = norm(input.actionType), by = norm(input.by);
    if (!by) throw new Error("Retomar a autonomia exige um usuário identificado.");
    const r = db.prepare("UPDATE autonomy_pauses SET resumed_at = CURRENT_TIMESTAMP, resumed_by = ? WHERE organization_id = ? AND resumed_at IS NULL AND COALESCE(domain,'') = ? AND COALESCE(action_type,'') = ?")
      .run(by, orgId, domain || "", actionType || "");
    if (r.changes) logAuthEvent(orgId, by, null, "AUTONOMY_RESUMED", { scope: actionType ? "type" : "org", domain, actionType });
    return { resumed: Number(r.changes) || 0 };
  }

  /** A autonomia está pausada para (domínio, tipo)? A pausa da EMPRESA vale para tudo; senão a do tipo. */
  static isPaused(orgId: string, domain: string | null | undefined, actionType: string | null | undefined): ActivePause | null {
    const rows = db.prepare("SELECT * FROM autonomy_pauses WHERE organization_id = ? AND resumed_at IS NULL ORDER BY paused_at ASC").all(orgId) as any[];
    if (!rows.length) return null;
    const org = rows.find((r) => !r.action_type);
    if (org) return rowToPause(org);
    const t = rows.find((r) => r.domain === domain && r.action_type === actionType);
    return t ? rowToPause(t) : null;
  }

  /** Pausas ativas + histórico recente (mais novo primeiro). */
  static status(orgId: string, opts: { historyLimit?: number } = {}): { paused: boolean; active: ActivePause[]; history: any[] } {
    const active = (db.prepare("SELECT * FROM autonomy_pauses WHERE organization_id = ? AND resumed_at IS NULL ORDER BY paused_at DESC").all(orgId) as any[]).map(rowToPause);
    const history = (db.prepare("SELECT id, domain, action_type, reason, paused_by, paused_at, resumed_by, resumed_at FROM autonomy_pauses WHERE organization_id = ? AND resumed_at IS NOT NULL ORDER BY resumed_at DESC LIMIT ?")
      .all(orgId, Math.max(1, Math.min(100, Number(opts.historyLimit) || 20))) as any[]);
    return { paused: active.length > 0, active, history };
  }
}

export default AutonomyKillSwitchService;
