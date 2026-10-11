/**
 * ADR-206 F5.3 — PLAYBOOK REGISTRY versionado (ESTENDE `process_definitions`/`PlaybookEngine`; NÃO é motor novo — ADR-166 §184, RN-F5-12).
 *
 * O que faltava: `process_definitions` é por empresa e não diz nada sobre o playbook como PRODUTO — vertical, arquétipo,
 * risco, autonomia máxima, pré-condições, estágio de maturidade. Este registry é o CATÁLOGO DE PLATAFORMA (código, versionado,
 * imutável) que DESCREVE os playbooks que já existem; a execução continua inteira no `ProcessRuntimeService`/`PlaybookEngine`.
 *
 * Regras (RN-F5-*):
 *  - Versão é imutável: mudou o playbook → NOVA entrada (id+versão). Nunca se edita uma versão publicada (RN-F5-4).
 *  - Estágio experimental|validated|certified. `certified` exige evidência de piloto — nenhum playbook tem hoje (não inventa).
 *  - Autonomia máxima nunca passa de `execute` (= Nível 3, D3); o Nível 4 está bloqueado.
 *  - Experimental NÃO roda sozinho: `canRun` só libera até `suggest` (RN-F5-5).
 *  - Eficácia por versão é DERIVADA por query das instâncias reais (RN-004), sempre com n + banda de Wilson + vertical da empresa
 *    (RN-F5-8); sem instância concluída → null, nunca 0%.
 *  - Isolamento: a leitura por empresa só enxerga `process_definitions`/`process_instances` da própria empresa (RN-F5-9).
 *  - O catálogo é só leitura: nada aqui ativa, desativa ou inicia processo.
 */
import db from "./db.js";
import { wilsonInterval, intervalConfidenceLabel } from "./statsWilson.js";

export const PLAYBOOK_REGISTRY_VERSION = "2026-10-11.1";

export type PlaybookStage = "experimental" | "validated" | "certified";
export type AutonomyLevel = "observe" | "suggest" | "prepare" | "execute";
export type RiskLevel = "low" | "medium" | "high";

export const AUTONOMY_ORDER: AutonomyLevel[] = ["observe", "suggest", "prepare", "execute"];

export interface PlaybookEntry {
  id: string;                    // id estável do playbook (≠ process_type, que carrega o sufixo de versão do runtime)
  version: number;               // versão do REGISTRO (cada mudança = nova entrada)
  processType: string;           // chave em process_definitions
  name: string;
  summary: string;
  verticals: string[];           // [] = qualquer vertical
  archetypes: string[];          // [] = qualquer arquétipo
  risk: RiskLevel;
  maxAutonomy: AutonomyLevel;    // teto; nunca acima de "execute" (D3)
  stage: PlaybookStage;
  preconditions: string[];       // o que precisa existir antes (texto de dono, verificável por humano)
  successMetric: string;         // como se mede que funcionou (o resultado vem do system-of-record, não da IA)
  evidence: string;              // de onde vem o estágio — honesto sobre o que NÃO foi provado
}

export const PLAYBOOKS: PlaybookEntry[] = [
  {
    id: "collection", version: 1, processType: "receivable_collection_v1",
    name: "Cobrança de recebíveis", summary: "Régua de cobrança de títulos vencidos, com confirmação de pagamento no system-of-record.",
    verticals: [], archetypes: [], risk: "medium", maxAutonomy: "execute", stage: "validated",
    preconditions: ["Contas a receber lançadas", "Canal de mensagem conectado", "Consentimento de comunicação do cliente"],
    successMetric: "Título passa a 'recebido' (receivables.status)",
    evidence: "Coberto por testes automatizados e em produção; sem validação por piloto com dado real.",
  },
  {
    id: "sales_recovery", version: 1, processType: "sales_recovery_v1",
    name: "Recuperação de vendas", summary: "Retoma orçamentos/oportunidades paradas com abordagem governada.",
    verticals: [], archetypes: [], risk: "medium", maxAutonomy: "execute", stage: "validated",
    preconditions: ["Orçamentos ou oportunidades registrados", "Canal de mensagem conectado", "Consentimento de comunicação do cliente"],
    successMetric: "Venda atribuída (sales_recovery_attributions)",
    evidence: "Coberto por testes automatizados e em produção; sem validação por piloto com dado real.",
  },
  {
    id: "retail_daily_closing", version: 1, processType: "retail_daily_closing_v1",
    name: "Fechamento diário de loja", summary: "Concilia declarado × PDV e lança o dia ou escala ao gerente.",
    verticals: ["moda", "varejo"], archetypes: [], risk: "medium", maxAutonomy: "execute", stage: "validated",
    preconditions: ["Loja cadastrada", "Fechamento declarado pelo gerente", "Venda do PDV importada"],
    successMetric: "Fechamento reconciliado/aprovado (retail_daily_closings.status)",
    evidence: "Coberto por testes automatizados e em produção; piloto TOULON não rodou.",
  },
];

