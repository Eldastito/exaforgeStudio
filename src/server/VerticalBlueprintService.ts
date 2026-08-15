/**
 * VerticalBlueprintService (ADR-153 F3.1) — produtos por nicho versionados.
 *
 * Um Blueprint é um SKU comercial vendido pra uma vertical/nicho específico
 * (ex.: `clinica_multiespecialidades_v1`, `chaveiro_autonomo_v1`,
 * `peixaria_balcao_peso_v1`). Ele encapsula em UM objeto imutável:
 *
 *   - Vertical base (`saude`, `varejo`, `servicos`...) — o preset genérico.
 *   - Plano mínimo/default recomendado (`minimum_plan_id`, `default_plan_id`).
 *   - Bundle opcional (`default_bundle_key`) que amarra plano+addons pré-composto.
 *   - `config`:
 *       - `requiredModules`: obrigatórios do nicho (a maioria já vem do plano).
 *       - `optionalModules`: dono pode ligar sem pagar (dentro do plano).
 *       - `hiddenModules`: NUNCA mostrar (fecha o pilar §11.2 do PRD).
 *       - `commercialUpgrades`: tiers recomendados como próximo passo.
 *       - `quickStartPack`: chave em OnboardingTemplateService.PACKS.
 *       - `runtimePlaybooks`: playbooks ADR-152 pré-ligados no seed.
 *
 * REGRA DURA de imutabilidade (G-153-5): uma vez `status='published'`, o
 * `config_json` NÃO pode mais ser alterado. Correção = nova versão (mesmo
 * `key`, `version+1`). Isso protege orgs vivas — mudar o preset da Clínica
 * agora não afeta as clínicas já assigneadas em v1; migrar é ato consciente
 * do Master Admin via F3.3 (upgradeBlueprintVersion + preview do diff).
 *
 * F1.4 substituirá o `HIDDEN_BY_VERTICAL` estático do `EntitlementService`
 * pelo `blueprint.hiddenModules` desta fatia — mas F3.1 só coloca a
 * infraestrutura no ar. Sem consumidor ativo ainda: seguro, opt-in.
 *
 * RN-153-F3.1-001: orgId sempre 1º arg em métodos org-scoped.
 * RN-153-F3.1-002: `key` é slug (a-z, 0-9, _). `version` é inteiro ≥1.
 * RN-153-F3.1-003: Master Admin é o único que cria/publish/assign (enforcement
 * na rota, não no service — service é chamável por CLI futuro se surgir).
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";
import { PLAN_GRADE, PLAN_BUNDLES } from "./plansGrade.js";
import { OPTIONAL_MODULES } from "./verticals.js";
// ADR-169 F3: import estático seguro — PermissionService só depende de `db`
// e `uuid`, portanto NÃO fecha ciclo com este arquivo.
import { PermissionService } from "./PermissionService.js";

export type BlueprintStatus = "draft" | "published" | "deprecated";
/**
 * ADR-154 F2.1 — modo do blueprint:
 * - 'suite' (default, comportamento pré-F2.1): org enxerga N módulos.
 * - 'solo': org enxerga UM módulo só (ex.: FalaTu como assistente pessoal),
 *   com o resto em hiddenModules. Marketing/pricing/onboarding próprios.
 *
 * Guardrail: em modo 'solo', requiredModules DEVE ter exatamente 1 módulo
 * (o primary do produto) e optionalModules DEVE ser vazio — se não fosse
 * assim, deixaria de ser "solo". A whitelist é decisão de produto; alterar
 * = mudar o `mode` explicitamente (não é acidente de v2).
 */
export type BlueprintMode = "suite" | "solo";
const VALID_MODES: BlueprintMode[] = ["suite", "solo"];

