import db from "./db.js";
import {
  Capability,
  SkillManifest,
  LifecycleStatus,
  LIFECYCLE_STATUSES,
  validateCapability,
  validateSkillManifest,
} from "./skillosModel.js";
import { EntitlementService } from "./EntitlementService.js";

/**
 * SkillOsRegistryService — PRD 4 F2: o CATÁLOGO de Capabilities e Skills.
 *
 * É a versão PERSISTIDA do padrão declarativo do `AnomalyDetectorRegistry` (Decisão
 * D7): registra (idempotente), busca, habilita/desabilita e filtra por vertical/
 * entitlement. O catálogo é de PLATAFORMA (universal, sem organization_id — §49):
 * "classify_intent" é a mesma capacidade pra todo tenant; o que varia por tenant é
 * o PLANO (entitlement) e a VERTICAL, checados na resolução — não o catálogo.
 *
 * `register*` valida contra o contrato puro (F1, `skillosModel`) — nada implícito
 * (§9). Ainda NÃO seleciona nem executa skill (isso é o Resolver/Runtime, fases
 * seguintes); aqui é só o registro + lookup. Inerte até algo registrar (0 regressão).
 *
 * GUARDRAILS (testados):
 *   - RN-REG-1 CONTRATO: só entra o que passa em `validateCapability`/`validateSkillManifest`.
 *   - RN-REG-2 INTEGRIDADE: Skill exige que a Capability exista (não órfã).
 *   - RN-REG-3 UNIVERSAL: catálogo sem org_id; o gate por tenant é vertical+entitlement.
 *   - RN-REG-4 IDEMPOTENTE: re-registrar a mesma id faz UPDATE (upsert), não duplica.
 *   - RN-REG-5 CICLO DE VIDA: `status` só transiciona entre os estados válidos.
 */

const j = (v: any): string | null => (v == null ? null : JSON.stringify(v));
const p = (s: any): any => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const verticalOk = (supported: string[] | null | undefined, vertical: string | null | undefined): boolean =>
  !vertical || !supported || supported.length === 0 || supported.includes(vertical);

export class SkillOsRegistryService {
  // ── Capabilities ───────────────────────────────────────────────────────────────

  /** Registra/atualiza (upsert idempotente) uma Capability validada (§7). */
  static registerCapability(cap: Capability): Capability {
    const v = validateCapability(cap);
    if (!v.valid) throw new Error(`Capability inválida: ${v.errors.join("; ")}`);
    db.prepare(`INSERT INTO skillos_capabilities
      (capability_id, version, name, description, category, risk_level, input_schema_json, output_schema_json, required_context, supported_verticals_json, entitlement_key, default_timeout_ms, default_budget_class, fallback_policy, status)
      VALUES (@capabilityId, @version, @name, @description, @category, @riskLevel, @inputSchema, @outputSchema, @requiredContext, @supportedVerticals, @entitlementKey, @defaultTimeoutMs, @defaultBudgetClass, @fallbackPolicy, @status)
      ON CONFLICT(capability_id) DO UPDATE SET
        version=excluded.version, name=excluded.name, description=excluded.description, category=excluded.category,
        risk_level=excluded.risk_level, input_schema_json=excluded.input_schema_json, output_schema_json=excluded.output_schema_json,
        required_context=excluded.required_context, supported_verticals_json=excluded.supported_verticals_json,
        entitlement_key=excluded.entitlement_key, default_timeout_ms=excluded.default_timeout_ms,
        default_budget_class=excluded.default_budget_class, fallback_policy=excluded.fallback_policy,
        status=excluded.status, updated_at=CURRENT_TIMESTAMP`)
      .run({
        capabilityId: cap.capabilityId, version: cap.version, name: cap.name, description: cap.description ?? null,
        category: cap.category, riskLevel: cap.riskLevel, inputSchema: j(cap.inputSchema), outputSchema: j(cap.outputSchema),
        requiredContext: cap.requiredContext ?? null, supportedVerticals: j(cap.supportedVerticals), entitlementKey: cap.entitlementKey ?? null,
        defaultTimeoutMs: cap.defaultTimeoutMs ?? null, defaultBudgetClass: cap.defaultBudgetClass ?? null,
        fallbackPolicy: cap.fallbackPolicy ?? null, status: cap.status,
      });
    return this.getCapability(cap.capabilityId)!;
  }

  static getCapability(capabilityId: string): Capability | null {
    const r = db.prepare("SELECT * FROM skillos_capabilities WHERE capability_id = ?").get(capabilityId) as any;
    return r ? rowToCapability(r) : null;
  }

