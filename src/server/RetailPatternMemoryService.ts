import db from "./db.js";
import { randomUUID } from "crypto";
import { chat, isAIConfigured } from "./llm.js";

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

  /**
   * Um passe de aprendizado: observa a janela, detecta padrões por regra, pede ao
   * LLM a descrição (frugal), grava (idempotente) e decai os que sumiram.
   * `asOf` = data de referência (default hoje). Opt-in: desligado → no-op.
   */
  static async learnPass(orgId: string, opts: { asOf?: string; windowWeeks?: number } = {}): Promise<{ enabled: boolean; detected: number; validated: number; decayed: number }> {
    if (!this.isEnabled(orgId)) return { enabled: false, detected: 0, validated: 0, decayed: 0 };
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
    return { enabled: true, detected: candidates.length, validated, decayed };
  }
}
