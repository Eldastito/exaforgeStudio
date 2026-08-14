/**
 * CreativeLearningService (PRD 10 / ADR-167 F13 — Creative Learning) — FECHA
 * percepção→…→APRENDIZADO no domínio social: o resultado ASSEGURADO de uma publicação
 * (F12 → Outcome Assurance) realimenta o MOTOR ÚNICO (`PatternMemoryService`) com QUAL
 * ângulo/formato funciona pra QUAL nicho. NÃO cria segundo motor de aprendizado (§42/§184)
 * — só ancora um padrão criativo e chama `recordOutcome`.
 *
 * Guardrails de aprendizado (PRD 9): só `assured` ensina forte (RN-EL-1 — DONE ≠ exemplo);
 * desfecho DETERMINÍSTICO a partir do valor MEDIDO — engajamento do post (RN-EL-3, nunca
 * LLM); idempotente por `creative:<actionId>` (RN-EL-4 — sweep repetido é no-op); opt-in
 * pelo mesmo flag `pattern_memory`; isolado por org. O "impacto realizado" aqui é
 * ENGAJAMENTO medido, não dinheiro (não inventa R$).
 */
import db from "./db.js";
import { OutcomeAssuranceService } from "./OutcomeAssuranceService.js";
import { PatternMemoryService, type PatternCandidate } from "./PatternMemoryService.js";
import { ContentRevenueAttributionService } from "./ContentRevenueAttributionService.js";
import { ContentLeadAttributionService } from "./ContentLeadAttributionService.js";

const DOMAIN = "social_creative";

