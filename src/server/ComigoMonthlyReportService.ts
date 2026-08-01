/**
 * ZappFlow Comigo — RELATÓRIO MENSAL EM PDF (Gap C do levantamento autônomos).
 *
 * O que o autônomo leva pro contador (ou pro banco quando pede empréstimo):
 * quanto vendeu, quanto sobrou, o que mais saiu, quem deve, e quantos
 * atendimentos rolaram. Mesmo padrão do ClinicMonthlyReportService: consolida
 * o estado atual num PDF por mês fechado, sem tabela nova, reusa aritmética
 * que já existe (ComigoHealthService.rangeResult — evita "duas verdades").
 *
 * Split intencional em buildPayload / renderPdfFromPayload: a rota
 * agrega o payload ANTES de emitir bytes pra auditar campos específicos
 * (total do mês, orders, fiado net) sem duplicar contas.
 *
 * Determinístico, zero-token, isolado por organization_id.
 */
import PDFDocument from "pdfkit";
import db from "./db.js";
import { ComigoHealthService } from "./ComigoHealthService.js";
import { normalizeMonth, monthWindow } from "./util/monthWindow.js";

export interface ComigoMonthlyReportPayload {
  month: string;               // YYYY-MM
  monthLabel: string;          // "julho de 2026"
  windowFromISO: string;
  windowToISO: string;
  businessName: string;
  archetype: string | null;
  archetypeLabel: string | null;
  mode: string | null;         // 'balcao' | 'agenda'
  formalization: string;       // 'informal' | 'mei' | ...

