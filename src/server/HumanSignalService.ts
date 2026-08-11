/**
 * HumanSignalService — PRD 2 F9 (§45-46, §10, CA2): a origem HUMANA da percepção.
 *
 * Contexto: o Radar tem três origens de percepção — Humana, Digital (detectores)
 * e Externa (F10). As duas últimas já existem. Esta fatia dá primeira classe à
 * PRIMEIRA: uma observação do humano ("terceiro cliente hoje procurando o produto
 * X", "vários alunos reclamando do transporte") — capturada no Fala Tu ou digitada
 * na UI — vira um `business_signal` NORMALIZADO, sem inventar nada além do que a
 * pessoa disse (o texto é verbatim).
 *
 * O que a fatia entrega e por quê:
 *   - ACÚMULO DE EVIDÊNCIA (§46, a marca do sinal humano): observações do MESMO
 *     assunto NÃO viram N sinais soltos — elas se ACUMULAM num único sinal, cuja
 *     confiança e severidade SOBEM com a corroboração ("um cliente perguntou" é
 *     info fraco; "o terceiro cliente perguntou" é atenção real). O contador de
 *     observações é DERIVADO do array de evidências (RN-004 — nunca contador
 *     mutável): confiança/severidade recomputam sobre `observations.length` a
 *     cada nova observação.
 *   - NUNCA É FATO (§13, CA3): a observação humana é `estimate` (relato) ou
 *     `hypothesis` (interpretação) — jamais `fact`. O humano não mediu; percebeu.
 *     Promover percepção a fato é exatamente o que o PRD proíbe.
 *   - SEM LEDGER/ALERTA NOVO (CA1/§5): publica no `business_signals` canônico via
 *     `BusinessSignalService.publish` (idempotente por dedupe_key). As observações
 *     individuais moram no `evidence_json` do próprio sinal — zero tabela nova.
 *   - Opt-in (`radar_human_signals_enabled`), isolado por org, atômico (read-append
 *     -publish numa transação — convenção #8, evita corrida entre 2 observações
 *     simultâneas do mesmo assunto).
 *
 * O que a IA/este service NUNCA faz aqui:
 *   - Não inventa o assunto nem o texto (verbatim do humano).
 *   - Não promove a fato (§13).
 *   - Não executa ação — só registra a percepção no ledger (o roteamento/decisão
 *     seguem no caminho canônico: attention feed → router → policy).
 */
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

export interface HumanObservationInput {
  /** Quem observou (audit + rastreio de corroboração). */
  observerId?: string | null;
  /** O texto verbatim da observação humana (NUNCA reescrito/inventado). */
  observation: string;
  /** Domínio de negócio (sales|retail_ops|agenda|clinic|escola|...). */
  domain: string;
  /** Tipo do sinal; default 'human_observation'. */
  signalType?: string;
  /** O "sobre o quê": sku|product|contact|topic|... (opcional). */
  subjectType?: string | null;
  /** Id/rótulo concreto do assunto — a CHAVE do acúmulo (mesmo assunto acumula). */
  subjectId?: string | null;
  /** `estimate` (relato direto) | `hypothesis` (interpretação). NUNCA fact (§13). */
  basis?: "estimate" | "hypothesis";
  /** Rastro da interação que originou (ex.: inbox item do Fala Tu). */
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  /** Quando a pessoa observou (default: agora). */
  occurredAt?: string | null;
  /** Fio da espinha única (ADR-158); omitido enraíza a própria cadeia. */
  correlationId?: string | null;
}

interface StoredObservation { at: string; by: string | null; text: string; }

// Bases aceitas: percepção humana é relato/interpretação, jamais fato comprovado.
const HUMAN_BASES = new Set(["estimate", "hypothesis"]);

// Normaliza um texto livre pra compor a chave de acúmulo quando não há subjectId
// explícito (ex.: duas frases parecidas sobre o mesmo produto convergem). Minúsculo,
// sem acento, colapsa espaço, corta em 80 chars (chave estável, não semântica —
// desambiguação fina é do humano ao informar subjectId).
function normKey(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "obs";
}

