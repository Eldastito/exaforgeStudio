/**
 * TEST — Lead→Sale→Revenue→Margin (PRD 11 / ADR-168 F8). DB-backed, determinístico.
 * Prova: precedência de valor (orders pago→fact > quotes aceito→estimate > avg_ticket→estimate
 * > nenhum→não atribui); margem por unit_price−unit_cost (só fact com custo completo, senão
 * null — RN-CG-03); fact/estimate NUNCA somados; resolver sobe pro estágio 'sale'; dedupe;
 * isolamento multi-tenant.
 *
 * Uso: npm run test:content-revenue-attribution
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-crev-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-crev-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ContentLeadAttributionService: LEAD } = await import("../src/server/ContentLeadAttributionService.js");
  const { ContentRevenueAttributionService: REV } = await import("../src/server/ContentRevenueAttributionService.js");
  const { BusinessOutcomeResolverRegistry } = await import("../src/server/BusinessOutcomeResolver.js");

  const org = `org_cr_${randomUUID().slice(0, 8)}`;
  const orgB = `org_cr_${randomUUID().slice(0, 8)}`;
  for (const o of [org, orgB]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);

  const mkContact = (o: string, avg = 0) => { const id = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, avg_ticket) VALUES (?, ?, 'ch', 'L', ?, ?)`).run(id, o, id, avg); return id; };
  const paidOrder = (o: string, contactId: string, total: number, items: [number, number, number][]) => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount) VALUES (?, ?, ?, 'pago', ?)`).run(oid, o, contactId, total);
    for (const [price, cost, qty] of items) db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, unit_cost, quantity, line_total) VALUES (?, ?, ?, 'x', ?, ?, ?, ?)`).run(randomUUID(), oid, o, price, cost, qty, price * qty);
    return oid;
  };
  const acceptedQuote = (o: string, contactId: string, total: number) => db.prepare(`INSERT INTO quotes (id, organization_id, contact_id, status, total_amount, accepted_at) VALUES (?, ?, ?, 'accepted', ?, CURRENT_TIMESTAMP)`).run(randomUUID(), o, contactId, total);

  const corr = "campaign:rev";
  const cFact = mkContact(org); paidOrder(org, cFact, 200, [[100, 60, 1], [50, 30, 2]]); // margem 40 + 40 = 80
  const cEst = mkContact(org); acceptedQuote(org, cEst, 150);
  const cAvg = mkContact(org, 90);
  const cNone = mkContact(org);
  const cNoCost = mkContact(org); paidOrder(org, cNoCost, 100, [[100, 0, 1]]); // custo desconhecido → margem null
  for (const c of [cFact, cEst, cAvg, cNone, cNoCost]) LEAD.attribute(org, { correlationId: corr, contactId: c });

  // ── 1. Schema ──
  check("1.1 tabela content_sale_attributions", !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='content_sale_attributions'`).get());

  // ── 2. Precedência de valor por contato ──
  const vFact = REV.valueForContact(org, cFact);
  check("2.1 pedido pago → fact + margem fact", vFact.revenue === 200 && vFact.revenueBasis === "fact" && vFact.margin === 80 && vFact.marginBasis === "fact" && vFact.source === "orders");
  check("2.2 quote aceito → estimate, margem null", (() => { const v = REV.valueForContact(org, cEst); return v.revenue === 150 && v.revenueBasis === "estimate" && v.margin === null && v.source === "quotes"; })());
  check("2.3 avg_ticket → estimate", (() => { const v = REV.valueForContact(org, cAvg); return v.revenue === 90 && v.revenueBasis === "estimate" && v.source === "contacts_avg_ticket"; })());
  check("2.4 sem prova → não atribui (null)", (() => { const v = REV.valueForContact(org, cNone); return v.revenue === null && v.source === null; })());
  check("2.5 custo desconhecido → revenue fact mas margem null (não inventa)", (() => { const v = REV.valueForContact(org, cNoCost); return v.revenue === 100 && v.revenueBasis === "fact" && v.margin === null && v.marginBasis === null; })());

  // ── 3. attributeLeads + resumo (fact≠estimate, RN-CG-03) ──
  const sum = REV.attributeLeads(org, corr);
  check("3.1 revenueFact = 200 + 100 = 300", sum.revenueFact === 300);
  check("3.2 revenueEstimate = 150 + 90 = 240", sum.revenueEstimate === 240);
  check("3.3 fact e estimate SEPARADOS (não somados)", sum.revenueFact !== sum.revenueFact + sum.revenueEstimate);
  check("3.4 marginFact = 80 (só o custo conhecido)", sum.marginFact === 80);
  check("3.5 salesCount = 4 (cNone não atribuído)", sum.salesCount === 4);
  check("3.6 leadsCount = 5", sum.leadsCount === 5);

  // ── 4. Idempotência (dedupe por lead, RN-CG-03) ──
  const sum2 = REV.attributeLeads(org, corr);
  check("4.1 reatribuir não dobra", sum2.salesCount === 4 && sum2.revenueFact === 300);

  // ── 5. Resolver sobe pro estágio 'sale' com receita ──
  const rSale = BusinessOutcomeResolverRegistry.resolve(org, { command_type: "social_publish", correlation_id: corr });
  check("5.1 confirmed + reason sale_attributed", rSale.resolved === "confirmed" && rSale.reason === "sale_attributed");
  check("5.2 evidência stage 'sale' + revenueFact", rSale.evidence?.stage === "sale" && rSale.evidence?.revenueFact === 300);

  // ── 6. Conteúdo só com lead (sem venda) fica no estágio 'lead' ──
  const corr2 = "campaign:leadonly";
  const cLead = mkContact(org); LEAD.attribute(org, { correlationId: corr2, contactId: cLead });
  const rLead = BusinessOutcomeResolverRegistry.resolve(org, { command_type: "social_publish", correlation_id: corr2 });
  check("6.1 sem venda → estágio 'lead'", rLead.resolved === "confirmed" && rLead.evidence?.stage === "lead");

  // ── 7. Isolamento multi-tenant ──
  check("7.1 org B não vê receita de A", REV.revenueFor(orgB, corr).revenueFact === 0 && REV.revenueFor(orgB, corr).salesCount === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} content-revenue-attribution: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
