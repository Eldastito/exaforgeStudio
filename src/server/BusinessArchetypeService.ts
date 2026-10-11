import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * BusinessArchetypeService — ADR-206 F5.2: Arquétipo Operacional + resolvedor de configuração em camadas.
 *
 * Arquétipo = "núcleo comum + políticas do modelo de operação" (Moda — coleção × Moda — reposição contínua), NÃO um produto
 * por nicho. Uma pergunta ("repõe as mesmas peças ou trabalha por coleção?") escolhe o arquétipo; o arquétipo fornece o valor
 * DEFAULT de políticas que a empresa ainda não definiu sozinha.
 *
 * PRECEDÊNCIA (RN-F5-1, explícita e única): organização > arquétipo > vertical > plataforma. O que a empresa configurou
 * vence sempre; o arquétipo só preenche o que está em branco; a vertical e a plataforma são o fundo. `resolve` devolve o valor
 * E de qual camada veio ("por que está assim?") — nunca escolhe em silêncio.
 *
 * O que existe de verdade (e só isso entra no catálogo): UMA política com valor que depende do modelo de operação —
 * `retail_replenishment_strategy` (ADR-205 §19). Arquétipo SEM política real por trás seria enfeite, então o catálogo nasce com
 * os dois arquétipos de moda que a TOULON provou; petshop/clínica/beleza entram quando houver política que os diferencie.
 * A camada "vertical" existe na precedência mas está vazia hoje (nenhuma vertical tem default próprio dessa política).
 *
 * Regras: escolher o arquétipo é decisão de PESSOA (rótulo de sistema recusado) e só entre os que cabem na vertical da empresa;
 * escolher NÃO sobrescreve nada que a empresa já configurou; sem arquétipo o comportamento é exatamente o de antes (0-regressão).
 * Sem motor/tabela novos: 1 coluna aditiva em `organization_settings` (§184). Isolado por organização.
 */
export interface ArchetypeDef { key: string; label: string; description: string; verticals: string[]; policies: Record<string, string> }
export interface PolicyDef { key: string; label: string; values: string[]; platformDefault: string; readOrg: (orgId: string) => string | null }
export type PolicySource = "organization" | "archetype" | "vertical" | "platform";

const SYSTEM_ACTOR = /^(rule|ai|runtime|system|scheduler|agent|autopilot|mission|playbook|process|cron|bot)([:_\-\s]|$)/i;

/** Catálogo versionado em código (auditável, testável). Só arquétipos com política real por trás. */
export const ARCHETYPE_CATALOG_VERSION = "1.0.0";
export const ARCHETYPES: ArchetypeDef[] = [
  {
    key: "moda_colecao", label: "Moda — coleção",
    description: "Compra em lote por coleção; cada peça tem ciclo finito. Zerar é fim normal do ciclo, não ruptura; transferir entre lojas importa mais que recomprar.",
    verticals: ["moda", "varejo"], policies: { retail_replenishment_strategy: "collection_sellout" },
  },
  {
    key: "moda_reposicao_continua", label: "Moda — reposição contínua",
    description: "Repõe as mesmas peças continuamente. Zerar é ruptura a investigar e recomprar.",
    verticals: ["moda", "varejo"], policies: { retail_replenishment_strategy: "continuous_replenishment" },
  },
];

/** Políticas que o resolvedor conhece (cada nova política entra aqui, com sua leitura da camada "organização"). */
export const POLICIES: PolicyDef[] = [
  {
    key: "retail_replenishment_strategy", label: "Estratégia de reposição",
    values: ["continuous_replenishment", "collection_sellout"], platformDefault: "continuous_replenishment",
    // NULL = a empresa nunca escolheu → deixa o arquétipo preencher. (A coluna não tem default no banco.)
    readOrg: (orgId) => {
      try { const r = db.prepare("SELECT retail_replenishment_strategy AS s FROM organization_settings WHERE organization_id = ?").get(orgId) as any; return r?.s || null; } catch { return null; }
    },
  },
];

/** Defaults por VERTICAL (camada 3). Vazio de propósito: nenhuma vertical tem default próprio hoje; existe para a precedência ser real. */
const VERTICAL_DEFAULTS: Record<string, Record<string, string>> = {};

export class BusinessArchetypeService {
  static catalog() { return { version: ARCHETYPE_CATALOG_VERSION, archetypes: ARCHETYPES.map((a) => ({ ...a })) }; }
  static get(key: string | null | undefined): ArchetypeDef | null { return ARCHETYPES.find((a) => a.key === key) || null; }