const stageRank: Record<PlaybookStage, number> = { experimental: 0, validated: 1, certified: 2 };

const clone = (e: PlaybookEntry): PlaybookEntry => ({ ...e, verticals: [...e.verticals], archetypes: [...e.archetypes], preconditions: [...e.preconditions] });

export class PlaybookRegistryService {
  /** Catálogo completo (todas as versões). Devolve cópia — o registro interno não vaza. */
  static catalog(): { version: string; playbooks: PlaybookEntry[] } {
    return { version: PLAYBOOK_REGISTRY_VERSION, playbooks: PLAYBOOKS.map(clone) };
  }

  /** Versão mais nova de um playbook (por id). */
  static latest(id: string): PlaybookEntry | null {
    const all = PLAYBOOKS.filter((p) => p.id === id).sort((a, b) => b.version - a.version);
    return all[0] ? clone(all[0]) : null;
  }

  static get(id: string, version: number): PlaybookEntry | null {
    const p = PLAYBOOKS.find((x) => x.id === id && x.version === version);
    return p ? clone(p) : null;
  }

  static byProcessType(processType: string): PlaybookEntry | null {
    const all = PLAYBOOKS.filter((p) => p.processType === processType).sort((a, b) => b.version - a.version);
    return all[0] ? clone(all[0]) : null;
  }

  private static orgRow(orgId: string): { vertical: string | null; archetype: string | null } {
    try {
      const r = db.prepare("SELECT vertical, business_archetype FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      return { vertical: r?.vertical || null, archetype: r?.business_archetype || null };
    } catch { return { vertical: null, archetype: null }; }
  }

  /** Cabe pra esta empresa? Lista vazia = qualquer. Vertical/arquétipo desconhecidos da empresa NÃO casam com lista restrita (nunca chuta). */
  static fits(orgId: string, entry: PlaybookEntry): { fits: boolean; reasons: string[] } {
    const { vertical, archetype } = this.orgRow(orgId);
    const reasons: string[] = [];
    if (entry.verticals.length && (!vertical || !entry.verticals.includes(vertical))) reasons.push(vertical ? `vertical "${vertical}" fora de ${entry.verticals.join("/")}` : "vertical da empresa não definida");
    if (entry.archetypes.length && (!archetype || !entry.archetypes.includes(archetype))) reasons.push(archetype ? `arquétipo "${archetype}" fora de ${entry.archetypes.join("/")}` : "arquétipo da empresa não definido");
    return { fits: reasons.length === 0, reasons };
  }

  /**
   * Pode rodar neste nível de autonomia? Regras duras: nunca acima do teto do playbook; experimental só até `suggest` (RN-F5-5).
   * Consulta apenas — NÃO está ligada ao start do runtime (0-regressão): quem decide usar é o chamador.
   */
  static canRun(entry: PlaybookEntry, level: AutonomyLevel): { ok: boolean; reason?: string } {
    const want = AUTONOMY_ORDER.indexOf(level);
    if (want < 0) return { ok: false, reason: "nível de autonomia desconhecido" };
    if (want > AUTONOMY_ORDER.indexOf(entry.maxAutonomy)) return { ok: false, reason: `acima do teto do playbook (${entry.maxAutonomy})` };
    if (entry.stage === "experimental" && want > AUTONOMY_ORDER.indexOf("suggest")) return { ok: false, reason: "playbook experimental não executa sozinho" };
    return { ok: true };
  }

  /**
   * Eficácia por VERSÃO DE DEFINIÇÃO da empresa (process_definitions.version), derivada das instâncias reais.
   * Taxa = concluídas / (concluídas + falhas); em andamento/canceladas ficam de fora e são ditas. Sem n → null.
   */
  static efficacy(orgId: string, processType: string): Array<{ definitionVersion: number; definitionId: string; completed: number; failed: number; inProgress: number; cancelled: number; n: number; completionRate: number | null; interval: { lower: number; upper: number } | null; confidence: string; vertical: string | null }> {
    const { vertical } = this.orgRow(orgId);
    const defs = db.prepare("SELECT id, version FROM process_definitions WHERE organization_id = ? AND process_type = ? ORDER BY version ASC").all(orgId, processType) as any[];
    return defs.map((d) => {
      const rows = db.prepare("SELECT status, COUNT(*) c FROM process_instances WHERE organization_id = ? AND process_definition_id = ? GROUP BY status").all(orgId, d.id) as any[];
      const by = (s: string[]) => rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + Number(r.c || 0), 0);
      const completed = by(["completed", "measured"]);
      const failed = by(["failed"]);
      const cancelled = by(["cancelled"]);
      const inProgress = rows.reduce((a, r) => a + Number(r.c || 0), 0) - completed - failed - cancelled;
      const n = completed + failed;
      const iv = wilsonInterval(completed, n);
      return {
        definitionVersion: Number(d.version), definitionId: d.id, completed, failed, inProgress, cancelled, n,
        completionRate: n > 0 ? completed / n : null,
        interval: iv ? { lower: iv.lower, upper: iv.upper } : null,
        confidence: intervalConfidenceLabel(iv),
        vertical,
      };
    });
  }

