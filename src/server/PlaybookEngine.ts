/**
 * PlaybookEngine (ADR-152 Fatia 1.1) — motor PURO de playbook.
 *
 * Sem I/O, sem DB, sem side effects. Recebe a definição do processo
 * (`steps_json` da tabela `process_definitions`) e um contexto, devolve o
 * próximo passo e o resultado da avaliação. Isso permite testar a lógica de
 * playbook em isolamento (SLA §11.8: auditabilidade + testabilidade +
 * simplicidade + versionamento + rollback fácil).
 *
 * Formato do playbook (ADR-152 D3 — JSON tipado, validação artesanal como o
 * resto do repo; nada de DSL própria):
 *
 * {
 *   "startStep": "id_do_primeiro_step",  // opcional; default = 1º item do array
 *   "steps": [
 *     {
 *       "id": "fetch_erp_data",
 *       "commandType": "alterdata_fetch_daily",  // resolvido pelo CommandExecutorService
 *       "successCondition": { "op": "truthy", "path": "erp_data" },
 *       "timeoutSeconds": 300,
 *       "maxAttempts": 3,
 *       "onFailure": "escalate",     // fallback | escalate | fail
 *       "fallbackStep": null,
 *       "next": "reconcile"           // id do próximo | array de {when, next} | "$end"
 *     }
 *   ]
 * }
 *
 * Condições ("op"): igual, subset do JSON-Logic que precisamos.
 *   - { "op": "truthy",  "path": "erp_data" }         → !!ctx.erp_data
 *   - { "op": "eq",      "path": "status", "value": "ok" }
 *   - { "op": "gte",     "path": "variance", "value": 0.05 }
 *   - { "op": "lte",     "path": "variance", "value": 0.05 }
 *   - { "op": "and",     "conditions": [...] }
 *   - { "op": "or",      "conditions": [...] }
 *   - { "op": "not",     "condition": {...} }
 *
 * "path" é uma dot-path no context ({a:{b:{c:1}}} → "a.b.c" → 1); tudo ausente
 * é `undefined`. Estender o vocabulário no futuro é aditivo — versionar o
 * playbook em process_definitions.version fica trivial.
 *
 * A engine NÃO executa comandos (isso é do CommandExecutorService, Fase 2);
 * ela só decide "qual step vem agora" e "esse step teve sucesso segundo a
 * condição?" — o Runtime chama os dois métodos e persiste o resultado.
 */

// ── Tipos ────────────────────────────────────────────────────────────────

export type ConditionOp = "truthy" | "eq" | "gte" | "lte" | "and" | "or" | "not";
export type OnFailure = "fallback" | "escalate" | "fail";

export interface Condition {
  op: ConditionOp;
  path?: string;
  value?: any;
  conditions?: Condition[];
  condition?: Condition;
}

export interface NextRule {
  when?: Condition;   // opcional; sem `when` → default (pega a última que casar; sem match e sem default → "$end")
  next: string;       // id do próximo step, ou "$end"
}

export interface PlaybookStep {
  id: string;
  commandType: string;
  successCondition?: Condition;   // ausente = sempre sucesso
  timeoutSeconds?: number;         // default 300
  maxAttempts?: number;            // default 3
  onFailure?: OnFailure;           // default "fail"
  fallbackStep?: string | null;    // exige onFailure = "fallback"
  next?: string | NextRule[];      // ausente = "$end"
}

export interface PlaybookDefinition {
  startStep?: string;
  steps: PlaybookStep[];
}

export interface ValidationError { path: string; message: string }
export interface ValidationResult { ok: boolean; errors: ValidationError[] }

// ── Validação ────────────────────────────────────────────────────────────

const OPS: Record<ConditionOp, true> = { truthy: true, eq: true, gte: true, lte: true, and: true, or: true, not: true };
const FAIL_MODES: Record<OnFailure, true> = { fallback: true, escalate: true, fail: true };

function isPlainString(v: any): v is string { return typeof v === "string" && v.length > 0; }

