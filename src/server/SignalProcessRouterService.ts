import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { ProcessRuntimeService } from "./ProcessRuntimeService.js";

/**
 * SignalProcessRouterService (ADR-158 F4 / D6) — roteador GENÉRICO que fecha o
 * elo hoje MANUAL sinal→processo. Para sinais MAPEADOS (por `domain:signal_type`)
 * inicia automaticamente a `process_instance` correspondente, sem que um humano
 * precise chamar `POST /runtime/instances` com o `signalId` na mão.
 *
 * DESENHO DE SEGURANÇA (por que isto NÃO amplia a superfície de autonomia):
 *  - Auto-INICIAR um processo NÃO é efeito externo. A instância nasce em
 *    `detected` (porta de entrada da FSM). Se/como ela avança até uma ação
 *    externa segue 100% governado pelo choke-point existente
 *    (`CommandExecutorService` G1/G2/G3 + `agent_policies`) — a F4 não toca
 *    nesse gate (RN-159-4: sem engine de governança paralelo). Ou seja: a F4
 *    automatiza só o ROTEAMENTO sinal→processo, nunca a EXECUÇÃO.
 *  - Opt-in DUPLO (convenção nº 10): `signal_auto_trigger_enabled` (o opt-in
 *    específico) EM CIMA de `execution_runtime_enabled` (o guarda-chuva do
 *    runtime — sem ele nada rodaria a instância criada, então iniciar seria
 *    inútil). Ambos default 0.
 *  - Best-effort (convenção nº 7): um mapeamento sem definição ativa ou um erro
 *    numa org NUNCA derruba o pass — vira `skipped` com motivo, auditável.
 *  - Idempotência em DUAS camadas: (1) ao rotear, o sinal vira `acknowledged`
 *    (sai da varredura de `open` do próximo pass; republicar por dedupe NÃO
 *    reabre — o UPDATE de dedupe não mexe em `status`); (2) `startForSubject`
 *    dedupa por `(processType, subjectType, subjectId)` vivo — reentrância
 *    devolve a instância existente em vez de duplicar. Some as duas e o mesmo
 *    sinal jamais dispara dois processos, mesmo que o processo re-emita o sinal.
 *
 * Isolado por org (convenção nº 1): toda leitura/escrita filtra organization_id.
 */

interface TriggerRule {
  processType: string;   // deve ter uma definição ATIVA na org (senão o sinal vira skipped)
  riskLevel?: string;    // low|medium|high — carimba a instância
}

export interface RouteResult {
  flagEnabled: boolean;
  triggered: Array<{ signalId: string; domain: string; signalType: string; processType: string; instanceId: string; deduped: boolean }>;
  previews: Array<{ signalId: string; domain: string; signalType: string; processType: string }>;
  skipped: Array<{ signalId: string; signalType: string; reason: string }>;
}

export class SignalProcessRouterService {
  /**
   * Mapa EXPLÍCITO e conservador `domain:signal_type` → processo. Cada entrada é
   * um "sinal-problema detectado → inicia o playbook de remediação", escolhido
   * pra NÃO formar laço (os playbooks emitem sinais de OUTCOME distintos dos que
   * disparam aqui; e o acknowledge + dedup barram reentrância de qualquer jeito).
   * Ampliar a automação = acrescentar uma linha aqui (o mecanismo é genérico).
   */
  private static readonly TRIGGER_MAP: Record<string, TriggerRule> = {
    // Risco de churn alto → inicia a Recuperação Comercial pro contato em risco.
    "churn:churn_risk_high": { processType: "sales_recovery_v1", riskLevel: "medium" },
    // Promessa de pagamento quebrada → inicia o processo de cobrança do recebível.
    "collection:promise_broken": { processType: "receivable_collection_v1", riskLevel: "high" },
    // PRD 2 F8 (§72) — oportunidades paradas → Recuperação Comercial (playbook maduro).
    "sales:stalled_opportunities": { processType: "sales_recovery_v1", riskLevel: "medium" },
  };

  // PRD 2 F8 (§41-42) — allowlist de processos MADUROS. Um sinal SEM mapeamento
  // explícito pode rotear pelo `recommendedProcessType` que seu DETECTOR declarou
  // (F4.2) — mas SOMENTE se o processo estiver aqui. Ampliar autonomia de forma
  // segura = (a) adicionar linha no TRIGGER_MAP OU (b) marcar um processo como
  // maduro aqui. Nunca "qualquer sinal → qualquer processo".
  private static readonly MATURE_PROCESSES = new Set(["sales_recovery_v1", "receivable_collection_v1"]);

  private static severityToRisk(severity: string): string {
    const s = String(severity || "").toLowerCase();
    return s === "critical" || s === "risk" ? "high" : s === "attention" ? "medium" : "low";
  }

  /**
   * Resolve a regra de roteamento de um sinal: (1) mapa EXPLÍCITO por
   * domain:signal_type; senão (2) o `recommendedProcessType` que o detector
   * declarou na evidência (F4.2), desde que seja um processo MADURO (allowlist).
   */
  private static resolveRule(sig: any): TriggerRule | null {
    const explicit = this.TRIGGER_MAP[`${sig.domain}:${sig.signal_type}`];
    if (explicit) return explicit;
    let rp: string | null = null;
    try { rp = (typeof sig.evidence === "object" ? sig.evidence : JSON.parse(sig.evidence_json || "{}"))?.recommendedProcessType || null; } catch { rp = null; }
    if (rp && this.MATURE_PROCESSES.has(rp)) return { processType: rp, riskLevel: this.severityToRisk(sig.severity) };
    return null;
  }

