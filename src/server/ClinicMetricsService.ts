/**
 * Módulo Clínica — Dashboard/insights (ADR-080 Fase O).
 *
 * Métricas agregadas em cima do que as Fatias G–N já produzem: consultas,
 * lembretes, confirmações, cancelamentos, docs emitidos e retornos. Sem
 * tabela nova — só GROUP BY. Determinístico, isolado por organization_id.
 *
 * O `from`/`to` são ISO (YYYY-MM-DD ou completo). Default: últimos 30 dias.
 * Todas as taxas são "% no denominador correto" — no-show sobre passados,
 * confirmação sobre lembretes enviados, etc — evita falsear números.
 */
import db from "./db.js";

export interface MetricsOverview {
  window: { from: string; to: string; days: number };
  appointments: {
    total: number;
    byStatus: Record<string, number>;
    // do período que já passou:
    past: number;
    noShowRate: number;         // no-show / past (%)
    completedRate: number;      // completed / past (%)
    patientConfirmedRate: number; // com patient_confirmed_at / total agendados (%)
  };
  reminders: {
    sent: number;
    failed: number;
    replied: number;            // que geraram confirm ou cancel via reply
    confirmationRate: number;   // SIM / lembretes sent (%)
    cancellationRate: number;   // NÃO / lembretes sent (%)
  };
  /** Automações do WhatsApp (Fases P, Q) — visibilidade das ofertas ativas
   *  e do funil de aceite/recusa. Sem isto, o gestor não vê o que o sistema
   *  fez sozinho e desconfia. */
  automations: {
    reschedule: {
      offered: number;          // criadas no período
      chosen: number;           // paciente escolheu 1/2/3
      abandoned: number;        // paciente respondeu X ou nova REMARCAR
      expired: number;
    };
    vacancy: {
      offered: number;
      accepted: number;         // paciente da fila aceitou a vaga aberta
      declined: number;
      expired: number;
      recoveredMinutes: number; // duração total das vagas aceitas — "receita salva"
    };
  };
  cancellations: {
    total: number;
    byOrigin: { patient: number; staff: number; system: number };
    patientShare: number;       // patient / total cancelamentos (%)
  };
  documents: {
    prescriptionsIssued: number;
    certificatesIssued: number;
    receiptsIssued: number;
    receiptsTotalCents: number;  // soma do amount_cents dos receipts issued na janela
    sentByChannel: number;      // deliveries com status='sent'
  };
  followUps: {
    recommended: number;        // encounters signed com follow_up_recommended_days > 0
    scheduled: number;          // recomendações que viraram appointment (parent_appointment_id)
    pending: number;            // recomendados sem retorno agendado (fila)
  };
  professionals: {
    id: string;
    name: string;
    appointments: number;
    completed: number;
    cancelled: number;
    occupationMinutes: number;  // soma expected_duration ou slot padrão
  }[];
}

function isoOrDefault(v: string | undefined, fallbackMs: number): string {
  if (v && /^\d{4}-\d{2}-\d{2}/.test(v)) return v;
  return new Date(fallbackMs).toISOString();
}

function pct(num: number, den: number): number {
  if (!den) return 0;
  return Math.round((num / den) * 10000) / 100; // 2 casas
}