  static listCapabilities(opts: { status?: LifecycleStatus; category?: string; vertical?: string } = {}): Capability[] {
    let sql = "SELECT * FROM skillos_capabilities WHERE 1=1";
    const params: any[] = [];
    if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
    if (opts.category) { sql += " AND category = ?"; params.push(opts.category); }
    sql += " ORDER BY category, capability_id";
    let out = (db.prepare(sql).all(...params) as any[]).map(rowToCapability);
    if (opts.vertical) out = out.filter((c) => verticalOk(c.supportedVerticals, opts.vertical));
    return out;
  }

  // ── Skills ───────────────────────────────────────────────────────────────────

  /** Registra/atualiza (upsert) uma Skill validada (§9). Exige a Capability existir. */
  static registerSkill(m: SkillManifest): SkillManifest {
    const v = validateSkillManifest(m);
    if (!v.valid) throw new Error(`Skill inválida: ${v.errors.join("; ")}`);
    if (!this.getCapability(m.capabilityId)) throw new Error(`Skill '${m.skillId}' referencia Capability inexistente: ${m.capabilityId}`);
    db.prepare(`INSERT INTO skillos_skills
      (skill_id, version, capability_id, description, input_schema_json, output_schema_json, risk_level, allowed_tools_json, forbidden_tools_json, required_permissions_json, required_entitlements_json, required_context_profile, model_requirements_json, max_execution_time_ms, max_attempts, budget_class, supports_fallback, fallback_skills_json, success_criteria_json, failure_criteria_json, supported_verticals_json, status)
      VALUES (@skillId, @version, @capabilityId, @description, @inputSchema, @outputSchema, @riskLevel, @allowedTools, @forbiddenTools, @requiredPermissions, @requiredEntitlements, @requiredContextProfile, @modelRequirements, @maxExecutionTimeMs, @maxAttempts, @budgetClass, @supportsFallback, @fallbackSkills, @successCriteria, @failureCriteria, @supportedVerticals, @status)
      ON CONFLICT(skill_id) DO UPDATE SET
        version=excluded.version, capability_id=excluded.capability_id, description=excluded.description,
        input_schema_json=excluded.input_schema_json, output_schema_json=excluded.output_schema_json, risk_level=excluded.risk_level,
        allowed_tools_json=excluded.allowed_tools_json, forbidden_tools_json=excluded.forbidden_tools_json,
        required_permissions_json=excluded.required_permissions_json, required_entitlements_json=excluded.required_entitlements_json,
        required_context_profile=excluded.required_context_profile, model_requirements_json=excluded.model_requirements_json,
        max_execution_time_ms=excluded.max_execution_time_ms, max_attempts=excluded.max_attempts, budget_class=excluded.budget_class,
        supports_fallback=excluded.supports_fallback, fallback_skills_json=excluded.fallback_skills_json,
        success_criteria_json=excluded.success_criteria_json, failure_criteria_json=excluded.failure_criteria_json,
        supported_verticals_json=excluded.supported_verticals_json, status=excluded.status, updated_at=CURRENT_TIMESTAMP`)
      .run({
        skillId: m.skillId, version: m.version, capabilityId: m.capabilityId, description: m.description ?? null,
        inputSchema: j(m.inputSchema), outputSchema: j(m.outputSchema), riskLevel: m.riskLevel,
        allowedTools: j(m.allowedTools ?? []), forbiddenTools: j(m.forbiddenTools), requiredPermissions: j(m.requiredPermissions),
        requiredEntitlements: j(m.requiredEntitlements), requiredContextProfile: m.requiredContextProfile ?? null,
        modelRequirements: j(m.modelRequirements), maxExecutionTimeMs: m.maxExecutionTimeMs ?? null, maxAttempts: m.maxAttempts ?? null,
        budgetClass: m.budgetClass ?? null, supportsFallback: m.supportsFallback ? 1 : 0, fallbackSkills: j(m.fallbackSkills),
        successCriteria: j(m.successCriteria), failureCriteria: j(m.failureCriteria), supportedVerticals: j(m.supportedVerticals), status: m.status,
      });
    return this.getSkill(m.skillId)!;
  }

  static getSkill(skillId: string): SkillManifest | null {
    const r = db.prepare("SELECT * FROM skillos_skills WHERE skill_id = ?").get(skillId) as any;
    return r ? rowToSkill(r) : null;
  }

  static listSkills(opts: { capabilityId?: string; status?: LifecycleStatus; vertical?: string } = {}): SkillManifest[] {
    let sql = "SELECT * FROM skillos_skills WHERE 1=1";
    const params: any[] = [];
    if (opts.capabilityId) { sql += " AND capability_id = ?"; params.push(opts.capabilityId); }
    if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
    sql += " ORDER BY capability_id, skill_id";
    let out = (db.prepare(sql).all(...params) as any[]).map(rowToSkill);
    if (opts.vertical) out = out.filter((s) => verticalOk(s.supportedVerticals, opts.vertical));
    return out;
  }

