/**
 * EntitlementService (ADR-153 F1.1) — porta única de decisão de acesso.
 *
 * Compõe os primitivos EXISTENTES (nada é recriado):
 *   - ModuleService.isEnabled       (org tem o módulo ligado?)
 *   - PlanService.modulesForPlan    (plano cobre + add-ons ativos?)
 *   - PermissionService.levelFor    (RBAC do usuário no módulo)
 *   - AddonService (ADDON_CATALOG)  (upgrade eligible por add-on?)
 *   - PLAN_GRADE                    (upgrade eligible por plano superior?)
 *   - organization_settings.billing_status
 *
 * Objetivo (ADR-153 §5.2): responder consultas de menu, middleware, tela de
 * Módulos e futuro motor de recomendação com UMA SÓ chamada por (org, user).
 *
 * F1.1 é ADITIVO PURO — nenhum consumidor atual é alterado. `ModuleService.
 * isEnabled` continua vigente. F1.2 delega o middleware pra cá. F1.3 delega o
 * frontend. F1.4 troca o `HIDDEN_BY_VERTICAL` estático desta fatia pelo
 * `blueprint.hiddenModules` (F3).
 *
 * G-153-1: nenhuma decisão vem do frontend — o consumidor sempre chama aqui.
 * G-153-7: estado `read_only` (downgrade) é reservado; F6.2 popula.
 *
 * RN-153-F1.1-001: orgId sempre 1º arg; toda query filtra organization_id.
 */
import db from "./db.js";
import { ModuleService } from "./ModuleService.js";
import { PlanService } from "./PlanService.js";
import { PermissionService } from "./PermissionService.js";
import { AddonService } from "./AddonService.js";
import { PLAN_GRADE } from "./plansGrade.js";
import { OPTIONAL_MODULES, ADDON_MODULES } from "./verticals.js";
import { MASTER_ADMIN_EMAIL } from "./config/secret.js";
import { VerticalBlueprintService } from "./VerticalBlueprintService.js";

// 7 estados do PRD §7.1. Cada resource decidido cai em exatamente um.
export type EntitlementState =
  | "active"               // ligado + coberto + RBAC ok — usável
  | "available_to_enable"  // plano cobre + RBAC ok, mas dono não ligou (toggle na tela de Módulos)
  | "available_to_buy"     // não coberto, mas contratável (add-on OU upgrade coerente)
  | "hidden"               // não pertence ao produto — não mostrar
  | "suspended"            // ligado, mas billing bloqueou (past_due→escrita bloqueada; blocked/cancelled→total)
  | "deprecated"           // legado, uso desencorajado (F1.1: apenas placeholder — futuro registry)
  | "pilot_only";          // beta/piloto — opt-in explícito por org (F1.1: apenas placeholder)

// Ação sob avaliação. A intent do consumidor determina qual gate aplica.
export type EntitlementAction = "view" | "use" | "enable" | "buy" | "execute";

export type EntitlementReason =
  | "core_module"           // módulo core — sempre allowed
  | "master_admin"          // Master Admin bypassa tudo
  | "allowed"               // decisão positiva
  | "module_off"            // não está em enabled_modules
  | "plan_ceiling"          // não coberto pelo plano nem add-on
  | "rbac_gate"             // RBAC = none
  | "rbac_low"              // RBAC < required pra ação
  | "billing_blocked"       // billing_status IN (blocked, cancelled)
  | "billing_suspended"     // billing_status = suspended
  | "billing_past_due"      // past_due — leitura permitida, escrita bloqueada
  | "hidden_by_vertical"    // sinalizado como incoerente pro produto atual (F1.4/F3 refina)
  | "not_in_product";       // fallback — resource desconhecido/sem lugar

export interface EntitlementSource {
  // F3 preencherá blueprintKey + blueprintVersion. F1.1 mantém null.
  verticalBlueprint: string | null;
  vertical: string | null;
  plan: string | null;
  addon: string | null;
  rbac: "none" | "read" | "write" | "full";
}