// Módulos categorizados no config do blueprint. Todos os arrays contêm keys
// de OPTIONAL_MODULES (module-key namespace). O EntitlementService (F1.4)
// consumirá `hiddenModules` pra decidir visibility=hidden.
export interface BlueprintConfig {
  requiredModules: string[];
  optionalModules: string[];
  hiddenModules: string[];
  commercialUpgrades: string[];    // plan IDs, ex.: ['start', 'growth']
  quickStartPack: string | null;   // vertical key em OnboardingTemplateService.PACKS
  runtimePlaybooks: string[];      // playbook ids do ADR-152
}

export interface Blueprint {
  id: string;
  key: string;
  name: string;
  baseVertical: string;
  version: number;
  status: BlueprintStatus;
  mode: BlueprintMode;
  minimumPlanId: string | null;
  defaultPlanId: string | null;
  defaultBundleKey: string | null;
  config: BlueprintConfig;
  createdAt: string;
  publishedAt: string | null;
}

export interface OrganizationBlueprint {
  organizationId: string;
  blueprintId: string;
  blueprintKey: string;
  blueprintVersion: number;
  assignedAt: string;
  assignedBy: string | null;
  overrides: Record<string, any> | null;
  status: "active" | "migrating" | "suspended";
}

// Slug validator — evita `key` como "Clinica Multi V1!" (quebraria dedupe).
const KEY_RE = /^[a-z][a-z0-9_]{1,63}$/;

function assertValidKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error(`Blueprint key inválida (só a-z, 0-9, _, começa com letra, ≤64 chars): "${key}"`);
}

function assertValidPlanId(planId: string | null | undefined, field: string): void {
  if (planId == null) return;
  const valid = new Set(PLAN_GRADE.map((p) => p.id));
  if (!valid.has(planId)) throw new Error(`${field} deve ser um plano válido em PLAN_GRADE (recebido: "${planId}")`);
}

function assertValidBundleKey(bundleKey: string | null | undefined): void {
  if (bundleKey == null) return;
  const valid = new Set(PLAN_BUNDLES.map((b) => b.key));
  if (!valid.has(bundleKey)) throw new Error(`default_bundle_key deve existir em PLAN_BUNDLES (recebido: "${bundleKey}")`);
}

function assertValidModules(list: string[] | undefined, field: string): void {
  if (!list) return;
  const known = new Set([...(OPTIONAL_MODULES as readonly string[]), "atendimento", "contatos", "relatorios", "configuracoes"]);
  for (const m of list) {
    if (!known.has(m)) throw new Error(`${field} inclui módulo desconhecido "${m}" (esperado OPTIONAL_MODULES ou CORE)`);
  }
}

function assertValidCommercialUpgrades(list: string[] | undefined): void {
  if (!list) return;
  const valid = new Set(PLAN_GRADE.map((p) => p.id));
  for (const p of list) {
    if (!valid.has(p)) throw new Error(`commercialUpgrades inclui plano desconhecido "${p}"`);
  }
}

function normalizeConfig(config: Partial<BlueprintConfig>): BlueprintConfig {
  return {
    requiredModules: config.requiredModules || [],
    optionalModules: config.optionalModules || [],
    hiddenModules: config.hiddenModules || [],
    commercialUpgrades: config.commercialUpgrades || [],
    quickStartPack: config.quickStartPack ?? null,
    runtimePlaybooks: config.runtimePlaybooks || [],
  };
}

function rowToBlueprint(row: any): Blueprint {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    baseVertical: row.base_vertical,
    version: Number(row.version),
    status: row.status as BlueprintStatus,
    mode: (row.mode as BlueprintMode) || "suite", // default 'suite' pra blueprints pré-F2.1
    minimumPlanId: row.minimum_plan_id || null,
    defaultPlanId: row.default_plan_id || null,
    defaultBundleKey: row.default_bundle_key || null,
    config: JSON.parse(row.config_json || "{}"),
    createdAt: row.created_at,
    publishedAt: row.published_at || null,
  };
}

