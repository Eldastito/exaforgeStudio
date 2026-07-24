import db from "./db.js";
import { PatternMemoryService, PatternCandidate, Hypothesizer } from "./PatternMemoryService.js";

/**
 * AgendaPatternMemory — o domínio de AGENDA/SERVIÇOS aprende sobre o motor genérico
 * (PatternMemoryService). Detectores determinísticos sobre appointments:
 *   - cliente_no_show_recorrente: cliente que falta (status='no_show') com frequência;
 *   - horario_no_show_recorrente: faixa de dia/hora com muito no-show (encaixe ruim).
 *
 * Validados, viram sinais 'agenda' que fluem para o Pareto, o briefing, o Diretor
 * e a tela de Insights. Ajudam a reduzir buraco de agenda (confirmar presença,
 * exigir sinal, rever lembrete no horário problemático).
 */

const MIN_EVIDENCE = 3;
const DOMAIN = "agenda";
const HANDLED_TYPES = ["cliente_no_show_recorrente", "horario_no_show_recorrente"];
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));
const DOW = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

function daysBefore(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export class AgendaPatternMemory {
  /** Cliente com no-show recorrente. */
  static detectCustomerNoShow(orgId: string, from: string, asOf: string): PatternCandidate[] {
    const rows = db.prepare(
      `SELECT contact_id,
              SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS noshows,
              COUNT(*) AS total
         FROM appointments
        WHERE organization_id = ? AND contact_id IS NOT NULL AND scheduled_start IS NOT NULL
          AND date(scheduled_start) BETWEEN ? AND ?
        GROUP BY contact_id`
    ).all(orgId, from, asOf) as any[];
    const out: PatternCandidate[] = [];
    for (const r of rows) {
      const noshows = Number(r.noshows) || 0;
      const total = Number(r.total) || 0;
      if (noshows < MIN_EVIDENCE) continue;
      const name = (db.prepare("SELECT name FROM contacts WHERE id = ? AND organization_id = ?").get(r.contact_id, orgId) as any)?.name || "cliente";
      out.push({
        scopeId: String(r.contact_id), scopeName: name,
        patternType: "cliente_no_show_recorrente", patternKey: "no_show",
        evidenceCount: noshows, confidence: clamp01(noshows / Math.max(1, total)),
        impactAmount: noshows, impactUnit: "no_shows",
        evidence: { customer: name, noshows, total, from, to: asOf },
        fallbackDescription: `Cliente ${name} falta com frequência: ${noshows} de ${total} agendamentos como no-show na janela — confirmar presença/pedir sinal antecipado.`,
      });
    }
    return out;
  }

  /** Faixa de dia/hora com no-show recorrente. */
  static detectTimeSlotNoShow(orgId: string, from: string, asOf: string): PatternCandidate[] {
    const rows = db.prepare(
      `SELECT strftime('%w', scheduled_start) AS dow, strftime('%H', scheduled_start) AS hh,
              SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS noshows,
              COUNT(*) AS total
         FROM appointments
        WHERE organization_id = ? AND scheduled_start IS NOT NULL
          AND date(scheduled_start) BETWEEN ? AND ?
        GROUP BY dow, hh`
    ).all(orgId, from, asOf) as any[];
    const out: PatternCandidate[] = [];
    for (const r of rows) {
      const noshows = Number(r.noshows) || 0;
      const total = Number(r.total) || 0;
      if (noshows < MIN_EVIDENCE) continue;
      const dow = DOW[Number(r.dow)] || `dia ${r.dow}`;
      const label = `${dow} ${r.hh}h`;
      out.push({
        scopeId: `${r.dow}-${r.hh}`, scopeName: label,
        patternType: "horario_no_show_recorrente", patternKey: "slot",
        evidenceCount: noshows, confidence: clamp01(noshows / Math.max(1, total)),
        impactAmount: noshows, impactUnit: "no_shows",
        evidence: { slot: label, noshows, total, from, to: asOf },
        fallbackDescription: `Horário com no-show recorrente: ${label} teve ${noshows} de ${total} agendamentos como falta na janela — reforçar lembrete ou rever o encaixe nesse horário.`,
      });
    }
    return out;
  }

  /** Um passe de aprendizado do domínio de agenda (opt-in via PatternMemoryService). */
  static async learnPass(orgId: string, opts: { asOf?: string; windowWeeks?: number; hypothesizer?: Hypothesizer | null } = {}): Promise<{ enabled: boolean; detected: number; validated: number; decayed: number; published: number; resolved: number }> {
    if (!PatternMemoryService.isEnabled(orgId)) return { enabled: false, detected: 0, validated: 0, decayed: 0, published: 0, resolved: 0 };
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf || "") ? opts.asOf! : new Date().toISOString().slice(0, 10);
    const from = daysBefore(asOf, (opts.windowWeeks || 12) * 7);
    const candidates = [
      ...this.detectCustomerNoShow(orgId, from, asOf),
      ...this.detectTimeSlotNoShow(orgId, from, asOf),
    ];
    const res = await PatternMemoryService.learn(orgId, DOMAIN, candidates, {
      asOf, handledTypes: HANDLED_TYPES, sourceService: "AgendaPatternMemory", hypothesizer: opts.hypothesizer,
    });
    return { enabled: true, ...res };
  }
}

export default AgendaPatternMemory;
