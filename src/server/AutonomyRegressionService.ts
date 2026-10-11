/**
 * ADR-206 F5.4 — ESCADA ÚNICA de autonomia + REGRESSÃO AUTOMÁTICA (só pra baixo — D4, RN-F5-6/7).
 *
 * NÃO é motor novo (RN-F5-12): a escada já existe DERIVADA em `ApprovalPolicyService.autonomyLevel` (autonomy_level × execution_mode
 * × aprovação automática × piso humano × pausa do dono). Aqui há duas coisas:
 *   1) `ladder` — leitura única que nomeia o degrau de cada política: observe · shadow · recommend · prepare · auto (+ paused);
 *   2) `assess`/`apply` — a regressão: política em `auto` (Nível 3) cujo histórico REAL piorou perde UM degrau (auto → prepare). Só desce.
 *
 * Regras duras:
 *  - SÓ DESCE: nunca eleva, nunca mexe em política que já está em prepare/recommend/observe/shadow/paused. Subir de volta é ato humano
 *    (editar a política ou aceitar a proposta do ProgressiveAutonomyService) — esta classe não tem caminho de subida (RN-F5-7).
 *  - Gatilho com prova, não com susto: (a) falhas REAIS do handler (`error_code='handler_error'`; recusa de guarda de política NÃO conta —
 *    é o sistema protegendo, não o playbook errando) com amostra mínima e limite INFERIOR de Wilson acima do piso; ou (b) reversões
 *    (aprovada e depois cancelada) acima do limite. Janela contada a partir da última regressão do tipo (não pune duas vezes o mesmo passado).
 *  - Determinístico, derivado por query (RN-004); sem LLM. `assess` é read-only e sempre disponível; `apply` só age com a flag opt-in
 *    `autonomy_regression_enabled` (default 0 — convenção nº 10; limiares não calibrados com dado real).
 *  - Efeito: `execution_mode` → 'assisted' (o executor passa a recusar efeito externo: a IA prepara e espera autorização). Auditado
 *    (`AUTONOMY_REGRESSED`) e AVISA o dono pela espinha (`business_signals`, domain governance — nunca tabela de alerta paralela).
 *  - Isolado por organização.
 */
import db from "./db.js";
import { ApprovalPolicyService } from "./ApprovalPolicyService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { logAuthEvent } from "./auditLog.js";
import { wilsonInterval } from "./statsWilson.js";

export type Rung = "observe" | "shadow" | "recommend" | "prepare" | "auto" | "paused";

export const DEFAULTS = { windowDays: 30, minAttempts: 5, failureFloor: 0.15, maxReversals: 2 };
const ACTOR = "system:autonomy-regression";

export interface Assessment {
  domain: string; actionType: string;
  attempts: number; failed: number; reversed: number;
  failureRate: number | null; failureLower: number | null;
  since: string;
  regress: boolean;
  reasons: string[];
}

const dedupeKey = (domain: string, actionType: string) => `autonomy_regressed:${domain}:${actionType}`;

export class AutonomyRegressionService {
  static isEnabled(orgId: string): boolean {
    try { return !!(db.prepare("SELECT autonomy_regression_enabled v FROM organization_settings WHERE organization_id = ?").get(orgId) as any)?.v; } catch { return false; }
  }
  static setEnabled(orgId: string, on: boolean): boolean {
    db.prepare("UPDATE organization_settings SET autonomy_regression_enabled = ? WHERE organization_id = ?").run(on ? 1 : 0, orgId);
    return this.isEnabled(orgId);
  }

  /** Degrau nomeado a partir do nível derivado + modo. Só nomeia; não decide nada. */
  static rungOf(orgId: string, domain: string, actionType: string): { rung: Rung; level: number; reason: string } {
    const a = ApprovalPolicyService.autonomyLevel(orgId, { domain, actionType });
    if (a.paused) return { rung: "paused", level: a.level, reason: a.reason };
    const cfg = db.prepare("SELECT autonomy_level, execution_mode FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ? AND active = 1").get(orgId, domain, actionType) as any;
    if (cfg && String(cfg.execution_mode) === "shadow" && ["prepare", "execute"].includes(String(cfg.autonomy_level))) return { rung: "shadow", level: a.level, reason: "modo sombra: a IA registra o que faria, sem efeito externo" };
    const rung: Rung = a.level === 0 ? "observe" : a.level === 1 ? "recommend" : a.level === 2 ? "prepare" : "auto";
    return { rung, level: a.level, reason: a.reason };
  }

  /** A escada de TODAS as políticas ativas da empresa, num lugar só. */
  static ladder(orgId: string): { enabled: boolean; policies: Array<{ domain: string; actionType: string; rung: Rung; level: number; reason: string; humanOnly: boolean }> } {
    const rows = db.prepare("SELECT domain, action_type FROM agent_policies WHERE organization_id = ? AND active = 1 ORDER BY domain, action_type").all(orgId) as any[];
    return {
      enabled: this.isEnabled(orgId),
      policies: rows.map((r) => ({ domain: r.domain, actionType: r.action_type, ...this.rungOf(orgId, r.domain, r.action_type), humanOnly: ApprovalPolicyService.isHumanOnly(r.action_type) })),
    };
  }

