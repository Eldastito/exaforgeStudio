import { SkillOsRegistryService } from "./SkillOsRegistryService.js";
import { SkillOsRolloutService } from "./SkillOsRolloutService.js";
import { SkillOsPlannerService } from "./SkillOsPlannerService.js";
import { FalaTuAskService } from "./FalaTuAskService.js";
import { FalaTuMultiActionService, MultiItem } from "./FalaTuMultiActionService.js";
import { Capability, SkillManifest, ExecutionPlan, RiskLevel } from "./skillosModel.js";

/**
 * FalaTuSkillMapService — ADR-206 F5.10: liga 3 ações do FalaTu a capacidades REAIS do SkillOS
 * e deixa o Planner montar o plano de uma frase composta.
 *
 * O que é: a ponte FalaTu → SkillOS Planner (que a auditoria F5.0 não achou). NÃO é orquestrador
 * novo (RN-F5-12): a divisão da frase e a classificação são as do FalaTu (`split` + `classify`), a
 * dependência "compromisso com cliente que ainda vai ser cadastrado" é a do `linkDependencies`, e o
 * plano é o do `SkillOsPlannerService`. Aqui só vive o MAPA e a costura.
 *
 * As 3 ações escolhidas (as do exemplo "cadastra o cliente João e marca reunião com ele; lança a despesa…"):
 *   - record_contact     → `falatu.record_contact`     (risco low)
 *   - record_appointment → `falatu.record_appointment` (risco low)
 *   - record_expense     → `falatu.record_expense`     (risco medium — dinheiro que sai, §73)
 * Cada Skill é só MANIFESTO: aponta para o caminho que JÁ existe (`FalaTuAskService.converse` →
 * proposta GOVERNADA `DecisionAction → ApprovalPolicy → CommandExecutor`). Nenhuma executa nada.
 * Venda, recebível e anotação NÃO foram mapeadas e o plano diz isso (`notMapped`), não chuta.
 *
 * REGRAS (testadas):
 *  - Só PLANEJA: zero escrita (nenhuma ação, nenhum pendente, nenhum audit) — executar segue pelo
 *    `FalaTuMultiActionService.confirm` e pela política de aprovação.
 *  - Registro OPT-IN e em `shadow` (sem efeito); NÃO entra na promoção automática dos pilotos do boot.
 *  - Catálogo não registrado → passo `unresolved` e plano `blocked`, nunca "pronto de mentira".
 *  - Dinheiro role-gated (§73): despesa para quem não vê dinheiro vem `blocked`.
 *  - Ação sem capacidade mapeada e frase que não é ação aparecem separadas, nunca somem.
 *  - Sem texto do dono em banco/audit (nada é persistido).
 */

interface MapEntry { kind: string; capabilityId: string; skillId: string; name: string; riskLevel: RiskLevel; permission: string; money: boolean; service: string }

export const FALATU_SKILL_MAP: ReadonlyArray<MapEntry> = [
  { kind: "record_contact", capabilityId: "falatu.record_contact", skillId: "falatu-record-contact-v1", name: "Cadastrar cliente por frase", riskLevel: "low", permission: "contatos", money: false, service: "FalaTuAskService.converse (record_contact)" },
  { kind: "record_appointment", capabilityId: "falatu.record_appointment", skillId: "falatu-record-appointment-v1", name: "Marcar compromisso por frase", riskLevel: "low", permission: "agenda", money: false, service: "FalaTuAskService.converse (record_appointment)" },
  { kind: "record_expense", capabilityId: "falatu.record_expense", skillId: "falatu-record-expense-v1", name: "Lançar despesa por frase", riskLevel: "medium", permission: "financeiro", money: true, service: "FalaTuAskService.converse (record_expense)" },
];

/** Tipos que o FalaTu trata como GRAVAÇÃO (espelha o ACTION_KINDS do multi-ação). */
const RECORD_KINDS = new Set(["record", "record_expense", "record_sale", "record_contact", "record_receivable", "record_appointment"]);
const byKind = new Map(FALATU_SKILL_MAP.map((e) => [e.kind, e]));

export interface FalaTuSkillPlanItem {
  id: string; text: string; kind: string;
  capabilityId: string | null; mapped: boolean;
  blocked: string | null; dependsOn: string | null; dependsName: string | null;
}

export class FalaTuSkillMapService {
  /** Mapa transparente: ação do FalaTu → capacidade/skill + o serviço real por trás. */
  static mapping() {
    return FALATU_SKILL_MAP.map((e) => ({ kind: e.kind, capabilityId: e.capabilityId, skillId: e.skillId, riskLevel: e.riskLevel, service: e.service }));
  }

