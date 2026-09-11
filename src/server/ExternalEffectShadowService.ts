import db from "./db.js";
import { ApprovalPolicyService } from "./ApprovalPolicyService.js";

/**
 * ExternalEffectShadowService — F1.1 fatia B1 (SHADOW) do PRD-ZF-UNIFIED-GAP-CLOSURE-03.
 *
 * Prepara a migração do choke-point de efeito externo (CommandExecutorService) SEM tocar em
 * NENHUM caminho de envio de produção. É 100% read-only/derivado: responde à pergunta que
 * decide o rollout — "se ligarmos a flag `*_via_executor_enabled` (default hoje = bypass),
 * quais envios que HOJE saem passariam a ser SEGURADOS/NEGADOS pela governança?".
 *
 * Por que dá pra responder sem instrumentar envio: `CommandExecutorService.dispatchGoverned`
 * (o caminho ON) AUTO-SEMEIA uma `agent_policies` `execute/approved_execution` quando não há
 * política — logo, org SEM política pró-endpoint → enviaria igual (sem divergência). A
 * divergência só existe em org que JÁ tem política restritiva pra aquele (domain,actionType).
 * Isso é determinístico e computável por query (mesmo veredito que instrumentar cada envio,
 * porque mensagem não carrega valor — `amount:0`).
 *
 * Guardrails: read-only (RN-004), isolado por org, Master Admin (não vaza governança pro
 * tenant), determinístico. NÃO muda envio, NÃO liga flag, NÃO semeia política (isso é a B1.5).
 */

// Os 6 endpoints governáveis (os 5 services com dual-path + os 2 canais do Prospect).
// Espelha exatamente o (domain, actionType) que cada service usa no caminho `viaExecutor`.
export const EXTERNAL_SINKS: { sink: string; domain: string; actionType: string; flag: string; channel: string }[] = [
  { sink: "CollectionCadenceService", domain: "collection", actionType: "collection_followup", flag: "collection_cadence_via_executor_enabled", channel: "whatsapp" },
  { sink: "CollectionPromiseService", domain: "collection", actionType: "collection_promise_followup", flag: "collection_cadence_via_executor_enabled", channel: "whatsapp" },
  { sink: "CollectionResendPixService", domain: "collection", actionType: "collection_resend_pix", flag: "collection_cadence_via_executor_enabled", channel: "whatsapp" },
  { sink: "SalesRecoveryPlaybook", domain: "sales", actionType: "sales_recovery_send", flag: "sales_recovery_via_executor_enabled", channel: "whatsapp" },
  { sink: "ProspectExecutionService", domain: "prospect", actionType: "prospect_outreach_whatsapp", flag: "prospect_via_executor_enabled", channel: "whatsapp" },
  { sink: "ProspectExecutionService", domain: "prospect", actionType: "prospect_outreach_email", flag: "prospect_via_executor_enabled", channel: "email" },
];

const AUTO_EXEC_MODES = new Set(["approved_execution", "autonomous"]);

export interface SinkShadow {
  sink: string; domain: string; actionType: string; channel: string; flag: string;
  flagOn: boolean;               // governado já ligado pra esta org?
  policyExists: boolean;         // já há agent_policies pra (domain,actionType)?
  wouldAutoExecute: boolean;     // se ligar a flag, enviaria automaticamente (sem segurar)?
  wouldState: string;            // allow | require_approval | escalate | deny (resolveContract)
  divergence: boolean;           // hoje ENVIA (flag off) mas o governado SEGURARIA → mudança de comportamento
  reason: string;
}

function num(v: any): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export class ExternalEffectShadowService {
  private static flagOn(orgId: string, flag: string): boolean {
    try {
      const r = db.prepare(`SELECT COALESCE(${flag}, 0) AS v FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      return num(r?.v) === 1;
    } catch { return false; }
  }

  /** Avalia um sink pra uma org. Determinístico, read-only. */
  private static evalSink(orgId: string, s: typeof EXTERNAL_SINKS[number]): SinkShadow {
    const flagOn = this.flagOn(orgId, s.flag);
    const pol = db.prepare("SELECT autonomy_level, execution_mode, active FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?")
      .get(orgId, s.domain, s.actionType) as any;
    const policyExists = !!pol;
    const contract = ApprovalPolicyService.resolveContract(orgId, { domain: s.domain, actionType: s.actionType, amount: 0 });

    let wouldAutoExecute: boolean;
    let reason: string;
    if (!policyExists) {
      // dispatchGoverned auto-semeia execute/approved_execution → enviaria igual (sem divergência).
      wouldAutoExecute = true;
      reason = "sem política → o executor auto-semeia execute/approved_execution e envia (sem mudança).";
    } else {
      const modeOk = AUTO_EXEC_MODES.has(String(pol.execution_mode));
      const autoOk = String(pol.autonomy_level) === "execute";
      const activeOk = num(pol.active) === 1;
      const allowOk = contract.state === "allow";
      wouldAutoExecute = modeOk && autoOk && activeOk && allowOk;
      reason = wouldAutoExecute
        ? "política existente permite auto-execução (envia)."
        : `política existente SEGURA: ${!activeOk ? "inativa" : !autoOk ? `autonomy=${pol.autonomy_level}` : !modeOk ? `mode=${pol.execution_mode}` : `contrato=${contract.state} (${contract.reason})`}.`;
    }

    // Divergência = hoje envia livre (flag off) E o governado NÃO enviaria automaticamente.
    const divergence = !flagOn && !wouldAutoExecute;
    return {
      sink: s.sink, domain: s.domain, actionType: s.actionType, channel: s.channel, flag: s.flag,
      flagOn, policyExists, wouldAutoExecute, wouldState: contract.state, divergence, reason,
    };
  }

  /** Relatório de prontidão de migração de UMA org: por sink + resumo. */
  static analyze(orgId: string): {
    generatedAt: string; orgId: string; sinks: SinkShadow[];
    summary: { total: number; divergences: number; readyToFlip: boolean };
  } {
    const sinks = EXTERNAL_SINKS.map((s) => this.evalSink(orgId, s));
    const divergences = sinks.filter((x) => x.divergence).length;
    return {
      generatedAt: new Date().toISOString(), orgId, sinks,
      summary: { total: sinks.length, divergences, readyToFlip: divergences === 0 },
    };
  }

  /**
   * Relatório de plataforma (Master Admin): quais orgs têm divergência (não estão prontas pra
   * flip) e quais estão prontas. Dimensiona a B1.5 (seed de policy) e a B2 (canary).
   */
  static analyzeAll(opts: { limit?: number } = {}): {
    generatedAt: string; orgsAnalyzed: number;
    orgsReady: number; orgsWithDivergence: { orgId: string; divergences: number; sinks: string[] }[];
  } {
    const limit = Math.max(1, Math.min(5000, opts.limit || 1000));
    const orgs = db.prepare("SELECT organization_id FROM organization_settings LIMIT ?").all(limit) as any[];
    let orgsReady = 0;
    const withDiv: { orgId: string; divergences: number; sinks: string[] }[] = [];
    for (const o of orgs) {
      const r = this.analyze(o.organization_id);
      if (r.summary.divergences === 0) orgsReady++;
      else withDiv.push({ orgId: o.organization_id, divergences: r.summary.divergences, sinks: r.sinks.filter((x) => x.divergence).map((x) => `${x.domain}/${x.actionType}`) });
    }
    return { generatedAt: new Date().toISOString(), orgsAnalyzed: orgs.length, orgsReady, orgsWithDivergence: withDiv };
  }
}

export default ExternalEffectShadowService;
