/**
 * Módulo Clínica — TIMELINE UNIFICADA DO PACIENTE (ADR-080 Fase 21).
 *
 * Agrega numa cronologia única todos os eventos clínicos de um paciente:
 * consultas agendadas, prontuário aberto/assinado, addendums, receitas e
 * atestados emitidos, anexos, envios de documento por WhatsApp. Fecha o
 * lado "gestor consulta rápida" — hoje o profissional precisa abrir 4 abas
 * pra reconstruir o histórico. Não introduz tabela nova (agregação read-only
 * sobre o que as Fases G/H/I/J/K/M/20 já produzem).
 *
 * LGPD Art.11 (dado sensível): mesma semântica de `listByPatient` da Fase 19 —
 * `requireConsent(orgId, contactId)` ANTES de qualquer leitura. Revoke bloqueia
 * timeline inteira até novo grant.
 *
 * Determinístico, zero-token, isolado por `organization_id`.
 */
import db from "./db.js";
import { LgpdService } from "./LgpdService.js";

const SENSITIVE_CONSENT = "dados_sensiveis";

export type TimelineKind =
  | "appointment_scheduled"
  | "encounter_opened"
  | "encounter_signed"
  | "encounter_addendum"
  | "prescription_issued"
  | "certificate_issued"
  | "receipt_issued"
  | "attachment_added"
  | "document_sent";

export interface TimelineItem {
  kind: TimelineKind;
  at: string; // ISO timestamp — chave de ordenação
  encounterId: string | null;
  appointmentId: string | null;
  refId: string | null; // id do doc/addendum/anexo/delivery, quando aplicável
  actorId: string | null; // usuário do sistema que gerou o evento (quando registrado)
  actorName: string | null; // snapshot amigável (professional_name_snapshot etc.)
  summary: string; // linha curta pra UI ("Receita emitida", "Anexo: raio-X.pdf")
}

export interface TimelineOptions {
  from?: string; // ISO — filtro inclusivo `at >= from`
  to?: string; // ISO — filtro inclusivo `at <= to`
  limit?: number; // 1..500, default 100
  kinds?: TimelineKind[]; // se passado, restringe aos kinds pedidos
}

function requireConsent(orgId: string, contactId: string) {
  if (!LgpdService.hasConsent(orgId, contactId, SENSITIVE_CONSENT)) {
    const e: any = new Error(
      "Consentimento LGPD para dados sensíveis (saúde) é obrigatório antes de ler a timeline."
    );
    e.code = "LGPD_CONSENT_REQUIRED";
    throw e;
  }
}

// Filtros de janela aplicados em memória depois do UNION — mais legível
// que replicar WHERE em cada SELECT e sem custo perceptível na escala real
// (paciente com histórico grande tem centenas de linhas, não milhões).
function withinWindow(at: string, from?: string, to?: string): boolean {
  if (from && at < from) return false;
  if (to && at > to) return false;
  return true;
}

