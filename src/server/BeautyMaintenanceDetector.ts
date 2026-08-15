/**
 * BeautyMaintenanceDetector (ADR-169 F12 / BEAUTY-013) — publica na ESPINHA
 * CANÔNICA (`business_signals`) o sinal "cliente está na janela de
 * manutenção" (ex.: coloração feita há 30 dias e cliente não voltou).
 * Segundo tijolo do Beauty Autopilot em SHADOW (o primeiro foi F11 —
 * simulação abandonada).
 *
 * O QUE DETECTA: para cada `appointments` da org cujo `product_service_id`
 * é um serviço com `maintenance_days > 0`, se a diferença em dias entre
 * HOJE e o `scheduled_start` do appointment PASSADO é maior ou igual a
 * `maintenance_days` E o mesmo contato NÃO tem outro appointment do MESMO
 * serviço marcado a partir daquele passado (nem futuro nem passado mais
 * recente), a janela de manutenção venceu e vira sinal.
 *
 * A ideia é simples: "corte foi há 60 dias, corte tem manutenção sugerida
 * em 45 — está na hora de oferecer retorno". Sem `maintenance_days`
 * configurado no serviço, nada acontece (0-regressão dura pra catálogos
 * legados). O detector É POR SERVIÇO — cada serviço decide sua própria
 * janela via `products_services.maintenance_days` (aditivo, opt-in).
 *
 * DEDUPE `beauty:maintenance_due:{contactId}:{serviceId}` — republicar o
 * mesmo par (contato, serviço) ATUALIZA a linha em `business_signals`
 * (idempotência), não cria N sinais. Se o cliente marca o retorno, o
 * detector para de publicar (a query já filtra "sem próximo appointment"),
 * e o sinal existente vira stale — a fatia futura Autopilot fecha o loop
 * (resolve/dispensa) quando marca appointment novo.
 *
 * POSTURA: OPT-IN + 0-REGRESSÃO. Flag `beauty_maintenance_detector_enabled`
 * default 0. Sem a flag, `sweep` retorna zero sem varrer. Serviços sem
 * `maintenance_days` são ignorados mesmo com flag ligada.
 *
 * §42/D6 — SEM TABELA paralela de alerta. O sinal vive em `business_signals`
 * com dedupe.
 *
 * §84 CANONICAL_LOOP — DETECTAR só. Não escreve `decision_actions`; não
 * marca appointment como "cliente inativo" nem move nada. A ação
 * (oferta de retorno) é fatia futura via `DecisionAction→ApprovalPolicy→
 * CommandExecutor` (`beauty_maintenance_offer` handler) freada pelos 3
 * gates da F5-transversal (consent + quiet-hours + freq-cap).
 *
 * GUARDRAILS RN-BS:
 *  - RN-BS-07 (cross-tenant): TODAS as queries filtram `organization_id`;
 *    appointments de orgB NUNCA viram sinais em orgA.
 *  - RN-BS-11 (nunca infere): só publica pra serviços com
 *    `maintenance_days > 0` DE FATO configurado; nunca "chuta" janela.
 *  - RN-BS-12 (autopilot conservador): só sinaliza, nunca envia.
 *  - RN-BS-04 (consent tipado): `evidence.contactName` só aparece se
 *    consent `comunicacoes` ativo — leitura live.
 *
 * PADRÃO CANÔNICO: espelha `AbandonedBeautySimulationDetector` (F11) —
 * `sweep(orgId, now?)` + `pass()` best-effort no Scheduler + shape de
 * retorno pra observability + `isEnabled`/`setEnabled` — mesma API,
 * mesmo estilo. Consistência é feature.
 */
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { LgpdService } from "./LgpdService.js";

const OUTBOUND_CONSENT_SCOPE = "comunicacoes";

export interface MaintenanceSweepResult {
  detected: number;
  deduped: number;
  publishedSignalIds: string[];
}