  /**
   * Opt-in DUPLO: o roteador só age se a org ligou `signal_auto_trigger_enabled`
   * E o guarda-chuva `execution_runtime_enabled` (sem runtime, iniciar instância
   * não leva a nada). Cascade idêntico ao do RuntimePilot.
   */
  static isEnabled(orgId: string): boolean {
    const row = db.prepare(
      `SELECT COALESCE(execution_runtime_enabled,0) AS rt, COALESCE(signal_auto_trigger_enabled,0) AS at
         FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any;
    return Number(row?.rt) === 1 && Number(row?.at) === 1;
  }

  /**
   * Roteia todos os sinais ABERTOS e mapeados da org. `dryRun` PREVIEW ignora a
   * flag (deixa o operador ver o que dispararia antes de ligar); disparo real
   * exige a flag. Retorna o que foi disparado / previsto / pulado (com motivo).
   */
  static routeOrg(orgId: string, opts: { actor?: string; dryRun?: boolean; limit?: number } = {}): RouteResult {
    const enabled = this.isEnabled(orgId);
    const out: RouteResult = { flagEnabled: enabled, triggered: [], previews: [], skipped: [] };
    // Disparo real sem flag = no-op silencioso (respeita o opt-in). Preview segue.
    if (!opts.dryRun && !enabled) return out;

    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 100;
    let budget = limit;
    // F8 — varre TODOS os sinais abertos (o `resolveRule` decide: mapa explícito
    // OU recommendedProcessType maduro). `list` já limita a 200 + ordena.
    {
      const signals = BusinessSignalService.list(orgId, { status: "open" });
      for (const sig of signals) {
        if (budget <= 0) break;
        const rule = this.resolveRule(sig);
        if (!rule) continue; // não-mapeado e sem processo maduro recomendado: ignora
        budget--;
        if (opts.dryRun) {
          out.previews.push({ signalId: sig.id, domain: sig.domain, signalType: sig.signal_type, processType: rule.processType });
          continue;
        }
        try {
          const inst = ProcessRuntimeService.startFromSignal(orgId, sig.id, {
            processType: rule.processType,
            subjectType: sig.subject_type || sig.source_entity_type || undefined,
            subjectId: sig.source_entity_id || undefined,
            riskLevel: rule.riskLevel,
            createdBy: opts.actor || "signal-router",
          }, opts.actor || "signal-router");
          // Roteado → acknowledged: sai da varredura de `open` (idempotência).
          BusinessSignalService.acknowledge(orgId, sig.id);
          const deduped = inst?.status && inst.status !== "detected"; // instância viva pré-existente
          out.triggered.push({ signalId: sig.id, domain: sig.domain, signalType: sig.signal_type, processType: rule.processType, instanceId: inst.id, deduped: !!deduped });
        } catch (e: any) {
          // Definição inativa/ausente, subject inválido, etc. — não derruba o pass.
          out.skipped.push({ signalId: sig.id, signalType: sig.signal_type, reason: e?.message || "erro ao iniciar processo" });
        }
      }
    }
    return out;
  }

  /**
   * Roteia UM sinal específico (por id). Usado pela rota manual e por testes.
   * Respeita a mesma flag e as mesmas garantias do pass em lote.
   */
  static routeSignal(orgId: string, signalId: string, opts: { actor?: string; dryRun?: boolean } = {}): RouteResult {
    const enabled = this.isEnabled(orgId);
    const out: RouteResult = { flagEnabled: enabled, triggered: [], previews: [], skipped: [] };
    if (!opts.dryRun && !enabled) return out;
    const sig = db.prepare(`SELECT * FROM business_signals WHERE id = ? AND organization_id = ?`).get(signalId, orgId) as any;
    if (!sig) { out.skipped.push({ signalId, signalType: "?", reason: "sinal não encontrado" }); return out; }
    if (sig.status !== "open") { out.skipped.push({ signalId, signalType: sig.signal_type, reason: `sinal não está aberto (${sig.status})` }); return out; }
    const rule = this.resolveRule(sig);
    if (!rule) { out.skipped.push({ signalId, signalType: sig.signal_type, reason: "sinal não mapeado" }); return out; }
    if (opts.dryRun) { out.previews.push({ signalId, domain: sig.domain, signalType: sig.signal_type, processType: rule.processType }); return out; }
    try {
      const inst = ProcessRuntimeService.startFromSignal(orgId, sig.id, {
        processType: rule.processType,
        subjectType: sig.subject_type || sig.source_entity_type || undefined,
        subjectId: sig.source_entity_id || undefined,
        riskLevel: rule.riskLevel,
        createdBy: opts.actor || "signal-router",
      }, opts.actor || "signal-router");
      BusinessSignalService.acknowledge(orgId, sig.id);
      const deduped = inst?.status && inst.status !== "detected";
      out.triggered.push({ signalId: sig.id, domain: sig.domain, signalType: sig.signal_type, processType: rule.processType, instanceId: inst.id, deduped: !!deduped });
    } catch (e: any) {
      out.skipped.push({ signalId: sig.id, signalType: sig.signal_type, reason: e?.message || "erro ao iniciar processo" });
    }
    return out;
  }
}

export default SignalProcessRouterService;
