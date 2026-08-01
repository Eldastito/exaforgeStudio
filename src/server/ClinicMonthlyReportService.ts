/**
 * Módulo Clínica — RELATÓRIO MENSAL EM PDF (ADR-080 Fase 17 / Fase V).
 *
 * Consolida num único PDF o que as Fases G–U produziram durante o mês:
 * atendimentos totais/realizados/no-show, taxa de confirmação SIM, docs
 * emitidos, ocupação por profissional e o funil das automações WhatsApp
 * (vagas ofertadas/aceitas + minutos recuperados = "receita salva").
 *
 * Reusa `ClinicMetricsService.overview` (mesma matemática do dashboard —
 * evita duas verdades) mas com janela FECHADA no mês (primeiro dia ao
 * último). O PDF é `Buffer` via `pdfkit` (mesmo padrão da Fase H).
 *
 * Determinístico, zero-token, isolado por `organization_id`. Sem tabela
 * nova — o relatório é derivado do estado atual. Auditoria só quando o
 * gestor gera de fato (rota, Scheduler futuro).
 */
import PDFDocument from "pdfkit";
import db from "./db.js";
import { ClinicMetricsService, type MetricsOverview } from "./ClinicMetricsService.js";
// normalizeMonth/monthWindow moradores em util/monthWindow.ts (compartilhado
// com ComigoMonthlyReportService). Re-exportados aqui p/ manter a API pública.
import { normalizeMonth, monthWindow } from "./util/monthWindow.js";
export { normalizeMonth, monthWindow };

export interface MonthlyReportPayload {
  month: string;               // YYYY-MM
  monthLabel: string;          // "julho de 2026"
  windowFromISO: string;
  windowToISO: string;
  businessName: string;
  metrics: MetricsOverview;
}

function businessName(orgId: string): string {
  try {
    const o = db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return o?.business_name || "Clínica";
  } catch { return "Clínica"; }
}

function fmtInt(n: number | undefined | null): string { return String(Math.round(Number(n) || 0)); }
function fmtPct(n: number | undefined | null): string { return `${(Number(n) || 0).toFixed(2).replace(/\.00$/, "").replace(".", ",")}%`; }
function fmtHours(minutes: number | undefined | null): string {
  const m = Math.round(Number(minutes) || 0);
  if (m < 60) return `${m} min`;
  const h = m / 60;
  return `${h.toFixed(1).replace(".0", "").replace(".", ",")} h`;
}

export class ClinicMonthlyReportService {
  /** Monta o payload do mês (não renderiza). Reusado pelo teste + pela rota. */
  static buildPayload(orgId: string, month?: string | null, nowMs?: number): MonthlyReportPayload {
    const normalized = normalizeMonth(month || undefined, nowMs);
    const win = monthWindow(normalized);
    const metrics = ClinicMetricsService.overview(orgId, { from: win.fromISO, to: win.toISO });
    return {
      month: normalized,
      monthLabel: win.label,
      windowFromISO: win.fromISO,
      windowToISO: win.toISO,
      businessName: businessName(orgId),
      metrics,
    };
  }

  /** Renderiza o PDF (Buffer) do relatório mensal. */
  static renderPdf(orgId: string, month?: string | null, nowMs?: number): Promise<Buffer> {
    const payload = this.buildPayload(orgId, month, nowMs);
    return this.renderPdfFromPayload(payload);
  }

