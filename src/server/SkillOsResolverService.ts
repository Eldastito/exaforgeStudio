import {
  SkillManifest,
  SkillResolution,
  RiskLevel,
  RISK_LEVELS,
  rankSkills,
  riskRank,
  isDeterministicSkill,
} from "./skillosModel.js";
import { SkillOsRegistryService } from "./SkillOsRegistryService.js";
import { PermissionService } from "./PermissionService.js";

/**
 * SkillOsResolverService — PRD 4 F3: o CAPABILITY RESOLVER.
 *
 * Dada uma Capability + contexto (vertical/tenant/usuário/risco), ESCOLHE qual
 * Skill atende — determinística e conservadoramente. NÃO executa (isso é o Runtime)
 * e NÃO usa IA pra escolher (§11 / esta fatia): a decisão é por REGRA, reproduzível
 * e explicável.
 *
 * Pipeline (READ + DERIVE):
 *   1. a Capability existe e está DISPONÍVEL pro tenant? (status+vertical+entitlement,
 *      via `SkillOsRegistryService.isCapabilityAvailable` — reusa, não duplica).
 *   2. candidatas = Skills ACTIVE que atendem a Capability + compatíveis com a vertical.
 *   3. filtra por teto de risco (opcional) + permissões RBAC declaradas (opcional).
 *   4. ranqueia por `rankSkills` (§11: determinístico > barato > menor risco > versão).
 *   5. vencedora = 1ª; alternativas = resto; fallback = fallbackSkills da vencedora (§25).
 * NUNCA "silêncio" (§65): sem candidata → `resolved:false` + `unresolvedReason`
 * (vira escalada humana numa fase seguinte, §45).
 *
 * GUARDRAILS (testados):
 *   - RN-RES-1 SEM IA: escolha 100% por regra, determinística/reproduzível (§11).
 *   - RN-RES-2 DISPONIBILIDADE: só resolve Capability ativa+vertical+entitlement.
 *   - RN-RES-3 SÓ ACTIVE: candidatas são Skills active compatíveis; disabled fora.
 *   - RN-RES-4 SEM SILÊNCIO: sempre um resultado estruturado com razão.
 *   - RN-RES-5 CONSERVADOR: não "escolhe o modelo mais poderoso"; prefere o mais
 *     simples/barato que cumpre (P7/§11).
 */

export interface ResolveInput {
  capabilityId: string;
  vertical?: string | null;
  maxRisk?: RiskLevel | null;         // teto de risco aceitável (opcional)
  requirePermissions?: boolean;       // se true, filtra por skill.requiredPermissions (RBAC)
}

export class SkillOsResolverService {
  static resolve(orgId: string, user: any, input: ResolveInput): SkillResolution {
    const capabilityId = String(input?.capabilityId || "").trim();
    const base = (over: Partial<SkillResolution>): SkillResolution => ({
      capabilityId, resolved: false, skill: null, reason: "", alternatives: [], fallbackChain: [], unresolvedReason: null, ...over,
    });

    const cap = SkillOsRegistryService.getCapability(capabilityId);
    if (!cap) return base({ reason: `Capability '${capabilityId}' não existe no catálogo.`, unresolvedReason: "capability_not_found" });

    const vertical = input.vertical ?? undefined;
    if (!SkillOsRegistryService.isCapabilityAvailable(orgId, user, cap, vertical)) {
      return base({ reason: `Capability '${capabilityId}' indisponível para o tenant (status/vertical/plano).`, unresolvedReason: "capability_unavailable" });
    }

    // candidatas: active + compatíveis com a vertical.
    let candidates = SkillOsRegistryService.skillsForCapability(capabilityId, { vertical });

    // filtro de teto de risco (§21 — não passa de um risco aceitável).
    if (input.maxRisk && RISK_LEVELS.includes(input.maxRisk)) {
      const ceiling = riskRank(input.maxRisk);
      candidates = candidates.filter((s) => riskRank(s.riskLevel) <= ceiling);
    }

    // filtro opcional de permissões RBAC declaradas pela skill (reusa PermissionService).
    if (input.requirePermissions) {
      candidates = candidates.filter((s) => this.userHasSkillPermissions(orgId, user, s));
    }

    if (candidates.length === 0) {
      return base({ reason: "Nenhuma Skill elegível atende a Capability (risco/permissão/vertical filtraram tudo).", unresolvedReason: "no_skill_available" });
    }

    const ranked = rankSkills(candidates);
    const winner = ranked[0];
    const alternatives = ranked.slice(1);
    return base({
      resolved: true,
      skill: winner,
      reason: this.explain(winner, ranked),
      alternatives,
      // §25 fallback: os declarados pela skill que EXISTAM e estejam active (não inventa).
      fallbackChain: this.validFallbacks(winner),
    });
  }

  /** Explica a escolha (§10 — razão auditável) comparando a vencedora ao runner-up. */
  private static explain(winner: SkillManifest, ranked: SkillManifest[]): string {
    if (ranked.length === 1) return "Única Skill elegível para a Capability.";
    const next = ranked[1];
    if (isDeterministicSkill(winner) && !isDeterministicSkill(next)) return "Determinística preferida sobre probabilística (P7/§11).";
    if ((winner.budgetClass || "") !== (next.budgetClass || "")) return `Menor custo computacional (budget=${winner.budgetClass ?? "n/d"}) entre ${ranked.length} candidatas.`;
    if (winner.riskLevel !== next.riskLevel) return `Menor risco (${winner.riskLevel}) entre ${ranked.length} candidatas.`;
    return `Escolhida por versão/id (desempate estável) entre ${ranked.length} candidatas.`;
  }

  /** fallbackSkills declaradas que existem E estão active (§25 — sem inventar). */
  private static validFallbacks(skill: SkillManifest): string[] {
    const out: string[] = [];
    for (const id of skill.fallbackSkills || []) {
      const fb = SkillOsRegistryService.getSkill(id);
      if (fb && fb.status === "active") out.push(id);
    }
    return out;
  }

  /** O usuário tem as permissões RBAC que a skill declara? (≥read em cada módulo.) */
  private static userHasSkillPermissions(orgId: string, user: any, skill: SkillManifest): boolean {
    const mods = skill.requiredPermissions || [];
    if (mods.length === 0) return true;
    return mods.every((m) => PermissionService.can(orgId, user, m, "read"));
  }
}

export default SkillOsResolverService;