export class CreativeLearningService {
  private static verticalOf(orgId: string, signalId: string | null): string {
    if (signalId) {
      const s = db.prepare("SELECT evidence_json FROM business_signals WHERE id = ? AND organization_id = ?").get(signalId, orgId) as any;
      try { const ev = JSON.parse(s?.evidence_json || "{}"); if (ev?.vertical) return String(ev.vertical); } catch { /* noop */ }
    }
    const o = db.prepare("SELECT vertical FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return (o?.vertical && String(o.vertical).trim()) || "geral";
  }

  /**
   * Aprende de UMA ação de publicação, se (e só se) ela estiver `assured`. Deriva o
   * padrão criativo (nicho × ângulo × canal × formato) do command_payload + origem, e
   * grava o desfecho MEDIDO no motor único. Idempotente por `creative:<actionId>`.
   */
  static learnFromAction(orgId: string, actionId: string, actorId?: string): {
    ok: boolean; learned: boolean; idempotent?: boolean; reason?: string;
    assuranceState?: string; patternId?: string; patternKey?: string; outcome?: string; engagement?: number;
    businessBasis?: "revenue" | "leads" | "engagement"; businessValue?: number;
  } {
    if (!orgId || !actionId) return { ok: false, learned: false, reason: "args_invalidos" };
    if (!PatternMemoryService.isEnabled(orgId)) return { ok: true, learned: false, reason: "pattern_memory_off" };

    // 1. Só `assured` ensina forte (RN-EL-1).
    const assess = OutcomeAssuranceService.assessAction(orgId, actionId);
    if (!assess.found) return { ok: true, learned: false, reason: "acao_nao_encontrada" };
    if (assess.assuranceState !== "assured") return { ok: true, learned: false, reason: "nao_assured", assuranceState: assess.assuranceState };

    const action = db.prepare("SELECT signal_id, correlation_id, command_payload_json, action_type FROM decision_actions WHERE id = ? AND organization_id = ?").get(actionId, orgId) as any;
    if (!action || action.action_type !== "social_publish") return { ok: true, learned: false, reason: "nao_e_publicacao_social", assuranceState: "assured" };

    // 2. Dimensões criativas do payload.
    let channel = "instagram", format = "image", variantKey: string | null = null;
    try { const p = JSON.parse(action.command_payload_json || "{}"); channel = p.channel || channel; format = p.kind || format; variantKey = p.variantKey ?? null; } catch { /* noop */ }
    const vertical = this.verticalOf(orgId, action.signal_id || null);
    const angle = variantKey && variantKey.includes(":") ? variantKey.split(":").pop()! : "default";
    // A ASSINATURA criativa (nicho×ângulo×canal×formato) é o `pattern_type` — assim a
    // eficácia aprendida (`business_pattern_type_stats`, agregada por tipo) sai POR
    // combinação, respondendo "qual ângulo/formato funciona pra qual nicho".
    const signature = `${vertical}:${angle}:${channel}:${format}`;
    const patternType = `creative:${signature}`;
    const patternKey = signature;

    // 3. Desfecho DETERMINÍSTICO. Engajamento medido (confirmação social_publish, F12)…
    const conf = db.prepare("SELECT evidence_json FROM action_confirmations WHERE organization_id = ? AND action_id = ? AND confirmation_method = 'social_publish' AND status = 'confirmed'").get(orgId, actionId) as any;
    let engagement = 0;
    try { const ev = JSON.parse(conf?.evidence_json || "{}"); engagement = Number(ev?.engagement) || 0; } catch { /* noop */ }

    // …mas o RESULTADO DE NEGÓCIO (F7/F8) SOBREPÕE o engajamento quando existe (Creative
    // Learning 2.0 / F10, RN-CG-01: ENGAGEMENT ≠ BUSINESS VALUE). O aprendizado forte passa a
    // ser "que assinatura VENDE/gera lead", não "que assinatura engaja". Sem desfecho de
    // negócio ainda → cai pro engajamento (proxy), 0-regressão do F13.
    const corr = action.correlation_id || null;
    let businessBasis: "revenue" | "leads" | "engagement" = "engagement";
    let businessValue = 0;
    let outcome: string;
    if (corr) {
      const revenueFact = ContentRevenueAttributionService.revenueFor(orgId, corr).revenueFact;
      const leads = ContentLeadAttributionService.leadCount(orgId, corr);
      if (revenueFact > 0) { outcome = "worked"; businessBasis = "revenue"; businessValue = revenueFact; }
      else if (leads > 0) { outcome = "worked"; businessBasis = "leads"; businessValue = leads; }
      else { outcome = engagement > 0 ? "worked" : "no_effect"; } // engajamento é PROXY
    } else {
      outcome = engagement > 0 ? "worked" : "no_effect";
    }

    // 4. Ancora o padrão criativo no motor único e grava o outcome assured (idempotente).
    const candidate: PatternCandidate = {
      scopeId: vertical, patternType, patternKey,
      evidenceCount: 1, confidence: 0.5,
      evidence: { vertical, angle, channel, format },
      fallbackDescription: `Conteúdo no nicho ${vertical} com ângulo "${angle}" em ${channel} (${format}).`,
      scopeName: vertical,
    };
    const patternId = PatternMemoryService.ensurePattern(orgId, DOMAIN, candidate);
    // realizedImpact segue = ENGAJAMENTO (unidade documentada; nunca mistura R$ com contagem
    // — RN-CG-03). A PONDERAÇÃO por negócio vive na CLASSIFICAÇÃO (worked/no_effect acima) →
    // a eficácia aprendida passa a medir "que assinatura VENDE", não "que assinatura engaja".
    const res = PatternMemoryService.recordOutcome(orgId, patternId, {
      outcome, realizedImpact: engagement, source: "assured",
      eventKey: `creative:${actionId}`,
      correlationId: action.correlation_id ?? null, actionId,
      note: `aprendizado criativo forte (assured) — desfecho por ${businessBasis}${businessBasis !== "engagement" ? ` (${businessValue})` : ""} (PRD 11 F10)`,
    }, actorId || "system:creative-learning");

    if (!res.ok) return { ok: false, learned: false, reason: res.error, assuranceState: "assured", patternId, patternKey };
    return { ok: true, learned: !res.idempotent, idempotent: !!res.idempotent, reason: res.idempotent ? "ja_aprendido" : "aprendido", assuranceState: "assured", patternId, patternKey, outcome, engagement, businessBasis, businessValue };
  }

  /** Aprende de todas as publicações `done` com confirmação confirmada. Idempotente. */
  static sweep(orgId: string): { learned: number; skipped: number } {
    let rows: any[] = [];
    try {
      rows = db.prepare(
        `SELECT a.id FROM decision_actions a
         JOIN action_confirmations c ON c.action_id = a.id AND c.organization_id = a.organization_id
         WHERE a.organization_id = ? AND a.action_type = 'social_publish' AND a.status = 'done'
           AND c.confirmation_method = 'social_publish' AND c.status = 'confirmed'
         ORDER BY a.completed_at DESC LIMIT 200`,
      ).all(orgId) as any[];
    } catch { return { learned: 0, skipped: 0 }; }
    let learned = 0, skipped = 0;
    for (const r of rows) {
      try { const out = this.learnFromAction(orgId, r.id); if (out.learned) learned++; else skipped++; }
      catch { skipped++; }
    }
    return { learned, skipped };
  }

  /** Passe do Scheduler: aprende das publicações asseguradas das orgs com o motor ligado. */
  static pass(): void {
    let orgs: any[] = [];
    try { orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE COALESCE(pattern_memory,0) = 1`).all() as any[]; } catch { return; }
    for (const o of orgs) {
      try { this.sweep(o.organization_id); }
      catch (e: any) { console.error(`[CreativeLearning] pass falhou (org ${o.organization_id})`, e?.message || e); }
    }
  }

  /** Eficácia aprendida por ângulo criativo (assured), do motor único. Read-only. */
  static effectiveness(orgId: string): any[] {
    return PatternMemoryService.allEffectiveness(orgId, DOMAIN);
  }
}

export default CreativeLearningService;
