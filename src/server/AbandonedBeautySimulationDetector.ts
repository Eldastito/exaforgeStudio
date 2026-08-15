/**
 * AbandonedBeautySimulationDetector (ADR-169 F11 / BEAUTY-012) — publica na
 * ESPINHA CANÔNICA (`business_signals`) o sinal "cliente fez simulação mas
 * não avançou". Primeiro tijolo do Beauty Autopilot (RN-BS-12 em SHADOW).
 *
 * O QUE DETECTA: consulta em `beauty_visual_consultations.status='ready'` que
 * tem PELO MENOS UMA simulação SUCCEEDED, mas cujo `selected_at` continua
 * NULL há MAIS de X horas (default 24h). A cliente carregou foto, gerou o
 * visual, viu — mas não clicou "quero esse" nem agendou. Essa lacuna é a
 * oportunidade que a F11+ transforma em follow-up governado (fatia futura
 * "Beauty Autopilot", via DecisionAction→ApprovalPolicy — nunca envia direto).
 *
 * DEDUPE `beauty:abandoned_simulation:{consultationId}` — republicar o mesmo
 * sinal ATUALIZA a linha (idempotência do `BusinessSignalService`); não
 * cria N sinais pra mesma consulta.
 *
 * POSTURA: OPT-IN + 0-REGRESSÃO. Flag `beauty_abandoned_detector_enabled`
 * default 0. Sem a flag, `sweep` retorna 0 sem varrer. `beauty_abandoned_after_hours`
 * customiza a janela (NULL = default 24h).
 *
 * §42/D6 — sem TABELA paralela de alerta. O sinal vive em `business_signals`
 * com dedupe; o "Atenção" (`attention()`) já sabe ler dali.
 *
 * §84 CANONICAL_LOOP — DETECTAR só. Não escreve `decision_actions` (isso é
 * a fatia futura do autopilot em SHADOW, via `DecisionActionService.propose`
 * com `wouldExecute:false` — mesma postura do `GrowthAutopilotService`).
 *
 * GUARDRAILS RN-BS:
 *  - RN-BS-07 (cross-tenant): TODAS as queries filtram `organization_id`;
 *    detector de orgB NUNCA vê consultas da orgA.
 *  - RN-BS-11 (nunca infere): só detecta se consulta REALMENTE tem sim
 *    SUCCEEDED (não "quase-succeeded" nem PROCESSING). Sem consent
 *    `hair_simulation` da paciente na hora de detectar → NÃO publica
 *    (leitura live — se o consent já foi revogado, não vazamos oportunidade
 *    obsoleta).
 *  - RN-BS-12 (autopilot não vai direto pra GA): esta fatia NÃO envia
 *    mensagem — só sinaliza. A ação (follow-up via WhatsApp) é a fatia F11-B
 *    (Autopilot em SHADOW) que passará pelos 3 gates da F5-transversal
 *    (consent LGPD + quiet-hours + frequency-cap) antes de virar propose.
 *  - RN-BS-04 (consent tipado): sinal NÃO carrega foto/base64 — só ids +
 *    contactName (se consent `comunicacoes` estiver ativo).
 *
 * READ-ONLY MODULO O SINAL: detector não muda status da consulta, não
 * marca "abandonada" — a consulta continua `ready`. Se a cliente voltar
 * e selecionar, o sinal é auto-resolvido pela fatia futura (Autopilot
 * fecha o loop) ou fica `open` até TTL/dispensa manual.
 */
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { LgpdService } from "./LgpdService.js";

export const ABANDONED_DEFAULT_AFTER_HOURS = 24;
const OUTBOUND_CONSENT_SCOPE = "comunicacoes";
const HAIR_SIM_CONSENT_SCOPE = "hair_simulation";

export interface AbandonedSweepResult {
  detected: number;
  deduped: number;
  skipped_consent_revoked: number;
  publishedSignalIds: string[];
}