export interface EntitlementDecision {
  resource: string;
  action: EntitlementAction;
  allowed: boolean;
  visibility: "visible" | "hidden";
  state: EntitlementState;
  reason: EntitlementReason;
  source: EntitlementSource;
  upgradeEligible: boolean;
  upgradeTargetPlan: string | null;  // plano superior mais próximo que inclui o resource
  addonEligible: boolean;
  addonPrice: number | null;
}

// FALLBACK do "vertical esconde módulo" — usado quando a org NÃO tem blueprint
// assignado (ex.: org antiga que nunca rodou `POST /api/admin/blueprints/
// migrate-orgs` ou vertical fora da inferência do BlueprintSeeder — food,
// hospitalidade, educacao, outro). ADR-153 F1.4 endureceu a fonte principal
// pra `blueprint.config.hiddenModules` (F3.2 popula 5 blueprints iniciais);
// este mapa fica como safety net pra orgs em transição.
//
// Regra: opinião mínima e defensiva. Só marca `hidden` o obviamente incoerente
// pro nicho. Qualquer módulo fora daqui + fora do plano vira `available_to_buy`
// (upgrade coerente) ou fallback `hidden` (§7 do PRD).
const FALLBACK_HIDDEN_BY_VERTICAL: Record<string, string[]> = {
  varejo: ["clinica", "escola"],
  moda: ["clinica", "escola"],
  food: ["clinica", "escola"],
  servicos: ["clinica", "escola", "retail_floor"],
  saude: ["retail", "retail_floor", "escola"],
  educacao: ["clinica", "retail", "retail_floor"],
  hospitalidade: ["clinica", "escola"],
  // ADR-169 / PRD 12 — Beleza & Salões: mesmo racional de `servicos`. Módulos
  // como `clinica` (prontuário/TISS/guias) e `escola` (secretaria/família) são
  // obviamente incoerentes pra um salão; `retail_floor` (fluxo de loja
  // supervisionada) também. A vertical reusa a agenda profissional/sala/
  // especialidade da Clínica pelos SERVICES (ClinicAgendaService etc.), sem
  // ligar o módulo `clinica` — evita expor a UI de prontuário.
  beleza: ["clinica", "escola", "retail_floor"],
  // 'outro' não esconde nada — dono explora catálogo cheio.
};

/**
 * Contexto opcional passado pelo `overview` pra evitar N × 2 queries de
 * blueprint (uma por módulo). `check` chamado direto (sem ctx) resolve on-the-fly.
 */
interface EntitlementContext {
  blueprintHidden?: string[];
  blueprintKey?: string | null;
  blueprintVersion?: number | null;
}

/**
 * Fonte de `hidden` — blueprint tem prioridade, fallback pro mapa estático.
 * F1.4 mudança: usa blueprint quando assignado.
 */
function resolveHiddenForOrg(orgId: string, verticalFallback: string | null): { hidden: string[]; blueprintKey: string | null; blueprintVersion: number | null } {
  try {
    const orgBp = VerticalBlueprintService.getForOrganization(orgId);
    if (orgBp) {
      const bp = VerticalBlueprintService.getBlueprint(orgBp.blueprintId);
      if (bp) {
        return {
          hidden: bp.config.hiddenModules || [],
          blueprintKey: bp.key,
          blueprintVersion: bp.version,
        };
      }
    }
  } catch { /* best-effort — cai no fallback */ }
  return {
    hidden: verticalFallback ? (FALLBACK_HIDDEN_BY_VERTICAL[verticalFallback] || []) : [],
    blueprintKey: null,
    blueprintVersion: null,
  };
}

// Tier ordering pra `upgradeTargetPlan` — o índice determina "acima" vs "abaixo".
const PLAN_TIER = ["autonomo", "start", "growth", "scale", "enterprise"] as const;
type PlanId = typeof PLAN_TIER[number];

