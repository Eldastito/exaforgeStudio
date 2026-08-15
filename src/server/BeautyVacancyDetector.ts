/**
 * BeautyVacancyDetector (ADR-169 F14 / BEAUTY-015) — publica na ESPINHA
 * CANÔNICA (`business_signals`) o sinal "horário ocioso + cliente elegível"
 * (`beauty:vacancy_opportunity:{professionalId}:{slotStartISO}`). Terceiro
 * tijolo do Beauty Autopilot em SHADOW (após F11 abandoned_simulation e
 * F12 maintenance_due).
 *
 * O QUE DETECTA: pra cada profissional ATIVO da org, varre a agenda dos
 * próximos DEFAULT_LOOKAHEAD_DAYS dias, dividindo em slots de
 * `AgendaConfig.slotMin` dentro do horário de funcionamento (openHour ~
 * closeHour). Um slot é "ocioso" quando NÃO há appointment do profissional
 * sobrepondo E há PELO MENOS UM cliente elegível — atendido pelo mesmo pro
 * em <= LOOKBACK_ELIGIBILITY_DAYS (default 90d), COM consent hair_simulation
 * ATIVO, SEM appointment futuro nenhum (não vamos incomodar quem já tem
 * horário).
 *
 * Composição pura sobre peças canônicas:
 *  - `AppointmentService.config` → openHour/closeHour/slotMin
 *  - Query sobre `appointments` pra detectar conflito
 *  - Query sobre `appointments` + `contact_consents` pra elegibilidade
 *  - `BusinessSignalService.publish` (dedupe canônico)
 *
 * DEDUPE `beauty:vacancy_opportunity:{professionalId}:{slotStartISO}` —
 * republicar o mesmo par ATUALIZA a linha; não cria N sinais pro mesmo
 * slot. Se o cliente marca outro serviço com esse pro nesse slot, o próximo
 * sweep não publica mais (query filtra "sem conflito").
 *
 * POSTURA: OPT-IN + 0-REGRESSÃO. Flag `beauty_vacancy_detector_enabled`
 * default 0. Sem flag → sweep retorna 0 sem varrer. Também: sem profissional
 * cadastrado → nada; sem cliente elegível → nada (não publica "vaga que
 * ninguém pode ocupar" — RN-BS-11).
 *
 * §42/D6 — sem TABELA paralela. Vive em `business_signals`.
 * §84 CANONICAL_LOOP DETECTAR — só publica; não escreve `decision_actions`;
 * não muda status de appointment. A ação (`beauty_vacancy_offer` handler)
 * é fatia futura, passará pelos 3 gates F5-transversal.
 *
 * GUARDRAILS RN-BS:
 *  - RN-BS-07 (cross-tenant): TODAS as queries filtram `organization_id`;
 *    profissionais/appointments/contatos de orgB NUNCA viram sinais em orgA.
 *  - RN-BS-11 (nunca infere): só publica quando há candidato ELEGÍVEL DE
 *    FATO (não fabrica oportunidade sem público).
 *  - RN-BS-12 (autopilot conservador): só sinaliza; ação é fatia futura em
 *    SHADOW freada pelos guards F5-transversal.
 *  - RN-BS-04 (consent tipado): elegibilidade EXIGE `hair_simulation` ativo —
 *    consent revogado remove o contato do funil.
 *
 * LIMITES intencionais desta fatia:
 *  - Considera slots contíguos de `slotMin` (1 slot por vez). Não junta 2
 *    slots pra ofertar serviço mais longo — o handler futuro pode.
 *  - Não filtra por sala. F14 opera por profissional; sala é constraint
 *    adicional do handler no F14-B.
 *  - Não considera férias/ausências do pro (`clinic_professional_absences`)
 *    diretamente — o `ClinicAgendaService.findConflicts` faz isso, mas o
 *    detector aqui usa consulta direta simplificada. F14-B pode refinar
 *    reusando a mesma peça.
 */
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { AppointmentService } from "./AppointmentService.js";