export interface CreateBlueprintInput {
  key: string;
  name: string;
  baseVertical: string;
  version?: number;               // default 1; use N+1 pra nova versão de mesmo key
  mode?: BlueprintMode;           // default 'suite' (ADR-154 F2.1)
  minimumPlanId?: string | null;
  defaultPlanId?: string | null;
  defaultBundleKey?: string | null;
  config: Partial<BlueprintConfig>;
}

export class VerticalBlueprintService {
  /** Cria um novo blueprint em status `draft`. Se `version` omitido, calcula
   *  próxima livre pra `key`. Validação estrita — evita blueprint quebrado. */
  static createBlueprint(input: CreateBlueprintInput, actor?: string | null): Blueprint {
    assertValidKey(input.key);
    if (!input.name || !input.name.trim()) throw new Error("name é obrigatório");
    if (!input.baseVertical || !input.baseVertical.trim()) throw new Error("baseVertical é obrigatório");
    assertValidPlanId(input.minimumPlanId, "minimumPlanId");
    assertValidPlanId(input.defaultPlanId, "defaultPlanId");
    assertValidBundleKey(input.defaultBundleKey);
    const config = normalizeConfig(input.config);
    assertValidModules(config.requiredModules, "requiredModules");
    assertValidModules(config.optionalModules, "optionalModules");
    assertValidModules(config.hiddenModules, "hiddenModules");
    assertValidCommercialUpgrades(config.commercialUpgrades);

    // ADR-154 F2.1 — valida mode + guardrail Solo. 'solo' exige exatamente
    // UM módulo em requiredModules e zero em optionalModules (é isso que faz
    // ser "solo"). Se v2 tentar adicionar 2 módulos ou trazer opcional, quebra
    // aqui — a whitelist é decisão de produto, mudança consciente do mode.
    const mode: BlueprintMode = input.mode ?? "suite";
    if (!VALID_MODES.includes(mode)) throw new Error(`mode deve ser 'suite' ou 'solo' (recebido: "${mode}")`);
    if (mode === "solo") {
      if (config.requiredModules.length !== 1) {
        throw new Error(`Blueprint 'solo' exige EXATAMENTE 1 módulo em requiredModules (recebido: ${config.requiredModules.length}). Whitelist do solo é decisão de produto — pra abrir mais de 1 módulo, use mode='suite'.`);
      }
      if (config.optionalModules.length > 0) {
        throw new Error(`Blueprint 'solo' não permite optionalModules (recebido: ${config.optionalModules.length}). Solo é módulo único — pra opcional, use mode='suite'.`);
      }
    }

    // Auto-versionamento: se `version` omitido, próxima livre pra key.
    let version = input.version ?? 1;
    if (input.version == null) {
      const latest = db.prepare(
        `SELECT MAX(version) AS v FROM vertical_blueprints WHERE key = ?`,
      ).get(input.key) as any;
      version = (latest?.v || 0) + 1;
    } else if (!Number.isInteger(version) || version < 1) {
      throw new Error(`version deve ser inteiro ≥ 1 (recebido: ${input.version})`);
    }

    // Impede duplicar (key, version) explicitamente pra dar erro claro em vez
    // de UNIQUE constraint SQLite (mensagem críptica).
    const existing = db.prepare(
      `SELECT id FROM vertical_blueprints WHERE key = ? AND version = ?`,
    ).get(input.key, version) as any;
    if (existing) throw new Error(`Blueprint (${input.key}, v${version}) já existe (id=${existing.id}). Use outra version.`);

    // Guardrail F2.1: quando cria uma NOVA versão de uma key existente, o `mode`
    // NÃO PODE MUDAR entre versões — v1 é 'solo' → v2 tem que ser 'solo'.
    // Alteração de mode é ruptura de contrato pro cliente Solo (viraria suíte
    // de repente). Se precisar mudar, cria KEY nova.
    if (version > 1) {
      const priorMode = (db.prepare(`SELECT mode FROM vertical_blueprints WHERE key = ? ORDER BY version DESC LIMIT 1`).get(input.key) as any)?.mode;
      if (priorMode && priorMode !== mode) {
        throw new Error(`Blueprint '${input.key}' já existe em modo '${priorMode}' — nova versão deve manter o mesmo mode (recebido: '${mode}'). Pra mudar de mode, crie uma key nova.`);
      }
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO vertical_blueprints (id, key, name, base_vertical, version, status, mode, minimum_plan_id, default_plan_id, default_bundle_key, config_json)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    ).run(
      id, input.key, input.name.trim(), input.baseVertical.trim(), version, mode,
      input.minimumPlanId || null, input.defaultPlanId || null, input.defaultBundleKey || null,
      JSON.stringify(config),
    );

    try {
      logAuthEvent(null, actor || null, null, "BLUEPRINT_CREATED", { id, key: input.key, version, mode, baseVertical: input.baseVertical });
    } catch { /* noop */ }

    return this.getBlueprint(id)!;
  }