// Nível RBAC exigido por ação. Alinha com PermissionService.ACTION_MIN.
const ACTION_MIN_RBAC: Record<EntitlementAction, "read" | "write" | "full"> = {
  view: "read",
  use: "read",
  execute: "write",
  enable: "full",   // só quem tem full em configuracoes muda enabled_modules
  buy: "full",      // idem — contratação é ato do dono/gerente com full
};

function tierIndex(planId: string | null | undefined): number {
  if (!planId) return -1;
  return (PLAN_TIER as readonly string[]).indexOf(planId);
}

function planIncludesModule(planId: string | null | undefined, moduleKey: string): boolean {
  if (!planId) return false;
  const row = PLAN_GRADE.find((p) => p.id === planId);
  if (!row) return false;
  return row.features.modules.includes(moduleKey);
}

// Menor tier ≥ currentIdx+1 cujo `features.modules` contém o resource.
function findUpgradePlan(currentPlanId: string | null | undefined, moduleKey: string): string | null {
  const currentIdx = tierIndex(currentPlanId);
  for (let i = currentIdx + 1; i < PLAN_TIER.length; i++) {
    const p = PLAN_TIER[i];
    if (planIncludesModule(p, moduleKey)) return p;
  }
  return null;
}

// Preço do add-on que expõe o resource no plano CORRENTE. Se o plano atual
// não tem esse resource no catálogo de add-on, devolve null (dono não pode
// contratar sem trocar de plano; upgrade é o caminho — vira `upgradeTargetPlan`).
function findAddonPriceForPlan(planId: string | null | undefined, moduleKey: string): number | null {
  if (!planId) return null;
  const catalog = (AddonService as any).ADDON_CATALOG[planId] as { key: string; price: number }[] | undefined;
  const item = catalog?.find((c) => c.key === moduleKey);
  return item ? item.price : null;
}

function isCore(moduleKey: string): boolean {
  return (ModuleService.CORE as readonly string[]).includes(moduleKey);
}

function isMasterAdmin(user: any): boolean {
  return !!(user?.email && user.email === MASTER_ADMIN_EMAIL);
}

function rbacRankOk(level: "none" | "read" | "write" | "full", required: "read" | "write" | "full"): boolean {
  const rank: Record<string, number> = { none: 0, read: 1, write: 2, full: 3 };
  return rank[level] >= rank[required];
}

export class EntitlementService {
  static REGISTERED_MODULES = OPTIONAL_MODULES as readonly string[];

