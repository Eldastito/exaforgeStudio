import db from "./db.js";
import { randomUUID } from "crypto";
import { chat, isAIConfigured } from "./llm.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * PatternMemoryService — memória de padrões GENÉRICA (ADR-142 generalizada).
 *
 * Extrai o loop de aprendizado que nasceu no varejo (RetailPatternMemoryService)
 * para QUALQUER domínio: produção, compras, finanças, pessoas… O ciclo é o mesmo —
 * OBSERVAR (determinístico, fora daqui) → HIPOTETIZAR (LLM, frugal, só a frase) →
 * VERIFICAR (regra de recorrência) → LEMBRAR (memória que acumula) → REALIMENTAR
 * (padrão validado vira sinal no business_signals) → MEDIR (o desfecho ajusta a
 * eficácia aprendida do tipo).
 *
 * O que é genérico aqui: a MEMÓRIA e as REGRAS (confiança por recorrência, decaimento,
 * publicação de sinais, eficácia por tipo). O que cada domínio traz: os DETECTORES
 * (SQL do domínio) que produzem os `PatternCandidate`. Assim um domínio novo "aprende"
 * escrevendo só o seu detector e chamando `learn(orgId, domain, candidates, ...)`.
 *
 * Guardas (ADR-142): determinístico é a verdade — status/confiança é REGRA; o LLM só
 * narra. Frugal: 1 chamada de LLM por passe (sobre o resumo). Opt-in por org. Isolado.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));

// Regras de recorrência (mesmos limiares do varejo — herança comprovada).
const MIN_EVIDENCE = 3;
const VALIDATE_EVIDENCE = 4;
const VALIDATE_CONFIDENCE = 0.5;
const DECAY = 0.6;
const DORMANT_AT = 0.2;

const OUTCOMES = ["worked", "no_effect", "backfired"] as const;
type Outcome = typeof OUTCOMES[number];
const OUTCOME_CONF_DELTA: Record<Outcome, number> = { worked: 0.1, no_effect: -0.05, backfired: -0.2 };

export interface PatternCandidate {
  scopeId: string | null;         // dimensão do domínio (produto, fornecedor, conta…); null = org toda
  patternType: string;
  patternKey: string;
  evidenceCount: number;
  confidence: number;             // 0..1 (regra)
  impactAmount?: number | null;   // impacto p/ o sinal (default: evidenceCount)
  impactUnit?: string | null;     // default "units"
  evidence: any;
  fallbackDescription: string;
  scopeName?: string;             // rótulo legível do escopo (p/ a evidência do sinal)
}

export type Hypothesizer = (summary: string, candidates: PatternCandidate[]) => Promise<Record<string, string>>;

const keyOf = (domain: string, c: { scopeId: string | null; patternType: string; patternKey: string }) =>
  `${domain}|${c.scopeId || ""}|${c.patternType}|${c.patternKey}`;

