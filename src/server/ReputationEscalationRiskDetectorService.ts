/**
 * ReputationEscalationRiskDetectorService (ADR-162 / PRD 5 §39-§41, F11) — PREVENÇÃO:
 * antecipa QUAIS clientes tendem a ESCALAR PUBLICAMENTE antes de a reclamação virar
 * crise. Porta o molde do `ChurnRiskDetectorService` (ADR-155): score 0–100 DERIVADO
 * POR QUERY (RN-004, nunca contador), `detect()` PURO + `publish()` com sweep, sinal em
 * `business_signals` (convenção #12 — nunca tabela de alerta própria), advisory (RN-014).
 *
 * O score cruza os sinais que JÁ existem no caso (sem inventar):
 *   - reclamação de reputação ABERTA e NÃO resolvida (o gatilho) — mais pontos por
 *     severidade, por categoria HIGH-RISK (F4), por RECORRÊNCIA (repeat complainer) e
 *     por IDADE (reclamação parada há dias apodrece);
 *   - CHURN ↔ REPUTAÇÃO no MESMO contato (§41): reusa `SignalCorrelationService` — um
 *     cluster de alta confiança que cruza os domínios `reputation`+`churn` sobre o mesmo
 *     contato é o multiplicador mais forte (cliente insatisfeito E saindo → vai expor);
 *   - atrito de atendimento: ticket aberto marcado `cold`.
 *
 * GUARDRAIL (RN-014/RN-CRR-4): o detector SUGERE, humano decide. Não responde, não
 * reembolsa, não escala sozinho — publica um sinal advisory pra a operação priorizar.
 * Opt-in por org (`reputation_prevention_enabled`, default 0). Isolado por org (RN-CRR-9).
 */
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { SignalCorrelationService } from "./SignalCorrelationService.js";

export interface EscalationScoreBreakdown {
  complaints: { open: number; maxSeverity: string; points: number };
  highRisk: { present: boolean; points: number };
  recurrence: { count: number; points: number };
  age: { oldestDays: number; points: number };
  churnCorrelated: { present: boolean; points: number };
  coldTicket: { present: boolean; points: number };
  total: number;
}

export interface EscalationCandidate {
  contactId: string;
  contactName: string | null;
  score: number;
  severity: "attention" | "risk";
  breakdown: EscalationScoreBreakdown;
  factors: string[];
  dedupeKey: string;
}

const MIN_PUBLISH = 60; // só publica o acionável (0–59 baixo; 60+ merece um olhar).
const SEV_RANK: Record<string, number> = { critical: 0, risk: 1, attention: 2, info: 3 };
const sevMax = (a: string, b: string) => ((SEV_RANK[a] ?? 3) <= (SEV_RANK[b] ?? 3) ? a : b);

export class ReputationEscalationRiskDetectorService {
  static readonly MIN_PUBLISH_SCORE = MIN_PUBLISH;