export class HumanSignalService {
  static enabled(orgId: string): boolean {
    const r = db.prepare(`SELECT COALESCE(radar_human_signals_enabled,0) e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return !!(r && r.e);
  }

  /**
   * Confiança por corroboração (§46). Começa baixa (uma percepção isolada é fraca)
   * e sobe com cada observação corroborante, mas NUNCA chega a 1 — percepção
   * humana não vira certeza (§13). Curva: 1→0.30, 2→0.48, 3→0.66, 4→0.84, 5+→0.85.
   */
  static accrualConfidence(count: number): number {
    const c = Math.max(1, Math.floor(count));
    return Math.min(0.85, Math.round((0.30 + 0.18 * (c - 1)) * 100) / 100);
  }

  /**
   * Severidade por corroboração: 1 observação = info (registra, não alarma);
   * 2 = attention (padrão emergindo); 3+ = risk (padrão corroborado, merece ação).
   */
  static accrualSeverity(count: number): "info" | "attention" | "risk" {
    if (count >= 3) return "risk";
    if (count === 2) return "attention";
    return "info";
  }

  /**
   * Registra uma observação humana, ACUMULANDO no sinal do mesmo assunto (se já
   * existir e ainda aberto). Read-append-publish atômico. Retorna o estado do
   * sinal após o acúmulo. Isolado por org; opt-in (checa flag).
   */
  static observe(orgId: string, input: HumanObservationInput): {
    ok: boolean;
    reason?: string;
    signalId?: string;
    observationCount?: number;
    confidence?: number;
    severity?: string;
    deduped?: boolean;
  } {
    if (!this.enabled(orgId)) return { ok: false, reason: "disabled" };
    const text = String(input?.observation || "").trim();
    if (!text) return { ok: false, reason: "empty_observation" };
    if (!input?.domain) return { ok: false, reason: "missing_domain" };
    const basis = HUMAN_BASES.has(String(input.basis || "")) ? String(input.basis) : "estimate";
    const signalType = String(input.signalType || "human_observation");
    const subjectType = input.subjectType || null;
    // Chave de acúmulo: assunto explícito (subjectId) OU normalização do texto.
    const subjectKey = input.subjectId ? String(input.subjectId) : normKey(text);
    const dedupeKey = `human:${input.domain}:${signalType}:${subjectType || "-"}:${subjectKey}`;
    const nowIso = new Date().toISOString();
    const newObs: StoredObservation = { at: input.occurredAt || nowIso, by: input.observerId || null, text: text.slice(0, 500) };

    // Transação: lê o sinal existente (aberto/reconhecido — não reabre resolvido/
    // dispensado), acumula as observações, recomputa confiança/severidade e publica.
    const run = db.transaction(() => {
      const existing = db.prepare(
        `SELECT id, status, evidence_json FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`
      ).get(orgId, dedupeKey) as any;

      let observations: StoredObservation[] = [];
      // Só acumula sobre sinal AINDA VIVO (open/acknowledged). Se o assunto foi
      // resolvido/dispensado, uma observação nova começa um ciclo limpo (o publish
      // idempotente reaproveita a linha mas o histórico anterior não infla a nova
      // contagem — evita "ressuscitar" gravidade velha).
      const revived = existing && (existing.status === "open" || existing.status === "acknowledged");
      if (revived) {
        try {
          const prev = JSON.parse(existing.evidence_json || "{}");
          if (Array.isArray(prev?.observations)) observations = prev.observations.filter((o: any) => o && typeof o.text === "string");
        } catch { /* evidência corrompida → recomeça a contagem */ }
      }
      observations.push(newObs);

      const count = observations.length;
      const confidence = this.accrualConfidence(count);
      const severity = this.accrualSeverity(count);
      const firstObservedAt = observations[0]?.at || nowIso;
      const lastObservedAt = newObs.at;

      const pub = BusinessSignalService.publish(orgId, {
        domain: input.domain,
        signalType,
        severity,
        basis,
        confidence,
        occurredAt: firstObservedAt,
        sourceService: "HumanSignalService",
        sourceEntityType: input.sourceEntityType || null,
        sourceEntityId: input.sourceEntityId || null,
        subjectType,
        subjectId: input.subjectId || subjectKey,
        evidence: {
          summary: text.slice(0, 200),
          origin: "human",
          observationCount: count,
          latest: newObs.text,
          firstObservedAt,
          lastObservedAt,
          observers: Array.from(new Set(observations.map((o) => o.by).filter(Boolean))),
          observations,
        },
        premises: { note: "Percepção humana — não medida. Confiança cresce por corroboração, nunca vira fato (§13)." },
        dedupeKey,
        correlationId: input.correlationId || null,
      });

      return { signalId: pub.id, deduped: pub.deduped, observationCount: count, confidence, severity };
    });

    const out = run();
    return { ok: true, ...out };
  }
}

export default HumanSignalService;
