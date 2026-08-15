/**
 * BlueprintSeeder (ADR-153 F3.2) — os 5 blueprints iniciais publicados +
 * migração inferindo `(vertical, plan)` → blueprint pra orgs vivas.
 *
 * Idempotente: `seedInitialBlueprints()` pode rodar N vezes sem duplicar
 * (checa por `key`+`version`). `migrateExistingOrgs({dryRun})` pode simular
 * antes de aplicar; apply é idempotente (só atinge orgs sem blueprint).
 *
 * A escolha dos blueprints segue PRD §10:
 *
 *   1. moda_loja_unica_v1        — vertical `moda`, loja única (pequeno varejista)
 *   2. moda_rede_lojas_v1        — vertical `moda`, rede/franquia (TOULON)
 *   3. clinica_multiespecialidades_v1 — vertical `saude`, bundle Growth+Clínica
 *   4. chaveiro_autonomo_v1      — vertical `servicos`, autônomo com balcão
 *   5. peixaria_balcao_peso_v1   — vertical `varejo`, balcão + copiloto
 *
 * `hiddenModules` marca o que NÃO faz sentido pro nicho (chaveiro não vê
 * Clínica; peixaria não vê Escola; clínica não vê Retail Ops de rede).
 * F1.4 vai substituir `HIDDEN_BY_VERTICAL` estático do EntitlementService
 * por esses arrays via `VerticalBlueprintService.getForOrganization`.
 *
 * Migração — regra de inferência CONSERVADORA (só migra org com sinal
 * inequívoco):
 *
 *   vertical='saude' + qualquer plano                    → clinica_multi_v1
 *   vertical='moda' + plan IN (scale, enterprise)        → moda_rede_lojas_v1
 *   vertical='moda' + plan NOT IN (scale, enterprise)    → moda_loja_unica_v1
 *   vertical='varejo' + plan='autonomo'                  → peixaria_balcao_peso_v1
 *   vertical='servicos' + plan='autonomo'                → chaveiro_autonomo_v1
 *   qualquer outro caso                                  → SKIPPED (Master
 *                                                          Admin migra manual)
 *
 * Orgs que já têm `organization_blueprints` NÃO são tocadas (respeita
 * assign manual anterior).
 *
 * RN-153-F3.2-001: nenhum blueprint é seedado em DRAFT — o seed já publica.
 * RN-153-F3.2-002: nenhum override forçado — orgs migradas ficam com
 * `overrides_json=null`.
 */
import db from "./db.js";
import { VerticalBlueprintService, type CreateBlueprintInput } from "./VerticalBlueprintService.js";

// ─────────────────────────────────────────────────────────────────────────
// Definições dos 5 blueprints (versão 1). Fonte da verdade — se algum dia
// mudar, o Master Admin cria v2 via rota; NÃO edite estes objetos in-place
// depois de rodar em produção (imutabilidade — G-153-5).
// ─────────────────────────────────────────────────────────────────────────

