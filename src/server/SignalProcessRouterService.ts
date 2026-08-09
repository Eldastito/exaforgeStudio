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
  };

  /** Domínios distintos presentes no mapa (pra varrer só o que interessa). */
  private static mappedDomains(): string[] {
    return [...new Set(Object.keys(this.TRIGGER_MAP).map((k) => k.split(":")[0]))];
  }

  private static ruleFor(domain: string, signalType: string): TriggerRule | null {
    return this.TRIGGER_MAP[`${domain}:${signalType}`] || null;
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
    for (const domain of this.mappedDomains()) {
      if (budget <= 0) break;
      const signals = BusinessSignalService.list(orgId, { status: "open", domain });
      for (const sig of signals) {
        if (budget <= 0) break;
        const rule = this.ruleFor(sig.domain, sig.signal_type);
        if (!rule) continue; // sinal do domínio mas tipo não-mapeado: ignora
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
    const rule = this.ruleFor(sig.domain, sig.signal_type);
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
