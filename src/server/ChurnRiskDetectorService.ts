import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * ChurnRiskDetectorService — health-score 0–100 de risco de churn do CLIENTE
 * (contato) (ADR-155 F4.1). Porta o modelo `churn-prevention` (rubrica
 * docs/grimoire/copy/intake/churn-risk-scoring.md) pra um detector que publica
 * `churn_risk_high` em `business_signals` (convenção nº 12 — nunca tabela
 * própria de alertas) pra alimentar a operação (aba Operações, ADR-152 F3.2) e,
 * na Fase 5, a cadência de retenção.
 *
 * SCORE DERIVADO POR QUERY (RN-004 — nunca contador mutável), sobre sinais que
 * já existem, com pesos + explicabilidade rica (molde PlanFitDetector F7.2):
 *   - fatura vencida (receivables open + past due) — o sinal mais forte.
 *   - silêncio no canal (dias desde a última msg do contato — proxy de "uso
 *     caindo" pra F4.1; tendência fina fica pra depois).
 *   - atendimento frio (ticket aberto temperature='cold').
 *
 * GUARDRAIL RN-014: o detector SUGERE, humano decide. Não cancela, não dá
 * desconto, não renova. O sinal é advisory. Opt-in por org
 * (`churn_detector_enabled`, default 0). `detect()` é PURO; `publish()` faz o
 * side effect (publish + sweep dos que saíram do risco).
 */

export type ChurnSeverity = "attention" | "risk";

export interface ChurnScoreBreakdown {
  overdue: { days: number; amount: number; points: number };
  silence: { days: number | null; points: number };
  ticket: { temperature: string | null; points: number };
  total: number;
}

export interface ChurnCandidate {
  contactId: string;
  contactName: string | null;
  score: number;
  band: "alto";
  severity: ChurnSeverity;
  breakdown: ChurnScoreBreakdown;
  factors: string[];
  dedupeKey: string;
}

const MIN_PUBLISH = 70; // faixa "alto" (0–39 baixo, 40–69 médio, 70–100 alto) — só publica o acionável.

function tempRank(t: string | null | undefined): number {
  return t === "cold" ? 3 : t === "warm" ? 2 : t === "hot" ? 1 : 0;
}

export class ChurnRiskDetectorService {
  static readonly MIN_PUBLISH_SCORE = MIN_PUBLISH;

  /** Varre a org e devolve candidatos de alto risco (score ≥ 70). PURO — sem side effects. */
  static detect(orgId: string): ChurnCandidate[] {
    // Faturas vencidas por contato (dias de atraso + total em aberto).
    const overdue = new Map<string, { days: number; amount: number }>();
    for (const r of db.prepare(
      `SELECT contact_id AS c,
              MAX(CAST(julianday('now') - julianday(due_date) AS INTEGER)) AS days,
              SUM(amount) AS amt
         FROM receivables
        WHERE organization_id = ? AND status = 'open'
          AND date(due_date) < date('now') AND contact_id IS NOT NULL
        GROUP BY contact_id`
    ).all(orgId) as any[]) {
      overdue.set(String(r.c), { days: Math.max(0, Number(r.days || 0)), amount: Number(r.amt || 0) });
    }

    // Silêncio: dias desde a última mensagem DO CONTATO (sender_type='contact').
    const silence = new Map<string, number>();
    for (const r of db.prepare(
      `SELECT t.contact_id AS c,
              CAST(julianday('now') - julianday(MAX(m.created_at)) AS INTEGER) AS silenceDays
         FROM messages m
         JOIN tickets t ON t.id = m.ticket_id AND t.organization_id = m.organization_id
        WHERE m.organization_id = ? AND m.sender_type = 'contact'
        GROUP BY t.contact_id`
    ).all(orgId) as any[]) {
      silence.set(String(r.c), Math.max(0, Number(r.silenceDays || 0)));
    }

    // Temperatura "pior" entre os tickets abertos do contato.
    const coldest = new Map<string, string>();
    for (const r of db.prepare(`SELECT contact_id AS c, temperature AS temp FROM tickets WHERE organization_id = ? AND status = 'open'`).all(orgId) as any[]) {
      const cur = coldest.get(String(r.c));
      if (!cur || tempRank(r.temp) > tempRank(cur)) coldest.set(String(r.c), String(r.temp));
    }

    const ids = new Set<string>([...overdue.keys(), ...coldest.keys()]);
    const out: ChurnCandidate[] = [];
    for (const cid of ids) {
      const od = overdue.get(cid) || null;
      const silenceDays = silence.has(cid) ? silence.get(cid)! : null;
      const temp = coldest.get(cid) || null;

      const overduePts = !od || od.days <= 0 ? 0 : od.days <= 7 ? 25 : od.days <= 30 ? 40 : 50;
      const silencePts = silenceDays === null ? 0 : silenceDays < 7 ? 0 : silenceDays <= 14 ? 10 : silenceDays <= 30 ? 20 : 30;
      const ticketPts = temp === "cold" ? 20 : temp === "warm" ? 5 : 0;
      const total = Math.min(100, overduePts + silencePts + ticketPts);
      if (total < MIN_PUBLISH) continue;

      const factors: string[] = [];
      if (od && od.days > 0) factors.push(`fatura vencida há ${od.days} dia(s) (R$ ${od.amount.toFixed(2)})`);
      if (silenceDays !== null && silenceDays >= 7) factors.push(`sem responder há ${silenceDays} dia(s)`);
      if (temp === "cold") factors.push(`atendimento marcado como frio`);

      const contactName = (db.prepare(`SELECT name FROM contacts WHERE id = ? AND organization_id = ?`).get(cid, orgId) as any)?.name ?? null;
      out.push({
        contactId: cid, contactName, score: total, band: "alto",
        severity: total >= 85 ? "risk" : "attention",
        breakdown: {
          overdue: { days: od?.days || 0, amount: od?.amount || 0, points: overduePts },
          silence: { days: silenceDays, points: silencePts },
          ticket: { temperature: temp, points: ticketPts },
          total,
        },
        factors,
        dedupeKey: `churn:risk:${cid}`,
      });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Publica os candidatos de alto risco e RESOLVE os sinais de contatos que saíram do risco (sweep). */
  static publish(orgId: string): { published: number; resolved: number } {
    const candidates = this.detect(orgId);
    const validKeys = new Set(candidates.map((c) => c.dedupeKey));
    let published = 0;
    for (const c of candidates) {
      const amt = c.breakdown.overdue.amount > 0 ? c.breakdown.overdue.amount : null;
      BusinessSignalService.publish(orgId, {
        domain: "churn",
        signalType: "churn_risk_high",
        severity: c.severity,
        basis: "fact",
        confidence: 0.8,
        impactAmount: amt,
        impactUnit: amt ? "BRL" : null,
        sourceService: "ChurnRiskDetectorService",
        sourceEntityType: "contact",
        sourceEntityId: c.contactId,
        evidence: {
          contactId: c.contactId, contactName: c.contactName, score: c.score, band: c.band,
          breakdown: c.breakdown, factors: c.factors, detector: "ChurnRiskDetectorService",
          nota: "Sugere retenção; humano decide (RN-014). Não cancela, não dá desconto, não renova.",
        },
        dedupeKey: c.dedupeKey,
      });
      published++;
    }
    // Sweep: contato que caiu abaixo de 70 → o sinal aberto dele é resolvido.
    let resolved = 0;
    const open = db.prepare(`SELECT dedupe_key AS k FROM business_signals WHERE organization_id = ? AND domain = 'churn' AND signal_type = 'churn_risk_high' AND status = 'open'`).all(orgId) as any[];
    for (const s of open) {
      if (!validKeys.has(String(s.k))) { BusinessSignalService.resolveByDedupe(orgId, String(s.k)); resolved++; }
    }
    return { published, resolved };
  }

  /** Roda o detector pra todas as orgs opt-in. Best-effort. */
  static runAll(): { orgs: number; published: number; resolved: number } {
    const orgs = db.prepare(`SELECT organization_id AS orgId FROM organization_settings WHERE COALESCE(churn_detector_enabled, 0) = 1`).all() as any[];
    let published = 0, resolved = 0;
    for (const o of orgs) {
      try { const r = this.publish(String(o.orgId)); published += r.published; resolved += r.resolved; }
      catch (e) { console.error("[Churn F4.1] detector falhou pra org", o.orgId, e); }
    }
    return { orgs: orgs.length, published, resolved };
  }
}

export default ChurnRiskDetectorService;