export const INITIAL_BLUEPRINTS: CreateBlueprintInput[] = [
  {
    key: "moda_loja_unica",
    name: "ZappFlow Moda",
    baseVertical: "moda",
    version: 1,
    minimumPlanId: "start",
    defaultPlanId: "growth",
    defaultBundleKey: null,
    config: {
      requiredModules: ["catalogo", "vendas", "loja", "pagamentos"],
      optionalModules: ["campanhas", "cadencias", "compras", "execucao", "estudio", "areas", "diretor"],
      hiddenModules: ["clinica", "escola", "vms", "prospect", "retail", "retail_floor"],
      commercialUpgrades: ["growth", "scale"],
      quickStartPack: "varejo",
      runtimePlaybooks: [],
    },
  },
  {
    key: "moda_rede_lojas",
    name: "ZappFlow Moda Rede",
    baseVertical: "moda",
    version: 1,
    minimumPlanId: "scale",
    defaultPlanId: "scale",
    defaultBundleKey: null,
    config: {
      requiredModules: ["catalogo", "vendas", "pagamentos", "retail", "retail_floor", "rie", "execucao", "diretor"],
      optionalModules: ["vms", "prospect", "estudio", "compras", "campanhas", "integracoes"],
      hiddenModules: ["clinica", "escola", "copiloto"],
      commercialUpgrades: ["enterprise"],
      quickStartPack: "varejo",
      runtimePlaybooks: [],
    },
  },
  {
    key: "clinica_multiespecialidades",
    name: "ZappFlow Clínica",
    baseVertical: "saude",
    version: 1,
    minimumPlanId: "growth",
    defaultPlanId: "growth",
    defaultBundleKey: "growth_clinica",
    config: {
      requiredModules: ["agenda", "clinica", "pagamentos", "assinaturas", "cadencias", "areas", "diretor", "rie"],
      optionalModules: ["campanhas", "execucao", "vms", "prospect", "estudio"],
      hiddenModules: ["loja", "retail", "retail_floor", "escola"],
      commercialUpgrades: ["scale", "enterprise"],
      quickStartPack: "saude",
      runtimePlaybooks: [],
    },
  },
  {
    key: "chaveiro_autonomo",
    name: "ZappFlow Chaveiro",
    baseVertical: "servicos",
    version: 1,
    minimumPlanId: "autonomo",
    defaultPlanId: "autonomo",
    defaultBundleKey: null,
    config: {
      requiredModules: ["catalogo", "vendas", "pagamentos", "agenda", "copiloto", "integracoes"],
      optionalModules: ["campanhas", "cadencias", "assinaturas", "diretor", "estudio"],
      hiddenModules: ["clinica", "escola", "retail", "retail_floor", "vms", "prospect"],
      commercialUpgrades: ["start", "growth"],
      quickStartPack: "servicos",
      runtimePlaybooks: [],
    },
  },
  {
    key: "peixaria_balcao_peso",
    name: "ZappFlow Peixaria",
    baseVertical: "varejo",
    version: 1,
    minimumPlanId: "autonomo",
    defaultPlanId: "autonomo",
    defaultBundleKey: null,
    config: {
      requiredModules: ["catalogo", "vendas", "pagamentos", "copiloto"],
      optionalModules: ["loja", "campanhas", "cadencias", "compras", "diretor", "rie", "agenda"],
      hiddenModules: ["clinica", "escola", "retail_floor", "vms", "prospect"],
      commercialUpgrades: ["start", "growth"],
      quickStartPack: "varejo",
      runtimePlaybooks: [],
    },
  },
  // ADR-169 F2 (BEAUTY-002) — vertical Beleza & Salões. Preset stack "salão"
  // agnóstico ao porte: coração operacional (agenda + vendas + pagamentos)
  // como REQUIRED; comunicação, retenção e conteúdo como OPTIONAL (o dono
  // liga quando quiser). Reusa a agenda profissional/sala/especialidade
  // dos SERVICES da Clínica sem ligar o módulo `clinica` (RN-BS-05/D5) —
  // por isso `clinica` fica em `hiddenModules`. `retail`/`retail_floor`
  // (operação de rede supervisionada), `escola`, `vms` e `prospect` também
  // são incoerentes pro nicho. `quickStartPack: null` — o pack de beleza
  // (áreas de atendimento, cadências e FAQ específicas) é fatia futura;
  // hoje `OnboardingTemplateService.PACKS` só tem os 4 verticais originais.
  // `defaultBundleKey: null` — se F17 quiser, adiciona um bundle
  // "growth_beleza" em `PLAN_BUNDLES` (molde: `growth_clinica`).
  // Beauty AI (Simulador de Cabelo, ADR-169 F5+) NÃO entra em módulos —
  // vive como flag `beauty_hair_simulator_enabled` em `organization_settings`.
  {
    key: "beleza_salao_v1",
    name: "ZappFlow Beleza & Salões",
    baseVertical: "beleza",
    version: 1,
    minimumPlanId: "start",
    defaultPlanId: "growth",
    defaultBundleKey: null,
    config: {
      requiredModules: ["agenda", "vendas", "pagamentos"],
      optionalModules: ["campanhas", "cadencias", "assinaturas", "estudio", "areas", "integracoes", "diretor", "rie", "execucao"],
      hiddenModules: ["clinica", "escola", "retail", "retail_floor", "vms", "prospect"],
      commercialUpgrades: ["scale", "enterprise"],
      quickStartPack: null,
      runtimePlaybooks: [],
    },
  },
  // ADR-154 F2.1 — BLUEPRINT SOLO: assistente pessoal FalaTu vendido como app
  // único. mode='solo' esconde qualquer navegação/menu fora do único módulo
  // requerido (RN-154 §1 — vazamento de módulo hidden = bug de segurança).
  // Sem `optionalModules` (guardrail do createBlueprint enforça).
  // Sem `commercialUpgrades` — solo NÃO oferece upgrade suíte (produto
  // diferente; conversão suíte é outra história).
  // Sem `defaultPlanId` — plano comercial "Assistente Pessoal" vem em F2.2.
  {
    key: "falatu_solo",
    name: "FalaTu — Assistente Pessoal",
    baseVertical: "outro",
    version: 1,
    mode: "solo",
    minimumPlanId: null,
    defaultPlanId: null,
    defaultBundleKey: null,
    config: {
      requiredModules: ["falatu"],
      optionalModules: [],
      // hiddenModules: TUDO que não é falatu (todos os OPTIONAL_MODULES exceto
      // 'falatu' + os CORE não-obrigatórios). Preenchido explicitamente pra
      // deixar o intent claro e pro EntitlementService.hiddenModules puxar.
      hiddenModules: [
        "agenda", "catalogo", "vendas", "loja", "pagamentos",
        "campanhas", "cadencias", "areas", "integracoes", "reservas", "assinaturas",
        "compras", "orcamentos", "eventos", "diretor", "estudio", "rie", "execucao", "prospect",
        "vms", "radar", "clinica", "retail", "copiloto", "escola", "retail_floor",
      ],
      commercialUpgrades: [],
      quickStartPack: null,
      runtimePlaybooks: [],
    },
  },
];

