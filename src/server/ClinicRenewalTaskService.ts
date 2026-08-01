/**
 * Módulo Clínica — DETECTOR DE RENOVAÇÃO (ADR-145 Fase 5 / Fatia 47).
 *
 * Sweep determinístico: varre `ClinicTreatmentCycleService.renewalQueue`
 * e publica sinais operacionais no `business_signals` (padrão ADR-136)
 * pra recepção enxergar no dashboard sem depender de polling manual.
 *
 * GUARDRAILS (RN-014 §Fase 5) — IA operacional NUNCA:
 *   - Renova ciclo automaticamente (recepção decide + humano confirma).
 *   - Emite guia sem revisão humana (F48 desenha o rascunho; assinatura
 *     PIN da guia continua em ClinicGuideService.issue).
 *   - Troca profissional do episódio (RN-003, profissional fixo).
 *   - Dá alta em nome do médico (RN-007, alta com PIN — Fatia 39).
 *   - Inventa TUSS/carteirinha/autorização (F48 sinaliza campo ausente).
 *
 * Este service SÓ sinaliza — dedup por (org, dedupe_key), idempotente,
 * seguro pra rodar em cron/Scheduler. Sinais que deixaram de valer (ex.:
 * ciclo renovado) são resolvidos por `resolveByDedupe`.
 *
 * Severidade determinística:
 *   - `pending_authorization`        → attention (esperando OK do convênio)
 *   - `renewal_due` + remaining == 0 → risk (esgotou; agenda travada)
 *   - `active` + remaining <= threshold → attention (alerta antecipado)
 */
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { ClinicTreatmentCycleService } from "./ClinicTreatmentCycleService.js";

export type RenewalSignalType =
  | "cycle_renewal_due"
  | "cycle_pending_authorization"
  | "cycle_renewal_alert";

function dedupeKeyFor(t: RenewalSignalType, cycleId: string): string {
  return `clinic:${t}:cycle:${cycleId}`;
}

export class ClinicRenewalTaskService {
  /**
   * Executa uma varredura na org. Retorna resumo (published + resolved
   * + itens vistos). Idempotente — rodar 2× não duplica sinal.
   *
   * `threshold` = quantas sessões de folga contam como "alerta antecipado"
   * (default 2 — mesma semântica de renewalQueue).
   */
  static run(orgId: string, opts: { threshold?: number } = {}): {
    seen: number;
    published: number;
    deduped: number;
    resolved: number;
  } {
    const items = ClinicTreatmentCycleService.renewalQueue(orgId, { threshold: opts.threshold });

    let published = 0;
    let deduped = 0;

    // Todas as dedupe_keys que "devem" estar abertas após esta rodada.
    // Qualquer sinal do domínio clinic com esse prefixo que não esteja
    // aqui é candidato a resolveByDedupe.
    const validKeys = new Set<string>();

    for (const it of items) {
      const cycle = it.cycle;
      const usage = it.usage;

      // Determina signalType + severidade determinística.
      let signalType: RenewalSignalType;
      let severity: string;
      if (cycle.status === "pending_authorization") {
        signalType = "cycle_pending_authorization";
        severity = "attention";
      } else if (cycle.status === "renewal_due" || usage.remaining <= 0) {
        signalType = "cycle_renewal_due";
        severity = "risk";
      } else {
        signalType = "cycle_renewal_alert";
        severity = "attention";
      }

      const dedupeKey = dedupeKeyFor(signalType, cycle.id);
      validKeys.add(dedupeKey);

      const res = BusinessSignalService.publish(orgId, {
        domain: "clinic",
        signalType,
        severity,
        basis: "fact",
        confidence: 1,
        sourceService: "ClinicRenewalTaskService",
        sourceEntityType: "treatment_cycle",
        sourceEntityId: cycle.id,
        // evidência sem dado clínico — só o suficiente pra recepção agir.
        evidence: {
          cycleId: cycle.id,
          cycleNumber: cycle.cycleNumber,
          episodeId: cycle.episodeId,
          plannedSessions: cycle.plannedSessions,
          remaining: usage.remaining,
          scheduled: usage.scheduled,
          patientName: it.patientName,
          specialtyName: it.specialtyName,
          professionalName: it.professionalName,
          cycleStatus: cycle.status,
        },
        dedupeKey,
      });

      if (res.deduped) deduped++;
      else published++;
    }

    // Fecha sinais que existiam antes e não estão mais válidos.
    // Filtra pela família dos 3 signalTypes deste service.
    const open = db.prepare(
      `SELECT dedupe_key FROM business_signals
        WHERE organization_id = ? AND domain = 'clinic' AND status = 'open'
          AND signal_type IN ('cycle_renewal_due','cycle_pending_authorization','cycle_renewal_alert')`
    ).all(orgId) as any[];

    let resolved = 0;
    for (const row of open) {
      if (!validKeys.has(row.dedupe_key)) {
        const r = BusinessSignalService.resolveByDedupe(orgId, row.dedupe_key);
        if (r.ok) resolved++;
      }
    }

    return {
      seen: items.length,
      published,
      deduped,
      resolved,
    };
  }

  /**
   * Lista os sinais abertos do domínio clínica — helper pra rota de UI.
   * Ordenado por severidade (BusinessSignalService.list já ordena).
   */
  static list(orgId: string, opts: { includeResolved?: boolean } = {}): any[] {
    const all = BusinessSignalService.list(orgId, { domain: "clinic", ...(opts.includeResolved ? {} : { status: "open" }) });
    return all.filter((s: any) =>
      s.signal_type === "cycle_renewal_due"
      || s.signal_type === "cycle_pending_authorization"
      || s.signal_type === "cycle_renewal_alert"
    );
  }
}

export default ClinicRenewalTaskService;