// Padrões razoáveis; podem virar colunas configuráveis em fatia futura.
export const DEFAULT_LOOKAHEAD_DAYS = 3;
export const LOOKBACK_ELIGIBILITY_DAYS = 90;
export const MAX_SLOTS_PER_PROFESSIONAL = 6; // não polui sinal com dezenas de vagas
const HAIR_SIM_CONSENT_SCOPE = "hair_simulation";

const TZ_OFFSET_MIN = -180; // -03:00 SP (sem DST desde 2019 — mesma constante do AppointmentService)

export interface VacancySweepResult {
  detected: number;
  deduped: number;
  publishedSignalIds: string[];
}

function brParts(ms: number) {
  const d = new Date(ms + TZ_OFFSET_MIN * 60000);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth(),
    da: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    dow: d.getUTCDay() === 0 ? 7 : d.getUTCDay(),
  };
}

function brToMs(y: number, mo: number, da: number, h: number, mi: number): number {
  return Date.UTC(y, mo, da, h, mi) - TZ_OFFSET_MIN * 60000;
}

export class BeautyVacancyDetector {
  /**
   * Varre uma org. Retorna resumo pra observability. Idempotente por dedupe.
   */
  static sweep(orgId: string, now: Date = new Date()): VacancySweepResult {
    const empty: VacancySweepResult = { detected: 0, deduped: 0, publishedSignalIds: [] };
    if (!this.isEnabled(orgId)) return empty;

    const cfg = AppointmentService.config(orgId);
    if (!(cfg.slotMin > 0) || !(cfg.closeHour > cfg.openHour)) return empty;

    let pros: any[] = [];
    try {
      pros = db
        .prepare(
          `SELECT id, name FROM clinic_professionals WHERE organization_id = ? AND active = 1`,
        )
        .all(orgId) as any[];
    } catch { return empty; }
    if (pros.length === 0) return empty;

    const slotMs = cfg.slotMin * 60000;
    const startMs = now.getTime();
    const endMs = startMs + DEFAULT_LOOKAHEAD_DAYS * 24 * 3600 * 1000;

    for (const pro of pros) {
      let publishedForPro = 0;
      // Anda no grid de slots dentro da janela.
      let cur = startMs;
      // Alinha o cursor ao próximo múltiplo de slotMs.
      cur = Math.ceil(cur / slotMs) * slotMs;

      while (cur + slotMs <= endMs && publishedForPro < MAX_SLOTS_PER_PROFESSIONAL) {
        const slotStart = cur;
        const slotEnd = slotStart + slotMs;
        cur += slotMs;

        // Slot está dentro do horário de funcionamento e dia de trabalho?
        const p = brParts(slotStart);
        if (!cfg.days.includes(p.dow)) continue;
        const slotStartMin = p.h * 60 + p.mi;
        const openMin = cfg.openHour * 60;
        const closeMin = cfg.closeHour * 60;
        if (slotStartMin < openMin || slotStartMin + cfg.slotMin > closeMin) continue;

        // Conflito com appointment do mesmo pro?
        const conflict = db
          .prepare(
            `SELECT id FROM appointments
              WHERE organization_id = ?
                AND professional_id = ?
                AND (status IS NULL OR status NOT IN ('cancelled','no_show'))
                AND scheduled_start < ? AND scheduled_end > ?
              LIMIT 1`,
          )
          .get(orgId, pro.id, new Date(slotEnd).toISOString(), new Date(slotStart).toISOString());
        if (conflict) continue;

        // Elegibilidade: existe ≥1 contato que atendeu com este pro em
        // <=90d, com consent hair_simulation ativo, SEM appt futuro?
        const eligibleCount = this.countEligibleContacts(orgId, pro.id, now);
        if (eligibleCount === 0) continue;

        const slotStartISO = new Date(slotStart).toISOString();
        const slotEndISO = new Date(slotEnd).toISOString();
        const dedupeKey = `beauty:vacancy_opportunity:${pro.id}:${slotStartISO}`;
        let res: { id: string; deduped: boolean };
        try {
          res = BusinessSignalService.publish(orgId, {
            domain: "beauty",
            signalType: "vacancy_opportunity",
            severity: "info",
            basis: "fact",
            confidence: 1,
            sourceService: "BeautyVacancyDetector",
            sourceEntityType: "clinic_professional",
            sourceEntityId: pro.id,
            subjectType: "professional",
            subjectId: pro.id,
            evidence: {
              professionalId: pro.id,
              professionalName: pro.name,
              slotStartISO,
              slotEndISO,
              durationMin: cfg.slotMin,
              eligibleContactsCount: eligibleCount,
            },
            dedupeKey,
          });
        } catch { continue; }
        if (res.deduped) empty.deduped++;
        else empty.detected++;
        empty.publishedSignalIds.push(res.id);
        publishedForPro++;
      }
    }

    return empty;
  }

