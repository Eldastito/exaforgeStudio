/**
 * AlterdataSyncLedgerService — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 3, RF-06/08/17).
 *
 * Escreve o ledger de execuções da integração Alterdata:
 *   - alterdata_sync_runs         (1 linha por execução, cabeçalho)
 *   - alterdata_sync_run_resources (1 linha por resource, detalhe)
 *
 * Contrato pro runner:
 *   1. begin(orgId, env, trigger, initiatedBy?): abre a run com status 'running'
 *      e devolve { runId, correlationId, record, finish }.
 *   2. record({ module, resource, filial, required, status, ... }): grava o
 *      resultado de UM recurso — sucesso OU falha, sem `catch {}` silencioso.
 *   3. finish({ status?, note? }): fecha a run tabulando required/optional
 *      failures a partir das linhas de resource; se `status` não vier, decide
 *      pelo próprio saldo (success | partial_failure | failed).
 *
 * Sanitização (RF-08): mensagens de erro são cortadas em 500 chars, o token
 * cifrado e caches "Bearer …" são substituídos por `<redacted>` — segredo
 * NUNCA vai pro ledger nem pra UI.
 *
 * Códigos de erro (RF-17):
 *   ZAPFLOW_CODE          → bug interno do nosso código
 *   ALTERDATA_AUTH        → falha de auth (Guardian, 401)
 *   ALTERDATA_API         → resposta 4xx/5xx do serviço Alterdata
 *   TOULON_CONFIGURATION  → falta configuração do lado do cliente (rede/filial/tabela)
 *   LGPD_APPROVAL         → aprovação LGPD ausente pra dado pessoal (CRM)
 *   UNKNOWN               → não classificado
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import type { AlterdataEnvironment } from "./AlterdataProfileService.js";

export type LedgerRunTrigger = "manual" | "scheduler" | "resync";
export type LedgerRunStatus = "queued" | "running" | "success" | "partial_failure" | "failed" | "cancelled";

export type LedgerErrorCode =
  | "ZAPFLOW_CODE"
  | "ALTERDATA_AUTH"
  | "ALTERDATA_API"
  | "TOULON_CONFIGURATION"
  | "LGPD_APPROVAL"
  | "UNKNOWN";

/**
 * Status possíveis por resource, superset do RF-09 (probe). Runner do delta-sync
 * usa principalmente `ready`, `empty_but_valid`, `auth_failed`, `server_error`.
 */
export type LedgerResourceStatus =
  | "ready"
  | "empty_but_valid"
  | "auth_failed"
  | "forbidden"
  | "not_found"
  | "server_error"
  | "contract_mismatch"
  | "mapping_failed"
  | "store_not_mapped"
  | "product_not_mapped"
  | "rate_limited"
  | "unreachable"
  | "skipped_by_policy";

export interface LedgerResourceInput {
  module: string;
  resource: string;
  filial?: string;
  required: boolean;
  status: LedgerResourceStatus;
  httpStatus?: number | null;
  cursorBefore?: string | null;
  cursorAfter?: string | null;
  pages?: number;
  received?: number;
  imported?: number;
  skipped?: number;
  mappingErrors?: number;
  errorCode?: LedgerErrorCode | null;
  errorMessage?: string | null;
}

export interface LedgerRunHandle {
  runId: string;
  correlationId: string;
  record: (r: LedgerResourceInput) => void;
  finish: (opts?: { status?: LedgerRunStatus }) => LedgerRunStatus;
}