  private static orgRow(orgId: string): { vertical: string | null; archetype: string | null } {
    try {
      const r = db.prepare("SELECT vertical, business_archetype FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      return { vertical: r?.vertical || null, archetype: r?.business_archetype || null };
    } catch { return { vertical: null, archetype: null }; }
  }

  /** Arquétipo atual da empresa (só se ainda existir no catálogo — chave desconhecida vale como "sem arquétipo"). */
  static current(orgId: string): ArchetypeDef | null { return this.get(this.orgRow(orgId).archetype); }

  /** Arquétipos que cabem na vertical da empresa. Vertical desconhecida → nenhum (nunca chuta). */
  static applicable(orgId: string): ArchetypeDef[] {
    const { vertical } = this.orgRow(orgId);
    return vertical ? ARCHETYPES.filter((a) => a.verticals.includes(vertical)) : [];
  }

  /**
   * A pergunta guiada do onboarding. Só existe se (a) a vertical tem arquétipos e (b) a empresa ainda não escolheu.
   * Devolve as opções em linguagem de dono — escolher continua sendo um ato explícito (`select`).
   */
  static question(orgId: string): { text: string; options: Array<{ key: string; label: string; description: string }> } | null {
    if (this.current(orgId)) return null;
    const opts = this.applicable(orgId);
    if (!opts.length) return null;
    return { text: "Como sua operação trata o estoque: repõe as mesmas peças continuamente ou trabalha por coleção, com ciclo finito?", options: opts.map((a) => ({ key: a.key, label: a.label, description: a.description })) };
  }

  /**
   * Escolhe (ou limpa, com `null`) o arquétipo. Só PESSOA; só um arquétipo que cabe na vertical. NÃO altera nenhuma política que a
   * empresa já configurou — o arquétipo só passa a preencher o que está em branco. Auditado.
   */
  static select(orgId: string, key: string | null, actor: string | null | undefined): { ok: boolean; error?: string; archetype?: string | null } {
    const by = String(actor || "").trim();
    if (!by) return { ok: false, error: "Escolher o modelo de operação exige uma pessoa identificada." };
    if (SYSTEM_ACTOR.test(by)) return { ok: false, error: "Só uma pessoa escolhe o modelo de operação da empresa." };
    if (key !== null) {
      const a = this.get(key);
      if (!a) return { ok: false, error: "Arquétipo desconhecido." };
      if (!this.applicable(orgId).some((x) => x.key === key)) return { ok: false, error: "Esse modelo de operação não se aplica à vertical da sua empresa." };
    }
    const exists = db.prepare("SELECT 1 FROM organization_settings WHERE organization_id = ?").get(orgId);
    if (!exists) return { ok: false, error: "Empresa não encontrada." };
    db.prepare("UPDATE organization_settings SET business_archetype = ? WHERE organization_id = ?").run(key, orgId);
    try { logAuthEvent(orgId, by, orgId, key ? "BUSINESS_ARCHETYPE_SET" : "BUSINESS_ARCHETYPE_CLEARED", { archetype: key }); } catch { /* best-effort */ }
    return { ok: true, archetype: key };
  }

  /**
   * Resolve UMA política pela precedência organização > arquétipo > vertical > plataforma, dizendo de onde veio e o que cada
   * camada tinha (`layers`, para o "por que está assim?"). Valor inválido numa camada é ignorado (cai para a próxima).
   */
  static resolve(orgId: string, policyKey: string): { policy: string; value: string; source: PolicySource; archetype: string | null; layers: Array<{ source: PolicySource; value: string | null }> } | null {
    const p = POLICIES.find((x) => x.key === policyKey);
    if (!p) return null;
    const { vertical } = this.orgRow(orgId);
    const arch = this.current(orgId);
    const ok = (v: string | null | undefined) => (v && p.values.includes(v) ? v : null);
    const layers: Array<{ source: PolicySource; value: string | null }> = [
      { source: "organization", value: ok(p.readOrg(orgId)) },
      { source: "archetype", value: ok(arch?.policies[policyKey]) },
      { source: "vertical", value: ok(vertical ? VERTICAL_DEFAULTS[vertical]?.[policyKey] : null) },
      { source: "platform", value: p.platformDefault },
    ];
    const hit = layers.find((l) => l.value) as { source: PolicySource; value: string };
    return { policy: policyKey, value: hit.value, source: hit.source, archetype: arch?.key || null, layers };
  }

  /** Visão completa para o dono: arquétipo atual, pergunta pendente e cada política com a origem do valor. */
  static explain(orgId: string) {
    const arch = this.current(orgId);
    return {
      catalogVersion: ARCHETYPE_CATALOG_VERSION,
      precedence: ["organization", "archetype", "vertical", "platform"] as PolicySource[],
      archetype: arch ? { key: arch.key, label: arch.label, description: arch.description } : null,
      question: this.question(orgId),
      policies: POLICIES.map((p) => ({ label: p.label, ...this.resolve(orgId, p.key)! })),
    };
  }
}

export default BusinessArchetypeService;