  /** Varre a org e devolve candidatos a escalar (score ≥ 60). PURO — sem side effects. */
  static detect(orgId: string, opts: { now?: number } = {}): EscalationCandidate[] {
    const now = opts.now || Date.now();

    // Reclamações de reputação ABERTAS por contato (exclui o próprio sinal de escalada).
    const perContact = new Map<string, { count: number; maxSev: string; highRisk: boolean; oldestMs: number }>();
    for (const r of db.prepare(
      `SELECT subject_id AS c, severity, evidence_json, detected_at FROM business_signals
        WHERE organization_id = ? AND domain = 'reputation' AND status = 'open'
          AND signal_type != 'reputational_escalation_risk'
          AND subject_type = 'contact' AND subject_id IS NOT NULL AND subject_id != ''`
    ).all(orgId) as any[]) {
      const cid = String(r.c);
      let highRisk = false;
      try { highRisk = !!JSON.parse(r.evidence_json || "{}")?.classification?.highRisk; } catch { /* ignore */ }
      const t = Date.parse(r.detected_at || "") || now;
      const cur = perContact.get(cid);
      if (!cur) perContact.set(cid, { count: 1, maxSev: String(r.severity || "info"), highRisk, oldestMs: t });
      else { cur.count++; cur.maxSev = sevMax(cur.maxSev, String(r.severity || "info")); cur.highRisk = cur.highRisk || highRisk; cur.oldestMs = Math.min(cur.oldestMs, t); }
    }
    if (!perContact.size) return [];

    // §41 — churn↔reputação: contatos com cluster de alta confiança cruzando os 2 domínios.
    const correlated = new Set<string>();
    try {
      for (const cl of SignalCorrelationService.clusters(orgId, { now }).clusters) {
        if (cl.subjectType === "contact" && cl.domains.includes("reputation") && cl.domains.includes("churn")) correlated.add(cl.subjectId);
      }
    } catch { /* correlação é best-effort; ausência não zera o detector */ }

    // Tickets abertos "frios" por contato.
    const coldTicket = new Set<string>();
    for (const r of db.prepare(`SELECT contact_id AS c FROM tickets WHERE organization_id = ? AND status = 'open' AND temperature = 'cold' AND contact_id IS NOT NULL`).all(orgId) as any[]) coldTicket.add(String(r.c));

    const out: EscalationCandidate[] = [];
    for (const [cid, agg] of perContact) {
      const complaintPts = agg.maxSev === "critical" ? 35 : agg.maxSev === "risk" ? 25 : agg.maxSev === "attention" ? 15 : 5;
      const highRiskPts = agg.highRisk ? 30 : 0;
      const recurrencePts = agg.count >= 3 ? 25 : agg.count === 2 ? 15 : 0;
      const oldestDays = Math.max(0, Math.floor((now - agg.oldestMs) / 86400e3));
      const agePts = oldestDays > 14 ? 20 : oldestDays > 7 ? 10 : 0;
      const churnPts = correlated.has(cid) ? 25 : 0;
      const coldPts = coldTicket.has(cid) ? 10 : 0;
      const total = Math.min(100, complaintPts + highRiskPts + recurrencePts + agePts + churnPts + coldPts);
      if (total < MIN_PUBLISH) continue;

      const factors: string[] = [];
      factors.push(`${agg.count} reclamação(ões) aberta(s) (severidade ${agg.maxSev})`);
      if (agg.highRisk) factors.push("categoria de ALTO RISCO em aberto");
      if (agg.count >= 2) factors.push(`cliente reincidente (${agg.count} reclamações)`);
      if (agePts > 0) factors.push(`reclamação parada há ${oldestDays} dia(s)`);
      if (churnPts > 0) factors.push("churn e reputação correlacionados no mesmo cliente (§41)");
      if (coldPts > 0) factors.push("atendimento marcado como frio");

      const contactName = (db.prepare(`SELECT name FROM contacts WHERE id = ? AND organization_id = ?`).get(cid, orgId) as any)?.name ?? null;
      out.push({
        contactId: cid, contactName, score: total,
        severity: total >= 80 || agg.highRisk ? "risk" : "attention",
        breakdown: {
          complaints: { open: agg.count, maxSeverity: agg.maxSev, points: complaintPts },
          highRisk: { present: agg.highRisk, points: highRiskPts },
          recurrence: { count: agg.count, points: recurrencePts },
          age: { oldestDays, points: agePts },
          churnCorrelated: { present: correlated.has(cid), points: churnPts },
          coldTicket: { present: coldTicket.has(cid), points: coldPts },
          total,
        },
        factors,
        dedupeKey: `reputation:escalation:${cid}`,
      });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Publica os candidatos e RESOLVE os que saíram do risco (sweep). Advisory (RN-014). */
  static publish(orgId: string, opts: { now?: number } = {}): { published: number; resolved: number } {
    if (!this.enabled(orgId)) return { published: 0, resolved: 0 };
    const candidates = this.detect(orgId, opts);
    const validKeys = new Set(candidates.map((c) => c.dedupeKey));
    let published = 0;
    for (const c of candidates) {
      BusinessSignalService.publish(orgId, {
        domain: "reputation",
        signalType: "reputational_escalation_risk",
        severity: c.severity,
        basis: "estimate",   // previsão (não é fato consumado) — §13/RN-CRR-2.
        confidence: 0.6,
        sourceService: "ReputationEscalationRiskDetectorService",
        sourceEntityType: "contact",
        sourceEntityId: c.contactId,
        subjectType: "contact",
        subjectId: c.contactId,
        evidence: {
          contactId: c.contactId, contactName: c.contactName, score: c.score,
          breakdown: c.breakdown, factors: c.factors, detector: "ReputationEscalationRiskDetectorService",
          nota: "Risco PREVISTO de escalada pública; humano decide (RN-014/RN-CRR-4). O detector não responde nem escala sozinho.",
        },
        dedupeKey: c.dedupeKey,
      });
      published++;
    }
    // Sweep: contato que caiu abaixo de 60 → sinal de escalada aberto resolvido.
    let resolved = 0;
    for (const s of db.prepare(`SELECT dedupe_key AS k FROM business_signals WHERE organization_id = ? AND domain = 'reputation' AND signal_type = 'reputational_escalation_risk' AND status = 'open'`).all(orgId) as any[]) {
      if (!validKeys.has(String(s.k))) { BusinessSignalService.resolveByDedupe(orgId, String(s.k)); resolved++; }
    }
    return { published, resolved };
  }

  static enabled(orgId: string): boolean {
    const r = db.prepare(`SELECT COALESCE(reputation_prevention_enabled, 0) e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return !!(r && r.e);
  }

  /** Roda o detector pra todas as orgs opt-in. Best-effort (uma org não derruba as outras). */
  static runAll(): { orgs: number; published: number; resolved: number } {
    const orgs = db.prepare(`SELECT organization_id AS orgId FROM organization_settings WHERE COALESCE(reputation_prevention_enabled, 0) = 1`).all() as any[];
    let published = 0, resolved = 0;
    for (const o of orgs) {
      try { const r = this.publish(String(o.orgId)); published += r.published; resolved += r.resolved; }
      catch (e) { console.error("[Reputation F11] detector de escalada falhou pra org", o.orgId, e); }
    }
    return { orgs: orgs.length, published, resolved };
  }
}

export default ReputationEscalationRiskDetectorService;