export class ClinicPatientTimelineService {
  /**
   * Devolve a timeline do paciente ordenada DESC por `at` (mais recente
   * primeiro). Cada evento carrega ids pra permitir link/drill-down na UI.
   *
   * Semântica de ausência:
   *  - Paciente sem eventos → `{contactId, count:0, items:[]}` (após consent).
   *  - Paciente sem consent → lança `LGPD_CONSENT_REQUIRED` (403 na rota).
   *  - Paciente inexistente/cross-tenant → também gata consent primeiro
   *    (mesmo comportamento de `ClinicEncounterService.listByPatient` da Fase
   *    19); consent lookup em contactId inexistente devolve false → 403.
   *    Consistente com "nada a expor sobre id que não existe neste org".
   */
  static getTimeline(orgId: string, contactId: string, opts: TimelineOptions = {}) {
    requireConsent(orgId, contactId);

    const items: TimelineItem[] = [];

    // 1. Appointments — data agendada é a âncora temporal do evento clínico.
    //    Inclui todos os appts do paciente (independente de status) — cancelled
    //    também importa pra rastro do "por que essa consulta não aconteceu".
    const appts = db.prepare(
      `SELECT id, scheduled_start, title, status, professional_name_snapshot
         FROM appointments
        WHERE organization_id = ? AND contact_id = ? AND scheduled_start IS NOT NULL`
    ).all(orgId, contactId) as any[];
    for (const a of appts) {
      const suffix =
        a.status === "cancelled" ? " (cancelado)" :
        a.status === "no_show" ? " (não compareceu)" :
        a.status === "completed" ? " (concluído)" : "";
      items.push({
        kind: "appointment_scheduled",
        at: a.scheduled_start,
        encounterId: null,
        appointmentId: a.id,
        refId: null,
        actorId: null,
        actorName: a.professional_name_snapshot ?? null,
        summary: `${a.title || "Consulta"}${suffix}`,
      });
    }

    // 2. Encounters — abertura (created_at) e assinatura (signed_at).
    const encs = db.prepare(
      `SELECT id, appointment_id, created_at, signed_at, status,
              professional_name_snapshot, created_by, signed_by
         FROM clinical_encounters
        WHERE organization_id = ? AND contact_id = ?`
    ).all(orgId, contactId) as any[];
    for (const e of encs) {
      items.push({
        kind: "encounter_opened",
        at: e.created_at,
        encounterId: e.id,
        appointmentId: e.appointment_id ?? null,
        refId: null,
        actorId: e.created_by ?? null,
        actorName: e.professional_name_snapshot ?? null,
        summary: "Prontuário aberto",
      });
      if (e.status === "signed" && e.signed_at) {
        items.push({
          kind: "encounter_signed",
          at: e.signed_at,
          encounterId: e.id,
          appointmentId: e.appointment_id ?? null,
          refId: null,
          actorId: e.signed_by ?? null,
          actorName: e.professional_name_snapshot ?? null,
          summary: "Prontuário assinado",
        });
      }
    }

    // 3. Addendums (Fase 20).
    const adds = db.prepare(
      `SELECT id, encounter_id, note, author_id, author_name_snapshot, signed_with_pin, created_at
         FROM clinical_encounter_addendums
        WHERE organization_id = ? AND contact_id = ?`
    ).all(orgId, contactId) as any[];
    for (const a of adds) {
      const preview = a.note.length > 60 ? a.note.slice(0, 57) + "..." : a.note;
      items.push({
        kind: "encounter_addendum",
        at: a.created_at,
        encounterId: a.encounter_id,
        appointmentId: null,
        refId: a.id,
        actorId: a.author_id ?? null,
        actorName: a.author_name_snapshot ?? null,
        summary: `Adendo${a.signed_with_pin ? " (assinado com PIN)" : ""}: ${preview}`,
      });
    }

    // 4. Prescriptions issued (Fase H). Só emitidas — rascunho não vai
    //    na timeline (é privado do profissional até virar issued).
    const rx = db.prepare(
      `SELECT id, encounter_id, appointment_id, issued_at, issued_by,
              professional_name_snapshot, signed_with_pin
         FROM clinical_prescriptions
        WHERE organization_id = ? AND contact_id = ? AND status = 'issued' AND issued_at IS NOT NULL`
    ).all(orgId, contactId) as any[];
    for (const r of rx) {
      items.push({
        kind: "prescription_issued",
        at: r.issued_at,
        encounterId: r.encounter_id ?? null,
        appointmentId: r.appointment_id ?? null,
        refId: r.id,
        actorId: r.issued_by ?? null,
        actorName: r.professional_name_snapshot ?? null,
        summary: `Receita emitida${r.signed_with_pin ? " (assinada com PIN)" : ""}`,
      });
    }

    // 5. Certificates issued (Fase H).
    const cert = db.prepare(
      `SELECT id, encounter_id, appointment_id, issued_at, issued_by,
              professional_name_snapshot, signed_with_pin, days, purpose
         FROM clinical_medical_certificates
        WHERE organization_id = ? AND contact_id = ? AND status = 'issued' AND issued_at IS NOT NULL`
    ).all(orgId, contactId) as any[];
    for (const c of cert) {
      const days = Number(c.days) || 0;
      items.push({
        kind: "certificate_issued",
        at: c.issued_at,
        encounterId: c.encounter_id ?? null,
        appointmentId: c.appointment_id ?? null,
        refId: c.id,
        actorId: c.issued_by ?? null,
        actorName: c.professional_name_snapshot ?? null,
        summary: `Atestado emitido (${days} dia${days === 1 ? "" : "s"})${c.signed_with_pin ? " (assinado com PIN)" : ""}`,
      });
    }

    // 5b. Receipts issued (Fase 27). Só emitidos — rascunho é privado.
    const rcpt = db.prepare(
      `SELECT id, encounter_id, appointment_id, issued_at, issued_by,
              professional_name_snapshot, signed_with_pin, amount_cents, payment_method
         FROM clinical_receipts
        WHERE organization_id = ? AND contact_id = ? AND status = 'issued' AND issued_at IS NOT NULL`
    ).all(orgId, contactId) as any[];
    for (const r of rcpt) {
      const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
        .format(Number(r.amount_cents || 0) / 100);
      items.push({
        kind: "receipt_issued",
        at: r.issued_at,
        encounterId: r.encounter_id ?? null,
        appointmentId: r.appointment_id ?? null,
        refId: r.id,
        actorId: r.issued_by ?? null,
        actorName: r.professional_name_snapshot ?? null,
        summary: `Recibo emitido (${brl})${r.signed_with_pin ? " (assinado com PIN)" : ""}`,
      });
    }

    // 6. Attachments (Fase J). Rows purgadas pela retenção (Fase U) ficam
    //    com `purged_at`; ainda aparecem na timeline (auditoria diz que
    //    existiu) mas o summary sinaliza.
    const attach = db.prepare(
      `SELECT id, encounter_id, appointment_id, label, kind, original_filename,
              uploaded_by, uploaded_at, purged_at
         FROM clinical_encounter_attachments
        WHERE organization_id = ? AND contact_id = ?`
    ).all(orgId, contactId) as any[];
    for (const at of attach) {
      const label = at.label || at.original_filename || `Anexo (${at.kind})`;
      const suffix = at.purged_at ? " [arquivo purgado]" : "";
      items.push({
        kind: "attachment_added",
        at: at.uploaded_at,
        encounterId: at.encounter_id,
        appointmentId: at.appointment_id ?? null,
        refId: at.id,
        actorId: at.uploaded_by ?? null,
        actorName: null,
        summary: `Anexo: ${label}${suffix}`,
      });
    }

    // 7. Document deliveries (Fase K). Só `sent` — falhas ficam no
    //    endpoint dedicado de deliveries, não na cronologia visível.
    const dlv = db.prepare(
      `SELECT id, doc_kind, doc_id, sent_at, sent_by, file_purged_at
         FROM clinical_document_deliveries
        WHERE organization_id = ? AND contact_id = ? AND status = 'sent'`
    ).all(orgId, contactId) as any[];
    for (const d of dlv) {
      const what = d.doc_kind === "prescription" ? "Receita" : d.doc_kind === "certificate" ? "Atestado" : "Recibo";
      const suffix = d.file_purged_at ? " [PDF purgado]" : "";
      items.push({
        kind: "document_sent",
        at: d.sent_at,
        encounterId: null,
        appointmentId: null,
        refId: d.doc_id,
        actorId: d.sent_by ?? null,
        actorName: null,
        summary: `${what} enviado por WhatsApp${suffix}`,
      });
    }

    // Filtro de janela + kinds
    const kindsFilter = opts.kinds && opts.kinds.length ? new Set(opts.kinds) : null;
    const filtered = items.filter((it) => {
      if (kindsFilter && !kindsFilter.has(it.kind)) return false;
      return withinWindow(it.at, opts.from, opts.to);
    });

    // Ordena DESC por at (mais recente primeiro). Tiebreaker por kind pra
    // determinismo: dentro do mesmo timestamp, `encounter_signed` deve vir
    // depois de `encounter_opened`, receita antes de envio, etc. Ordem de
    // desempate segue a ordem "narrativa" do atendimento.
    const KIND_ORDER: Record<TimelineKind, number> = {
      appointment_scheduled: 0,
      encounter_opened: 1,
      prescription_issued: 2,
      certificate_issued: 3,
      receipt_issued: 3,      // mesmo peso narrativo dos outros docs do encounter
      attachment_added: 4,
      document_sent: 5,
      encounter_signed: 6,
      encounter_addendum: 7,
    };
    filtered.sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? 1 : -1;
      // mesmo timestamp: maior KIND_ORDER = mais tarde na narrativa =
      // primeiro no DESC.
      return KIND_ORDER[b.kind] - KIND_ORDER[a.kind];
    });

    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
    const clipped = filtered.slice(0, limit);

    return {
      contactId,
      count: clipped.length,
      totalBeforeLimit: filtered.length,
      items: clipped,
    };
  }
}

export default ClinicPatientTimelineService;