export interface MigrationResult {
  migrated: Array<{ orgId: string; blueprintKey: string; blueprintVersion: number; reason: string }>;
  skipped: Array<{ orgId: string; reason: string; vertical: string | null; planId: string | null }>;
  alreadyAssigned: Array<{ orgId: string; blueprintKey: string; blueprintVersion: number }>;
  errors: Array<{ orgId: string; error: string }>;
}

// ─────────────────────────────────────────────────────────────────────────
// Inferência determinística. Retorna a KEY do blueprint (não o id — as
// versões podem mudar). O seeder busca a última publicada por key.
// ─────────────────────────────────────────────────────────────────────────
export function inferBlueprintKeyFor(vertical: string | null | undefined, planId: string | null | undefined): { key: string; reason: string } | null {
  if (!vertical) return null;
  const v = String(vertical).toLowerCase();
  const p = planId ? String(planId).toLowerCase() : "";

  // Saúde: sempre Clínica multiespecialidades (independente do plano — o
  // bundle Growth+Clínica é o default; se estiver em plano menor, Master
  // Admin decide upgrade separado).
  if (v === "saude") {
    return { key: "clinica_multiespecialidades", reason: "vertical=saude → clinica_multiespecialidades" };
  }

  // Moda: rede vs loja única pelo tier.
  if (v === "moda") {
    if (p === "scale" || p === "enterprise") {
      return { key: "moda_rede_lojas", reason: "vertical=moda + plan=scale|enterprise → moda_rede_lojas" };
    }
    return { key: "moda_loja_unica", reason: "vertical=moda + plan<scale → moda_loja_unica" };
  }

  // Varejo autônomo (peixaria e afins): balcão + copiloto.
  if (v === "varejo" && p === "autonomo") {
    return { key: "peixaria_balcao_peso", reason: "vertical=varejo + plan=autonomo → peixaria_balcao_peso" };
  }

  // Serviços autônomo (chaveiro e afins).
  if (v === "servicos" && p === "autonomo") {
    return { key: "chaveiro_autonomo", reason: "vertical=servicos + plan=autonomo → chaveiro_autonomo" };
  }

  // ADR-169 F2 — vertical Beleza & Salões: sempre o blueprint canônico,
  // independente do plano. Mesmo padrão da saúde (`hiddenModules` do
  // blueprint precisa valer mesmo antes do dono contratar plano superior).
  // Se o plano contratado for menor que `minimumPlanId="start"` do blueprint,
  // o assign funciona mas o EntitlementService segue recortando pelo teto do
  // plano — o `commercialUpgrades` sinaliza o próximo passo comercial.
  if (v === "beleza") {
    return { key: "beleza_salao_v1", reason: "vertical=beleza → beleza_salao_v1" };
  }

  // Todo o resto (varejo+start+, servicos+start+, food, educacao,
  // hospitalidade, outro, sem plano) — Master Admin migra manual.
  return null;
}

