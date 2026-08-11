import db from "./db.js";
import { randomUUID } from "crypto";
import { FailureClass, ReliabilityResult, ReliabilityStatus, retryPolicyFor } from "./skillosModel.js";
import { computeBackoffSeconds } from "./JobQueueService.js";

/**
 * AiReliabilityKernel — PRD 4 F4 (Reliability Core, §15): o CHOKE-POINT de
 * confiabilidade de IA. Toda chamada relevante de modelo passa por aqui (Decisão
 * D2 — vive em volta do primitivo de provider de `llm.ts`, não é motor paralelo):
 * o caller injeta o `invoke` (a chamada crua ao modelo) e o Kernel embrulha com
 * validação de saída, taxonomia de falha, retry por política e o registro de uma
 * AI RUN (Decisão D4 — estende `ai_usage_log`, sem tabela de tracing paralela).
 *
 * Esta fatia entrega o NÚCLEO: AI Run + schema validation + error taxonomy + retry
 * + correlação. Grounding avançado e Model Router são fases seguintes (F5/F6);
 * aqui `groundingStatus` fica 'skipped'. Aditivo e opt-in — nenhum caller existente
 * passa a usar o Kernel automaticamente (0 mudança de comportamento).
 *
 * GUARDRAILS (testados):
 *   - RN-KER-1 SEMPRE UMA AI RUN: toda execução (sucesso/falha/fallback) grava 1
 *     linha rastreável; best-effort (o registro nunca derruba a execução).
 *   - RN-KER-2 RETRY POR POLÍTICA (§27): técnico→retry; formato→retry corretivo;
 *     policy→nunca; a taxonomia (F1) decide, não um retry cego.
 *   - RN-KER-3 SEM SILÊNCIO (§65): o resultado termina sempre num estado observável
 *     (ok/retried/fallback/blocked/failed) + failureClass quando falha.
 *   - RN-KER-4 REUSA: backoff = `computeBackoffSeconds` (JobQueue), tokens/custo no
 *     `ai_usage_log` existente — não duplica infra.
 */

export interface AiInvokeUsage {
  inputTokens?: number; outputTokens?: number; totalTokens?: number;
  costUsd?: number; costBrl?: number;
  model?: string; provider?: string; latencyMs?: number;
}

export interface AiInvokeResult {
  output: any;
  usage?: AiInvokeUsage;
}

export interface AiRunSpec {
  skillId?: string | null;
  capabilityId?: string | null;
  provider?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  contextHash?: string | null;
  contextProfile?: string | null;
  correlationId?: string | null;
  userId?: string | null;
  kind?: string;              // ai_usage_log.kind (default 'skill_run')
  module?: string;            // ai_usage_log.module (default 'skillos')
  operation?: string | null;
  maxAttempts?: number;       // total de tentativas (default 1 = sem retry)
  confidence?: number | null;
  /** Valida a saída (schema §18). Retorna bool ou {valid, errors}. */
  validate?: (output: any) => boolean | { valid: boolean; errors?: string[] };
  /** Classifica um erro na taxonomia AI-FAIL (§17). Default: heurística. */
  classifyError?: (err: any) => FailureClass;
}

export interface AiRunOutcome {
  runId: string;
  output: any;
  reliability: ReliabilityResult;
}

export class AiReliabilityKernel {
  /**
   * §15 — executa `invoke` sob o Kernel. Retorna a saída + o `ReliabilityResult` +
   * o `runId`. Nunca lança por falha de modelo (retorna status 'failed'/'fallback').
   */
  static async run(orgId: string, spec: AiRunSpec, invoke: () => Promise<AiInvokeResult>): Promise<AiRunOutcome> {
    const runId = randomUUID();
    const maxAttempts = Math.max(1, Math.floor(spec.maxAttempts || 1));
    let attempt = 0;
    let retryCount = 0;
    let usage: AiInvokeUsage | undefined;

    while (true) {
      attempt++;
      try {
        const res = await invoke();
        usage = res?.usage;
        // §18 validação de saída.
        if (spec.validate) {
          const v = normalizeValidation(spec.validate(res?.output));
          if (!v.valid) {
            // AI-FAIL-2 (format): retry CORRETIVO até o teto; senão, falha.
            if (attempt < maxAttempts) { retryCount++; continue; }
            return this.finish(runId, orgId, spec, usage, { status: "failed", validationStatus: "invalid", failureClass: "format", retryCount, fallbackUsed: false }, res?.output);
          }
          return this.finish(runId, orgId, spec, usage, { status: retryCount > 0 ? "retried" : "ok", validationStatus: "valid", failureClass: null, retryCount, fallbackUsed: false }, res?.output);
        }
        return this.finish(runId, orgId, spec, usage, { status: retryCount > 0 ? "retried" : "ok", validationStatus: "skipped", failureClass: null, retryCount, fallbackUsed: false }, res?.output);
      } catch (err: any) {
        const fc = (spec.classifyError && spec.classifyError(err)) || this.defaultClassify(err);
        const policy = retryPolicyFor(fc);
        const retriable = policy === "backoff" || policy === "corrective";
        if (retriable && attempt < maxAttempts) { retryCount++; continue; }
        // policy 'fallback' sinaliza ao caller trocar de skill (a cadeia é do Resolver F3).
        const status: ReliabilityStatus = policy === "fallback" ? "fallback" : "failed";
        return this.finish(runId, orgId, spec, usage, { status, validationStatus: "skipped", failureClass: fc, retryCount, fallbackUsed: policy === "fallback", error: String(err?.message || err) }, null);
      }
    }
  }