export class AbandonedBeautySimulationDetector {
  /**
   * Varre uma org. Publica sinais pras consultas elegíveis. Retorna resumo
   * pra observability. Idempotente (publish é dedupe).
   */
  static sweep(orgId: string, now: Date = new Date()): AbandonedSweepResult {
    const empty: AbandonedSweepResult = {
      detected: 0,
      deduped: 0,
      skipped_consent_revoked: 0,
      publishedSignalIds: [],
    };
    if (!this.isEnabled(orgId)) return empty;

    const hours = this.effectiveAfterHours(orgId);
    const cutoffMs = now.getTime() - hours * 3600 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    // Consultas 'ready' criadas há mais de X horas, contato-válido,
    // com >=1 simulação SUCCEEDED. Query única.
    let rows: any[] = [];
    try {
      rows = db
        .prepare(
          `SELECT c.id AS consultation_id, c.contact_id, c.created_at, c.goal,
                  ct.name AS contact_name,
                  (SELECT s.id FROM beauty_visual_simulations s
                     WHERE s.organization_id = c.organization_id
                       AND s.consultation_id = c.id
                       AND s.status = 'SUCCEEDED'
                     ORDER BY s.completed_at DESC, s.rowid DESC LIMIT 1) AS latest_sim_id
             FROM beauty_visual_consultations c
             LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.organization_id = c.organization_id
            WHERE c.organization_id = ?
              AND c.status = 'ready'
              AND c.selected_at IS NULL
              AND c.created_at <= ?
              AND c.contact_id IS NOT NULL`,
        )
        .all(orgId, cutoffIso) as any[];
    } catch {
      return empty;
    }

    // Filtra: só linhas COM sim SUCCEEDED (sub-query pode dar null).
    const eligible = rows.filter((r) => r.latest_sim_id != null);

    for (const r of eligible) {
      // RN-BS-11 (leitura live): se consent `hair_simulation` foi revogado,
      // não vazamos oportunidade — a paciente pode ter pedido pra apagar
      // tudo. Só publicamos se o consent-chave da vertical continua ativo.
      if (!LgpdService.hasConsent(orgId, r.contact_id, HAIR_SIM_CONSENT_SCOPE)) {
        empty.skipped_consent_revoked++;
        continue;
      }
      // Consent `comunicacoes` decide se COLOCAMOS o nome no evidence.
      const canName = LgpdService.hasConsent(orgId, r.contact_id, OUTBOUND_CONSENT_SCOPE);
      const contactName = canName ? r.contact_name : null;

      const dedupeKey = `beauty:abandoned_simulation:${r.consultation_id}`;
      let res: { id: string; deduped: boolean };
      try {
        res = BusinessSignalService.publish(orgId, {
          domain: "beauty",
          signalType: "abandoned_simulation",
          severity: "attention",
          basis: "fact",
          confidence: 1,
          sourceService: "AbandonedBeautySimulationDetector",
          sourceEntityType: "beauty_visual_consultation",
          sourceEntityId: r.consultation_id,
          subjectType: "contact",
          subjectId: r.contact_id,
          evidence: {
            consultationId: r.consultation_id,
            contactId: r.contact_id,
            contactName,
            simulationId: r.latest_sim_id,
            goal: r.goal || null,
            createdAt: r.created_at,
            hoursSinceCreation: Math.round((now.getTime() - Date.parse(r.created_at)) / 3600000),
          },
          dedupeKey,
        });
      } catch {
        continue;
      }
      if (res.deduped) {
        empty.deduped++;
      } else {
        empty.detected++;
      }
      empty.publishedSignalIds.push(res.id);
    }

    return empty;
  }

  /**
   * Varre TODAS as orgs com flag habilitada. Chamado do Scheduler.tick.
   * Best-effort per-org (uma falha não interrompe as demais).
   */
  static pass(now: Date = new Date()): void {
    let orgs: { organization_id: string }[] = [];
    try {
      orgs = db
        .prepare(
          `SELECT organization_id FROM organization_settings WHERE beauty_abandoned_detector_enabled = 1`,
        )
        .all() as any[];
    } catch {
      return;
    }
    for (const o of orgs) {
      try {
        this.sweep(o.organization_id, now);
      } catch (e) {
        console.error("[AbandonedBeautySimulationDetector] sweep falhou", o.organization_id, e);
      }
    }
  }

  static isEnabled(orgId: string): boolean {
    try {
      const r = db
        .prepare(
          `SELECT beauty_abandoned_detector_enabled FROM organization_settings WHERE organization_id = ?`,
        )
        .get(orgId) as { beauty_abandoned_detector_enabled?: number } | undefined;
      return Number(r?.beauty_abandoned_detector_enabled || 0) === 1;
    } catch {
      return false;
    }
  }

  static setEnabled(orgId: string, enabled: boolean): void {
    db.prepare(
      `UPDATE organization_settings SET beauty_abandoned_detector_enabled = ? WHERE organization_id = ?`,
    ).run(enabled ? 1 : 0, orgId);
  }

  static effectiveAfterHours(orgId: string): number {
    try {
      const r = db
        .prepare(
          `SELECT beauty_abandoned_after_hours h FROM organization_settings WHERE organization_id = ?`,
        )
        .get(orgId) as { h?: number | null } | undefined;
      if (r?.h != null) return Math.max(1, Math.trunc(Number(r.h)));
      return ABANDONED_DEFAULT_AFTER_HOURS;
    } catch {
      return ABANDONED_DEFAULT_AFTER_HOURS;
    }
  }

  static setAfterHours(orgId: string, hours: number | null): void {
    if (hours != null) {
      const h = Math.trunc(Number(hours));
      if (!Number.isInteger(h) || h < 1) throw new Error("hours deve ser inteiro ≥ 1 ou null.");
    }
    db.prepare(
      `UPDATE organization_settings SET beauty_abandoned_after_hours = ? WHERE organization_id = ?`,
    ).run(hours, orgId);
  }
}

export default AbandonedBeautySimulationDetector;