  sales: {
    revenue: number;
    cost: number;
    profit: number;
    marginPct: number;
    units: number;
    orders: number;
    avgTicket: number;
  };
  breakEven: {
    fixedCostsMonthly: number;
    profitVsFixedPct: number;  // profit/fixedCostsMonthly*100 (∞ = 0 se fixed=0)
    achieved: boolean;         // profit >= fixedCostsMonthly (e fixed > 0)
  };
  topProducts: Array<{ name: string; qty: number; revenue: number; cost: number; profit: number }>;
  byPaymentMethod: Array<{ method: string; orders: number; total: number }>;
  bySource: Array<{ source: string; orders: number; total: number }>;
  fiado: {
    debtsAdded: number;
    paymentsReceived: number;
    netChange: number;
    balanceEndOfMonth: number;
    remindersSent: number;
  };
  agenda: {
    total: number;
    completed: number;
    cancelled: number;
    noShow: number;
    noShowRate: number;
  };
  health: {
    signal: "subindo" | "estavel" | "caindo";
    profitDeltaPct: number;
    insightText: string;
  };
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const fmtInt = (n: number | undefined | null) => String(Math.round(Number(n) || 0));
const fmtBrl = (n: number | undefined | null) => brl.format(Number(n) || 0);
const fmtPct = (n: number | undefined | null) => `${(Number(n) || 0).toFixed(2).replace(/\.00$/, "").replace(".", ",")}%`;

// Etiquetas legíveis pros métodos/fontes que o banco guarda em código.
const PAY_LABEL: Record<string, string> = {
  cash: "Dinheiro",
  pix_manual: "Pix (manual)",
  pix_dyn: "Pix dinâmico",
  card: "Cartão",
  fiado: "Fiado",
};
const SOURCE_LABEL: Record<string, string> = {
  balcao: "Balcão",
  mesa: "Mesa/QR",
};
const ARCHETYPE_LABEL: Record<string, string> = {
  marmita: "Marmita / encomenda",
  salgados: "Doces / salgados",
  foodtruck: "Foodtruck / lanche",
  feira: "Feira / praia",
  unhas: "Manicure / pedicure",
  cabelo: "Cabelo / barbearia",
  servico_tecnico: "Chaveiro / serviço técnico",
  revenda: "Revenda / ambulante",
  outro: "Outro",
};

function orgHeader(orgId: string): { businessName: string; archetype: string | null; mode: string | null; formalization: string } {
  const o = db.prepare(
    "SELECT business_name, comigo_archetype, comigo_mode, comigo_formalization FROM organization_settings WHERE organization_id = ?"
  ).get(orgId) as any || {};
  return {
    businessName: o.business_name || "Meu corre",
    archetype: o.comigo_archetype || null,
    mode: o.comigo_mode || null,
    formalization: o.comigo_formalization || "informal",
  };
}

function topProducts(orgId: string, fromDate: string, toDate: string) {
  const rows = db.prepare(`
    SELECT oi.name AS name,
           COALESCE(SUM(oi.qty), 0) AS qty,
           COALESCE(SUM(oi.qty * oi.unit_price), 0) AS revenue,
           COALESCE(SUM(oi.qty * oi.unit_cost_snapshot), 0) AS cost
    FROM comigo_orders o
    JOIN comigo_order_items oi ON oi.order_id = o.id
    WHERE o.organization_id = ?
      AND o.status IN ('paid','done')
      AND date(o.created_at) BETWEEN ? AND ?
    GROUP BY oi.name
    ORDER BY revenue DESC
    LIMIT 10
  `).all(orgId, fromDate, toDate) as any[];
  return rows.map((r) => {
    const revenue = round2(r.revenue);
    const cost = round2(r.cost);
    return { name: r.name || "—", qty: round2(r.qty), revenue, cost, profit: round2(revenue - cost) };
  });
}

function byPaymentMethod(orgId: string, fromDate: string, toDate: string) {
  const rows = db.prepare(`
    SELECT COALESCE(paid_via, 'outro') AS method,
           COUNT(*) AS orders,
           COALESCE(SUM(total), 0) AS total
    FROM comigo_orders
    WHERE organization_id = ?
      AND status IN ('paid','done')
      AND date(created_at) BETWEEN ? AND ?
    GROUP BY paid_via
    ORDER BY total DESC
  `).all(orgId, fromDate, toDate) as any[];
  return rows.map((r) => ({ method: r.method, orders: Number(r.orders) || 0, total: round2(r.total) }));
}

function bySource(orgId: string, fromDate: string, toDate: string) {
  const rows = db.prepare(`
    SELECT COALESCE(source, 'balcao') AS source,
           COUNT(*) AS orders,
           COALESCE(SUM(total), 0) AS total
    FROM comigo_orders
    WHERE organization_id = ?
      AND status IN ('paid','done')
      AND date(created_at) BETWEEN ? AND ?
    GROUP BY source
    ORDER BY total DESC
  `).all(orgId, fromDate, toDate) as any[];
  return rows.map((r) => ({ source: r.source, orders: Number(r.orders) || 0, total: round2(r.total) }));
}

function fiadoMonth(orgId: string, fromDate: string, toDate: string, toISO: string) {
  const debts = (db.prepare(
    `SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger
      WHERE organization_id = ? AND kind = 'debt' AND date(created_at) BETWEEN ? AND ?`
  ).get(orgId, fromDate, toDate) as any)?.s || 0;
  const payments = (db.prepare(
    `SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger
      WHERE organization_id = ? AND kind = 'payment' AND date(created_at) BETWEEN ? AND ?`
  ).get(orgId, fromDate, toDate) as any)?.s || 0;
  // Saldo acumulado ATÉ o fim do mês (não só o mês).
  const debtsAll = (db.prepare(
    `SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger
      WHERE organization_id = ? AND kind = 'debt' AND created_at <= ?`
  ).get(orgId, toISO) as any)?.s || 0;
  const paymentsAll = (db.prepare(
    `SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger
      WHERE organization_id = ? AND kind = 'payment' AND created_at <= ?`
  ).get(orgId, toISO) as any)?.s || 0;
  let reminders = 0;
  try {
    reminders = Number((db.prepare(
      `SELECT COUNT(*) c FROM comigo_fiado_reminders
        WHERE organization_id = ? AND status = 'sent' AND date(created_at) BETWEEN ? AND ?`
    ).get(orgId, fromDate, toDate) as any)?.c) || 0;
  } catch { /* tabela pode não existir em algum ambiente antigo */ }
  return {
    debtsAdded: round2(debts),
    paymentsReceived: round2(payments),
    netChange: round2(debts - payments),
    balanceEndOfMonth: Math.max(0, round2(debtsAll - paymentsAll)),
    remindersSent: reminders,
  };
}

function agendaMonth(orgId: string, fromISO: string, toISO: string) {
  // A agenda usa `appointments` (mesma tabela do clínico) — filtramos por
  // scheduled_start no mês. Cross-tenant não é problema (isolado por org).
  const rows = db.prepare(
    `SELECT status FROM appointments
      WHERE organization_id = ? AND scheduled_start IS NOT NULL
        AND scheduled_start BETWEEN ? AND ?`
  ).all(orgId, fromISO, toISO) as any[];
  let total = 0, completed = 0, cancelled = 0, noShow = 0;
  for (const r of rows) {
    total++;
    if (r.status === "completed") completed++;
    else if (r.status === "cancelled") cancelled++;
    else if (r.status === "no_show") noShow++;
  }
  const noShowRate = total > 0 ? round2((noShow / total) * 100) : 0;
  return { total, completed, cancelled, noShow, noShowRate };
}

export class ComigoMonthlyReportService {
  /** Monta o payload do mês (não renderiza). Reusado pelo teste + pela rota. */
  static buildPayload(orgId: string, month?: string | null, nowMs?: number): ComigoMonthlyReportPayload {
    const normalized = normalizeMonth(month || undefined, nowMs);
    const win = monthWindow(normalized);
    const fromDate = win.fromISO.slice(0, 10);
    const toDate = win.toISO.slice(0, 10);

    const header = orgHeader(orgId);
    const sales = ComigoHealthService.rangeResult(orgId, fromDate, toDate);
    const avgTicket = sales.orders > 0 ? round2(sales.revenue / sales.orders) : 0;
    const marginPct = sales.revenue > 0 ? round2((sales.profit / sales.revenue) * 100) : 0;

    const fixed = Number((db.prepare(
      "SELECT comigo_fixed_costs_monthly FROM organization_settings WHERE organization_id = ?"
    ).get(orgId) as any)?.comigo_fixed_costs_monthly) || 0;
    const profitVsFixedPct = fixed > 0 ? round2((sales.profit / fixed) * 100) : 0;

    const health = ComigoHealthService.trend(orgId, "mes", toDate);
    const insight = ComigoHealthService.insight(orgId, "mes", toDate);

    return {
      month: normalized,
      monthLabel: win.label,
      windowFromISO: win.fromISO,
      windowToISO: win.toISO,
      businessName: header.businessName,
      archetype: header.archetype,
      archetypeLabel: header.archetype ? (ARCHETYPE_LABEL[header.archetype] || header.archetype) : null,
      mode: header.mode,
      formalization: header.formalization,
      sales: {
        revenue: sales.revenue, cost: sales.cost, profit: sales.profit,
        marginPct, units: sales.units, orders: sales.orders, avgTicket,
      },
      breakEven: {
        fixedCostsMonthly: round2(fixed),
        profitVsFixedPct,
        achieved: fixed > 0 && sales.profit >= fixed,
      },
      topProducts: topProducts(orgId, fromDate, toDate),
      byPaymentMethod: byPaymentMethod(orgId, fromDate, toDate),
      bySource: bySource(orgId, fromDate, toDate),
      fiado: fiadoMonth(orgId, fromDate, toDate, win.toISO),
      agenda: agendaMonth(orgId, win.fromISO, win.toISO),
      health: {
        signal: health.signal,
        profitDeltaPct: health.profitDeltaPct,
        insightText: insight.text,
      },
    };
  }