  /** Backoff (seg) reusando o cálculo do JobQueue — pro caminho de retry ASSÍNCRONO. */
  static backoffSeconds(attempt: number, cls: FailureClass): number {
    return computeBackoffSeconds(attempt, cls === "technical" ? "external_unavailable" : "retryable");
  }

  /** Lê uma AI Run gravada (uso interno/observabilidade; a redação §30 é da F9). */
  static getRun(orgId: string, runId: string): any {
    const r = db.prepare("SELECT * FROM ai_usage_log WHERE organization_id = ? AND run_id = ?").get(orgId, runId) as any;
    return r || null;
  }

  // ── internos ──────────────────────────────────────────────────────────────────

  /** Heurística default de classificação de erro (§17). Conservadora: desconhecido → técnico. */
  static defaultClassify(err: any): FailureClass {
    const code = Number(err?.status ?? err?.statusCode ?? err?.code);
    const msg = String(err?.message || err || "").toLowerCase();
    if (code === 429 || /rate.?limit|too many requests/.test(msg)) return "technical";
    if ((code >= 500 && code < 600) || /timeout|etimedout|econnreset|network|unavailable|socket|fetch failed/.test(msg)) return "technical";
    if (/schema|json|parse|invalid output|enum|malformed/.test(msg)) return "format";
    if (/policy|forbidden|not allowed|unauthorized|constraint|lgpd|rbac/.test(msg)) return "policy";
    return "technical"; // default retryável (conservador)
  }

  private static finish(
    runId: string, orgId: string, spec: AiRunSpec, usage: AiInvokeUsage | undefined,
    r: { status: ReliabilityStatus; validationStatus: "valid" | "invalid" | "skipped"; failureClass: FailureClass | null; retryCount: number; fallbackUsed: boolean; error?: string },
    output: any,
  ): AiRunOutcome {
    const provider = usage?.provider ?? spec.provider ?? null;
    const model = usage?.model ?? spec.model ?? null;
    const reliability: ReliabilityResult = {
      status: r.status,
      validationStatus: r.validationStatus,
      groundingStatus: "skipped",         // grounding é F6
      confidence: spec.confidence ?? null,
      retryCount: r.retryCount,
      fallbackUsed: r.fallbackUsed,
      failureClass: r.failureClass,
      provider, model,
      latencyMs: usage?.latencyMs ?? null,
    };
    // RN-KER-1 — grava a AI Run (best-effort; nunca derruba a execução).
    try {
      const costBrl = usage?.costBrl ?? null;
      db.prepare(`INSERT INTO ai_usage_log
        (id, organization_id, user_id, model, kind, module, operation, input_tokens, output_tokens, total_tokens, cost_usd, cost_brl, cost_cents, latency_ms, request_id,
         run_id, skill_id, capability_id, prompt_version, context_hash, context_profile, provider, validation_status, grounding_status, confidence, failure_class, retry_count, fallback_used, run_status, correlation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          randomUUID(), orgId, spec.userId ?? null, model, spec.kind || "skill_run", spec.module || "skillos", spec.operation ?? null,
          usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)),
          usage?.costUsd ?? 0, costBrl ?? 0, costBrl != null ? Math.round(costBrl * 100) : 0, usage?.latencyMs ?? 0, runId,
          runId, spec.skillId ?? null, spec.capabilityId ?? null, spec.promptVersion ?? null, spec.contextHash ?? null, spec.contextProfile ?? null,
          provider, r.validationStatus, "skipped", spec.confidence ?? null, r.failureClass, r.retryCount, r.fallbackUsed ? 1 : 0, r.status, spec.correlationId ?? null,
        );
    } catch (e) { /* AI Run é aditiva — nunca bloqueia (RN-KER-1) */ }
    return { runId, output, reliability };
  }
}

function normalizeValidation(v: boolean | { valid: boolean; errors?: string[] }): { valid: boolean; errors?: string[] } {
  return typeof v === "boolean" ? { valid: v } : (v || { valid: false });
}

export default AiReliabilityKernel;