export class BlueprintSeeder {
  /**
   * Seed idempotente dos 5 blueprints iniciais em versão publicada.
   * Roda 2x sem duplicar (checa por key+version).
   */
  static seedInitialBlueprints(actor?: string | null): {
    created: Array<{ key: string; version: number; id: string }>;
    published: Array<{ key: string; version: number; id: string }>;
    skipped: Array<{ key: string; version: number; id: string; status: string }>;
  } {
    const created: Array<{ key: string; version: number; id: string }> = [];
    const published: Array<{ key: string; version: number; id: string }> = [];
    const skipped: Array<{ key: string; version: number; id: string; status: string }> = [];

    for (const input of INITIAL_BLUEPRINTS) {
      const version = input.version || 1;
      const existing = VerticalBlueprintService.getBlueprintByKeyVersion(input.key, version);
      if (!existing) {
        const bp = VerticalBlueprintService.createBlueprint(input, actor || "system-seed");
        created.push({ key: bp.key, version: bp.version, id: bp.id });
        // Publish imediato — blueprints iniciais são production-ready.
        const pub = VerticalBlueprintService.publishVersion(bp.id, actor || "system-seed");
        published.push({ key: pub.key, version: pub.version, id: pub.id });
        continue;
      }
      // Já existe. Se está em draft, publica; se published, pula silenciosamente.
      if (existing.status === "draft") {
        const pub = VerticalBlueprintService.publishVersion(existing.id, actor || "system-seed");
        published.push({ key: pub.key, version: pub.version, id: pub.id });
      } else {
        skipped.push({ key: existing.key, version: existing.version, id: existing.id, status: existing.status });
      }
    }

    return { created, published, skipped };
  }

  /**
   * Migra orgs vivas: pra cada org SEM `organization_blueprints`, infere via
   * `(vertical, plan_id)` e faz `assignToOrganization`. Idempotente — orgs
   * já assinadas ficam intactas. `dryRun=true` só reporta o plano.
   */
  static migrateExistingOrgs(opts: { dryRun?: boolean; actor?: string | null } = {}): MigrationResult {
    const dryRun = !!opts.dryRun;
    const actor = opts.actor || "system-migrate";
    const result: MigrationResult = { migrated: [], skipped: [], alreadyAssigned: [], errors: [] };

    // Todas as orgs ativas (não soft-deleted).
    const orgs = db.prepare(
      `SELECT o.organization_id, o.vertical, o.plan_id, ob.blueprint_key AS current_bp_key, ob.blueprint_version AS current_bp_version
         FROM organization_settings o
         LEFT JOIN organization_blueprints ob ON ob.organization_id = o.organization_id
        WHERE o.deleted_at IS NULL`,
    ).all() as any[];

    for (const org of orgs) {
      try {
        if (org.current_bp_key) {
          result.alreadyAssigned.push({
            orgId: org.organization_id,
            blueprintKey: org.current_bp_key,
            blueprintVersion: Number(org.current_bp_version),
          });
          continue;
        }
        const inf = inferBlueprintKeyFor(org.vertical, org.plan_id);
        if (!inf) {
          result.skipped.push({
            orgId: org.organization_id,
            reason: `sem inferência pra (vertical=${org.vertical || "null"}, plan=${org.plan_id || "null"}) — assign manual`,
            vertical: org.vertical || null,
            planId: org.plan_id || null,
          });
          continue;
        }
        const bp = VerticalBlueprintService.getLatestPublished(inf.key);
        if (!bp) {
          result.errors.push({
            orgId: org.organization_id,
            error: `blueprint '${inf.key}' não encontrado publicado — rode seedInitialBlueprints antes`,
          });
          continue;
        }
        if (!dryRun) {
          VerticalBlueprintService.assignToOrganization(org.organization_id, bp.id, actor);
        }
        result.migrated.push({
          orgId: org.organization_id,
          blueprintKey: bp.key,
          blueprintVersion: bp.version,
          reason: inf.reason,
        });
      } catch (e: any) {
        result.errors.push({ orgId: org.organization_id, error: e?.message || String(e) });
      }
    }

    return result;
  }
}