/** Corta segredo do texto ANTES de gravar no ledger. */
export function sanitizeErrorMessage(message: unknown): string {
  const raw = message instanceof Error ? message.message : String(message ?? "");
  const noBearer = raw.replace(/Bearer\s+[A-Za-z0-9._~+/=\-]+/gi, "Bearer <redacted>");
  const noEnc = noBearer.replace(/\benc:[A-Za-z0-9+/=]{20,}/g, "enc:<redacted>");
  const noAuthHeaders = noEnc.replace(/(client_secret|password|api[_-]?key)=([^&\s"']+)/gi, "$1=<redacted>");
  return noAuthHeaders.slice(0, 500);
}

/**
 * Classifica um erro pra código do ledger. HTTP 401 → ALTERDATA_AUTH, 4xx/5xx
 * → ALTERDATA_API, TypeError/ReferenceError → ZAPFLOW_CODE, mensagem contendo
 * `configuraç` → TOULON_CONFIGURATION. Fallback UNKNOWN.
 */
export function classifyError(e: unknown, httpStatus?: number | null): LedgerErrorCode {
  if (httpStatus === 401) return "ALTERDATA_AUTH";
  if (httpStatus && httpStatus >= 400) return "ALTERDATA_API";
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError) return "ZAPFLOW_CODE";
  const msg = String((e as any)?.message ?? e ?? "").toLowerCase();
  if (msg.includes("guardian") || msg.includes("401") || msg.includes("token")) return "ALTERDATA_AUTH";
  if (/(http\s*)?(4\d\d|5\d\d)\b/.test(msg)) return "ALTERDATA_API";
  if (msg.includes("configur") || msg.includes("rede") || msg.includes("tabela") || msg.includes("filial")) return "TOULON_CONFIGURATION";
  if (msg.includes("lgpd") || msg.includes("aprova")) return "LGPD_APPROVAL";
  return "UNKNOWN";
}

/** Extrai `HTTP <n>` de mensagens comuns pra alimentar httpStatus. */
export function extractHttpStatus(message: unknown): number | null {
  const raw = message instanceof Error ? message.message : String(message ?? "");
  const m = raw.match(/HTTP\s+(\d{3})/);
  return m ? Number(m[1]) : null;
}

export class AlterdataSyncLedgerService {
  /**
   * Abre uma run. O caller recebe `record` pra logar cada resource e `finish`
   * pra fechar. `correlationId` viaja em todo log/erro dessa execução.
   */
  static begin(
    orgId: string,
    environment: AlterdataEnvironment,
    trigger: LedgerRunTrigger,
    initiatedBy: string = "system",
  ): LedgerRunHandle {
    const runId = randomUUID();
    const correlationId = randomUUID();
    db.prepare(
      `INSERT INTO alterdata_sync_runs
       (id, organization_id, environment, trigger, status, correlation_id, initiated_by)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`
    ).run(runId, orgId, environment, trigger, correlationId, initiatedBy);

    const record = (r: LedgerResourceInput): void => {
      db.prepare(
        `INSERT INTO alterdata_sync_run_resources
         (id, run_id, module, resource, filial, required, status, http_status,
          cursor_before, cursor_after, pages, received, imported, skipped,
          mapping_errors, error_code, error_message_sanitized, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).run(
        randomUUID(), runId, r.module, r.resource, r.filial ?? "",
        r.required ? 1 : 0, r.status, r.httpStatus ?? null,
        r.cursorBefore ?? null, r.cursorAfter ?? null,
        r.pages ?? 0, r.received ?? 0, r.imported ?? 0, r.skipped ?? 0,
        r.mappingErrors ?? 0,
        r.errorCode ?? null,
        r.errorMessage ? sanitizeErrorMessage(r.errorMessage) : null,
      );
    };

    const finish = (opts?: { status?: LedgerRunStatus }): LedgerRunStatus => {
      const tally = db.prepare(
        `SELECT
           SUM(CASE WHEN required = 1 AND status NOT IN ('ready', 'empty_but_valid', 'skipped_by_policy') THEN 1 ELSE 0 END) AS req_fail,
           SUM(CASE WHEN required = 0 AND status NOT IN ('ready', 'empty_but_valid', 'skipped_by_policy') THEN 1 ELSE 0 END) AS opt_fail
         FROM alterdata_sync_run_resources WHERE run_id = ?`
      ).get(runId) as { req_fail: number | null; opt_fail: number | null };
      const requiredFailures = Number(tally?.req_fail || 0);
      const optionalFailures = Number(tally?.opt_fail || 0);
      const finalStatus: LedgerRunStatus = opts?.status ??
        (requiredFailures > 0 ? "failed" : (optionalFailures > 0 ? "partial_failure" : "success"));
      db.prepare(
        `UPDATE alterdata_sync_runs
         SET status = ?, finished_at = CURRENT_TIMESTAMP,
             required_failures = ?, optional_failures = ?
         WHERE id = ?`
      ).run(finalStatus, requiredFailures, optionalFailures, runId);
      return finalStatus;
    };

    return { runId, correlationId, record, finish };
  }

  /** Marca uma run como `cancelled` (uso: kill do container mid-run). */
  static cancelRun(runId: string, reason?: string): void {
    db.prepare(
      `UPDATE alterdata_sync_runs
       SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'running'`
    ).run(runId);
    if (reason) {
      db.prepare(
        `INSERT INTO alterdata_sync_run_resources
         (id, run_id, module, resource, filial, required, status, error_code, error_message_sanitized, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).run(randomUUID(), runId, "_meta", "cancellation", "", 0, "unreachable", "ZAPFLOW_CODE", sanitizeErrorMessage(reason));
    }
  }

  /** Últimas N runs da org (com contagem de resources). Base pra futura UI. */
  static listRecentRuns(orgId: string, environment: AlterdataEnvironment, limit = 20): any[] {
    return db.prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM alterdata_sync_run_resources rr WHERE rr.run_id = r.id) AS resource_count
       FROM alterdata_sync_runs r
       WHERE r.organization_id = ? AND r.environment = ?
       ORDER BY r.started_at DESC
       LIMIT ?`
    ).all(orgId, environment, limit) as any[];
  }

  /** Detalhes de uma run + linhas de resource. */
  static getRun(runId: string): { run: any; resources: any[] } | null {
    const run = db.prepare(`SELECT * FROM alterdata_sync_runs WHERE id = ?`).get(runId) as any;
    if (!run) return null;
    const resources = db.prepare(
      `SELECT * FROM alterdata_sync_run_resources WHERE run_id = ? ORDER BY started_at ASC`
    ).all(runId) as any[];
    return { run, resources };
  }
}
