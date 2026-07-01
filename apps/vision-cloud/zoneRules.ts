// Motor de regras de zona — a camada DETERMINÍSTICA de "vídeo analytics"
// (PRD §19.1: vision_zones/vision_rules). Recebe uma OBSERVAÇÃO (quantas
// pessoas tem numa zona agora — um fato simples, que hoje é alimentado à mão
// via routes/zones.ts, e no futuro virá do detector local de verdade rodando
// no Vision Edge Gateway) e decide, com regra simples e auditável (não IA),
// se isso deve virar um `vision_event`. Dali em diante é o pipeline que já
// existe: Event Inbox, ponte com Tarefas (Maestro), notificação e webhook —
// nenhum desses precisou mudar uma linha pra reagir a esses eventos novos.
import db from "./db.js";
import { createEventIfNotOpen } from "./events.js";

export type RuleType = "dwell_time" | "occupancy_count" | "after_hours_presence";
export const RULE_TYPES: readonly RuleType[] = ["dwell_time", "occupancy_count", "after_hours_presence"] as const;
export function isValidRuleType(t: string): t is RuleType {
  return (RULE_TYPES as readonly string[]).includes(t);
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function isValidHHMM(v: string): boolean {
  return HHMM.test(v);
}

/** true se `now` está DENTRO da janela [start, end) — trata janela que cruza meia-noite. */
function isWithinWindow(start: string, end: string, now: Date): boolean {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

// Guarda com precisão de MILISSEGUNDO (ISO 8601 completo, não truncado pro
// segundo como o resto do projeto usa) — session_started_at é a chave de
// idempotência de disparo de regra (ver evaluateRules), então precisa ser
// única o bastante pra nunca colidir entre uma sessão que fechou e outra que
// abriu logo em seguida (round-trips de HTTP em localhost facilmente caem no
// mesmo segundo).
function toSessionTimestamp(d: Date): string {
  return d.toISOString();
}
function fromSessionTimestamp(s: string): Date {
  return new Date(s);
}

/**
 * Registra o que foi observado numa zona (contagem de pessoas AGORA) e avalia
 * as regras ativas dessa zona. `observedAt` é opcional (default: agora) —
 * existe pra permitir teste determinístico sem depender do relógio de verdade.
 */
export function recordObservation(organizationId: string, zoneId: string, personCount: number, observedAt?: Date): void {
  const now = observedAt || new Date();
  const nowTs = toSessionTimestamp(now);

  const occ = db.prepare(`SELECT * FROM vision_zone_occupancy WHERE zone_id = ?`).get(zoneId) as any;
  const wasEmpty = !occ || !occ.session_started_at;

  if (personCount <= 0) {
    // Zona esvaziou (ou já estava vazia): encerra a sessão. A próxima
    // observação com pessoa > 0 começa uma sessão NOVA (libera as regras pra
    // disparar de novo, ver checagem de idempotência em evaluateRules).
    db.prepare(`
      INSERT INTO vision_zone_occupancy (zone_id, current_count, session_started_at, last_observed_at, updated_at)
      VALUES (?, 0, NULL, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(zone_id) DO UPDATE SET current_count = 0, session_started_at = NULL, last_observed_at = excluded.last_observed_at, updated_at = CURRENT_TIMESTAMP
    `).run(zoneId, nowTs);
    return;
  }

  const sessionStartedAt = wasEmpty ? nowTs : occ.session_started_at;
  db.prepare(`
    INSERT INTO vision_zone_occupancy (zone_id, current_count, session_started_at, last_observed_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(zone_id) DO UPDATE SET current_count = excluded.current_count, session_started_at = excluded.session_started_at, last_observed_at = excluded.last_observed_at, updated_at = CURRENT_TIMESTAMP
  `).run(zoneId, personCount, sessionStartedAt, nowTs);

  evaluateRules(organizationId, zoneId, personCount, sessionStartedAt, now);
}

function evaluateRules(organizationId: string, zoneId: string, personCount: number, sessionStartedAt: string, now: Date) {
  const rules = db.prepare(`SELECT * FROM vision_rules WHERE zone_id = ? AND is_active = 1`).all(zoneId) as any[];

  for (const rule of rules) {
    // Idempotência: já disparamos esta regra NESTA sessão de ocupação? Só
    // dispara de novo numa sessão nova (zona esvaziou e encheu de novo) —
    // sem isso, toda observação repetida (a cada poucos segundos) recriaria
    // o mesmo evento sem parar.
    if (rule.last_triggered_session_at === sessionStartedAt) continue;

    let triggered = false;
    let detail = "";
    if (rule.rule_type === "occupancy_count") {
      const threshold = Number(rule.threshold_value);
      triggered = Number.isFinite(threshold) && personCount >= threshold;
      detail = `ocupação atual: ${personCount} pessoa(s) (limite configurado: ${threshold})`;
    } else if (rule.rule_type === "dwell_time") {
      const threshold = Number(rule.threshold_value);
      const minutesPresent = (now.getTime() - fromSessionTimestamp(sessionStartedAt).getTime()) / 60000;
      triggered = Number.isFinite(threshold) && minutesPresent >= threshold;
      detail = `presença contínua: ${minutesPresent.toFixed(2)} min (limite configurado: ${threshold} min)`;
    } else if (rule.rule_type === "after_hours_presence") {
      const withinConfiguredHours = rule.active_hours_start && rule.active_hours_end
        ? isWithinWindow(rule.active_hours_start, rule.active_hours_end, now)
        : true; // sem janela configurada -> nunca "fora do horário"
      triggered = !withinConfiguredHours;
      detail = `presença fora da janela configurada (${rule.active_hours_start}-${rule.active_hours_end})`;
    }

    if (!triggered) continue;

    db.prepare(`UPDATE vision_rules SET last_triggered_session_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(sessionStartedAt, rule.id);

    const zone = db.prepare(`SELECT site_id FROM vision_zones WHERE id = ?`).get(zoneId) as any;
    createEventIfNotOpen({
      organizationId,
      siteId: zone?.site_id || null,
      eventType: `zone_${rule.rule_type}`,
      severity: rule.severity,
      payload: { zone_id: zoneId, rule_id: rule.id, detail, person_count: personCount },
    });
  }
}