  static renderPdfFromPayload(payload: MonthlyReportPayload): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: "A4", margin: 48 });
        const chunks: Buffer[] = [];
        doc.on("data", (b: Buffer) => chunks.push(b));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        // ── Cabeçalho ────────────────────────────────────────────────────
        doc.font("Helvetica-Bold").fontSize(16).fillColor("#0f766e").text(payload.businessName, { align: "left" });
        doc.moveDown(0.1);
        doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827").text(`Relatório mensal · ${payload.monthLabel}`);
        doc.moveDown(0.1);
        doc.font("Helvetica").fontSize(9).fillColor("#6b7280").text(`Período: ${payload.windowFromISO.slice(0, 10)} a ${payload.windowToISO.slice(0, 10)} (UTC)`);
        doc.moveDown(0.8);

        const m = payload.metrics;

        // ── Bloco 1 — Atendimentos ───────────────────────────────────────
        writeSectionTitle(doc, "Atendimentos");
        writeKV(doc, [
          ["Total no mês", fmtInt(m.appointments.total)],
          ["Realizados", fmtInt(m.appointments.byStatus["completed"] || 0)],
          ["Não compareceu (no-show)", `${fmtInt(m.appointments.byStatus["no_show"] || 0)}  (${fmtPct(m.appointments.noShowRate)})`],
          ["Cancelados", fmtInt(m.appointments.byStatus["cancelled"] || 0)],
          ["Confirmados pelo paciente", `${fmtInt(Math.round((m.appointments.patientConfirmedRate / 100) * m.appointments.total))}  (${fmtPct(m.appointments.patientConfirmedRate)})`],
        ]);

        // ── Bloco 2 — Cancelamentos por origem ───────────────────────────
        writeSectionTitle(doc, "Cancelamentos por origem");
        writeKV(doc, [
          ["Pelo paciente", `${fmtInt(m.cancellations.byOrigin.patient)}  (${fmtPct(m.cancellations.patientShare)})`],
          ["Pela recepção/equipe", fmtInt(m.cancellations.byOrigin.staff)],
          ["Pelo sistema", fmtInt(m.cancellations.byOrigin.system)],
        ]);

        // ── Bloco 3 — Lembretes (Fase M + S) ─────────────────────────────
        writeSectionTitle(doc, "Lembretes WhatsApp");
        writeKV(doc, [
          ["Enviados", fmtInt(m.reminders.sent)],
          ["Falhas do provedor", fmtInt(m.reminders.failed)],
          ["Taxa de confirmação (SIM)", fmtPct(m.reminders.confirmationRate)],
          ["Taxa de cancelamento (NÃO)", fmtPct(m.reminders.cancellationRate)],
        ]);

        // ── Bloco 4 — Automações (Fase P + Q + R) ────────────────────────
        writeSectionTitle(doc, "Automações WhatsApp");
        writeKV(doc, [
          ["Vagas oferecidas (fila de retornos)", fmtInt(m.automations.vacancy.offered)],
          ["Vagas aceitas", fmtInt(m.automations.vacancy.accepted)],
          ["Horário recuperado", fmtHours(m.automations.vacancy.recoveredMinutes)],
          ["Reagendamentos ofertados", fmtInt(m.automations.reschedule.offered)],
          ["Reagendamentos escolhidos", fmtInt(m.automations.reschedule.chosen)],
        ]);

        // ── Bloco 5 — Documentos emitidos ────────────────────────────────
        writeSectionTitle(doc, "Documentos emitidos");
        const brlReceipts = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
          .format(Number(m.documents.receiptsTotalCents || 0) / 100);
        writeKV(doc, [
          ["Receitas", fmtInt(m.documents.prescriptionsIssued)],
          ["Atestados", fmtInt(m.documents.certificatesIssued)],
          ["Recibos particulares", fmtInt(m.documents.receiptsIssued)],
          ["Faturamento particular", brlReceipts],
          ["Enviados por canal (WhatsApp/email)", fmtInt(m.documents.sentByChannel)],
        ]);

        // ── Bloco 6 — Retornos ───────────────────────────────────────────
        writeSectionTitle(doc, "Retornos");
        writeKV(doc, [
          ["Recomendados no mês", fmtInt(m.followUps.recommended)],
          ["Já agendados", fmtInt(m.followUps.scheduled)],
          ["Pendentes na fila", fmtInt(m.followUps.pending)],
        ]);

        // ── Bloco 7 — Por profissional ───────────────────────────────────
        writeSectionTitle(doc, "Ocupação por profissional");
        if (!m.professionals.length) {
          doc.font("Helvetica-Oblique").fontSize(10).fillColor("#6b7280").text("Sem atendimentos no período.");
        } else {
          // Cabeçalho da tabela
          const startY = doc.y + 4;
          doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151");
          doc.text("Profissional", 48, startY, { width: 220 });
          doc.text("Consultas", 268, startY, { width: 70, align: "right" });
          doc.text("Realizadas", 338, startY, { width: 70, align: "right" });
          doc.text("Canceladas", 408, startY, { width: 70, align: "right" });
          doc.text("Ocupação", 478, startY, { width: 70, align: "right" });
          doc.moveTo(48, startY + 12).lineTo(547, startY + 12).strokeColor("#d1d5db").lineWidth(0.4).stroke();
          doc.y = startY + 16;
          for (const p of m.professionals) {
            const y = doc.y;
            doc.font("Helvetica").fontSize(10).fillColor("#111827");
            doc.text(p.name || "Sem profissional", 48, y, { width: 220 });
            doc.text(fmtInt(p.appointments), 268, y, { width: 70, align: "right" });
            doc.text(fmtInt(p.completed), 338, y, { width: 70, align: "right" });
            doc.text(fmtInt(p.cancelled), 408, y, { width: 70, align: "right" });
            doc.text(fmtHours(p.occupationMinutes), 478, y, { width: 70, align: "right" });
            doc.moveDown(0.4);
          }
        }

        // ── Rodapé ───────────────────────────────────────────────────────
        doc.moveDown(1.2);
        doc.font("Helvetica-Oblique").fontSize(8).fillColor("#6b7280")
          .text("Relatório gerado automaticamente pelo ExaforgeStudio · ADR-080 Fase 17", { align: "center" });

        doc.end();
      } catch (e) { reject(e); }
    });
  }
}

function writeSectionTitle(doc: any, title: string) {
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f766e").text(title);
  doc.moveTo(48, doc.y + 1).lineTo(547, doc.y + 1).strokeColor("#0f766e").lineWidth(0.5).stroke();
  doc.moveDown(0.35);
}

function writeKV(doc: any, rows: [string, string][]) {
  for (const [k, v] of rows) {
    const y = doc.y;
    doc.font("Helvetica").fontSize(10).fillColor("#374151").text(k, 48, y, { width: 340 });
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text(v, 388, y, { width: 159, align: "right" });
    doc.moveDown(0.2);
  }
}

export default ClinicMonthlyReportService;