function validateCondition(c: any, path: string, errors: ValidationError[]): void {
  if (c == null) return; // opcional
  if (typeof c !== "object" || Array.isArray(c)) { errors.push({ path, message: "condition deve ser objeto" }); return; }
  const op = c.op;
  if (!(op in OPS)) { errors.push({ path: `${path}.op`, message: `op inválido "${op}"` }); return; }
  if (op === "truthy") {
    if (!isPlainString(c.path)) errors.push({ path: `${path}.path`, message: "path obrigatório em 'truthy'" });
  } else if (op === "eq" || op === "gte" || op === "lte") {
    if (!isPlainString(c.path)) errors.push({ path: `${path}.path`, message: `path obrigatório em '${op}'` });
    if (!("value" in c)) errors.push({ path: `${path}.value`, message: `value obrigatório em '${op}'` });
  } else if (op === "and" || op === "or") {
    if (!Array.isArray(c.conditions) || c.conditions.length === 0) errors.push({ path: `${path}.conditions`, message: `array não-vazio obrigatório em '${op}'` });
    else c.conditions.forEach((sub: any, i: number) => validateCondition(sub, `${path}.conditions[${i}]`, errors));
  } else if (op === "not") {
    if (c.condition == null) errors.push({ path: `${path}.condition`, message: "condition obrigatória em 'not'" });
    else validateCondition(c.condition, `${path}.condition`, errors);
  }
}

/**
 * Valida a definição inteira antes de aceitar (chamado em ProcessRuntimeService.
 * defineProcess). Motivo: um playbook mal formado não pode virar processo em
 * produção — descobrir a `next` inexistente rodando é tarde demais.
 */
export function validateDefinition(def: any): ValidationResult {
  const errors: ValidationError[] = [];
  if (!def || typeof def !== "object" || Array.isArray(def)) return { ok: false, errors: [{ path: "$", message: "definição deve ser objeto" }] };
  if (!Array.isArray(def.steps) || def.steps.length === 0) errors.push({ path: "steps", message: "array não-vazio obrigatório" });
  const ids = new Set<string>();
  if (Array.isArray(def.steps)) {
    def.steps.forEach((s: any, i: number) => {
      const p = `steps[${i}]`;
      if (!isPlainString(s?.id)) errors.push({ path: `${p}.id`, message: "id obrigatório" });
      else if (ids.has(s.id)) errors.push({ path: `${p}.id`, message: `id duplicado "${s.id}"` });
      else ids.add(s.id);
      if (!isPlainString(s?.commandType)) errors.push({ path: `${p}.commandType`, message: "commandType obrigatório" });
      if (s?.timeoutSeconds != null && (!Number.isFinite(s.timeoutSeconds) || s.timeoutSeconds <= 0)) errors.push({ path: `${p}.timeoutSeconds`, message: "positivo" });
      if (s?.maxAttempts != null && (!Number.isInteger(s.maxAttempts) || s.maxAttempts <= 0)) errors.push({ path: `${p}.maxAttempts`, message: "inteiro > 0" });
      if (s?.onFailure != null && !((s.onFailure as OnFailure) in FAIL_MODES)) errors.push({ path: `${p}.onFailure`, message: `inválido "${s.onFailure}"` });
      if (s?.onFailure === "fallback" && !isPlainString(s?.fallbackStep)) errors.push({ path: `${p}.fallbackStep`, message: "obrigatório quando onFailure='fallback'" });
      if (s?.successCondition != null) validateCondition(s.successCondition, `${p}.successCondition`, errors);
      // `next` valida referências abaixo (precisamos de ids conhecidos).
    });
  }
  // Referências (next / fallbackStep / startStep) só depois de coletar ids.
  const nextTargets: { path: string; target: string }[] = [];
  if (isPlainString(def.startStep)) nextTargets.push({ path: "startStep", target: def.startStep });
  if (Array.isArray(def.steps)) {
    def.steps.forEach((s: any, i: number) => {
      const p = `steps[${i}]`;
      if (isPlainString(s?.fallbackStep)) nextTargets.push({ path: `${p}.fallbackStep`, target: s.fallbackStep });
      if (isPlainString(s?.next)) {
        nextTargets.push({ path: `${p}.next`, target: s.next });
      } else if (Array.isArray(s?.next)) {
        s.next.forEach((rule: any, j: number) => {
          const rp = `${p}.next[${j}]`;
          if (!isPlainString(rule?.next)) errors.push({ path: `${rp}.next`, message: "obrigatório" });
          else nextTargets.push({ path: `${rp}.next`, target: rule.next });
          if (rule?.when != null) validateCondition(rule.when, `${rp}.when`, errors);
        });
      } else if (s?.next != null) {
        errors.push({ path: `${p}.next`, message: "deve ser string ou array de {when, next}" });
      }
    });
  }
  for (const t of nextTargets) {
    if (t.target === "$end") continue;
    if (!ids.has(t.target)) errors.push({ path: t.path, message: `referência a step inexistente "${t.target}"` });
  }
  return { ok: errors.length === 0, errors };
}