  static pass(now: Date = new Date()): void {
    let orgs: { organization_id: string }[] = [];
    try {
      orgs = db
        .prepare(
          `SELECT organization_id FROM organization_settings WHERE beauty_vacancy_detector_enabled = 1`,
        )
        .all() as any[];
    } catch { return; }
    for (const o of orgs) {
      try {
        this.sweep(o.organization_id, now);
      } catch (e) {
        console.error("[BeautyVacancyDetector] sweep falhou", o.organization_id, e);
      }
    }
  }

  /**
   * Conta contatos elegíveis pra este pro nesta org. Elegível =
   *   - teve pelo menos 1 appointment com este pro nos últimos 90d
   *     (não cancelled/no_show; scheduled_start passado)
   *   - tem consent hair_simulation ativo
   *   - NÃO tem appointment futuro (nenhum, com qualquer pro/serviço)
   *
   * Retorna count (útil pra observability); publicar exige count >= 1.
   */
  static countEligibleContacts(orgId: string, professionalId: string, now: Date = new Date()): number {
    try {
      const lookbackStart = new Date(
        now.getTime() - LOOKBACK_ELIGIBILITY_DAYS * 24 * 3600 * 1000,
      ).toISOString();
      const nowIso = now.toISOString();
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT c.id) n
             FROM contacts c
             JOIN appointments a
               ON a.contact_id = c.id
              AND a.organization_id = c.organization_id
              AND a.professional_id = ?
              AND (a.status IS NULL OR a.status NOT IN ('cancelled','no_show'))
              AND a.scheduled_start >= ?
              AND a.scheduled_start < ?
             JOIN contact_consents cc
               ON cc.contact_id = c.id
              AND cc.organization_id = c.organization_id
              AND cc.consent_type = ?
              AND cc.granted = 1
            WHERE c.organization_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM appointments af
                 WHERE af.organization_id = c.organization_id
                   AND af.contact_id = c.id
                   AND (af.status IS NULL OR af.status NOT IN ('cancelled','no_show'))
                   AND af.scheduled_start >= ?
              )`,
        )
        .get(professionalId, lookbackStart, nowIso, HAIR_SIM_CONSENT_SCOPE, orgId, nowIso) as any;
      return Number(row?.n || 0);
    } catch { return 0; }
  }

  static isEnabled(orgId: string): boolean {
    try {
      const r = db
        .prepare(
          `SELECT beauty_vacancy_detector_enabled FROM organization_settings WHERE organization_id = ?`,
        )
        .get(orgId) as { beauty_vacancy_detector_enabled?: number } | undefined;
      return Number(r?.beauty_vacancy_detector_enabled || 0) === 1;
    } catch { return false; }
  }

  static setEnabled(orgId: string, enabled: boolean): void {
    db.prepare(
      `UPDATE organization_settings SET beauty_vacancy_detector_enabled = ? WHERE organization_id = ?`,
    ).run(enabled ? 1 : 0, orgId);
  }
}

// Suprimir warning de unused (importante manter helpers exportáveis se F14-B refinar):
void brToMs;

export default BeautyVacancyDetector;