  /** Registro idempotente no catálogo. Estágio inicial `shadow` só na 1ª vez (não clobera o operador, RN-RO-5). Nunca promove. */
  static register(): { capabilities: number; skills: number; stages: Record<string, string> } {
    const stages: Record<string, string> = {};
    for (const e of FALATU_SKILL_MAP) {
      SkillOsRegistryService.registerCapability({
        capabilityId: e.capabilityId, version: 1, name: e.name, category: "falatu", riskLevel: e.riskLevel, requiredContext: "minimal",
        description: `Aponta p/ ${e.service}: a frase vira PROPOSTA governada (DecisionAction → ApprovalPolicy → CommandExecutor). Só planeja; nunca executa.`,
        status: "active",
      } as Capability);
      SkillOsRegistryService.registerSkill({
        skillId: e.skillId, version: 1, capabilityId: e.capabilityId, riskLevel: e.riskLevel, supportsFallback: false,
        description: `Manifesto de ${e.service}. O efeito real é a proposta governada do FalaTu; a skill não tem sink próprio.`,
        allowedTools: [], forbiddenTools: [], requiredPermissions: [e.permission], requiredEntitlements: [], requiredContextProfile: "minimal",
        fallbackSkills: [], successCriteria: ["vira proposta governada (ou captura pendente no Inbox)"], failureCriteria: ["escrever sem passar pela política de aprovação"],
        status: "active",
      } as SkillManifest);
      if (!SkillOsRolloutService.has(e.skillId)) SkillOsRolloutService.setStage(e.skillId, "shadow");
      stages[e.skillId] = SkillOsRolloutService.get(e.skillId).stage;
    }
    return { capabilities: FALATU_SKILL_MAP.length, skills: FALATU_SKILL_MAP.length, stages };
  }

  /** Plano de uma frase (simples ou composta). Read-only: não grava nada. */
  static plan(orgId: string, user: any, text: string, opts: { today: string; vertical?: string | null }): {
    executes: false; plan: ExecutionPlan | null; items: FalaTuSkillPlanItem[]; notMapped: Array<{ text: string; kind: string }>; notActions: string[]; summary: string;
  } {
    const t = String(text || "").trim();
    const split = t ? FalaTuMultiActionService.split(t, opts.today) : [];
    const clauses = split.length ? split : (t ? [t] : []);
    const canMoney = FalaTuAskService.canSeeMoney(orgId, user);

    const items: MultiItem[] = [];
    const notMapped: Array<{ text: string; kind: string }> = [];
    const notActions: string[] = [];
    clauses.forEach((c, i) => {
      const kind = FalaTuAskService.classify(c, opts.today).kind;
      if (byKind.has(kind)) items.push({ id: `a${i + 1}`, text: c, kind, label: "", blocked: null });
      else if (RECORD_KINDS.has(kind)) notMapped.push({ text: c, kind });
      else notActions.push(c);
    });
    // a dependência do compromisso com cliente a cadastrar é a MESMA regra do multi-ação
    FalaTuMultiActionService.linkDependencies(items);

    const out: FalaTuSkillPlanItem[] = items.map((it) => {
      const e = byKind.get(it.kind)!;
      return {
        id: it.id, text: it.text, kind: it.kind, capabilityId: e.capabilityId, mapped: true,
        blocked: e.money && !canMoney ? "Restrito ao dono, sócios, administradores e gerentes." : null,
        dependsOn: it.dependsOn ?? null, dependsName: it.dependsName ?? null,
      };
    });

    const live = out.filter((i) => !i.blocked);
    const plan = live.length
      ? SkillOsPlannerService.plan(orgId, user, {
          goal: t.slice(0, 200), intent: "falatu_phrase", vertical: opts.vertical ?? null,
          steps: live.map((i) => ({ stepId: i.id, capabilityId: i.capabilityId!, dependsOn: i.dependsOn && live.some((x) => x.id === i.dependsOn) ? [i.dependsOn] : [] })),
        })
      : null;

    const parts = [
      plan ? `${live.length} passo(s) no plano (${plan.status === "ready" ? "pronto" : "bloqueado: " + (plan.unresolvedCapabilities.length ? "capacidade sem skill no catálogo" : "dependência inválida")})` : "nenhum passo no plano",
      out.some((i) => i.blocked) ? `${out.filter((i) => i.blocked).length} bloqueado(s) por permissão` : null,
      notMapped.length ? `${notMapped.length} ação(ões) sem capacidade mapeada` : null,
      notActions.length ? `${notActions.length} trecho(s) que não é ação` : null,
    ].filter(Boolean);
    return { executes: false, plan, items: out, notMapped, notActions, summary: parts.join("; ") + ". Nada foi executado." };
  }
}

export default FalaTuSkillMapService;