export class ClinicMetricsService {
  static overview(orgId: string, opts: { from?: string; to?: string } = {}): MetricsOverview {
    const nowMs = Date.now();
    // Default cobre passado E futuro próximo: dashboard clínico precisa
    // mostrar taxa de confirmação/cancelamento de consultas AGENDADAS (que
    // ainda vão ocorrer) além de no-show/completed do passado.
    const from = isoOrDefault(opts.from, nowMs - 30 * 86400_000);
    const to = isoOrDefault(opts.to, nowMs + 30 * 86400_000);
    const days = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400_000));
    const nowISO = new Date(nowMs).toISOString();

    // ── Appointments no período ──────────────────────────────────────────
    const apptRows = db.prepare(
      `SELECT status, COUNT(*) AS c FROM appointments
        WHERE organization_id = ? AND scheduled_start >= ? AND scheduled_start <= ?
        GROUP BY status`
    ).all(orgId, from, to) as any[];
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of apptRows) { byStatus[r.status] = Number(r.c); total += Number(r.c); }

    const pastRow = db.prepare(
      `SELECT COUNT(*) AS c FROM appointments
        WHERE organization_id = ? AND scheduled_start >= ? AND scheduled_start <= ? AND scheduled_start < ?`
    ).get(orgId, from, to, nowISO) as any;
    const past = Number(pastRow?.c || 0);
    const noShow = byStatus["no_show"] || 0;
    const completed = byStatus["completed"] || 0;

    const patientConfirmedRow = db.prepare(
      `SELECT COUNT(*) AS c FROM appointments
        WHERE organization_id = ? AND scheduled_start >= ? AND scheduled_start <= ?
          AND patient_confirmed_at IS NOT NULL`
    ).get(orgId, from, to) as any;
    const patientConfirmed = Number(patientConfirmedRow?.c || 0);

    // ── Reminders (lembretes enviados no período) ────────────────────────
    const remRows = db.prepare(
      `SELECT status, COUNT(*) AS c FROM clinical_appointment_reminders
        WHERE organization_id = ? AND sent_at >= ? AND sent_at <= ?
        GROUP BY status`
    ).all(orgId, from, to) as any[];
    let remSent = 0, remFailed = 0;
    for (const r of remRows) {
      if (r.status === "sent") remSent = Number(r.c);
      else if (r.status === "failed") remFailed = Number(r.c);
    }

    // Confirmações/cancelamentos pelo paciente que casam com lembretes do período.
    // Aproximação prática: quantos appointments que RECEBERAM lembrete no
    // período foram depois confirmados pelo paciente OU cancelled_by='patient'.
    const repliedRow = db.prepare(
      `SELECT
         SUM(CASE WHEN a.patient_confirmed_at IS NOT NULL THEN 1 ELSE 0 END) AS confirmed,
         SUM(CASE WHEN a.cancelled_by = 'patient' THEN 1 ELSE 0 END) AS cancelledByPatient
       FROM clinical_appointment_reminders r
       JOIN appointments a ON a.id = r.appointment_id AND a.organization_id = r.organization_id
      WHERE r.organization_id = ? AND r.status = 'sent' AND r.sent_at >= ? AND r.sent_at <= ?`
    ).get(orgId, from, to) as any;
    const remConfirmed = Number(repliedRow?.confirmed || 0);
    const remCancelled = Number(repliedRow?.cancelledByPatient || 0);

    // ── Automações (ADR-080 Fase R) ─────────────────────────────────────
    const reschedRows = db.prepare(
      `SELECT status, COUNT(*) AS c FROM clinical_reschedule_offers
        WHERE organization_id = ? AND created_at >= ? AND created_at <= ?
        GROUP BY status`
    ).all(orgId, from, to) as any[];
    const reschedMap: Record<string, number> = {};
    for (const r of reschedRows) reschedMap[r.status] = Number(r.c);

    const vacancyRows = db.prepare(
      `SELECT status, COUNT(*) AS c FROM clinical_vacancy_offers
        WHERE organization_id = ? AND created_at >= ? AND created_at <= ?
        GROUP BY status`
    ).all(orgId, from, to) as any[];
    const vacancyMap: Record<string, number> = {};
    for (const r of vacancyRows) vacancyMap[r.status] = Number(r.c);
    // Minutos "recuperados": soma da duração das vagas aceitas — cada uma
    // seria uma consulta perdida convertida em consulta faturada.
    const recoveredRow = db.prepare(
      `SELECT COALESCE(SUM(slot_duration_minutes), 0) AS m FROM clinical_vacancy_offers
        WHERE organization_id = ? AND created_at >= ? AND created_at <= ? AND status = 'accepted'`
    ).get(orgId, from, to) as any;

    // ── Cancelamentos no período (todos, não só via reply) ──────────────
    const cancelRows = db.prepare(
      `SELECT cancelled_by, COUNT(*) AS c FROM appointments
        WHERE organization_id = ? AND cancelled_at IS NOT NULL AND cancelled_at >= ? AND cancelled_at <= ?
        GROUP BY cancelled_by`
    ).all(orgId, from, to) as any[];
    const byOrigin = { patient: 0, staff: 0, system: 0 };
    let cancelTotal = 0;
    for (const r of cancelRows) {
      const k = (r.cancelled_by === "patient" || r.cancelled_by === "system") ? r.cancelled_by : "staff";
      byOrigin[k as keyof typeof byOrigin] += Number(r.c);
      cancelTotal += Number(r.c);
    }

    // ── Documentos emitidos no período ──────────────────────────────────
    const rxRow = db.prepare(
      `SELECT COUNT(*) AS c FROM clinical_prescriptions
        WHERE organization_id = ? AND status = 'issued' AND issued_at >= ? AND issued_at <= ?`
    ).get(orgId, from, to) as any;
    const certRow = db.prepare(
      `SELECT COUNT(*) AS c FROM clinical_medical_certificates
        WHERE organization_id = ? AND status = 'issued' AND issued_at >= ? AND issued_at <= ?`
    ).get(orgId, from, to) as any;
    const sentDocsRow = db.prepare(
      `SELECT COUNT(*) AS c FROM clinical_document_deliveries
        WHERE organization_id = ? AND status = 'sent' AND sent_at >= ? AND sent_at <= ?`
    ).get(orgId, from, to) as any;
    // Fase 27: receitas particulares emitidas + faturamento total no período.
    const rcptRow = db.prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents), 0) AS t
         FROM clinical_receipts
        WHERE organization_id = ? AND status = 'issued' AND issued_at >= ? AND issued_at <= ?`
    ).get(orgId, from, to) as any;

    // ── Retornos ─────────────────────────────────────────────────────────
    const recRow = db.prepare(
      `SELECT COUNT(*) AS c FROM clinical_encounters
        WHERE organization_id = ? AND status = 'signed'
          AND follow_up_recommended_days IS NOT NULL AND follow_up_recommended_days > 0
          AND signed_at >= ? AND signed_at <= ?`
    ).get(orgId, from, to) as any;
    const schedRow = db.prepare(
      `SELECT COUNT(*) AS c FROM appointments
        WHERE organization_id = ? AND parent_appointment_id IS NOT NULL
          AND scheduled_start >= ? AND scheduled_start <= ?`
    ).get(orgId, from, to) as any;
    // Pendentes: encounters signed com recomendação SEM retorno agendado (independente de data).
    const pendRow = db.prepare(
      `SELECT COUNT(*) AS c FROM clinical_encounters e
        WHERE e.organization_id = ? AND e.status = 'signed'
          AND e.follow_up_recommended_days IS NOT NULL AND e.follow_up_recommended_days > 0
          AND NOT EXISTS (
            SELECT 1 FROM appointments ret
             WHERE ret.organization_id = e.organization_id
               AND ret.parent_appointment_id = e.appointment_id
               AND ret.status NOT IN ('cancelled','no_show')
          )`
    ).get(orgId) as any;

    // ── Por profissional (dentro do período) ────────────────────────────
    const profRows = db.prepare(
      `SELECT
         COALESCE(a.professional_id, '') AS professional_id,
         COALESCE(a.professional_name_snapshot, p.name, 'Sem profissional') AS name,
         COUNT(*) AS appointments,
         SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
         SUM(COALESCE(a.expected_duration_minutes, 30)) AS occupation_minutes
       FROM appointments a
       LEFT JOIN clinic_professionals p ON p.id = a.professional_id AND p.organization_id = a.organization_id
      WHERE a.organization_id = ? AND a.scheduled_start >= ? AND a.scheduled_start <= ?
      GROUP BY professional_id, name
      ORDER BY appointments DESC`
    ).all(orgId, from, to) as any[];

    return {
      window: { from, to, days },
      appointments: {
        total,
        byStatus,
        past,
        noShowRate: pct(noShow, past),
        completedRate: pct(completed, past),
        patientConfirmedRate: pct(patientConfirmed, total),
      },
      reminders: {
        sent: remSent,
        failed: remFailed,
        replied: remConfirmed + remCancelled,
        confirmationRate: pct(remConfirmed, remSent),
        cancellationRate: pct(remCancelled, remSent),
      },
      automations: {
        reschedule: {
          offered: (reschedMap.pending || 0) + (reschedMap.chosen || 0) + (reschedMap.abandoned || 0) + (reschedMap.expired || 0),
          chosen: reschedMap.chosen || 0,
          abandoned: reschedMap.abandoned || 0,
          expired: reschedMap.expired || 0,
        },
        vacancy: {
          offered: (vacancyMap.pending || 0) + (vacancyMap.accepted || 0) + (vacancyMap.declined || 0) + (vacancyMap.expired || 0) + (vacancyMap.superseded || 0),
          accepted: vacancyMap.accepted || 0,
          declined: vacancyMap.declined || 0,
          expired: vacancyMap.expired || 0,
          recoveredMinutes: Number(recoveredRow?.m || 0),
        },
      },
      cancellations: {
        total: cancelTotal,
        byOrigin,
        patientShare: pct(byOrigin.patient, cancelTotal),
      },
      documents: {
        prescriptionsIssued: Number(rxRow?.c || 0),
        certificatesIssued: Number(certRow?.c || 0),
        receiptsIssued: Number(rcptRow?.c || 0),
        receiptsTotalCents: Number(rcptRow?.t || 0),
        sentByChannel: Number(sentDocsRow?.c || 0),
      },
      followUps: {
        recommended: Number(recRow?.c || 0),
        scheduled: Number(schedRow?.c || 0),
        pending: Number(pendRow?.c || 0),
      },
      professionals: profRows.map((r) => ({
        id: r.professional_id,
        name: r.name,
        appointments: Number(r.appointments),
        completed: Number(r.completed),
        cancelled: Number(r.cancelled),
        occupationMinutes: Number(r.occupation_minutes || 0),
      })),
    };
  }
}

export default ClinicMetricsService;