  static renderPdf(orgId: string, month?: string | null, nowMs?: number): Promise<Buffer> {
    const payload = this.buildPayload(orgId, month, nowMs);
    return this.renderPdfFromPayload(payload);
  }

  static renderPdfFromPayload(payload: ComigoMonthlyReportPayload): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: "A4", margin: 48 });
        const chunks: Buffer[] = [];
        doc.on("data", (b: Buffer) => chunks.push(b));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        // Cor de destaque do Comigo (emerald — combina com a UI da aba Comigo).
        const ACCENT = "#059669";

        // ── Cabeçalho ────────────────────────────────────────────────────
        doc.font("Helvetica-Bold").fontSize(16).fillColor(ACCENT).text(payload.businessName, { align: "left" });
        doc.moveDown(0.1);
        doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827").text(`Relatório mensal · ${payload.monthLabel}`);
        doc.moveDown(0.1);
        const subLine: string[] = [];
        if (payload.archetypeLabel) subLine.push(payload.archetypeLabel);
        if (payload.mode) subLine.push(payload.mode === "agenda" ? "hora marcada" : "chegou-e-comprou");
        if (payload.formalization && payload.formalization !== "informal") subLine.push(payload.formalization.toUpperCase());
        if (subLine.length) doc.font("Helvetica").fontSize(9).fillColor("#6b7280").text(subLine.join(" · "));
        doc.font("Helvetica").fontSize(9).fillColor("#6b7280")
          .text(`Período: ${payload.windowFromISO.slice(0, 10)} a ${payload.windowToISO.slice(0, 10)} (UTC)`);
        doc.moveDown(0.8);

        // ── Bloco 1 — Vendas ─────────────────────────────────────────────
        writeSectionTitle(doc, "Vendas do mês", ACCENT);
        writeKV(doc, [
          ["Faturamento", fmtBrl(payload.sales.revenue)],
          ["Custo dos produtos/serviços", fmtBrl(payload.sales.cost)],
          ["Sobrou (lucro bruto)", fmtBrl(payload.sales.profit)],
          ["Margem", fmtPct(payload.sales.marginPct)],
          ["Pedidos", fmtInt(payload.sales.orders)],
          ["Ticket médio", fmtBrl(payload.sales.avgTicket)],
        ]);

        // ── Bloco 2 — Ponto de equilíbrio ────────────────────────────────
        if (payload.breakEven.fixedCostsMonthly > 0) {
          writeSectionTitle(doc, "Ponto de equilíbrio", ACCENT);
          writeKV(doc, [
            ["Custos fixos do mês", fmtBrl(payload.breakEven.fixedCostsMonthly)],
            ["Lucro vs. custos fixos", `${fmtPct(payload.breakEven.profitVsFixedPct)} ${payload.breakEven.achieved ? "· cobriu ✅" : "· falta cobrir"}`],
          ]);
        }

        // ── Bloco 3 — Top produtos ───────────────────────────────────────
        writeSectionTitle(doc, "Top 10 do mês", ACCENT);
        if (!payload.topProducts.length) {
          doc.font("Helvetica-Oblique").fontSize(10).fillColor("#6b7280").text("Sem vendas no período.");
        } else {
          const startY = doc.y + 4;
          doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151");
          doc.text("Item", 48, startY, { width: 260 });
          doc.text("Qtd", 308, startY, { width: 50, align: "right" });
          doc.text("Faturado", 358, startY, { width: 90, align: "right" });
          doc.text("Lucro", 448, startY, { width: 99, align: "right" });
          doc.moveTo(48, startY + 12).lineTo(547, startY + 12).strokeColor("#d1d5db").lineWidth(0.4).stroke();
          doc.y = startY + 16;
          for (const p of payload.topProducts) {
            const y = doc.y;
            doc.font("Helvetica").fontSize(10).fillColor("#111827");
            doc.text(p.name, 48, y, { width: 260 });
            doc.text(String(p.qty), 308, y, { width: 50, align: "right" });
            doc.text(fmtBrl(p.revenue), 358, y, { width: 90, align: "right" });
            doc.text(fmtBrl(p.profit), 448, y, { width: 99, align: "right" });
            doc.moveDown(0.4);
          }
        }

        // ── Bloco 4 — Pagamentos ─────────────────────────────────────────
        writeSectionTitle(doc, "Como o cliente pagou", ACCENT);
        if (!payload.byPaymentMethod.length) {
          doc.font("Helvetica-Oblique").fontSize(10).fillColor("#6b7280").text("Sem vendas no período.");
        } else {
          writeKV(doc, payload.byPaymentMethod.map((r) => [
            `${PAY_LABEL[r.method] || r.method}  (${r.orders} pedido${r.orders === 1 ? "" : "s"})`,
            fmtBrl(r.total),
          ] as [string, string]));
        }

        // ── Bloco 5 — Fonte ──────────────────────────────────────────────
        if (payload.bySource.length > 1) {
          writeSectionTitle(doc, "Onde a venda entrou", ACCENT);
          writeKV(doc, payload.bySource.map((r) => [
            `${SOURCE_LABEL[r.source] || r.source}  (${r.orders} pedido${r.orders === 1 ? "" : "s"})`,
            fmtBrl(r.total),
          ] as [string, string]));
        }

        // ── Bloco 6 — Caderneta ──────────────────────────────────────────
        writeSectionTitle(doc, "Caderneta (fiado)", ACCENT);
        writeKV(doc, [
          ["Dívida gerada no mês", fmtBrl(payload.fiado.debtsAdded)],
          ["Recebido no mês", fmtBrl(payload.fiado.paymentsReceived)],
          ["Variação líquida", `${payload.fiado.netChange >= 0 ? "+" : "−"}${fmtBrl(Math.abs(payload.fiado.netChange))}`],
          ["Saldo a receber no fim do mês", fmtBrl(payload.fiado.balanceEndOfMonth)],
          ["Cobranças enviadas", fmtInt(payload.fiado.remindersSent)],
        ]);

        // ── Bloco 7 — Agenda (só se modo agenda) ─────────────────────────
        if (payload.mode === "agenda" || payload.agenda.total > 0) {
          writeSectionTitle(doc, "Agenda", ACCENT);
          writeKV(doc, [
            ["Total marcado no mês", fmtInt(payload.agenda.total)],
            ["Atendidos", fmtInt(payload.agenda.completed)],
            ["Cancelados", fmtInt(payload.agenda.cancelled)],
            ["Não veio (no-show)", `${fmtInt(payload.agenda.noShow)}  (${fmtPct(payload.agenda.noShowRate)})`],
          ]);
        }

        // ── Bloco 8 — Saúde (frase) ──────────────────────────────────────
        writeSectionTitle(doc, "Saúde do corre", ACCENT);
        const signalLbl = payload.health.signal === "subindo" ? "🚀 subindo" : payload.health.signal === "caindo" ? "🔻 caindo" : "➖ estável";
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text(`Sinal: ${signalLbl}`);
        doc.moveDown(0.1);
        doc.font("Helvetica").fontSize(10).fillColor("#374151").text(payload.health.insightText, { width: 499 });

        // ── Rodapé ───────────────────────────────────────────────────────
        doc.moveDown(1.2);
        doc.font("Helvetica-Oblique").fontSize(8).fillColor("#6b7280")
          .text("Relatório gerado pelo ZappFlow Comigo · zero-token · isolado por organização", { align: "center" });

        doc.end();
      } catch (e) { reject(e); }
    });
  }
}

function writeSectionTitle(doc: any, title: string, accent = "#059669") {
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(accent).text(title);
  doc.moveTo(48, doc.y + 1).lineTo(547, doc.y + 1).strokeColor(accent).lineWidth(0.5).stroke();
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

export default ComigoMonthlyReportService;