  /** Publica um blueprint (draft → published). Idempotente. Após publicado, o
   *  config_json fica IMUTÁVEL. Publicar de novo não faz nada. */
  static publishVersion(id: string, actor?: string | null): Blueprint {
    const bp = this.getBlueprint(id);
    if (!bp) throw new Error(`Blueprint não encontrado: ${id}`);
    if (bp.status === "deprecated") throw new Error(`Blueprint ${bp.key} v${bp.version} está deprecated — não pode ser publicado`);
    if (bp.status === "published") return bp; // idempotente
    db.prepare(
      `UPDATE vertical_blueprints SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(id);
    try {
      logAuthEvent(null, actor || null, null, "BLUEPRINT_PUBLISHED", { id, key: bp.key, version: bp.version });
    } catch { /* noop */ }
    return this.getBlueprint(id)!;
  }

  /** Marca blueprint como `deprecated`. Orgs assignadas continuam funcionando
   *  (histórico); só impede novas atribuições e novos publish de mesma versão. */
  static deprecateBlueprint(id: string, actor?: string | null): Blueprint {
    const bp = this.getBlueprint(id);
    if (!bp) throw new Error(`Blueprint não encontrado: ${id}`);
    db.prepare(`UPDATE vertical_blueprints SET status = 'deprecated' WHERE id = ?`).run(id);
    try {
      logAuthEvent(null, actor || null, null, "BLUEPRINT_DEPRECATED", { id, key: bp.key, version: bp.version });
    } catch { /* noop */ }
    return this.getBlueprint(id)!;
  }

  static getBlueprint(id: string): Blueprint | null {
    const row = db.prepare(`SELECT * FROM vertical_blueprints WHERE id = ?`).get(id) as any;
    return row ? rowToBlueprint(row) : null;
  }

  static getBlueprintByKeyVersion(key: string, version: number): Blueprint | null {
    const row = db.prepare(`SELECT * FROM vertical_blueprints WHERE key = ? AND version = ?`).get(key, version) as any;
    return row ? rowToBlueprint(row) : null;
  }

  /** Última versão PUBLICADA de uma key (útil pra assign default). */
  static getLatestPublished(key: string): Blueprint | null {
    const row = db.prepare(
      `SELECT * FROM vertical_blueprints WHERE key = ? AND status = 'published' ORDER BY version DESC LIMIT 1`,
    ).get(key) as any;
    return row ? rowToBlueprint(row) : null;
  }

  static listBlueprints(filter?: { status?: BlueprintStatus; key?: string; baseVertical?: string }): Blueprint[] {
    const clauses: string[] = [];
    const params: any[] = [];
    if (filter?.status) { clauses.push("status = ?"); params.push(filter.status); }
    if (filter?.key) { clauses.push("key = ?"); params.push(filter.key); }
    if (filter?.baseVertical) { clauses.push("base_vertical = ?"); params.push(filter.baseVertical); }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const rows = db.prepare(`SELECT * FROM vertical_blueprints ${where} ORDER BY key, version DESC`).all(...params) as any[];
    return rows.map(rowToBlueprint);
  }

  /** Atribui um blueprint (por id) à org. Só permite blueprint `published`.
   *  Idempotente: 2× com mesmo (org, blueprint) sobrescreve `assigned_at`. */
  static assignToOrganization(orgId: string, blueprintId: string, actor?: string | null, overrides?: Record<string, any>): OrganizationBlueprint {
    const bp = this.getBlueprint(blueprintId);
    if (!bp) throw new Error(`Blueprint não encontrado: ${blueprintId}`);
    if (bp.status !== "published") throw new Error(`Blueprint ${bp.key} v${bp.version} não está published (status=${bp.status}). Publique antes de atribuir.`);

    // Verifica que org existe (não soft-deleted)
    const org = db.prepare(
      `SELECT organization_id FROM organization_settings WHERE organization_id = ? AND deleted_at IS NULL`,
    ).get(orgId) as any;
    if (!org) throw new Error(`Organização não encontrada: ${orgId}`);

    const overridesJson = overrides ? JSON.stringify(overrides) : null;
    // Upsert atômico (SQLite ON CONFLICT).
    db.prepare(
      `INSERT INTO organization_blueprints (organization_id, blueprint_id, blueprint_key, blueprint_version, assigned_by, overrides_json, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')
       ON CONFLICT(organization_id) DO UPDATE SET
         blueprint_id = excluded.blueprint_id,
         blueprint_key = excluded.blueprint_key,
         blueprint_version = excluded.blueprint_version,
         assigned_at = CURRENT_TIMESTAMP,
         assigned_by = excluded.assigned_by,
         overrides_json = excluded.overrides_json,
         status = 'active'`,
    ).run(orgId, bp.id, bp.key, bp.version, actor || null, overridesJson);

    try {
      logAuthEvent(orgId, actor || null, null, "BLUEPRINT_ASSIGNED", { blueprintId, key: bp.key, version: bp.version });
    } catch { /* noop */ }

    // ADR-169 F3 (BEAUTY-003): assign do blueprint `beleza_salao_v1` semeia
    // os perfis por-vertical da Beleza (Recepção/Cabeleireira/Gerente) —
    // SÍNCRONO. Best-effort: falha aqui NÃO derruba o assign (mesmo padrão
    // de `seedConsentForVertical` em `ModuleService.applyVertical`).
    if (bp.baseVertical === "beleza") {
      try { PermissionService.seedBeautyProfiles(orgId); } catch { /* noop */ }
    }

    return this.getForOrganization(orgId)!;
  }

  static getForOrganization(orgId: string): OrganizationBlueprint | null {
    const row = db.prepare(`SELECT * FROM organization_blueprints WHERE organization_id = ?`).get(orgId) as any;
    if (!row) return null;
    return {
      organizationId: row.organization_id,
      blueprintId: row.blueprint_id,
      blueprintKey: row.blueprint_key,
      blueprintVersion: Number(row.blueprint_version),
      assignedAt: row.assigned_at,
      assignedBy: row.assigned_by || null,
      overrides: row.overrides_json ? JSON.parse(row.overrides_json) : null,
      status: row.status || "active",
    };
  }

  /** Clone: copia o assignment de outra org (mesmo blueprint + overrides).
   *  F3.4 vai enriquecer com merge/customization; aqui é copy-verbatim. */
  static cloneToOrganization(targetOrgId: string, sourceOrgId: string, actor?: string | null): OrganizationBlueprint {
    const src = this.getForOrganization(sourceOrgId);
    if (!src) throw new Error(`Organização origem não tem blueprint atribuído: ${sourceOrgId}`);
    return this.assignToOrganization(targetOrgId, src.blueprintId, actor, src.overrides || undefined);
  }

  /** Preview de entitlements: dado um blueprint proposto pra org, mostra o
   *  diff (o que MUDA em `hiddenModules`, `requiredModules`, etc). Usado por
   *  F3.3 (upgrade de versão) e F3.2 (migração inicial). Não muta nada. */
  static previewEntitlements(orgId: string, blueprintId: string): {
    current: OrganizationBlueprint | null;
    target: Blueprint;
    diff: {
      hiddenAdded: string[];
      hiddenRemoved: string[];
      requiredAdded: string[];
      requiredRemoved: string[];
      optionalAdded: string[];
      optionalRemoved: string[];
    };
  } {
    const target = this.getBlueprint(blueprintId);
    if (!target) throw new Error(`Blueprint não encontrado: ${blueprintId}`);
    const current = this.getForOrganization(orgId);
    const currentBp = current ? this.getBlueprint(current.blueprintId) : null;

    const setDiff = (from: string[], to: string[]) => {
      const fromSet = new Set(from);
      const toSet = new Set(to);
      return {
        added: to.filter((m) => !fromSet.has(m)),
        removed: from.filter((m) => !toSet.has(m)),
      };
    };
    const hidden = setDiff(currentBp?.config.hiddenModules || [], target.config.hiddenModules);
    const required = setDiff(currentBp?.config.requiredModules || [], target.config.requiredModules);
    const optional = setDiff(currentBp?.config.optionalModules || [], target.config.optionalModules);

    return {
      current,
      target,
      diff: {
        hiddenAdded: hidden.added, hiddenRemoved: hidden.removed,
        requiredAdded: required.added, requiredRemoved: required.removed,
        optionalAdded: optional.added, optionalRemoved: optional.removed,
      },
    };
  }

  /**
   * ADR-153 F3.3 — cria a próxima versão de um blueprint existente.
   *
   * Contexto: G-153-5 diz que blueprint `published` é IMUTÁVEL. Corrigir/
   * evoluir o preset de um nicho (ex.: Clínica Multi ganhou módulo `rie`)
   * exige criar `key vN+1` em status `draft`, revisar o diff, publicar,
   * e então re-atribuir as orgs (opt-in) via `assignToOrganization`.
   *
   * Este método clona toda a config da versão-base e aplica overrides
   * pontuais (edits) — evita que o Master Admin precise re-escrever
   * requiredModules/optionalModules/etc do zero. Auto-incrementa version.
   *
   * Regra: só é possível bumpar a partir de `published` ou `draft`. Não
   * a partir de `deprecated` (blueprint aposentado não deve gerar linha
   * nova; se necessário, criar do zero com key nova).
   *
   * Edits aceitos: qualquer subconjunto do BlueprintConfig + name +
   * minimumPlanId + defaultPlanId + defaultBundleKey. Config vem por
   * merge shallow (arrays substituem completamente, não concatenam).
   */
  static createNextVersion(
    sourceBlueprintId: string,
    edits: Partial<Omit<CreateBlueprintInput, "key" | "baseVertical" | "version">>,
    actor?: string | null,
  ): Blueprint {
    const source = this.getBlueprint(sourceBlueprintId);
    if (!source) throw new Error(`Blueprint origem não encontrado: ${sourceBlueprintId}`);
    if (source.status === "deprecated") {
      throw new Error(`Blueprint ${source.key} v${source.version} está deprecated — não é permitido bumpar versão a partir dele. Crie um novo com key diferente.`);
    }

    // Merge shallow: campos escalares e config substituem inteiros; se edits
    // não incluir config, mantém o source.config verbatim.
    const mergedConfig: BlueprintConfig = edits.config
      ? normalizeConfig({ ...source.config, ...edits.config })
      : source.config;

    return this.createBlueprint({
      key: source.key,
      // version omitido → createBlueprint calcula MAX(version)+1 automaticamente.
      name: edits.name ?? source.name,
      baseVertical: source.baseVertical,
      minimumPlanId: edits.minimumPlanId ?? source.minimumPlanId ?? undefined,
      defaultPlanId: edits.defaultPlanId ?? source.defaultPlanId ?? undefined,
      defaultBundleKey: edits.defaultBundleKey ?? source.defaultBundleKey ?? undefined,
      config: mergedConfig,
    }, actor);
  }

  /**
   * ADR-153 F3.3 — diff entre dois blueprints SEM depender de org atribuída.
   *
   * `previewEntitlements` compara blueprint alvo × org atual — útil pro passo
   * "vou migrar essa org". Este método compara blueprint × blueprint direto,
   * útil pro passo ANTERIOR: "acabei de criar v2, mostra o que mudou vs v1
   * antes de eu publicar". Independente de qualquer org.
   *
   * Inclui, além dos módulos (mesmo formato do previewEntitlements), diffs
   * dos escalares: name / minimumPlanId / defaultPlanId / defaultBundleKey /
   * quickStartPack / commercialUpgrades / runtimePlaybooks. Motor de UI usa
   * essa estrutura pra renderizar "antes → depois" campo a campo.
   */
  static previewBlueprintDiff(sourceBlueprintId: string, targetBlueprintId: string): {
    source: Blueprint;
    target: Blueprint;
    diff: {
      hiddenAdded: string[];
      hiddenRemoved: string[];
      requiredAdded: string[];
      requiredRemoved: string[];
      optionalAdded: string[];
      optionalRemoved: string[];
      commercialUpgradesAdded: string[];
      commercialUpgradesRemoved: string[];
      runtimePlaybooksAdded: string[];
      runtimePlaybooksRemoved: string[];
      scalarChanges: Array<{ field: string; from: any; to: any }>;
    };
  } {
    const source = this.getBlueprint(sourceBlueprintId);
    if (!source) throw new Error(`Blueprint origem não encontrado: ${sourceBlueprintId}`);
    const target = this.getBlueprint(targetBlueprintId);
    if (!target) throw new Error(`Blueprint alvo não encontrado: ${targetBlueprintId}`);

    const setDiff = (from: string[], to: string[]) => {
      const fromSet = new Set(from);
      const toSet = new Set(to);
      return {
        added: to.filter((m) => !fromSet.has(m)),
        removed: from.filter((m) => !toSet.has(m)),
      };
    };
    const hidden = setDiff(source.config.hiddenModules, target.config.hiddenModules);
    const required = setDiff(source.config.requiredModules, target.config.requiredModules);
    const optional = setDiff(source.config.optionalModules, target.config.optionalModules);
    const upgrades = setDiff(source.config.commercialUpgrades, target.config.commercialUpgrades);
    const playbooks = setDiff(source.config.runtimePlaybooks, target.config.runtimePlaybooks);

    const scalarChanges: Array<{ field: string; from: any; to: any }> = [];
    const check = (field: string, from: any, to: any) => {
      if (from !== to) scalarChanges.push({ field, from, to });
    };
    check("name", source.name, target.name);
    check("minimumPlanId", source.minimumPlanId, target.minimumPlanId);
    check("defaultPlanId", source.defaultPlanId, target.defaultPlanId);
    check("defaultBundleKey", source.defaultBundleKey, target.defaultBundleKey);
    check("quickStartPack", source.config.quickStartPack, target.config.quickStartPack);

    return {
      source,
      target,
      diff: {
        hiddenAdded: hidden.added, hiddenRemoved: hidden.removed,
        requiredAdded: required.added, requiredRemoved: required.removed,
        optionalAdded: optional.added, optionalRemoved: optional.removed,
        commercialUpgradesAdded: upgrades.added, commercialUpgradesRemoved: upgrades.removed,
        runtimePlaybooksAdded: playbooks.added, runtimePlaybooksRemoved: playbooks.removed,
        scalarChanges,
      },
    };
  }
}