export class PatternMemoryService {
  /** Flag opt-in por organização (default off) — vale para todos os domínios genéricos. */
  static isEnabled(orgId: string): boolean {
    try {
      const r = db.prepare("SELECT pattern_memory FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      return !!Number(r?.pattern_memory);
    } catch { return false; }
  }
  static setEnabled(orgId: string, on: boolean): boolean {
    db.prepare("UPDATE organization_settings SET pattern_memory = ? WHERE organization_id = ?").run(on ? 1 : 0, orgId);
    return this.isEnabled(orgId);
  }

  static list(orgId: string, opts: { domain?: string; status?: string } = {}): any[] {
    let sql = "SELECT * FROM business_patterns WHERE organization_id = ?";
    const params: any[] = [orgId];
    if (opts.domain) { sql += " AND domain = ?"; params.push(opts.domain); }
    if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
    sql += " ORDER BY confidence DESC, updated_at DESC";
    return db.prepare(sql).all(...params) as any[];
  }

  // ── HIPOTETIZAR (LLM, frugal) — só a descrição; confiança é da regra ──────────
  private static async hypothesize(candidates: PatternCandidate[], domain: string, injected?: Hypothesizer | null): Promise<Record<string, string>> {
    if (!candidates.length) return {};
    const summary = JSON.stringify(candidates.map((c) => ({ chave: keyOf(domain, c), tipo: c.patternType, escopo: c.scopeName || c.scopeId, evidencia: c.evidence })));
    if (injected) { try { return (await injected(summary, candidates)) || {}; } catch { return {}; } }
    if (!isAIConfigured()) return {};
    const prompt = `Você é um analista de operações. Abaixo, padrões DETECTADOS de forma determinística no domínio "${domain}" (os números são fatos; NÃO invente nem altere números). Para cada um, escreva UMA frase curta e prática (pt-BR) que explique o padrão e sugira o que investigar.
PADRÕES: ${summary}
Responda em JSON: {"descriptions": {"<chave>": "frase"}} usando exatamente as chaves informadas.`;
    try {
      const raw = await chat(prompt, { temperature: 0.2 });
      const parsed = JSON.parse(String(raw).replace(/```json|```/g, "").trim());
      const d = parsed?.descriptions || {};
      const out: Record<string, string> = {};
      for (const c of candidates) { const k = keyOf(domain, c); if (typeof d[k] === "string") out[k] = String(d[k]).slice(0, 400); }
      return out;
    } catch { return {}; }
  }

  // ── LEMBRAR (upsert idempotente) ──────────────────────────────────────────────
  private static upsert(orgId: string, domain: string, c: PatternCandidate, description: string, byType: string, asOf: string): void {
    const existing = db.prepare(
      `SELECT id, occurrences FROM business_patterns
        WHERE organization_id = ? AND domain = ? AND COALESCE(scope_id,'') = ? AND pattern_type = ? AND pattern_key = ?`
    ).get(orgId, domain, c.scopeId || "", c.patternType, c.patternKey) as any;
    const nextOcc = (existing ? Number(existing.occurrences) : 0) + 1;
    const confidence = round2(c.confidence);
    const validated = (c.evidenceCount >= VALIDATE_EVIDENCE || nextOcc >= 2) && confidence >= VALIDATE_CONFIDENCE;
    const status = validated ? "validated" : "candidate";
    const evidence = JSON.stringify({ ...c.evidence, evidenceCount: c.evidenceCount });
    if (existing) {
      db.prepare(
        `UPDATE business_patterns SET description=?, evidence_json=?, confidence=?, status=?, occurrences=?,
                last_seen_date=?, created_by_type=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
      ).run(description, evidence, confidence, status, nextOcc, asOf, byType, existing.id);
    } else {
      db.prepare(
        `INSERT INTO business_patterns (id, organization_id, domain, scope_id, pattern_type, pattern_key, description, evidence_json, confidence, status, occurrences, first_seen_date, last_seen_date, created_by_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), orgId, domain, c.scopeId, c.patternType, c.patternKey, description, evidence, confidence, status, nextOcc, asOf, asOf, byType);
    }
  }

  /** Padrões do domínio/tipos tratados que NÃO reapareceram neste passe decaem e podem adormecer. */
  private static decayStale(orgId: string, domain: string, handledTypes: string[], seen: Set<string>): number {
    if (!handledTypes.length) return 0;
    const rows = db.prepare(
      `SELECT id, scope_id, pattern_type, pattern_key, confidence FROM business_patterns
        WHERE organization_id = ? AND domain = ? AND status != 'dormant' AND pattern_type IN (${handledTypes.map(() => "?").join(",")})`
    ).all(orgId, domain, ...handledTypes) as any[];
    let decayed = 0;
    for (const r of rows) {
      if (seen.has(keyOf(domain, { scopeId: r.scope_id, patternType: r.pattern_type, patternKey: r.pattern_key }))) continue;
      const nc = round2(Number(r.confidence) * DECAY);
      const status = nc < DORMANT_AT ? "dormant" : "candidate";
      db.prepare(`UPDATE business_patterns SET confidence=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(nc, status, r.id);
      decayed++;
    }
    return decayed;
  }

  // ── REALIMENTAR: padrões validados viram sinais no business_signals (ADR-136) ──
  /**
   * Publica os padrões `validated` do domínio como sinais — de onde fluem sozinhos
   * para o Pareto, o briefing, o Diretor e a tela de Insights. Padrões NÃO validados
   * têm o sinal RESOLVIDO. A eficácia aprendida do tipo modula a severidade (o que
   * costuma resolver sobe; o que não ajuda desce). Idempotente por
   * `pattern:domínio:tipo:escopo`.
   */
  static publishSignals(orgId: string, domain: string, opts: { sourceService: string; handledTypes: string[] }): { published: number; resolved: number } {
    const { sourceService, handledTypes } = opts;
    if (!handledTypes.length) return { published: 0, resolved: 0 };
    const rows = db.prepare(
      `SELECT * FROM business_patterns WHERE organization_id = ? AND domain = ? AND pattern_type IN (${handledTypes.map(() => "?").join(",")})`
    ).all(orgId, domain, ...handledTypes) as any[];
    let published = 0, resolved = 0;
    for (const p of rows) {
      const dedupeKey = `pattern:${domain}:${p.pattern_type}:${p.scope_id || ""}`;
      if (p.status !== "validated") { if (BusinessSignalService.resolveByDedupe(orgId, dedupeKey).ok) resolved++; continue; }
      const ev = (() => { try { return JSON.parse(p.evidence_json || "{}"); } catch { return {}; } })();
      const stats = this.typeStats(orgId, domain, p.pattern_type);
      let severity = Number(p.confidence) >= 0.6 ? "risk" : "attention";
      if (stats && stats.acted >= 2) {
        if (stats.effectiveness <= 0.25) severity = "info";
        else if (stats.effectiveness >= 0.66) severity = "risk";
      }
      try {
        BusinessSignalService.publish(orgId, {
          domain, signalType: p.pattern_type, severity, basis: "fact",
          confidence: Number(p.confidence) || 0.5,
          impactAmount: ev.impactAmount != null ? Number(ev.impactAmount) : (Number(ev.evidenceCount) || null),
          impactUnit: ev.impactUnit || "units",
          sourceService, sourceEntityType: "business_pattern", sourceEntityId: p.id,
          evidence: { description: p.description, occurrences: p.occurrences, effectiveness: stats?.effectiveness ?? null, acted: stats?.acted ?? 0, ...ev },
          dedupeKey,
        });
        published++;
      } catch { /* noop */ }
    }
    return { published, resolved };
  }

  // ── MEDIR: o desfecho ajusta a eficácia aprendida do tipo ─────────────────────
  static typeStats(orgId: string, domain: string, patternType: string): { acted: number; worked: number; no_effect: number; backfired: number; net_impact: number; effectiveness: number } | null {
    const r = db.prepare("SELECT acted, worked, no_effect, backfired, net_impact, effectiveness FROM business_pattern_type_stats WHERE organization_id = ? AND domain = ? AND pattern_type = ?").get(orgId, domain, patternType) as any;
    if (!r) return null;
    return { acted: Number(r.acted), worked: Number(r.worked), no_effect: Number(r.no_effect), backfired: Number(r.backfired), net_impact: Number(r.net_impact), effectiveness: Number(r.effectiveness) };
  }
  static allTypeStats(orgId: string, domain?: string): any[] {
    if (domain) return db.prepare("SELECT domain, pattern_type, acted, worked, no_effect, backfired, net_impact, effectiveness FROM business_pattern_type_stats WHERE organization_id = ? AND domain = ? ORDER BY pattern_type").all(orgId, domain) as any[];
    return db.prepare("SELECT domain, pattern_type, acted, worked, no_effect, backfired, net_impact, effectiveness FROM business_pattern_type_stats WHERE organization_id = ? ORDER BY domain, pattern_type").all(orgId) as any[];
  }

  /**
   * Eficácia ASSEGURADA por tipo (PRD 9 / ADR-166 F2): recorte que conta APENAS
   * desfechos de procedência 'assured' (a escada do PRD 8 confirmou E mediu — vindos
   * do `PatternLearningFromAssuranceService` da F1). É DERIVADA por query do ledger
   * `business_pattern_outcomes` (RN-004), SEPARADA do `effectiveness` de `typeStats`
   * que MISTURA manual+assured — as duas nunca se fundem (RN-EL-6).
   *
   * Sem desfecho assured → `assuredEffectiveness: null`, JAMAIS 0 (RN-EL-5 null ≠ zero):
   * "nunca agimos com garantia sobre este tipo" é ausência de prova, não fracasso.
   * Isso é o coração do §9/CA2 — DONE ≠ EXEMPLO DE SUCESSO: o número forte só existe
   * quando o resultado foi de fato assegurado.
   */
  static assuredStats(orgId: string, domain: string, patternType: string): { assuredActed: number; worked: number; no_effect: number; backfired: number; netImpact: number; assuredEffectiveness: number | null } {
    const r = db.prepare(
      `SELECT COUNT(*) acted,
              COALESCE(SUM(CASE WHEN outcome='worked' THEN 1 ELSE 0 END),0) worked,
              COALESCE(SUM(CASE WHEN outcome='no_effect' THEN 1 ELSE 0 END),0) no_effect,
              COALESCE(SUM(CASE WHEN outcome='backfired' THEN 1 ELSE 0 END),0) backfired,
              COALESCE(SUM(realized_impact),0) net_impact
         FROM business_pattern_outcomes
        WHERE organization_id = ? AND domain = ? AND pattern_type = ? AND source = 'assured'`
    ).get(orgId, domain, patternType) as any;
    const acted = Number(r?.acted) || 0;
    const worked = Number(r?.worked) || 0, noEffect = Number(r?.no_effect) || 0, backfired = Number(r?.backfired) || 0;
    const assuredEffectiveness = acted > 0 ? round2((worked * 1 + noEffect * 0.5 + backfired * 0) / acted) : null;
    return { assuredActed: acted, worked, no_effect: noEffect, backfired, netImpact: round2(Number(r?.net_impact) || 0), assuredEffectiveness };
  }

  /**
   * Lista a eficácia por tipo já com o recorte assegurado ANEXADO (aditivo aos campos
   * de `allTypeStats`): mantém `effectiveness`/`acted` (mistos) e acrescenta
   * `assuredEffectiveness` (null-safe) + `assuredActed`. Consumidores antigos seguem
   * lendo os campos originais; o recorte forte fica visível lado a lado, nunca somado.
   */
  static allEffectiveness(orgId: string, domain?: string): any[] {
    return this.allTypeStats(orgId, domain).map((s) => {
      const a = this.assuredStats(orgId, s.domain, s.pattern_type);
      return { ...s, assuredEffectiveness: a.assuredEffectiveness, assuredActed: a.assuredActed, assuredNetImpact: a.netImpact };
    });
  }

  /**
   * Registra o DESFECHO de uma ação sobre um padrão: `worked|no_effect|backfired`,
   * com impacto realizado opcional. Ajusta (1) a eficácia aprendida do tipo
   * (`effectiveness = Σpeso/acted`; worked=1, no_effect=0,5, backfired=0) e (2) a
   * confiança do próprio padrão. É assim que o sistema aprende O QUE FUNCIONA.
   *
   * PRD 9 / ADR-166 F1:
   *  - IDEMPOTÊNCIA (RN-EL-4, achado (a) da auditoria F0): antes o método fazia
   *    `acted+1` sem registro por-evento — chamar 2× dobrava a contagem. Agora grava
   *    um `business_pattern_outcome` por desfecho; um `eventKey` repetido vira no-op
   *    (retorna `idempotent:true`, sem tocar agregados). O índice UNIQUE PARCIAL é a
   *    guarda dura contra corrida; a pré-checagem só evita o custo do rollback.
   *  - PROCEDÊNCIA (`source`): 'assured' quando o desfecho vem da escada do PRD 8
   *    (`OutcomeAssuranceService` — via `PatternLearningFromAssuranceService` na F1),
   *    'manual' caso contrário. Base do `assuredEffectiveness` da F2 (DONE ≠ EXEMPLO
   *    DE SUCESSO — §9/CA2). O ledger + agregados são atômicos (uma transação).
   */
  static recordOutcome(
    orgId: string,
    patternId: string,
    input: { outcome: string; realizedImpact?: number; note?: string; eventKey?: string | null; source?: string; correlationId?: string | null; actionId?: string | null },
    actorId?: string,
  ): { ok: boolean; error?: string; idempotent?: boolean; outcomeId?: string; effectiveness?: number; patternConfidence?: number } {
    const outcome = String(input?.outcome || "") as Outcome;
    if (!OUTCOMES.includes(outcome)) return { ok: false, error: "outcome inválido (worked|no_effect|backfired)" };
    const p = db.prepare("SELECT * FROM business_patterns WHERE organization_id = ? AND id = ?").get(orgId, patternId) as any;
    if (!p) return { ok: false, error: "padrão não encontrado" };
    const impact = Number(input?.realizedImpact) || 0;
    const eventKey = input?.eventKey ? String(input.eventKey) : null;
    const source = input?.source === "assured" ? "assured" : "manual";

    // Pré-checagem de idempotência (RN-EL-4): mesmo evento não conta 2×.
    if (eventKey) {
      const dup = db.prepare("SELECT id FROM business_pattern_outcomes WHERE organization_id = ? AND event_key = ?").get(orgId, eventKey) as any;
      if (dup) {
        const st = this.typeStats(orgId, p.domain, p.pattern_type);
        return { ok: true, idempotent: true, outcomeId: dup.id, effectiveness: st?.effectiveness, patternConfidence: Number(p.confidence) };
      }
    }

    const outcomeId = randomUUID();
    let effectiveness = 0, patternConfidence = clamp01(round2(Number(p.confidence) + OUTCOME_CONF_DELTA[outcome]));
    try {
      const tx = db.transaction(() => {
        // 1. Ledger por-evento — o INSERT no índice UNIQUE é a guarda dura de idempotência.
        db.prepare(
          `INSERT INTO business_pattern_outcomes (id, organization_id, pattern_id, domain, pattern_type, outcome, realized_impact, source, event_key, correlation_id, action_id, note, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(outcomeId, orgId, p.id, p.domain, p.pattern_type, outcome, impact, source, eventKey, input?.correlationId ?? null, input?.actionId ?? null, input?.note ?? null, actorId ?? null);

        // 2. Eficácia aprendida do tipo (agregado).
        const existing = db.prepare("SELECT * FROM business_pattern_type_stats WHERE organization_id = ? AND domain = ? AND pattern_type = ?").get(orgId, p.domain, p.pattern_type) as any;
        const acted = (existing ? Number(existing.acted) : 0) + 1;
        const worked = (existing ? Number(existing.worked) : 0) + (outcome === "worked" ? 1 : 0);
        const noEffect = (existing ? Number(existing.no_effect) : 0) + (outcome === "no_effect" ? 1 : 0);
        const backfired = (existing ? Number(existing.backfired) : 0) + (outcome === "backfired" ? 1 : 0);
        const netImpact = round2((existing ? Number(existing.net_impact) : 0) + impact);
        effectiveness = round2((worked * 1 + noEffect * 0.5 + backfired * 0) / Math.max(1, acted));
        if (existing) {
          db.prepare("UPDATE business_pattern_type_stats SET acted=?, worked=?, no_effect=?, backfired=?, net_impact=?, effectiveness=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
            .run(acted, worked, noEffect, backfired, netImpact, effectiveness, existing.id);
        } else {
          db.prepare("INSERT INTO business_pattern_type_stats (id, organization_id, domain, pattern_type, acted, worked, no_effect, backfired, net_impact, effectiveness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(randomUUID(), orgId, p.domain, p.pattern_type, acted, worked, noEffect, backfired, netImpact, effectiveness);
        }

        // 3. Confiança do próprio padrão.
        db.prepare("UPDATE business_patterns SET confidence=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(patternConfidence, p.id);
      });
      tx();
    } catch (e: any) {
      // Corrida: outro passe gravou o mesmo event_key primeiro → idempotente (RN-EL-4).
      if (eventKey && (e?.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE/i.test(String(e?.message)))) {
        const dup = db.prepare("SELECT id FROM business_pattern_outcomes WHERE organization_id = ? AND event_key = ?").get(orgId, eventKey) as any;
        const st = this.typeStats(orgId, p.domain, p.pattern_type);
        return { ok: true, idempotent: true, outcomeId: dup?.id, effectiveness: st?.effectiveness, patternConfidence: Number(p.confidence) };
      }
      return { ok: false, error: String(e?.message || e) };
    }

    try { logAuthEvent(orgId, actorId || "system", p.id, "BUSINESS_PATTERN_OUTCOME", { domain: p.domain, patternType: p.pattern_type, outcome, impact, source, effectiveness }); } catch { /* noop */ }
    return { ok: true, outcomeId, effectiveness, patternConfidence };
  }

  /**
   * Um passe de aprendizado para um domínio: recebe os CANDIDATOS já detectados
   * (o domínio traz o seu detector), pede ao LLM a descrição (frugal), grava
   * (idempotente), decai os que sumiram e publica os validados como sinais.
   * `handledTypes` = os tipos que ESTE passe gerencia (p/ decair/publicar só eles).
   */
  static async learn(
    orgId: string,
    domain: string,
    candidates: PatternCandidate[],
    opts: { asOf?: string; handledTypes: string[]; sourceService: string; hypothesizer?: Hypothesizer | null },
  ): Promise<{ detected: number; validated: number; decayed: number; published: number; resolved: number }> {
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf || "") ? opts.asOf! : new Date().toISOString().slice(0, 10);
    const descriptions = await this.hypothesize(candidates, domain, opts.hypothesizer);

    const seen = new Set<string>();
    let validated = 0;
    for (const c of candidates) {
      const k = keyOf(domain, c);
      seen.add(k);
      const llmDesc = descriptions[k];
      this.upsert(orgId, domain, c, llmDesc || c.fallbackDescription, llmDesc ? "ai" : "rule", asOf);
      if (c.evidenceCount >= VALIDATE_EVIDENCE && round2(c.confidence) >= VALIDATE_CONFIDENCE) validated++;
    }
    const decayed = this.decayStale(orgId, domain, opts.handledTypes, seen);
    const sig = this.publishSignals(orgId, domain, { sourceService: opts.sourceService, handledTypes: opts.handledTypes });
    return { detected: candidates.length, validated, decayed, published: sig.published, resolved: sig.resolved };
  }
}

export default PatternMemoryService;
