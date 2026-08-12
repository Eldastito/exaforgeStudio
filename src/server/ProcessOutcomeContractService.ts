/**
 * ProcessOutcomeContractService — PRD 8 / ADR-165 F2 (§13, achado (a), RN-OA-3):
 * avalia o Outcome Contract de PROCESSO.
 *
 * A auditoria F0 achou que `success_conditions_json`/`failure_conditions_json` de
 * `process_definitions` são **só armazenados, nunca avaliados** (`ProcessRuntimeService.
 * defineProcess:139-141`) — só a `successCondition` de STEP é avaliada. Este serviço fecha
 * o gap SEM criar avaliador novo: REUSA `PlaybookEngine.evaluateCondition` (avaliador puro,
 * sem I/O) sobre um contexto de negócio derivado da instância.
 *
 * As colunas existentes viram o **Outcome Contract** (ADR-165 D2 — sem tabela nova). O
 * contrato pode vir em dois formatos, ambos normalizados por `toCondition`:
 *   - nativo do PlaybookEngine: `{ op, path, value, conditions, condition }`;
 *   - clausal de domínio: `{ field, operator, value }` / `{ all: [...] }` / `{ any: [...] }`.
 *
 * GUARDRAILS (RN-OA):
 *   - RN-OA-3 — **read-only**: NÃO muda a FSM, NÃO conclui/falha a instância. Só LÊ a
 *     definição + a instância e devolve um veredito DERIVADO. Quem corrige é governado (F10).
 *   - RN-OA-2 — sem contrato definido → `no_contract` (não inventa sucesso); condição que
 *     não dá pra avaliar → registrada como `unevaluable`, nunca "passou".
 *   - Determinístico, sem LLM. Isolado por `organization_id`.
 */
import db from "./db.js";
import { evaluateCondition, Condition } from "./PlaybookEngine.js";

const OP_MAP: Record<string, string> = {
  eq: "eq", equals: "eq", "==": "eq",
  gte: "gte", ">=": "gte", lte: "lte", "<=": "lte",
  truthy: "truthy", exists: "truthy", present: "truthy",
};

/** Normaliza um contrato (nativo OU clausal) numa `Condition` do PlaybookEngine. */
export function toCondition(raw: any): Condition | null {
  if (raw == null) return null;
  // Array de cláusulas → AND.
  if (Array.isArray(raw)) {
    const subs = raw.map(toCondition).filter(Boolean) as Condition[];
    return subs.length ? { op: "and", conditions: subs } : null;
  }
  if (typeof raw !== "object") return null;
  // Já é uma Condition nativa (tem `op`).
  if (typeof raw.op === "string") {
    if (raw.op === "and" || raw.op === "or") {
      const subs = (raw.conditions || []).map(toCondition).filter(Boolean) as Condition[];
      return subs.length ? { op: raw.op, conditions: subs } : null;
    }
    if (raw.op === "not") { const c = toCondition(raw.condition); return c ? { op: "not", condition: c } : null; }
    return raw as Condition;
  }
  // Açúcar clausal: { all: [...] } / { any: [...] }.
  if (Array.isArray(raw.all)) { const subs = raw.all.map(toCondition).filter(Boolean) as Condition[]; return subs.length ? { op: "and", conditions: subs } : null; }
  if (Array.isArray(raw.any)) { const subs = raw.any.map(toCondition).filter(Boolean) as Condition[]; return subs.length ? { op: "or", conditions: subs } : null; }
  // Cláusula de domínio: { field/path, operator, value }.
  const path = raw.field ?? raw.path;
  const op = OP_MAP[String(raw.operator ?? raw.op ?? "").toLowerCase()];
  if (typeof path === "string" && op) {
    if (op === "truthy") return { op: "truthy", path };
    return { op: op as any, path, value: raw.value };
  }
  return null;
}

export class ProcessOutcomeContractService {
  /** Monta o contexto de negócio da instância (context + result + campos de topo). */
  private static contextOf(inst: any): any {
    const context = safeParse(inst.context_json) ?? {};
    const result = inst.result_json ? safeParse(inst.result_json) : null;
    return {
      ...context,
      result,
      status: inst.status,
      expectedValue: inst.expected_value ?? null,
      riskLevel: inst.risk_level ?? null,
      subjectType: inst.subject_type ?? null,
      subjectId: inst.subject_id ?? null,
    };
  }

  /**
   * Avalia o Outcome Contract de uma instância de processo. Read-only.
   * verdict: `success` | `failure` | `indeterminate` | `no_contract`.
   * Failure tem precedência sobre success (um processo que bateu a condição de FALHA
   * não é "sucesso" mesmo que a de sucesso também bata — RN-OA-1 conservador).
   */
  static evaluate(orgId: string, instanceId: string): any {
    if (!orgId || !instanceId) return { found: false, verdict: "no_contract" };
    const inst = db.prepare(`SELECT * FROM process_instances WHERE id = ? AND organization_id = ?`).get(instanceId, orgId) as any;
    if (!inst) return { found: false, verdict: "no_contract" };
    const def = db.prepare(`SELECT success_conditions_json, failure_conditions_json FROM process_definitions WHERE id = ? AND organization_id = ?`).get(inst.process_definition_id, orgId) as any;

    const rawSuccess = def?.success_conditions_json ? safeParse(def.success_conditions_json) : null;
    const rawFailure = def?.failure_conditions_json ? safeParse(def.failure_conditions_json) : null;
    const successCond = toCondition(rawSuccess);
    const failureCond = toCondition(rawFailure);

    const hasSuccess = rawSuccess != null;
    const hasFailure = rawFailure != null;
    if (!hasSuccess && !hasFailure) {
      return { found: true, instanceId, status: inst.status, verdict: "no_contract", note: "Processo sem Outcome Contract definido (RN-OA-2 — não inventa sucesso)." };
    }

    const ctx = this.contextOf(inst);
    // Condição presente mas não-normalizável → unevaluable (nunca "passou" — RN-OA-2).
    const successUnevaluable = hasSuccess && successCond == null;
    const failureUnevaluable = hasFailure && failureCond == null;
    const successMet = successCond ? evaluateCondition(successCond, ctx) : null;
    const failureMet = failureCond ? evaluateCondition(failureCond, ctx) : null;

    let verdict: string;
    if (failureMet === true) verdict = "failure";               // falha tem precedência
    else if (successMet === true && !failureUnevaluable) verdict = "success";
    else if (successUnevaluable || failureUnevaluable) verdict = "indeterminate";
    else verdict = "indeterminate";                             // definido mas ainda não satisfeito

    return {
      found: true, instanceId, processType: inst.process_type, status: inst.status,
      verdict,
      contract: {
        success: { defined: hasSuccess, met: successMet, unevaluable: successUnevaluable },
        failure: { defined: hasFailure, met: failureMet, unevaluable: failureUnevaluable },
      },
      note: "Veredito DERIVADO read-only (RN-OA-3) — NÃO muda a FSM da instância; falha tem precedência sobre sucesso (RN-OA-1).",
    };
  }
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

export default ProcessOutcomeContractService;
