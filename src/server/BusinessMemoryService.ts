import db from "./db.js";
import { PatternMemoryService } from "./PatternMemoryService.js";
import { LearningEpisodeService } from "./LearningEpisodeService.js";
import { UxPreferencesService } from "./UxPreferencesService.js";
import { ApprovalPolicyService } from "./ApprovalPolicyService.js";

/**
 * BusinessMemoryService — "o que a empresa sabe sobre si mesma" (ADR-204 F3.2, PRD Fase 3 §6).
 *
 * É um READ-MODEL: COMPÕE o que já existe, sem tabela de RAG nova e sem 2º Context Engine —
 *   · REGRAS confirmadas por uma pessoa (`business_patterns.manager_decision='confirmed'`, F3.2);
 *   · HIPÓTESES (recorrência validou, ninguém decidiu) e padrões apenas OBSERVADOS;
 *   · o que o gestor REJEITOU (não volta a alertar);
 *   · PREFERÊNCIAS (`UxPreferencesService`) e POLÍTICAS de autonomia (`ApprovalPolicyService.overview`, F3.1d);
 *   · APRENDIZADOS com prova assegurada (`LearningEpisodeService`, PRD 9).
 *
 * Guardrails: RN-F3-4 (padrão ≠ regra sem confirmação — hipótese nunca aparece como regra) · RN-F3-5/null≠0 (nada
 * inventado: sem dado, lista vazia) · dinheiro role-gated (limiar de alerta só p/ quem vê dinheiro, §73) · isolado por
 * organização · determinístico, sem LLM.
 */
const SHOW = 50;
const parse = (j: any) => { try { return JSON.parse(j || "{}"); } catch { return {}; } };
const BR = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : null);

export class BusinessMemoryService {
  static overview(orgId: string, opts: { canSeeMoney?: boolean } = {}): any {
    const all = db.prepare("SELECT * FROM business_patterns WHERE organization_id = ? ORDER BY confidence DESC, occurrences DESC").all(orgId) as any[];
    const by = (stage: string) => all.filter((p) => PatternMemoryService.stageOf(p) === stage);
    const card = (p: any) => ({
      id: p.id, domain: p.domain, patternType: p.pattern_type, description: p.description || null,
      confidence: Number(p.confidence), occurrences: Number(p.occurrences || 0),
      firstSeen: p.first_seen_date || null, lastSeen: p.last_seen_date || null,
    });
    const rules = by("rule").map((p) => ({ ...card(p), confirmedBy: p.manager_decided_by || null, confirmedAt: p.manager_decided_at || null, note: p.manager_note || null }));
    const hypotheses = by("hypothesis").map((p) => ({
      ...card(p),
      // Só o que o motor contou (ocorrências reais desde a 1ª vez) — não inventa "X de Y semanas".
      question: `Identifiquei isso ${p.occurrences} vez${Number(p.occurrences) === 1 ? "" : "es"}${BR(p.first_seen_date) ? ` desde ${BR(p.first_seen_date)}` : ""}. Considera uma regra da empresa?`,
    }));
    const rejected = by("rejected").map((p) => ({ ...card(p), rejectedBy: p.manager_decided_by || null, rejectedAt: p.manager_decided_at || null, note: p.manager_note || null }));
    const observed = by("observed");

    const prefs = UxPreferencesService.effective(orgId);
    const preferences: any = { awakeStart: prefs.awakeStart, awakeEnd: prefs.awakeEnd, source: prefs.source };
    if (opts.canSeeMoney) preferences.alertMinAmount = prefs.alertMinAmount; // limiar de alerta é valor em R$ (§73)

    const ov = ApprovalPolicyService.overview(orgId);
    const policies = (ov.policies || []).map((p: any) => ({ label: p.label, level: p.level, levelLabel: p.levelLabel, paused: !!p.paused }));
    const alwaysHuman = (ov.humanOnly || []).map((c: any) => c.label);

    let learnings: any[] = [];
    try { learnings = (LearningEpisodeService.episodes(orgId, { onlyAssured: true, limit: 10 }).episodes || []).map((e: any) => ({ patternId: e.patternId, description: e.description, learningState: e.learningState, assuredEffectiveness: e.assuredEffectiveness, assuredActed: e.assuredActed })); } catch { /* sem aprendizado ainda */ }

    return {
      counts: { rules: rules.length, hypotheses: hypotheses.length, observed: observed.length, rejected: rejected.length, learnings: learnings.length },
      rules: rules.slice(0, SHOW), hypotheses: hypotheses.slice(0, SHOW), observed: observed.slice(0, 10).map(card), rejected: rejected.slice(0, SHOW),
      preferences, policies, alwaysHuman, learnings,
      note: "Read-model derivado (RN-004). Hipótese não é regra: só uma pessoa confirma (RN-F3-4).",
    };
  }
}

export default BusinessMemoryService;