  /**
   * As Skills que atendem uma Capability (o input do Capability Resolver, F3).
   * Por padrão só `active` + compatíveis com a vertical. Ordem estável.
   */
  static skillsForCapability(capabilityId: string, opts: { vertical?: string; includeInactive?: boolean } = {}): SkillManifest[] {
    return this.listSkills({ capabilityId, status: opts.includeInactive ? undefined : "active", vertical: opts.vertical });
  }

  // ── Ciclo de vida ────────────────────────────────────────────────────────────

  static setCapabilityStatus(capabilityId: string, status: LifecycleStatus): Capability {
    if (!LIFECYCLE_STATUSES.includes(status)) throw new Error(`status inválido: ${status}`);
    const r = db.prepare("UPDATE skillos_capabilities SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE capability_id = ?").run(status, capabilityId);
    if (!r.changes) throw new Error("Capability não encontrada.");
    return this.getCapability(capabilityId)!;
  }

  static setSkillStatus(skillId: string, status: LifecycleStatus): SkillManifest {
    if (!LIFECYCLE_STATUSES.includes(status)) throw new Error(`status inválido: ${status}`);
    const r = db.prepare("UPDATE skillos_skills SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE skill_id = ?").run(status, skillId);
    if (!r.changes) throw new Error("Skill não encontrada.");
    return this.getSkill(skillId)!;
  }

  // ── Compatibilidade vertical + entitlement ─────────────────────────────────────

  /** Capabilities ativas compatíveis com a vertical (§88-90). Sem gate de plano. */
  static capabilitiesForVertical(vertical: string): Capability[] {
    return this.listCapabilities({ status: "active", vertical });
  }

  /**
   * A Capability está DISPONÍVEL pra este tenant/usuário? Ativa + vertical OK +
   * (se tem `entitlementKey`) o plano permite (reusa `EntitlementService`, não
   * duplica RBAC/plano). Sem `entitlementKey` ⇒ universal (só depende de status).
   */
  static isCapabilityAvailable(orgId: string, user: any, cap: Capability, vertical?: string): boolean {
    if (cap.status !== "active") return false;
    if (!verticalOk(cap.supportedVerticals, vertical)) return false;
    if (!cap.entitlementKey) return true;
    try {
      return EntitlementService.check(orgId, user, cap.entitlementKey, "use").allowed === true;
    } catch { return false; }
  }
}

// ── mapeadores linha↔contrato ────────────────────────────────────────────────────
function rowToCapability(r: any): Capability {
  return {
    capabilityId: r.capability_id, version: Number(r.version) || 1, name: r.name, description: r.description ?? null,
    category: r.category, riskLevel: r.risk_level, inputSchema: p(r.input_schema_json), outputSchema: p(r.output_schema_json),
    requiredContext: r.required_context ?? null, supportedVerticals: p(r.supported_verticals_json), entitlementKey: r.entitlement_key ?? null,
    defaultTimeoutMs: r.default_timeout_ms ?? null, defaultBudgetClass: r.default_budget_class ?? undefined,
    fallbackPolicy: r.fallback_policy ?? null, status: r.status,
  };
}

function rowToSkill(r: any): SkillManifest {
  return {
    skillId: r.skill_id, version: Number(r.version) || 1, capabilityId: r.capability_id, description: r.description ?? null,
    inputSchema: p(r.input_schema_json), outputSchema: p(r.output_schema_json), riskLevel: r.risk_level,
    allowedTools: p(r.allowed_tools_json) || [], forbiddenTools: p(r.forbidden_tools_json) ?? undefined,
    requiredPermissions: p(r.required_permissions_json) ?? undefined, requiredEntitlements: p(r.required_entitlements_json) ?? undefined,
    requiredContextProfile: r.required_context_profile ?? null, modelRequirements: p(r.model_requirements_json) ?? undefined,
    maxExecutionTimeMs: r.max_execution_time_ms ?? null, maxAttempts: r.max_attempts ?? null, budgetClass: r.budget_class ?? undefined,
    supportsFallback: !!r.supports_fallback, fallbackSkills: p(r.fallback_skills_json) ?? undefined,
    successCriteria: p(r.success_criteria_json) ?? undefined, failureCriteria: p(r.failure_criteria_json) ?? undefined,
    supportedVerticals: p(r.supported_verticals_json), status: r.status,
  };
}

export default SkillOsRegistryService;