  /** Decisão única. Consumers: middleware (F1.2), UI (F1.3), motor de recomendação (F7).
   *  ADR-153 F1.4: `ctx` opcional pra overview pre-resolver o blueprint uma vez. */
  static check(orgId: string, user: any, resource: string, action: EntitlementAction, ctx?: EntitlementContext): EntitlementDecision {
    const org = db.prepare(
      `SELECT vertical, plan_id, billing_status FROM organization_settings WHERE organization_id = ? AND deleted_at IS NULL`,
    ).get(orgId) as any || {};
    const vertical: string | null = org.vertical || null;
    const planId: string | null = org.plan_id || null;
    const billingStatus: string = org.billing_status || "active";

    // RBAC do usuário sobre o módulo. Master Admin cai em "full" abaixo.
    const rbacLevel = isMasterAdmin(user)
      ? "full"
      : PermissionService.levelFor(orgId, user, resource);

    // ADR-153 F1.4: resolução de `hidden` via blueprint (prioridade) ou fallback
    // estático. Overview pré-resolve (evita N × 2 queries); consulta pontual
    // (middleware, /resource/:key) resolve on-the-fly.
    let hiddenList: string[];
    let blueprintKey: string | null;
    let blueprintVersion: number | null;
    if (ctx && Array.isArray(ctx.blueprintHidden)) {
      hiddenList = ctx.blueprintHidden;
      blueprintKey = ctx.blueprintKey ?? null;
      blueprintVersion = ctx.blueprintVersion ?? null;
    } else {
      const resolved = resolveHiddenForOrg(orgId, vertical);
      hiddenList = resolved.hidden;
      blueprintKey = resolved.blueprintKey;
      blueprintVersion = resolved.blueprintVersion;
    }
    // Formato semântico "clinica_multiespecialidades:v1" pra ficar legível no
    // response da rota; frontend pode fazer split(":") se quiser separar.
    const blueprintLabel = blueprintKey ? `${blueprintKey}:v${blueprintVersion}` : null;

    const source: EntitlementSource = {
      verticalBlueprint: blueprintLabel,
      vertical,
      plan: planId,
      addon: AddonService.isActive(orgId, resource) ? resource : null,
      rbac: rbacLevel,
    };

    // 1) Módulos CORE são sempre allowed pra QUALQUER user autenticado, exceto
    //    quando billing = blocked/cancelled pra ações de escrita.
    if (isCore(resource)) {
      const writeAction = action === "execute" || action === "enable" || action === "buy";
      if (writeAction && (billingStatus === "blocked" || billingStatus === "cancelled")) {
        return {
          resource, action,
          allowed: false, visibility: "visible", state: "suspended",
          reason: "billing_blocked", source,
          upgradeEligible: false, upgradeTargetPlan: null,
          addonEligible: false, addonPrice: null,
        };
      }
      return {
        resource, action,
        allowed: true, visibility: "visible", state: "active",
        reason: "core_module", source,
        upgradeEligible: false, upgradeTargetPlan: null,
        addonEligible: false, addonPrice: null,
      };
    }

    // 2) Master Admin bypassa gating por design (ADR-106) — enxerga tudo,
    //    inclusive `hidden`. Mantém a fonte pra auditoria.
    if (isMasterAdmin(user)) {
      const enabled = ModuleService.isEnabled(orgId, resource);
      return {
        resource, action,
        allowed: true, visibility: "visible",
        state: enabled ? "active" : "available_to_enable",
        reason: "master_admin", source,
        upgradeEligible: false, upgradeTargetPlan: null,
        addonEligible: false, addonPrice: null,
      };
    }

    // 3) Detecta se o plano/add-on cobre o resource + se dono ligou.
    const planMods = PlanService.modulesForPlan(orgId); // null = sem teto
    const covered = planMods == null || planMods.includes(resource);
    const enabled = ModuleService.isEnabled(orgId, resource); // já intersecciona plano+addon+enabled_modules

    // 4) `hidden` = blueprint marca como incoerente E plano não cobre.
    //    (Se plano cobre, mesmo em blueprint "esconde", devolve available — se
    //    dono ligou explicitamente ou está no plano, respeita. Comportamento
    //    intencionalmente defensivo pra não esconder algo que a org realmente
    //    tem contratado. G-153-2 aplica.) ADR-153 F1.4: fonte é
    //    `blueprint.config.hiddenModules` (via `resolveHiddenForOrg` acima)
    //    quando org tem blueprint assignado; senão FALLBACK_HIDDEN_BY_VERTICAL.
    const hiddenByVertical = hiddenList.includes(resource) && !covered;

    if (hiddenByVertical) {
      return {
        resource, action,
        allowed: false, visibility: "hidden", state: "hidden",
        reason: "hidden_by_vertical", source,
        upgradeEligible: false, upgradeTargetPlan: null,
        addonEligible: false, addonPrice: null,
      };
    }

    // 5) Coberto pelo plano/add-on?
    if (covered) {
      // 5a) Billing sobrepõe TUDO — blocked/cancelled bloqueia até `view` se
      //     for ação de escrita; suspended bloqueia escritas; past_due só
      //     bloqueia escritas.
      const writeAction = action === "execute" || action === "enable" || action === "buy";

      if (billingStatus === "blocked" || billingStatus === "cancelled") {
        return {
          resource, action,
          allowed: !writeAction && enabled,
          visibility: "visible",
          state: "suspended",
          reason: "billing_blocked", source,
          upgradeEligible: false, upgradeTargetPlan: null,
          addonEligible: false, addonPrice: null,
        };
      }
      if (billingStatus === "suspended" && writeAction) {
        return {
          resource, action,
          allowed: false, visibility: "visible", state: "suspended",
          reason: "billing_suspended", source,
          upgradeEligible: false, upgradeTargetPlan: null,
          addonEligible: false, addonPrice: null,
        };
      }
      if (billingStatus === "past_due" && writeAction) {
        return {
          resource, action,
          allowed: false, visibility: "visible", state: "active",
          reason: "billing_past_due", source,
          upgradeEligible: false, upgradeTargetPlan: null,
          addonEligible: false, addonPrice: null,
        };
      }

      // 5b) Coberto + billing ok. RBAC decide o resto.
      const required = ACTION_MIN_RBAC[action];
      if (rbacLevel === "none") {
        return {
          resource, action,
          allowed: false, visibility: "hidden", state: enabled ? "active" : "available_to_enable",
          reason: "rbac_gate", source,
          upgradeEligible: false, upgradeTargetPlan: null,
          addonEligible: false, addonPrice: null,
        };
      }
      if (!rbacRankOk(rbacLevel, required)) {
        return {
          resource, action,
          allowed: false, visibility: "visible", state: enabled ? "active" : "available_to_enable",
          reason: "rbac_low", source,
          upgradeEligible: false, upgradeTargetPlan: null,
          addonEligible: false, addonPrice: null,
        };
      }

      // 5c) OK. active se ligado, available_to_enable caso contrário.
      if (enabled) {
        return {
          resource, action,
          allowed: true, visibility: "visible", state: "active",
          reason: "allowed", source,
          upgradeEligible: false, upgradeTargetPlan: null,
          addonEligible: false, addonPrice: null,
        };
      }
      // Não ligado — `use`/`execute` recusa (precisa ligar antes), `view`/`enable` allowed.
      const canWithoutEnable = action === "view" || action === "enable";
      return {
        resource, action,
        allowed: canWithoutEnable, visibility: "visible", state: "available_to_enable",
        reason: canWithoutEnable ? "allowed" : "module_off", source,
        upgradeEligible: false, upgradeTargetPlan: null,
        addonEligible: false, addonPrice: null,
      };
    }

    // 6) Não coberto — é `available_to_buy` (upgrade OU add-on) ou fallback hidden.
    const addonPrice = findAddonPriceForPlan(planId, resource);
    const upgradeTarget = findUpgradePlan(planId, resource);

    if (addonPrice != null || upgradeTarget != null) {
      const required = ACTION_MIN_RBAC[action];
      const rbacOkForBuy = rbacLevel !== "none" && rbacRankOk(rbacLevel, required);
      return {
        resource, action,
        allowed: false, // não pode USAR sem contratar; `buy` também é false até rota de checkout confirmar (F5/F6)
        visibility: rbacOkForBuy ? "visible" : "hidden",
        state: "available_to_buy",
        reason: "plan_ceiling", source,
        upgradeEligible: upgradeTarget != null && rbacOkForBuy,
        upgradeTargetPlan: upgradeTarget,
        addonEligible: addonPrice != null && rbacOkForBuy,
        addonPrice,
      };
    }

    // 7) Fallback: nada explica esse resource — esconde por segurança.
    return {
      resource, action,
      allowed: false, visibility: "hidden", state: "hidden",
      reason: "not_in_product", source,
      upgradeEligible: false, upgradeTargetPlan: null,
      addonEligible: false, addonPrice: null,
    };
  }

