/**
 * TEST — Comigo/Relatório mensal em PDF (Gap C do levantamento autônomos).
 *
 * Cobre:
 *   - normalizeMonth/monthWindow (utilitários compartilhados)
 *   - buildPayload: agregados casam com o seed (vendas, custos, lucro, top
 *     produtos, forma de pagamento, fonte, fiado, agenda, break-even)
 *   - renderPdfFromPayload: header %PDF-, pdf-parse extrai título +
 *     seções + números formatados em BRL
 *   - Fiado com pagamento parcial: netChange e saldo do fim do mês
 *   - Agenda: no-show / cancelamento / completed / rate
 *   - Isolamento cross-tenant: org B com dados no mesmo mês NÃO vaza pra A
 *   - Mês sem movimento: PDF válido, seções não quebram
 *
 * Uso:  npm run test:comigo-monthly-report
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-monthly-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-monthly-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

async function pdfText(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  const out = await parser.getText();
  return String(out?.text || "");
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoMonthlyReportService } = await import("../src/server/ComigoMonthlyReportService.js");
  const { normalizeMonth, monthWindow } = await import("../src/server/util/monthWindow.js");
  const { ComigoAgendaService } = await import("../src/server/ComigoAgendaService.js");
  const { BalcaoService } = await import("../src/server/BalcaoService.js");

  // ── 1. Util: normalizeMonth / monthWindow ─────────────────────────────
  const nowAugMs = Date.UTC(2026, 7, 15, 12, 0, 0); // 2026-08-15
  check("normalizeMonth(undefined) volta mês anterior a nowMs", normalizeMonth(undefined, nowAugMs) === "2026-07");
  check("normalizeMonth('2026-03') aceita YYYY-MM válido", normalizeMonth("2026-03", nowAugMs) === "2026-03");
  check("normalizeMonth('lixo') volta mês anterior", normalizeMonth("bad", nowAugMs) === "2026-07");
  const win = monthWindow("2026-07");
  check("monthWindow fromISO = primeiro do mês UTC", win.fromISO === "2026-07-01T00:00:00.000Z");
  check("monthWindow toISO = último instante do mês", win.toISO === "2026-07-31T23:59:59.999Z");
  check("monthWindow label em PT-BR", win.label === "julho de 2026");

  // ── 2. Seed: org A com vendas em julho ─────────────────────────────────
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_archetype, comigo_mode, comigo_fixed_costs_monthly, comigo_formalization) VALUES (?, ?, 'Salão da Ana', 'active', 'cabelo', 'agenda', 1500, 'mei')`
  ).run(randomUUID(), orgId);

  // Produtos + custo snapshot (custo unit = 40% do preço → margem ~60%)
  const svcCorte = randomUUID(), svcEscova = randomUUID(), prodShampoo = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'service', 'Corte', 60, 1)`).run(svcCorte, orgId);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'service', 'Escova', 40, 1)`).run(svcEscova, orgId);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Shampoo', 30, 1)`).run(prodShampoo, orgId);

  // Cria pedido helper — cada linha é (product, qty, unit_price, cost_snapshot)
  function paidOrder(orgId: string, paidVia: string, source: string, createdAt: string, items: Array<{ id: string; name: string; qty: number; price: number; cost: number }>) {
    const orderId = randomUUID();
    const total = items.reduce((s, it) => s + it.qty * it.price, 0);
    db.prepare(
      `INSERT INTO comigo_orders (id, organization_id, status, paid_via, source, total, created_at, paid_at) VALUES (?, ?, 'paid', ?, ?, ?, ?, ?)`
    ).run(orderId, orgId, paidVia, source, total, createdAt, createdAt);
    for (const it of items) {
      db.prepare(
        `INSERT INTO comigo_order_items (id, order_id, product_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), orderId, it.id, it.name, it.qty, it.price, it.cost);
    }
    return orderId;
  }

  // Julho: 3 pedidos pagos (2 balcão pix, 1 mesa pix_dyn) + 1 fiado
  paidOrder(orgId, "pix_manual", "balcao", "2026-07-05 10:00:00", [
    { id: svcCorte, name: "Corte", qty: 1, price: 60, cost: 24 },
    { id: svcEscova, name: "Escova", qty: 1, price: 40, cost: 16 },
  ]); // total 100 / custo 40 / lucro 60
  paidOrder(orgId, "pix_manual", "balcao", "2026-07-12 15:30:00", [
    { id: svcCorte, name: "Corte", qty: 2, price: 60, cost: 24 },
  ]); // 120 / 48 / 72
  paidOrder(orgId, "pix_dyn", "mesa", "2026-07-20 18:00:00", [
    { id: prodShampoo, name: "Shampoo", qty: 1, price: 30, cost: 12 },
    { id: svcEscova, name: "Escova", qty: 1, price: 40, cost: 16 },
  ]); // 70 / 28 / 42
  paidOrder(orgId, "fiado", "balcao", "2026-07-25 11:00:00", [
    { id: svcCorte, name: "Corte", qty: 1, price: 60, cost: 24 },
  ]); // 60 / 24 / 36 — total mês: revenue 350 / cost 140 / profit 210

  // Fiado ledger: gera dívida (60) + recebe pagamento parcial (20) no mês
  const contactId = BalcaoService.ensureFiadoContact(orgId, "Cliente Fiel", "5511999998888");
  db.prepare(
    `INSERT INTO comigo_fiado_ledger (id, organization_id, contact_id, order_id, kind, amount, created_at) VALUES (?, ?, ?, NULL, 'debt', 60, '2026-07-25 11:00:00')`
  ).run(randomUUID(), orgId, contactId);
  db.prepare(
    `INSERT INTO comigo_fiado_ledger (id, organization_id, contact_id, order_id, kind, amount, created_at) VALUES (?, ?, ?, NULL, 'payment', 20, '2026-07-28 09:00:00')`
  ).run(randomUUID(), orgId, contactId);

  // Agenda: 3 marcados em julho (1 completed, 1 no_show, 1 cancelled)
  ComigoAgendaService.create(orgId, {
    contact_name: "Ana", contact_phone: "5511900001111",
    product_service_id: svcCorte, scheduled_start: "2026-07-08T14:00:00.000Z",
    duration_minutes: 30,
  });
  const ag2 = ComigoAgendaService.create(orgId, {
    contact_name: "Bia", contact_phone: "5511900002222",
    product_service_id: svcCorte, scheduled_start: "2026-07-15T14:00:00.000Z",
    duration_minutes: 30,
  }) as any;
  const ag3 = ComigoAgendaService.create(orgId, {
    contact_name: "Carla", contact_phone: "5511900003333",
    product_service_id: svcCorte, scheduled_start: "2026-07-22T14:00:00.000Z",
    duration_minutes: 30,
  }) as any;
  // Marca transições
  const firstAg = (db.prepare(`SELECT id FROM appointments WHERE organization_id = ? AND scheduled_start = '2026-07-08T14:00:00.000Z'`).get(orgId) as any).id;
  ComigoAgendaService.complete(orgId, firstAg);
  ComigoAgendaService.markNoShow(orgId, ag2.id);
  ComigoAgendaService.cancel(orgId, ag3.id, "chuva forte");

  // ── 3. buildPayload ────────────────────────────────────────────────────
  const payload = ComigoMonthlyReportService.buildPayload(orgId, "2026-07", nowAugMs);

  check("payload.month = 2026-07", payload.month === "2026-07");
  check("payload.monthLabel PT-BR", payload.monthLabel === "julho de 2026");
  check("businessName vem do organization_settings", payload.businessName === "Salão da Ana");
  check("archetype + label", payload.archetype === "cabelo" && payload.archetypeLabel === "Cabelo / barbearia");
  check("mode = agenda", payload.mode === "agenda");
  check("formalization = mei", payload.formalization === "mei");

  // Vendas
  check("sales.revenue = 350", near(payload.sales.revenue, 350));
  check("sales.cost = 140", near(payload.sales.cost, 140));
  check("sales.profit = 210", near(payload.sales.profit, 210));
  check("sales.orders = 4", payload.sales.orders === 4);
  check("sales.margin ~60%", near(payload.sales.marginPct, 60, 0.01));
  check("sales.avgTicket = 87,50", near(payload.sales.avgTicket, 87.5));

  // Break-even
  check("fixedCostsMonthly = 1500", near(payload.breakEven.fixedCostsMonthly, 1500));
  check("profitVsFixedPct = 14%", near(payload.breakEven.profitVsFixedPct, 14));
  check("break-even não coberto", payload.breakEven.achieved === false);

  // Top produtos (Corte deve ser #1 com revenue 240)
  const topCorte = payload.topProducts.find(p => p.name === "Corte");
  check("top produto Corte presente", !!topCorte);
  check("top Corte revenue = 240", near(topCorte!.revenue, 240));
  check("top produtos ordenados desc por revenue",
    payload.topProducts[0].revenue >= (payload.topProducts[1]?.revenue ?? 0));

  // Pagamentos: pix_manual (220 / 2), pix_dyn (70 / 1), fiado (60 / 1)
  const pixManual = payload.byPaymentMethod.find(p => p.method === "pix_manual");
  const pixDyn = payload.byPaymentMethod.find(p => p.method === "pix_dyn");
  const fiadoPay = payload.byPaymentMethod.find(p => p.method === "fiado");
  check("pix_manual = 220 / 2 pedidos", !!pixManual && near(pixManual.total, 220) && pixManual.orders === 2);
  check("pix_dyn = 70 / 1 pedido", !!pixDyn && near(pixDyn.total, 70));
  check("fiado = 60 / 1 pedido", !!fiadoPay && near(fiadoPay.total, 60));

  // Fonte: balcao 3 pedidos (280) + mesa 1 (70)
  const srcBal = payload.bySource.find(s => s.source === "balcao");
  const srcMesa = payload.bySource.find(s => s.source === "mesa");
  check("bySource balcao = 280 / 3", !!srcBal && near(srcBal.total, 280) && srcBal.orders === 3);
  check("bySource mesa = 70 / 1", !!srcMesa && near(srcMesa.total, 70));

  // Fiado do mês
  check("fiado.debtsAdded = 60", near(payload.fiado.debtsAdded, 60));
  check("fiado.paymentsReceived = 20", near(payload.fiado.paymentsReceived, 20));
  check("fiado.netChange = 40", near(payload.fiado.netChange, 40));
  check("fiado.balanceEndOfMonth = 40", near(payload.fiado.balanceEndOfMonth, 40));

  // Agenda
  check("agenda.total = 3", payload.agenda.total === 3);
  check("agenda.completed = 1", payload.agenda.completed === 1);
  check("agenda.cancelled = 1", payload.agenda.cancelled === 1);
  check("agenda.noShow = 1", payload.agenda.noShow === 1);
  check("agenda.noShowRate ~33%", near(payload.agenda.noShowRate, 33.33, 0.02));

  // ── 4. renderPdfFromPayload — magic bytes + texto extraído ─────────────
  const pdf = await ComigoMonthlyReportService.renderPdfFromPayload(payload);
  check("PDF começa com %PDF-", pdf.slice(0, 5).toString() === "%PDF-");
  const text = await pdfText(pdf);
  check("PDF traz nome do negócio", text.includes("Salão da Ana"));
  check("PDF traz 'Relatório mensal · julho de 2026'", text.includes("Relatório mensal") && text.includes("julho de 2026"));
  check("PDF traz seção Vendas do mês", text.includes("Vendas do mês"));
  check("PDF traz seção Top 10", text.includes("Top 10 do mês"));
  // pdf-parse às vezes normaliza acentos de forma diferente; casa por substring estável.
  check("PDF traz seção 'pagou' (Como o cliente pagou)", /pagou/i.test(text));
  check("PDF traz seção Caderneta", text.includes("Caderneta"));
  check("PDF traz seção Agenda", text.includes("Agenda"));
  check("PDF traz seção Saúde do corre", text.includes("Saúde do corre"));
  // Valor formatado — pdf-parse normaliza "R$ " em algumas fontes, mas o número deve aparecer.
  check("PDF traz valor total 350,00", text.includes("350,00"));
  check("PDF traz o item Corte", text.includes("Corte"));

  // ── 5. Isolamento cross-tenant ─────────────────────────────────────────
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja B', 'active')`).run(randomUUID(), orgB);
  const svcB = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'service', 'Servico B', 999, 1)`).run(svcB, orgB);
  paidOrder(orgB, "pix_manual", "balcao", "2026-07-10 10:00:00", [
    { id: svcB, name: "Servico B", qty: 1, price: 999, cost: 100 },
  ]);
  const payloadB = ComigoMonthlyReportService.buildPayload(orgB, "2026-07", nowAugMs);
  check("org B: businessName próprio", payloadB.businessName === "Loja B");
  check("org B: sales.revenue = 999", near(payloadB.sales.revenue, 999));
  // E o payload da orgA NÃO deve conter 'Servico B' nos top produtos.
  const payloadAAgain = ComigoMonthlyReportService.buildPayload(orgId, "2026-07", nowAugMs);
  check("orgA não vê produtos da orgB", !payloadAAgain.topProducts.some(p => p.name === "Servico B"));
  check("orgA revenue permanece 350", near(payloadAAgain.sales.revenue, 350));

  // ── 6. Mês sem movimento renderiza PDF sem quebrar ─────────────────────
  const empty = ComigoMonthlyReportService.buildPayload(orgId, "2026-01", nowAugMs);
  check("mês vazio: orders = 0", empty.sales.orders === 0);
  check("mês vazio: agenda.total = 0", empty.agenda.total === 0);
  const emptyPdf = await ComigoMonthlyReportService.renderPdfFromPayload(empty);
  check("mês vazio: PDF válido", emptyPdf.slice(0, 5).toString() === "%PDF-");
  const emptyText = await pdfText(emptyPdf);
  check("mês vazio: texto tem 'Sem vendas no período'", emptyText.includes("Sem vendas"));

  // ── Sumário ─────────────────────────────────────────────────────────
  console.log(`\n=== Comigo/Relatório mensal ===`);
  for (const r of results) console.log(`  ${r.ok ? "✔" : "✘"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} pass`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