  /** Situação do registro NESTA empresa: o que existe, se cabe, o que a empresa adotou e se a autonomia dela passa do teto. */
  static forOrg(orgId: string): Array<{ playbook: PlaybookEntry; fits: boolean; reasons: string[]; adopted: boolean; activeDefinition: { id: string; version: number; autonomyLevel: string } | null; autonomyAboveCeiling: boolean; canRunAtOrgLevel: { ok: boolean; reason?: string } | null; efficacy: ReturnType<typeof PlaybookRegistryService.efficacy> }> {
    if (!orgId) return [];
    const latestIds = new Set(PLAYBOOKS.filter((p) => !PLAYBOOKS.some((q) => q.id === p.id && q.version > p.version)).map((p) => `${p.id}@${p.version}`));
    return PLAYBOOKS.filter((p) => latestIds.has(`${p.id}@${p.version}`)).map((p) => {
      const fit = this.fits(orgId, p);
      const row = db.prepare("SELECT id, version, autonomy_level_default FROM process_definitions WHERE organization_id = ? AND process_type = ? AND active = 1 ORDER BY version DESC LIMIT 1").get(orgId, p.processType) as any;
      const level = row?.autonomy_level_default as AutonomyLevel | undefined;
      const above = !!level && AUTONOMY_ORDER.indexOf(level) > AUTONOMY_ORDER.indexOf(p.maxAutonomy);
      return {
        playbook: clone(p), fits: fit.fits, reasons: fit.reasons, adopted: !!row,
        activeDefinition: row ? { id: row.id, version: Number(row.version), autonomyLevel: row.autonomy_level_default } : null,
        autonomyAboveCeiling: above,
        canRunAtOrgLevel: level ? this.canRun(p, level) : null,
        efficacy: this.efficacy(orgId, p.processType),
      };
    });
  }

  /** Higiene do catálogo (usada no teste e em auditoria): problemas encontrados no próprio registro. */
  static lint(): string[] {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const p of PLAYBOOKS) {
      const k = `${p.id}@${p.version}`;
      if (seen.has(k)) problems.push(`duplicado: ${k}`);
      seen.add(k);
      if (!Number.isInteger(p.version) || p.version < 1) problems.push(`${k}: versão inválida`);
      if (!AUTONOMY_ORDER.includes(p.maxAutonomy)) problems.push(`${k}: autonomia inválida`);
      if (!p.preconditions.length) problems.push(`${k}: sem pré-condições`);
      if (!p.successMetric.trim()) problems.push(`${k}: sem métrica de sucesso`);
      if (!(p.stage in stageRank)) problems.push(`${k}: estágio inválido`);
      if (p.stage === "certified") problems.push(`${k}: 'certified' exige evidência de piloto que não existe`);
    }
    return problems;
  }
}
