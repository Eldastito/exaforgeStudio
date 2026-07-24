import db from "./db.js";
import { randomUUID } from "crypto";
import { chat, isAIConfigured } from "./llm.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { logAuthEvent } from "./auditLog.js";

const OUTCOMES = ["worked", "no_effect", "backfired"] as const;
type Outcome = typeof OUTCOMES[number];
const OUTCOME_CONF_DELTA: Record<Outcome, number> = { worked: 0.1, no_effect: -0.05, backfired: -0.2 };

/**
 * Memória de Padrões do Varejo (ADR-142 Fatia 1) — o loop de aprendizado da loja.
 *
 * Ciclo: OBSERVAR (determinístico) → HIPOTETIZAR (LLM, frugal) → VERIFICAR (regra)
 * → LEMBRAR (memória persistida que alimenta o próximo passe). O entendimento
 * ACUMULA: cada passe parte da memória do anterior; a confiança de um padrão sobe
 * quando ele se repete e cai quando não (evidência, NÃO treino de pesos).
 *
 * Guardas (ADR-142): determinístico é a verdade — a confiança/status é calculada
 * por REGRA (recorrência), o LLM só ESCREVE a descrição (narração). Frugal: 1
 * chamada de LLM por passe, sobre o RESUMO agregado (observação/verificação são
 * SQL). Sem PII (padrão de processo, não de cliente). Opt-in por org. Isolado.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));

// Janela e limiares (regras de recorrência).
const WINDOW_WEEKS = 8;
const MIN_EVIDENCE = 3;          // nº mínimo de ocorrências na janela p/ virar candidato
const VALIDATE_EVIDENCE = 4;     // evidência forte → valida já
const VALIDATE_CONFIDENCE = 0.5; // confiança mínima p/ 'validated'
const DECAY = 0.6;               // fator de decaimento quando o padrão não reaparece
const DORMANT_AT = 0.2;          // abaixo disso vira 'dormant'
const HANDLED_TYPES = ["caixa_divergente_recorrente", "estoque_negativo_recorrente"] as const;

export interface PatternCandidate {
  storeId: string | null;
  patternType: string;
  patternKey: string;
  evidenceCount: number;
  confidence: number;      // 0..1 (regra)
  evidence: any;
  fallbackDescription: string;
}

// Hipotetizador (LLM) injetável — teste offline, zero-token.
type Hypothesizer = (summary: string, candidates: PatternCandidate[]) => Promise<Record<string, string>>;
let _hypothesizer: Hypothesizer | null = null;
export function __setRetailPatternHypothesizerForTests(fn: Hypothesizer | null): void { _hypothesizer = fn; }

function daysBefore(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
const keyOf = (c: { storeId: string | null; patternType: string; patternKey: string }) => `${c.storeId || ""}|${c.patternType}|${c.patternKey}`;

export class RetailPatternMemoryService {
  /** Flag opt-in por organização (default off). */
  static isEnabled(orgId: string): boolean {
    try {
      const r = db.prepare("SELECT retail_pattern_memory FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      return !!Number(r?.retail_pattern_memory);
    } catch { return false; }
  }
  static setEnabled(orgId: string, on: boolean): boolean {
    db.prepare("UPDATE organization_settings SET retail_pattern_memory = ? WHERE organization_id = ?").run(on ? 1 : 0, orgId);
    return this.isEnabled(orgId);
  }

  static list(orgId: string, opts: { status?: string } = {}): any[] {
    if (opts.status) return db.prepare("SELECT * FROM retail_store_patterns WHERE organization_id = ? AND status = ? ORDER BY confidence DESC, updated_at DESC").all(orgId, opts.status) as any[];
    return db.prepare("SELECT * FROM retail_store_patterns WHERE organization_id = ? ORDER BY confidence DESC, updated_at DESC").all(orgId) as any[];
  }

  // ── OBSERVAR + VERIFICAR (determinístico): detectores de recorrência ──────────

  /** Divergência de caixa recorrente por loja (fechamentos com divergence_status='divergent'). */
  private static detectDivergenceRecurrence(orgId: string, from: string, to: string): PatternCandidate[] {
    const rows = db.prepare(
      `SELECT store_id,
              SUM(CASE WHEN divergence_status='divergent' THEN 1 ELSE 0 END) AS divergent,
              COUNT(*) AS total
         FROM retail_daily_closings
        WHERE organization_id = ? AND closing_date BETWEEN ? AND ? AND store_id IS NOT NULL
        GROUP BY store_id`
    ).all(orgId, from, to) as any[];
    const out: PatternCandidate[] = [];
    for (const r of rows) {
      const divergent = Number(r.divergent) || 0;
      const total = Number(r.total) || 0;
      if (divergent < MIN_EVIDENCE) continue;
      const confidence = clamp01(divergent / Math.max(1, total));
      out.push({
        storeId: String(r.store_id), patternType: "caixa_divergente_recorrente", patternKey: "caixa",
        evidenceCount: divergent, confidence, evidence: { divergent, total, from, to },
        fallbackDescription: `Divergência de caixa recorrente: ${divergent} de ${total} fechamentos divergiram do sistema nas últimas ${WINDOW_WEEKS} semanas.`,
      });
    }
    return out;
  }

  /** Estoque negativo recorrente por loja (alertas negative_stock na janela). */
  private static detectNegativeStockRecurrence(orgId: string, from: string, to: string): PatternCandidate[] {
    const rows = db.prepare(
      `SELECT store_id, COUNT(*) AS alerts
         FROM retail_stock_alerts
        WHERE organization_id = ? AND alert_type='negative_stock' AND store_id IS NOT NULL
          AND date(detected_at) BETWEEN ? AND ?
        GROUP BY store_id`
    ).all(orgId, from, to) as any[];
    const out: PatternCandidate[] = [];
    for (const r of rows) {
      const alerts = Number(r.alerts) || 0;
      if (alerts < MIN_EVIDENCE) continue;
      const confidence = clamp01(alerts / 10); // ~10 alertas na janela = confiança máxima
      out.push({
        storeId: String(r.store_id), patternType: "estoque_negativo_recorrente", patternKey: "estoque",
        evidenceCount: alerts, confidence, evidence: { alerts, from, to },
        fallbackDescription: `Estoque negativo recorrente: ${alerts} alertas de saldo negativo nas últimas ${WINDOW_WEEKS} semanas — provável divergência de recebimento/venda.`,
      });
    }
    return out;
  }

  // ── HIPOTETIZAR (LLM, frugal) — só a descrição; confiança é da regra ──────────
  private static async hypothesize(orgId: string, candidates: PatternCandidate[]): Promise<Record<string, string>> {
    if (!candidates.length) return {};
    if (_hypothesizer) { try { return (await _hypothesizer(this.summary(candidates), candidates)) || {}; } catch { return {}; } }
    if (!isAIConfigured()) return {};
    const prompt = `Você é um analista de operações de varejo. Abaixo, padrões DETECTADOS de forma determinística (os números são fatos; NÃO invente nem altere números). Para cada um, escreva UMA frase curta e prática (pt-BR) que explique o padrão e sugira o que investigar.
PADRÕES: ${this.summary(candidates)}
Responda em JSON: {"descriptions": {"<chave>": "frase"}} usando exatamente as chaves informadas.`;
    try {
      const raw = await chat(prompt, { temperature: 0.2 });
      const parsed = JSON.parse(String(raw).replace(/```json|```/g, "").trim());
      const d = parsed?.descriptions || {};
      const out: Record<string, string> = {};
      for (const c of candidates) if (typeof d[keyOf(c)] === "string") out[keyOf(c)] = String(d[keyOf(c)]).slice(0, 400);
      return out;
    } catch { return {}; }
  }
  private static summary(candidates: PatternCandidate[]): string {
    return JSON.stringify(candidates.map((c) => ({ chave: keyOf(c), tipo: c.patternType, loja: c.storeId, evidencia: c.evidence })));
  }

  // ── LEMBRAR (upsert idempotente) + decaimento ─────────────────────────────────
  private static upsert(orgId: string, c: PatternCandidate, description: string, byType: string, asOf: string): void {
    const existing = db.prepare(
      `SELECT id, occurrences FROM retail_store_patterns
        WHERE organization_id = ? AND COALESCE(store_id,'') = ? AND pattern_type = ? AND pattern_key = ?`
    ).get(orgId, c.storeId || "", c.patternType, c.patternKey) as any;
    const nextOcc = (existing ? Number(existing.occurrences) : 0) + 1;
    const confidence = round2(c.confidence);
    const validated = (c.evidenceCount >= VALIDATE_EVIDENCE || nextOcc >= 2) && confidence >= VALIDATE_CONFIDENCE;
    const status = validated ? "validated" : "candidate";
    const evidence = JSON.stringify({ ...c.evidence, evidenceCount: c.evidenceCount });
    if (existing) {
      db.prepare(
        `UPDATE retail_store_patterns SET description=?, evidence_json=?, confidence=?, status=?, occurrences=?,
                last_seen_date=?, created_by_type=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
      ).run(description, evidence, confidence, status, nextOcc, asOf, byType, existing.id);
    } else {
      db.prepare(
        `INSERT INTO retail_store_patterns (id, organization_id, store_id, pattern_type, pattern_key, description, evidence_json, confidence, status, occurrences, first_seen_date, last_seen_date, created_by_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), orgId, c.storeId, c.patternType, c.patternKey, description, evidence, confidence, status, nextOcc, asOf, asOf, byType);
    }
  }

  /** Padrões dos tipos tratados que NÃO reapareceram neste passe decaem e podem adormecer. */
  private static decayStale(orgId: string, asOf: string, seen: Set<string>): number {
    const rows = db.prepare(
      `SELECT id, store_id, pattern_type, pattern_key, confidence FROM retail_store_patterns
        WHERE organization_id = ? AND status != 'dormant' AND pattern_type IN (${HANDLED_TYPES.map(() => "?").join(",")})`
    ).all(orgId, ...HANDLED_TYPES) as any[];
    let decayed = 0;
    for (const r of rows) {
      if (seen.has(`${r.store_id || ""}|${r.pattern_type}|${r.pattern_key}`)) continue;
      const nc = round2(Number(r.confidence) * DECAY);
      const status = nc < DORMANT_AT ? "dormant" : "candidate";
      db.prepare(`UPDATE retail_store_patterns SET confidence=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(nc, status, r.id);
      decayed++;
    }
    return decayed;
  }

  // ── REALIMENTAR (ADR-142 Fatia 2): padrões validados viram sinais ─────────────
  /**
   * Publica os padrões `validated` como sinais `retail_ops` no `business_signals`
   * (ADR-136) — de onde fluem sozinhos para o Pareto e o briefing. Padrões que
   * NÃO estão validados (candidate/dormant) têm o sinal RESOLVIDO (param de
   * "cutucar" o gestor). Idempotente por `retail_pattern:tipo:loja`.
   */
  static publishSignals(orgId: string): { published: number; resolved: number } {
    const rows = db.prepare(
      `SELECT * FROM retail_store_patterns WHERE organization_id = ? AND pattern_type IN (${HANDLED_TYPES.map(() => "?").join(",")})`
    ).all(orgId, ...HANDLED_TYPES) as any[];
    let published = 0, resolved = 0;
    for (const p of rows) {
      const dedupeKey = `retail_pattern:${p.pattern_type}:${p.store_id || ""}`;
      if (p.status !== "validated") { if (BusinessSignalService.resolveByDedupe(orgId, dedupeKey).ok) resolved++; continue; }
      const ev = (() => { try { return JSON.parse(p.evidence_json || "{}"); } catch { return {}; } })();
      const storeName = (db.prepare("SELECT name FROM retail_stores WHERE id = ? AND organization_id = ?").get(p.store_id, orgId) as any)?.name || "loja";
      const stats = this.typeStats(orgId, p.pattern_type);
      // Feed-forward (Fatia 3): a EFICÁCIA aprendida do tipo modula a prioridade.
      // Tipo cujas ações costumam funcionar sobe; o que não ajuda desce.
      let severity = Number(p.confidence) >= 0.6 ? "risk" : "attention";
      if (stats && stats.acted >= 2) {
        if (stats.effectiveness <= 0.25) severity = "info";        // agir aqui não costuma ajudar
        else if (stats.effectiveness >= 0.66) severity = "risk";   // vale atacar — costuma resolver
      }
      try {
        BusinessSignalService.publish(orgId, {
          domain: "retail_ops", signalType: p.pattern_type, severity, basis: "fact",
          confidence: Number(p.confidence) || 0.5,
          impactAmount: Number(ev.evidenceCount) || null, impactUnit: "units",
          sourceService: "RetailPatternMemoryService", sourceEntityType: "retail_store_pattern", sourceEntityId: p.id,
          evidence: { store: storeName, description: p.description, occurrences: p.occurrences, effectiveness: stats?.effectiveness ?? null, acted: stats?.acted ?? 0, ...ev },
          dedupeKey,
        });
        published++;
      } catch { /* noop */ }
    }
    return { published, resolved };
  }

  // ── FECHAR O LOOP (ADR-142 Fatia 3): desfecho ajusta a eficácia do tipo ───────
  /** Estatística de eficácia de um tipo de padrão (null se ainda sem registro). */
  static typeStats(orgId: string, patternType: string): { acted: number; worked: number; no_effect: number; backfired: number; net_impact: number; effectiveness: number } | null {
    const r = db.prepare("SELECT acted, worked, no_effect, backfired, net_impact, effectiveness FROM retail_pattern_type_stats WHERE organization_id = ? AND pattern_type = ?").get(orgId, patternType) as any;
    if (!r) return null;
    return { acted: Number(r.acted), worked: Number(r.worked), no_effect: Number(r.no_effect), backfired: Number(r.backfired), net_impact: Number(r.net_impact), effectiveness: Number(r.effectiveness) };
  }
  static allTypeStats(orgId: string): any[] {
    return db.prepare("SELECT pattern_type, acted, worked, no_effect, backfired, net_impact, effectiveness FROM retail_pattern_type_stats WHERE organization_id = ? ORDER BY pattern_type").all(orgId) as any[];
  }

  /**
   * Registra o DESFECHO de uma ação sobre um padrão (o gestor agiu e mediu):
   * `worked` | `no_effect` | `backfired`, com impacto realizado opcional. Ajusta
   * (1) a EFICÁCIA aprendida do tipo — `effectiveness = Σpeso/acted` (worked=1,
   * no_effect=0,5, backfired=0) — e (2) a confiança do próprio padrão. É assim que
   * o sistema aprende O QUE FUNCIONA nesta loja. Determinístico, auditável.
   */
  static recordOutcome(orgId: string, patternId: string, input: { outcome: string; realizedImpact?: number; note?: string }, actorId?: string): { ok: boolean; error?: string; effectiveness?: number; patternConfidence?: number } {
    const outcome = String(input?.outcome || "") as Outcome;
    if (!OUTCOMES.includes(outcome)) return { ok: false, error: "outcome inválido (worked|no_effect|backfired)" };
    const p = db.prepare("SELECT * FROM retail_store_patterns WHERE organization_id = ? AND id = ?").get(orgId, patternId) as any;
    if (!p) return { ok: false, error: "padrão não encontrado" };
    const impact = Number(input?.realizedImpact) || 0;

    const existing = db.prepare("SELECT * FROM retail_pattern_type_stats WHERE organization_id = ? AND pattern_type = ?").get(orgId, p.pattern_type) as any;
    const acted = (existing ? Number(existing.acted) : 0) + 1;
    const worked = (existing ? Number(existing.worked) : 0) + (outcome === "worked" ? 1 : 0);
    const noEffect = (existing ? Number(existing.no_effect) : 0) + (outcome === "no_effect" ? 1 : 0);
    const backfired = (existing ? Number(existing.backfired) : 0) + (outcome === "backfired" ? 1 : 0);
    const netImpact = round2((existing ? Number(existing.net_impact) : 0) + impact);
    const effectiveness = round2((worked * 1 + noEffect * 0.5 + backfired * 0) / Math.max(1, acted));
    if (existing) {
      db.prepare("UPDATE retail_pattern_type_stats SET acted=?, worked=?, no_effect=?, backfired=?, net_impact=?, effectiveness=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(acted, worked, noEffect, backfired, netImpact, effectiveness, existing.id);
    } else {
      db.prepare("INSERT INTO retail_pattern_type_stats (id, organization_id, pattern_type, acted, worked, no_effect, backfired, net_impact, effectiveness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), orgId, p.pattern_type, acted, worked, noEffect, backfired, netImpact, effectiveness);
    }

    // Nudge na confiança do próprio padrão (feedback imediato).
    const patternConfidence = clamp01(round2(Number(p.confidence) + OUTCOME_CONF_DELTA[outcome]));
    db.prepare("UPDATE retail_store_patterns SET confidence=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(patternConfidence, p.id);

    try { logAuthEvent(orgId, actorId || "system", p.id, "RETAIL_PATTERN_OUTCOME", { patternType: p.pattern_type, outcome, impact, effectiveness }); } catch { /* noop */ }
    return { ok: true, effectiveness, patternConfidence };
  }

  /**
   * Um passe de aprendizado: observa a janela, detecta padrões por regra, pede ao
   * LLM a descrição (frugal), grava (idempotente), decai os que sumiram e publica
   * os validados como sinais. `asOf` = data de referência (default hoje). Opt-in.
   */
  static async learnPass(orgId: string, opts: { asOf?: string; windowWeeks?: number } = {}): Promise<{ enabled: boolean; detected: number; validated: number; decayed: number; published: number; resolved: number }> {
    if (!this.isEnabled(orgId)) return { enabled: false, detected: 0, validated: 0, decayed: 0, published: 0, resolved: 0 };
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf || "") ? opts.asOf! : new Date().toISOString().slice(0, 10);
    const from = daysBefore(asOf, (opts.windowWeeks || WINDOW_WEEKS) * 7);

    const candidates = [
      ...this.detectDivergenceRecurrence(orgId, from, asOf),
      ...this.detectNegativeStockRecurrence(orgId, from, asOf),
    ];
    const descriptions = await this.hypothesize(orgId, candidates);

    const seen = new Set<string>();
    let validated = 0;
    for (const c of candidates) {
      const k = keyOf(c);
      seen.add(k);
      const llmDesc = descriptions[k];
      this.upsert(orgId, c, llmDesc || c.fallbackDescription, llmDesc ? "ai" : "rule", asOf);
      if (c.evidenceCount >= VALIDATE_EVIDENCE && round2(c.confidence) >= VALIDATE_CONFIDENCE) validated++;
    }
    const decayed = this.decayStale(orgId, asOf, seen);
    const sig = this.publishSignals(orgId);
    return { enabled: true, detected: candidates.length, validated, decayed, published: sig.published, resolved: sig.resolved };
  }
}