export class BeautyMaintenanceDetector {
  /**
   * Varre uma org. Publica sinais pras (contato, serviço) elegíveis.
   * Idempotente por dedupe. Determinístico dado o mesmo `now`.
   */
  static sweep(orgId: string, now: Date = new Date()): MaintenanceSweepResult {
    const empty: MaintenanceSweepResult = { detected: 0, deduped: 0, publishedSignalIds: [] };
    if (!this.isEnabled(orgId)) return empty;

    const nowIso = now.toISOString();

    // Estratégia: pega o ÚLTIMO appointment por (contato, serviço) usando
    // MAX(scheduled_start). Se ainda não existe appointment MAIS RECENTE
    // desse par, é o candidato. Se a janela do serviço já venceu contra
    // agora, publica.
    //
    // Filtros:
    // - só serviço com maintenance_days > 0
    // - só appointments com contact_id não-null
    // - só serviços da MESMA org (RN-BS-07)
    // - status do appointment não 'cancelled' nem 'no_show' (se cliente
    //   faltou, não é "está na hora de repetir" — é outra história)
    //
    // O SUBQUERY "não há outro appointment desse par mais recente"
    // garante que só o último appt por (contato,serviço) entra — evita
    // publicar N sinais pro mesmo par.
    let rows: any[] = [];
    try {
      rows = db
        .prepare(
          `SELECT a.id AS appt_id,
                  a.contact_id,
                  a.product_service_id,
                  a.scheduled_start,
                  ps.name AS service_name,
                  ps.maintenance_days,
                  ct.name AS contact_name
             FROM appointments a
             JOIN products_services ps ON ps.id = a.product_service_id AND ps.organization_id = a.organization_id
             LEFT JOIN contacts ct ON ct.id = a.contact_id AND ct.organization_id = a.organization_id
            WHERE a.organization_id = ?
              AND a.contact_id IS NOT NULL
              AND a.product_service_id IS NOT NULL
              AND (a.status IS NULL OR a.status NOT IN ('cancelled','no_show'))
              AND ps.maintenance_days IS NOT NULL AND ps.maintenance_days > 0
              AND a.scheduled_start IS NOT NULL
              AND a.scheduled_start < ?
              -- Só o mais recente por par (contato, serviço)
              AND NOT EXISTS (
                SELECT 1 FROM appointments a2
                 WHERE a2.organization_id = a.organization_id
                   AND a2.contact_id = a.contact_id
                   AND a2.product_service_id = a.product_service_id
                   AND a2.id <> a.id
                   AND (a2.status IS NULL OR a2.status NOT IN ('cancelled','no_show'))
                   AND a2.scheduled_start > a.scheduled_start
              )`,
        )
        .all(orgId, nowIso) as any[];
    } catch {
      return empty;
    }

    for (const r of rows) {
      const startMs = Date.parse(r.scheduled_start);
      if (!Number.isFinite(startMs)) continue;
      const daysSince = Math.floor((now.getTime() - startMs) / (24 * 3600 * 1000));
      const janela = Number(r.maintenance_days || 0);
      if (janela <= 0 || daysSince < janela) continue;

      const canName = LgpdService.hasConsent(orgId, r.contact_id, OUTBOUND_CONSENT_SCOPE);
      const contactName = canName ? r.contact_name : null;

      const dedupeKey = `beauty:maintenance_due:${r.contact_id}:${r.product_service_id}`;
      let res: { id: string; deduped: boolean };
      try {
        res = BusinessSignalService.publish(orgId, {
          domain: "beauty",
          signalType: "maintenance_due",
          severity: "attention",
          basis: "fact",
          confidence: 1,
          sourceService: "BeautyMaintenanceDetector",
          sourceEntityType: "appointment",
          sourceEntityId: r.appt_id,
          subjectType: "contact",
          subjectId: r.contact_id,
          evidence: {
            contactId: r.contact_id,
            contactName,
            productServiceId: r.product_service_id,
            serviceName: r.service_name,
            maintenanceDays: janela,
            lastAppointmentAt: r.scheduled_start,
            daysSinceLast: daysSince,
          },
          dedupeKey,
        });
      } catch {
        continue;
      }
      if (res.deduped) empty.deduped++;
      else empty.detected++;
      empty.publishedSignalIds.push(res.id);
    }

    return empty;
  }

  /**
   * Varre TODAS as orgs com flag habilitada. Chamado do Scheduler.tick.
   * Best-effort per-org.
   */
  static pass(now: Date = new Date()): void {
    let orgs: { organization_id: string }[] = [];
    try {
      orgs = db
        .prepare(
          `SELECT organization_id FROM organization_settings WHERE beauty_maintenance_detector_enabled = 1`,
        )
        .all() as any[];
    } catch {
      return;
    }
    for (const o of orgs) {
      try {
        this.sweep(o.organization_id, now);
      } catch (e) {
        console.error("[BeautyMaintenanceDetector] sweep falhou", o.organization_id, e);
      }
    }
  }

  static isEnabled(orgId: string): boolean {
    try {
      const r = db
        .prepare(
          `SELECT beauty_maintenance_detector_enabled FROM organization_settings WHERE organization_id = ?`,
        )
        .get(orgId) as { beauty_maintenance_detector_enabled?: number } | undefined;
      return Number(r?.beauty_maintenance_detector_enabled || 0) === 1;
    } catch {
      return false;
    }
  }

  static setEnabled(orgId: string, enabled: boolean): void {
    db.prepare(
      `UPDATE organization_settings SET beauty_maintenance_detector_enabled = ? WHERE organization_id = ?`,
    ).run(enabled ? 1 : 0, orgId);
  }
}

export default BeautyMaintenanceDetector;