  /** Mapa completo de todos os OPTIONAL_MODULES pra `view`. Usado por /me e /modules.
   *  ADR-153 F1.4: pré-resolve o blueprint UMA vez e passa por `ctx` pra evitar
   *  N × 2 queries de blueprint (uma por módulo × 32 módulos = 64 queries). */
  static overview(orgId: string, user: any): Record<string, EntitlementDecision> {
    const org = db.prepare(
      `SELECT vertical FROM organization_settings WHERE organization_id = ? AND deleted_at IS NULL`,
    ).get(orgId) as any || {};
    const resolved = resolveHiddenForOrg(orgId, org.vertical || null);
    const ctx: EntitlementContext = {
      blueprintHidden: resolved.hidden,
      blueprintKey: resolved.blueprintKey,
      blueprintVersion: resolved.blueprintVersion,
    };
    const out: Record<string, EntitlementDecision> = {};
    for (const key of OPTIONAL_MODULES as readonly string[]) {
      out[key] = this.check(orgId, user, key, "view", ctx);
    }
    // Core também entra no overview — consumidor de UI quer o mapa fechado.
    for (const key of ModuleService.CORE as readonly string[]) {
      out[key] = this.check(orgId, user, key, "view", ctx);
    }
    return out;
  }

  /**
   * Decisão puramente ORG-level: "esse módulo está disponível para essa org?".
   * Sem RBAC, sem billing — igual ao antigo `ModuleService.isEnabled`, mas
   * devolve `{available, reason, state}` estruturado pra middleware do server.ts
   * (ADR-153 F1.2) exibir o motivo do 403 (`module_off` vs `plan_ceiling`) no
   * response, sem forçar o consumidor a fazer heurística no lado dele.
   *
   * IMPORTANTE (não-regressão): NÃO checa billing_status aqui — o middleware
   * de read-only (server.ts:359-378) já cuida disso pra escritas; se checasse
   * aqui, GETs em org `blocked/suspended` retornariam 403 e regrediria a
   * política "manter visibilidade, bloquear escrita" do ADR-091.
   */
  static isModuleAvailable(orgId: string, moduleKey: string): { available: boolean; reason: EntitlementReason; state: EntitlementState } {
    if (isCore(moduleKey)) {
      return { available: true, reason: "core_module", state: "active" };
    }
    // Delegação canônica: ModuleService.isEnabled compõe plan + addon + enabled_modules.
    // Se ele diz allowed, o middleware libera — comportamento IDÊNTICO ao atual.
    const enabled = ModuleService.isEnabled(orgId, moduleKey);
    if (enabled) return { available: true, reason: "allowed", state: "active" };

    // Não allowed — distinguir o porquê pra devolver reason estruturada.
    const em = ModuleService.enabledModules(orgId);
    const planMods = PlanService.modulesForPlan(orgId);
    const inEnabled = em == null ? false : em.includes(moduleKey);
    const inPlan = planMods == null || planMods.includes(moduleKey);

    if (!inPlan) return { available: false, reason: "plan_ceiling", state: "available_to_buy" };
    if (!inEnabled) return { available: false, reason: "module_off", state: "available_to_enable" };
    // Fallback improvável (isEnabled=false mas está no plano E em enabled_modules?
    // acontece só se ModuleService adicionar novos gates — mantemos aberto pra
    // evolução sem quebrar contrato).
    return { available: false, reason: "not_in_product", state: "hidden" };
  }

  /**
   * Decisão de rota (segment, method). Compatível com PermissionService.
   * checkRouteAccess — futuro F1.2 substitui o middleware por este método.
   * F1.1 é somente aditivo: método NOVO, mas ninguém consome ainda.
   */
  static checkRoute(orgId: string, user: any, segment: string | null | undefined, method: string): { module: string | null; allow: boolean; gated: boolean; reason: EntitlementReason; state?: EntitlementState } {
    if (!segment) return { module: null, allow: true, gated: false, reason: "allowed" };
    const moduleKey = (ModuleService.MODULE_BY_ROUTE as any)[segment] || null;
    if (!moduleKey) return { module: null, allow: true, gated: false, reason: "allowed" };

    const m = (method || "GET").toUpperCase();
    const action: EntitlementAction = m === "GET" || m === "HEAD" || m === "OPTIONS" ? "use" : m === "DELETE" ? "execute" : "execute";
    const d = this.check(orgId, user, moduleKey, action);
    return { module: moduleKey, allow: d.allowed, gated: true, reason: d.reason, state: d.state };
  }
}