  /** Avalia UM tipo (read-only). */
  static assessType(orgId: string, domain: string, actionType: string, opts: Partial<typeof DEFAULTS> = {}): Assessment {
    const o = { ...DEFAULTS, ...opts };
    const marker = db.prepare("SELECT detected_at FROM business_signals WHERE organization_id = ? AND dedupe_key = ?").get(orgId, dedupeKey(domain, actionType)) as any;
    const winStart = (db.prepare("SELECT datetime('now', ?) t").get(`-${o.windowDays} days`) as any).t as string;
    const since = marker?.detected_at && String(marker.detected_at) > winStart ? String(marker.detected_at) : winStart;

    const ex = db.prepare(`
      SELECT SUM(CASE WHEN l.status = 'done' THEN 1 ELSE 0 END) ok, SUM(CASE WHEN l.status = 'failed' AND l.error_code = 'handler_error' THEN 1 ELSE 0 END) bad
      FROM action_execution_log l JOIN decision_actions a ON a.id = l.action_id AND a.organization_id = l.organization_id
      WHERE l.organization_id = ? AND l.mode = 'execute' AND a.domain = ? AND a.action_type = ? AND l.started_at > ?`).get(orgId, domain, actionType, since) as any;
    const failed = Number(ex?.bad || 0), attempts = Number(ex?.ok || 0) + failed;
    const rev = db.prepare("SELECT COUNT(*) n FROM decision_actions WHERE organization_id = ? AND domain = ? AND action_type = ? AND status = 'cancelled' AND approved_at IS NOT NULL AND created_at > ?").get(orgId, domain, actionType, since) as any;
    const reversed = Number(rev?.n || 0);

    const iv = wilsonInterval(failed, attempts);
    const reasons: string[] = [];
    if (attempts >= o.minAttempts && iv && iv.lower >= o.failureFloor) reasons.push(`${failed} falha(s) em ${attempts} execuções (mesmo no melhor caso, ≥ ${Math.round(o.failureFloor * 100)}% falham)`);
    if (reversed >= o.maxReversals) reasons.push(`${reversed} ação(ões) aprovada(s) e depois canceladas`);
    return { domain, actionType, attempts, failed, reversed, failureRate: attempts ? failed / attempts : null, failureLower: iv ? iv.lower : null, since, regress: reasons.length > 0, reasons };
  }

  /** Avalia todas as políticas hoje em `auto` (read-only). Quem já está abaixo não entra — não há o que descer. */
  static assess(orgId: string, opts: Partial<typeof DEFAULTS> = {}): { assessed: Assessment[]; wouldRegress: Assessment[] } {
    const pol = db.prepare("SELECT domain, action_type FROM agent_policies WHERE organization_id = ? AND active = 1").all(orgId) as any[];
    const assessed = pol.filter((p) => this.rungOf(orgId, p.domain, p.action_type).rung === "auto").map((p) => this.assessType(orgId, p.domain, p.action_type, opts));
    return { assessed, wouldRegress: assessed.filter((a) => a.regress) };
  }

  /** Aplica a regressão (com a flag ligada): auto → prepare, auditado, com aviso ao dono. Idempotente: quem já desceu não está mais em `auto`. */
  static apply(orgId: string, opts: Partial<typeof DEFAULTS> = {}): { enabled: boolean; regressed: Array<{ domain: string; actionType: string; reasons: string[] }> } {
    if (!this.isEnabled(orgId)) return { enabled: false, regressed: [] };
    const regressed: Array<{ domain: string; actionType: string; reasons: string[] }> = [];
    for (const a of this.assess(orgId, opts).wouldRegress) {
      const r = db.prepare("UPDATE agent_policies SET execution_mode = 'assisted' WHERE organization_id = ? AND domain = ? AND action_type = ? AND active = 1 AND execution_mode IN ('approved_execution','autonomous')").run(orgId, a.domain, a.actionType);
      if (!r.changes) continue; // o degrau 'auto' vinha de outra combinação — não inventa efeito
      try { logAuthEvent(orgId, ACTOR, null, "AUTONOMY_REGRESSED", { domain: a.domain, actionType: a.actionType, from: "auto", to: "prepare", attempts: a.attempts, failed: a.failed, reversed: a.reversed, reasons: a.reasons }); } catch { /* auditoria best-effort */ }
      try {
        BusinessSignalService.publish(orgId, {
          domain: "governance", signalType: "autonomy_regressed", severity: "attention", basis: "fact", confidence: 1,
          sourceService: "AutonomyRegressionService", sourceEntityType: "agent_policy", sourceEntityId: `${a.domain}:${a.actionType}`,
          dedupeKey: dedupeKey(a.domain, a.actionType),
          evidence: { domain: a.domain, actionType: a.actionType, from: "auto", to: "prepare", attempts: a.attempts, failed: a.failed, reversed: a.reversed, reasons: a.reasons, note: "A IA voltou a preparar e esperar sua autorização. Só uma pessoa pode devolver a autonomia." },
        });
      } catch { /* sinal best-effort */ }
      regressed.push({ domain: a.domain, actionType: a.actionType, reasons: a.reasons });
    }
    return { enabled: true, regressed };
  }

  /** Varre empresas com a flag ligada. Best-effort. */
  static runAll(): { orgs: number; regressed: number } {
    const orgs = db.prepare("SELECT organization_id orgId FROM organization_settings WHERE COALESCE(autonomy_regression_enabled, 0) = 1").all() as any[];
    let regressed = 0;
    for (const o of orgs) { try { regressed += this.apply(String(o.orgId)).regressed.length; } catch (e) { console.error("[Autonomy F5.4] apply falhou pra org", o.orgId, e); } }
    return { orgs: orgs.length, regressed };
  }
}

export default AutonomyRegressionService;