// ── Avaliação ────────────────────────────────────────────────────────────

function pluck(ctx: any, path: string | undefined): any {
  if (!path) return undefined;
  return path.split(".").reduce((acc: any, key) => (acc == null ? undefined : acc[key]), ctx);
}

/**
 * Avalia uma condição contra o contexto. Ausente ou inválida na semântica
 * runtime = `false` (a validação de forma já ocorreu no `defineProcess`).
 */
export function evaluateCondition(cond: Condition | undefined | null, ctx: any): boolean {
  if (!cond) return true; // ausência de condição = sempre verdade (útil pra successCondition default)
  switch (cond.op) {
    case "truthy": return !!pluck(ctx, cond.path);
    case "eq": return pluck(ctx, cond.path) === cond.value;
    case "gte": { const v = pluck(ctx, cond.path); return typeof v === "number" && v >= Number(cond.value); }
    case "lte": { const v = pluck(ctx, cond.path); return typeof v === "number" && v <= Number(cond.value); }
    case "and": return (cond.conditions || []).every((c) => evaluateCondition(c, ctx));
    case "or": return (cond.conditions || []).some((c) => evaluateCondition(c, ctx));
    case "not": return !evaluateCondition(cond.condition!, ctx);
    default: return false;
  }
}

/** Retorna o step do playbook por id, ou null. */
export function findStep(def: PlaybookDefinition, id: string): PlaybookStep | null {
  return def.steps.find((s) => s.id === id) || null;
}

/** Primeiro step (startStep se declarado, senão o primeiro do array). */
export function firstStep(def: PlaybookDefinition): PlaybookStep {
  if (def.startStep) {
    const s = findStep(def, def.startStep);
    if (!s) throw new Error(`startStep "${def.startStep}" não encontrado (validação deveria ter pego)`);
    return s;
  }
  return def.steps[0];
}

/**
 * Decide o próximo step após `current` (dado o contexto acumulado, incluindo o
 * resultado do passo atual). Retorna:
 *   - id do próximo step (existente na definição)
 *   - "$end" quando o processo termina
 *   - null quando `next` está omitido — trata como "$end"
 *
 * Regra do array de `next`: percorre em ordem; primeira regra cuja `when` for
 * verdadeira ganha. Regra sem `when` é a default e SEMPRE ganha se alcançada
 * (por isso deve vir por último). Sem match e sem default → "$end".
 */
export function chooseNextStep(def: PlaybookDefinition, currentStepId: string, ctx: any): string {
  const step = findStep(def, currentStepId);
  if (!step) return "$end";
  if (step.next == null) return "$end";
  if (typeof step.next === "string") return step.next;
  for (const rule of step.next) {
    if (rule.when == null) return rule.next;   // default hit
    if (evaluateCondition(rule.when, ctx)) return rule.next;
  }
  return "$end";
}
