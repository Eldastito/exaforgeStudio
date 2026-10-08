/**
 * TESTE — ADR-205 F4.6: inteligência de fornecedores (SupplierIntelligenceService).
 * Prova: concentração por parcela/HHI/faixa · cancelada e sem-valor fora das parcelas (null≠0) · COBERTURA (compra lançada sem ordem) dita · ficha reaproveita o SupplierPerformanceService ·
 * prazo de pagamento vindo das contas a pagar da ordem · variação de preço do mesmo produto · rascunho de pauta SÓ com fato + evidência + amostra mínima, sem inventar desconto/prazo-alvo,
 * nunca enviado · sem histórico → insufficient_history · isolamento · read-only · rotas gestor-only · composição.
 * Uso: npm run test:supplier-intelligence
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-supplier-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-supplier-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SupplierIntelligenceService: S, MIN_ORDERS } = await import("../src/server/SupplierIntelligenceService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const thrown = (f: () => any) => { try { f(); return null; } catch (e: any) { return e?.code || "error"; } };
  const P = { from: "2026-01-01", to: "2026-06-30" };
  const A = mkOrg(), B = mkOrg();
  const SUP1 = "sup-alfa", SUP2 = "sup-beta", SUP3 = "sup-gama";

  let reqN = 0;
  const order = (org: string, sup: string, name: string, created: string, total: number, o: { status?: string; promised?: number | null; receivedAt?: string | null; items?: Array<{ pid: string; pname: string; price: number; qty: number; recv: number }>; payDue?: string | null } = {}) => {
    const reqId = `req-${++reqN}`, quoteId = randomUUID(), poId = randomUUID();
    db.prepare(`INSERT INTO purchase_quotes (id, organization_id, requisition_id, supplier_contact_id, status, delivery_days, total_amount, sent_at, answered_at, accepted_at) VALUES (?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?)`).run(quoteId, org, reqId, sup, o.promised ?? null, total, created, created, created);
    db.prepare(`INSERT INTO purchase_orders (id, organization_id, requisition_id, quote_id, supplier_contact_id, supplier_name, status, total_amount, delivery_days, created_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(poId, org, reqId, quoteId, sup, name, o.status || "received", total, o.promised ?? null, created, o.receivedAt ?? null);
    for (const it of o.items || []) db.prepare(`INSERT INTO purchase_order_items (id, purchase_order_id, organization_id, product_service_id, product_name, ordered_qty, unit_price, line_total, received_qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), poId, org, it.pid, it.pname, it.qty, it.price, it.price * it.qty, it.recv);
    if (o.payDue) db.prepare(`INSERT INTO payables (id, organization_id, description, category, amount, due_date, status, source_purchase_order_id) VALUES (?, ?, ?, 'compras', ?, ?, 'open', ?)`).run(randomUUID(), org, `Ordem ${name}`, total, o.payDue, poId);
    return poId;
  };
  // Alfa: 3 ordens (20.000), entrega atrasada (prometido 5, realizado 8/9/7), 90% de completude, preço +15%, pagamento 30/30/45 dias
  order(A, SUP1, "Atacado Alfa", "2026-02-01", 6000, { promised: 5, receivedAt: "2026-02-09 00:00:00", payDue: "2026-03-03", items: [{ pid: "P1", pname: "Camisa Polo", price: 10, qty: 100, recv: 90 }, { pid: "P2", pname: "Bermuda", price: 20, qty: 100, recv: 90 }] });
  order(A, SUP1, "Atacado Alfa", "2026-03-01", 6000, { promised: 5, receivedAt: "2026-03-10 00:00:00", payDue: "2026-03-31", items: [{ pid: "P1", pname: "Camisa Polo", price: 10.5, qty: 100, recv: 90 }] });
  order(A, SUP1, "Atacado Alfa", "2026-04-01", 8000, { promised: 5, receivedAt: "2026-04-08 00:00:00", payDue: "2026-05-16", items: [{ pid: "P1", pname: "Camisa Polo", price: 11.5, qty: 100, recv: 90 }, { pid: "P2", pname: "Bermuda", price: 20, qty: 100, recv: 90 }] });
  order(A, SUP1, "Atacado Alfa", "2026-05-01", 99999, { status: "cancelled" });                       // cancelada: fora
  order(A, SUP1, "Atacado Alfa", "2025-11-01", 77777);                                               // fora do período
  // Beta: 1 ordem com valor (5.000) + 1 ordem SEM valor
  order(A, SUP2, "Distribuidora Beta", "2026-03-15", 5000, { promised: 7 });
  order(A, SUP2, "Distribuidora Beta", "2026-04-15", 0, { status: "open" });
  // Gama: 1 ordem, recebida muito atrasada, completa
  order(A, SUP3, "Gama Têxtil", "2026-05-01", 5000, { promised: 5, receivedAt: "2026-05-21 00:00:00", items: [{ pid: "P9", pname: "Meia", price: 5, qty: 50, recv: 50 }] });
  // Compras lançadas como conta a pagar SEM ordem (fora da concentração)
  const pay = (cat: string | null, amount: number, due: string, status = "open") => db.prepare(`INSERT INTO payables (id, organization_id, description, category, amount, due_date, status) VALUES (?, ?, 'Compra por fora', ?, ?, ?, ?)`).run(randomUUID(), A, cat, amount, due, status);
  pay("compras", 10000, "2026-04-20"); pay("compras", 3000, "2026-04-21", "canceled"); pay("marketing", 4000, "2026-04-22"); pay("compras", 9000, "2025-12-20");
  const cnt = () => ["purchase_orders", "purchase_quotes", "payables", "decision_actions", "business_signals", "tasks"].map((t) => (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE organization_id = ?`).get(A) as any).c).join(",");
  const before = cnt();

  const c = S.concentration(A, P);
  check("é leitura, não previsão nem ação", c.type === "supplier_concentration" && c.isForecast === false && c.executes === false);
  check("só conta ordem não cancelada DENTRO do período: total 30.000 (20.000 Alfa + 5.000 Beta + 5.000 Gama)", c.totalSpend === 30000 && c.suppliers.length === 3);
  check("parcela por fornecedor, do maior pro menor (Alfa 66,67% · Beta 16,67% · Gama 16,67%)", c.suppliers[0].supplierName === "Atacado Alfa" && c.suppliers[0].sharePct === 66.67 && c.suppliers[0].orders === 3 && c.suppliers[1].sharePct === 16.67 && c.topSharePct === 66.67);
  check("HHI ≈ 5.000 e faixa 'high' (maior ≥ 50%)", c.hhi != null && c.hhi >= 4999 && c.hhi <= 5002 && c.band === "high");
  check("ordem sem valor fica FORA das parcelas e é contada à parte (null ≠ 0)", c.unpricedOrders === 1 && !c.suppliers.some((s) => s.supplierName === "Distribuidora Beta" && s.orders === 2));
  check("COBERTURA: compra lançada como conta a pagar SEM ordem (10.000) aparece; cancelada, outra categoria e fora do período não", c.coverage.purchasePayablesWithoutOrder === 10000 && c.coverage.payablesWithoutOrderCount === 1 && c.coverage.orderSpend === 30000);
  check("cobertura por ordem = 30.000 ÷ 40.000 = 75% (e avisa que compra por fora não aparece)", c.coverage.orderCoveragePct === 75 && c.caveats.some((x: string) => /compra por fora|Compra por fora/.test(x)));
  check("avisos: concentração é informação, não conselho; limiares declarados sem calibração", c.caveats.some((x: string) => /não conselho/.test(x)) && c.caveats.some((x: string) => /sem calibração/.test(x)));
  check("cobertura baixa (<70%) dispara aviso forte", (() => { const t = S.concentration(A, { from: "2026-04-01", to: "2026-04-30" }); return t.coverage.orderCoveragePct !== null && t.coverage.orderCoveragePct < 70 && t.caveats.some((x: string) => /só \d+(\.\d+)?% das compras/.test(x)); })());
  check("sem ordem e sem conta de compra: cobertura null (não 100%) e totalSpend null", (() => { const t = S.concentration(B, P); return t.coverage.orderCoveragePct === null && t.totalSpend === null && t.band === null && t.hhi === null && t.suppliers.length === 0; })());
  check("um único fornecedor → 'single_supplier'", (() => { const t = S.concentration(A, { from: "2026-02-01", to: "2026-02-28" }); return t.suppliers.length === 1 && t.band === "single_supplier"; })());
  check("faixas medium/low pelos limiares declarados (30% / 50%)", (() => { const C = mkOrg(); order(C, "s1", "S Um", "2026-02-01", 4000); order(C, "s2", "S Dois", "2026-02-02", 3000); order(C, "s3", "S Três", "2026-02-03", 3000); const m = S.concentration(C, P); const D = mkOrg(); for (let i = 0; i < 4; i++) order(D, `t${i}`, `T ${i}`, "2026-02-01", 2500); return m.band === "medium" && S.concentration(D, P).band === "low"; })());
  check("período inválido ou invertido é recusado", thrown(() => S.concentration(A, { from: "2026-13-01" })) === "invalid_period" && thrown(() => S.concentration(A, { from: "2026-06-30", to: "2026-01-01" })) === "invalid_period" && thrown(() => S.concentration(A, { from: "abc" })) === "invalid_period");
  check("rede-fornecedora sem nome cai em 'Fornecedor da rede' e ordem sem fornecedor em 'não identificado' (não some)", (() => { const C = mkOrg(); const poId = order(C, "x", "", "2026-02-01", 1000); db.prepare(`UPDATE purchase_orders SET supplier_contact_id = NULL, supplier_name = NULL WHERE id = ?`).run(poId); const t = S.concentration(C, P); return t.suppliers.length === 1 && t.suppliers[0].supplierKey === "unknown" && /não identificado/.test(t.suppliers[0].supplierName); })());

  // ficha
  const p = S.supplier(A, SUP1, P);
  check("ficha reaproveita o SupplierPerformanceService: entrega prometida 5 × realizada 8 dias (3 ordens), atrasada", p.delivery.measuredOrders === 3 && p.delivery.promisedAvgDays === 5 && p.delivery.realizedAvgDays === 8 && p.delivery.onTime === false);
  check("completude 90% e quantidade pedida/recebida", p.fulfillment.completenessPct === 90 && p.fulfillment.orderedQty === 500 && p.fulfillment.receivedQty === 450);
  check("prazo de pagamento vem das contas a pagar da ordem: média 35 dias em 3 ordens", p.paymentTerm.orders === 3 && p.paymentTerm.avgDays === 35);
  check("variação de preço do MESMO produto (primeira × última): Camisa Polo 10 → 11,50 = +15% (3 compras); Bermuda 0%", (() => { const x = p.priceChanges.find((v: any) => v.productId === "P1")!; const y = p.priceChanges.find((v: any) => v.productId === "P2")!; return x.variationPct === 15 && x.purchases === 3 && x.firstPrice === 10 && x.lastPrice === 11.5 && y.variationPct === 0 && p.priceChanges[0].productId === "P1"; })());
  check("sem ordem no período → not_found; fornecedor não identificado → invalid_supplier; outra empresa não vê", thrown(() => S.supplier(A, "sup-inexistente", P)) === "not_found" && thrown(() => S.supplier(A, "unknown", P)) === "invalid_supplier" && thrown(() => S.supplier(B, SUP1, P)) === "not_found");
  check("confiança: Alfa (3 ordens) média; Beta (2 ordens, 1 sem valor) baixa — e diz o tamanho da amostra", p.confidence.level === "media" && S.supplier(A, SUP2, P).confidence.level === "baixa" && /ordem/.test(p.confidence.reasons[0]));
  check("overview junta a concentração e a ficha de cada fornecedor", (() => { const o = S.overview(A, P); return o.concentration.suppliers.length === 3 && o.suppliers.length === 3; })());

  // pauta de negociação
  const nb = S.negotiationBrief(A, SUP1, P);
  const topics = nb.points.map((x: any) => x.topic);
  check("pauta do Alfa: entrega, completude, variação de preço, volume e prazo de pagamento — cada um com evidência e amostra", ["Prazo de entrega", "Completude", "Variação de preço", "Volume de compra", "Prazo de pagamento"].every((t) => topics.includes(t)) && nb.points.every((x: any) => x.evidence.length > 10 && x.sampleSize >= 1 && x.suggestedAsk.length > 5));
  check("as evidências citam os números reais do histórico (8 vs 5 dias · 90% · +15% · 66,67% · 35 dias)", (() => { const e = (t: string) => nb.points.find((x: any) => x.topic === t)!.evidence; return /8 dias contra 5/.test(e("Prazo de entrega")) && /90%/.test(e("Completude")) && /\+15%/.test(e("Variação de preço")) && /66[,.]67%/.test(e("Volume de compra")) && /35 dias/.test(e("Prazo de pagamento")); })());
  check("é RASCUNHO: não enviado, humano decide, nunca executa", nb.sent === false && nb.executes === false && nb.decisionOwner === "human" && nb.status === "draft" && /^RASCUNHO — não enviado/.test(nb.draftMessage!));
  check("NÃO inventa desconto, prazo-alvo nem contraproposta: nenhuma sugestão tem número/valor e o texto diz que isso é por conta do dono", nb.points.every((x: any) => !/\d/.test(x.suggestedAsk)) && !/desconto de|reduzir para|aceitamos|oferecemos/i.test(nb.draftMessage!) && /por sua conta/.test(nb.draftMessage!));
  check("não acusa o fornecedor: avisa que diferença não prova culpa (RN-F4-8)", nb.caveats.some((x: string) => /não prova culpa/.test(x)));
  check("amostra mínima: Gama tem 1 ordem atrasada → o ponto de entrega é OMITIDO e a omissão é dita", (() => { const g = S.negotiationBrief(A, SUP3, P); return MIN_ORDERS === 2 && !g.points.some((x: any) => x.topic === "Prazo de entrega") && g.omitted.some((x: string) => /Prazo de entrega.*amostra insuficiente/.test(x)); })());
  check("sem fato que se sustente → insufficient_history, sem texto de rascunho", (() => { const g = S.negotiationBrief(A, SUP3, P), b2 = S.negotiationBrief(A, SUP2, P); return g.status === "insufficient_history" && g.draftMessage === null && g.points.length === 0 && b2.status === "insufficient_history" && b2.draftMessage === null; })());
  check("reconhece o que vai bem: fornecedor pontual e completo vira 'reconhecer'", (() => { const C = mkOrg(); order(C, "ok", "Pontual SA", "2026-02-01", 1000, { promised: 5, receivedAt: "2026-02-04 00:00:00", items: [{ pid: "Q1", pname: "Item", price: 1, qty: 10, recv: 10 }] }); order(C, "ok", "Pontual SA", "2026-03-01", 1000, { promised: 5, receivedAt: "2026-03-04 00:00:00", items: [{ pid: "Q1", pname: "Item", price: 1, qty: 10, recv: 10 }] }); const r = S.negotiationBrief(C, "ok", P); return r.positives.length === 2 && r.points.every((x: any) => x.topic !== "Prazo de entrega"); })());
  check("o volume só vira ponto para quem tem ≥ 30% (Beta e Gama, com ~17%, não)", !S.negotiationBrief(A, SUP2, P).points.some((x: any) => x.topic === "Volume de compra") && !S.negotiationBrief(A, SUP3, P).points.some((x: any) => x.topic === "Volume de compra"));
  check("read-only: nada foi criado/alterado (ordens, cotações, contas, ações, sinais, tarefas)", cnt() === before);

  // rotas
  const { default: router } = await import("../src/server/routes/health.js");
  const express = (await import("express")).default;
  const mkU = (org: string, role: string, key: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, ?, 'active')`).run(id, org, `${id}@t.local`, role); const pid = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id; return { userId: id, id, role, role_profile_id: pid }; };
  const who: any = { dono: mkU(A, "owner", "owner"), vend: mkU(A, "agent", "vendedor") };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-anon"] ? undefined : A; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/health-center", router);
  const server = http.createServer(app); await new Promise<void>((x) => server.listen(0, x));
  const port = (server.address() as any).port;
  const get = async (u: string, user: string, anon = false) => { const x = await fetch(`http://127.0.0.1:${port}/api/health-center${u}`, { headers: { "x-user": user, ...(anon ? { "x-anon": "1" } : {}) } }); return { status: x.status, body: await x.json().catch(() => ({})) as any }; };
  const q = "?from=2026-01-01&to=2026-06-30";
  const r1 = await get(`/suppliers/concentration${q}`, "dono"), r2 = await get(`/suppliers/overview${q}`, "dono"), r3 = await get(`/suppliers/${SUP1}${q}`, "dono"), r4 = await get(`/suppliers/${SUP1}/negotiation-brief${q}`, "dono");
  check("rotas: gestor lê concentração, visão geral, ficha e pauta (200); '/overview' e '/concentration' não são confundidos com :key", r1.status === 200 && r1.body.type === "supplier_concentration" && r2.status === 200 && r2.body.type === "supplier_overview" && r3.status === 200 && r3.body.type === "supplier_profile" && r4.status === 200 && r4.body.type === "negotiation_brief" && r4.body.sent === false);
  check("rotas: vendedor não vê valor de compra (403 nas 4); sem empresa → 401", (await get(`/suppliers/concentration${q}`, "vend")).status === 403 && (await get(`/suppliers/overview${q}`, "vend")).status === 403 && (await get(`/suppliers/${SUP1}${q}`, "vend")).status === 403 && (await get(`/suppliers/${SUP1}/negotiation-brief${q}`, "vend")).status === 403 && (await get(`/suppliers/concentration${q}`, "dono", true)).status === 401);
  check("rotas: fornecedor sem ordem → 404; período inválido → 400 com código", (await get(`/suppliers/nao-existe${q}`, "dono")).status === 404 && (await get("/suppliers/concentration?from=abc", "dono")).body.code === "invalid_period");
  server.close();

  const src = fs.readFileSync(path.join(process.cwd(), "src/server/SupplierIntelligenceService.ts"), "utf8").replace(/\/\*\*[\s\S]*?\*\//g, "");
  check("RN-F4-11: compõe o SupplierPerformanceService (entrega/completude/divergência) e não relê recebimentos por conta própria", /SupplierPerformanceService\.metricsFor/.test(src) && !/goods_receipt/.test(src));
  check("RN-F4-1/2: nunca grava nem contata fornecedor (sem INSERT/UPDATE/DELETE, mensagem, comando, ação ou sinal)", !/\b(INSERT|UPDATE|DELETE)\b|MessageProvider|sendMessage|CommandExecutor|DecisionActionService|BusinessSignalService|ApprovalPolicy/.test(src));

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
