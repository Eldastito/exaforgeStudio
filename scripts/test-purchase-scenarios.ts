/**
 * TESTE — ADR-204 F3.9 (compras, SÓ ANÁLISE): cenários de compra conservador/base/otimista ligando caixa de 13 semanas + cobertura/encalhe + reserva saudável.
 * Prova: nunca executa (executes:false, nada de pedido/ação/pagamento) · cenários ordenados e coerentes · compra que fura o caixa conservador → not_recommended + orçamento máximo +
 * rascunho de contraproposta NÃO enviado · dado ausente → null/caveat (nunca 0) e insufficient_data · giro não medido → sem encalhe · caixa mínimo default declarado ·
 * semana de pagamento muda o aperto · isolamento · rota só pro gestor.
 * Uso: npm run test:purchase-scenarios
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pscen-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pscen-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }
const DAY = 86400e3;
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const mondayOf = (d: Date) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PurchaseScenarioService: S } = await import("../src/server/PurchaseScenarioService.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const week0 = mondayOf(new Date());
  const inWeek = (w: number) => fmt(new Date(week0.getTime() + (w * 7 + 2) * DAY));
  const sale = (org: string, total: number, cost: number) => { const oid = randomUUID(); db.prepare("INSERT INTO comigo_orders (id, organization_id, status, total) VALUES (?, ?, 'paid', ?)").run(oid, org, total); db.prepare("INSERT INTO comigo_order_items (id, order_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, 'Item', 1, ?, ?)").run(randomUUID(), oid, total, cost); };
  const stock = (org: string, pid: string, qty: number, cost: number, withOut: boolean) => { db.prepare("INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), org, pid, qty, cost); if (withOut) db.prepare("INSERT INTO stock_movements (id, organization_id, product_service_id, type, quantity) VALUES (?, ?, ?, 'saida', 1)").run(randomUUID(), org, pid); };

  // Org A: caixa 10.000; aluguel 3.000 na semana 5; vendas 30×R$40 (margem 50% → CMV/dia = 20); estoque R$500 com giro medido.
  const A = mkOrg();
  F.recordEvent(A, { direction: "in", amount: 10000 });
  F.addPayable(A, { description: "Aluguel", amount: 3000, dueDate: inWeek(5) });
  F.addReceivable(A, { description: "Cliente", amount: 2000, dueDate: inWeek(2), probability: 1 });
  for (let i = 0; i < 30; i++) sale(A, 40, 20);
  stock(A, "pA", 5, 100, true);
  const snap = () => JSON.stringify(["decision_actions", "purchase_orders", "purchase_requisitions", "payables"].map((t) => { try { return (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE organization_id = ?`).get(A) as any).c; } catch { return -1; } }));

  // 1) validação
  const bad: any = S.analyze(A, { amount: 0 });
  check("valor inválido → ok:false, executes:false", bad.ok === false && bad.reason === "valor_invalido" && bad.executes === false && !S.analyze(A, { amount: "abc" } as any).ok);

  // 2) compra pequena
  const before = snap();
  const small: any = S.analyze(A, { amount: 500 });
  check("sempre executes:false e nada de pedido/ação/conta criado", small.executes === false && snap() === before);
  check("3 cenários na ordem conservador/base/otimista", small.scenarios.map((s: any) => s.key).join() === "conservador,base,otimista");
  const [c, b, o] = small.scenarios;
  check("compra pequena: nenhum cenário fura o caixa e cobertura ≤ 60d no base", !c.breachesMinCash && !b.breachesMinCash && b.coverageDaysAfter === 50, JSON.stringify(b));
  check("cenários coerentes: venda mais lenta ⇒ mais dias de cobertura; caixa conservador ≤ base ≤ otimista", c.coverageDaysAfter > b.coverageDaysAfter && b.coverageDaysAfter > o.coverageDaysAfter && c.minEndingWith <= b.minEndingWith && b.minEndingWith <= o.minEndingWith);
  check("a compra reduz o caixa mínimo exatamente no valor (base)", Math.abs((b.minEndingWithout - b.minEndingWith) - 500) < 0.02, `${b.minEndingWithout} vs ${b.minEndingWith}`);
  check("payback/lucro bruto estimado (margem 50% → compra 500 rende ~500)", b.sellThroughDays === 25 && b.grossProfitIfSold === 500);
  check("caixa mínimo não informado → padrão 0 declarado no caveat", small.minCashSource === "padrao_zero" && small.caveats.some((x: string) => /Caixa mínimo não informado/.test(x)));
  check("premissas declaradas (±30%, semana de pagamento)", small.assumptions.some((x: string) => /±30%/.test(x)) && small.assumptions.some((x: string) => /semana/.test(x)));
  check("estoque: capital e cobertura atual (500/20 = 25 dias), giro medido", small.stock.totalCapital === 500 && small.stock.currentCoverageDays === 25 && small.stock.giroMeasured === true);

  // 3) compra grande fura o caixa conservador
  const big: any = S.analyze(A, { amount: 14000, minCash: 1000 });
  check("compra que fura o caixa conservador → not_recommended com o motivo", big.verdict === "not_recommended" && big.scenarios[0].breachesMinCash && big.reasons.some((x: string) => /conservador/.test(x)));
  check("caixa mínimo informado é respeitado (fonte 'informado')", big.minCashSource === "informado" && big.minCash === 1000);
  check("orçamento máximo recomendado < valor pedido, com a base declarada", big.recommendedMaxBudget.amount != null && big.recommendedMaxBudget.amount < 14000 && /caixa|cobertura/.test(big.recommendedMaxBudget.basis));
  check("rascunho de contraproposta existe, diz que NÃO foi enviado e não inventa fornecedor", /RASCUNHO \(não enviado/.test(big.counterproposalDraft) && !/Ltda|S\.A\./i.test(big.counterproposalDraft));
  check("compra dentro do orçamento NÃO gera contraproposta", small.counterproposalDraft === null);
  const atMax: any = S.analyze(A, { amount: big.recommendedMaxBudget.amount, minCash: 1000 });
  check("comprar exatamente o orçamento máximo não fura o caixa conservador", atMax.ok && !atMax.scenarios[0].breachesMinCash);

  // 4) semana do pagamento
  const early: any = S.analyze(A, { amount: 9000, payInWeeks: 0 }), late: any = S.analyze(A, { amount: 9000, payInWeeks: 12 });
  check("pagar mais tarde alivia o caixa (mín com pagamento na sem 12 ≥ na sem 0)", late.scenarios[1].minEndingWith >= early.scenarios[1].minEndingWith && late.payInWeeks === 12);

  // 5) cobertura exagerada
  const cover: any = S.analyze(A, { amount: 3000 });
  check("cobertura > 120 dias no base → not_recommended", cover.scenarios[1].coverageDaysAfter > 120 && cover.verdict === "not_recommended");

  // 6) dado ausente → null/caveat, nunca 0
  const E = mkOrg();
  const empty: any = S.analyze(E, { amount: 1000 });
  check("org vazia: insufficient_data, campos null (não 0) e caveats", empty.ok && empty.verdict === "insufficient_data" && empty.scenarios[1].coverageDaysAfter === null && empty.scenarios[1].grossProfitIfSold === null && empty.stock.currentCoverageDays === null && empty.caveats.length >= 2);
  check("org vazia: sem base de orçamento não inventa número", empty.recommendedMaxBudget.amount === 0 || empty.recommendedMaxBudget.amount === null);

  // 7) giro não medido → sem encalhe
  const G = mkOrg(); F.recordEvent(G, { direction: "in", amount: 5000 }); for (let i = 0; i < 30; i++) sale(G, 40, 20); stock(G, "pG", 5, 100, false);
  const sg: any = S.analyze(G, { amount: 500 });
  check("sem saídas registradas: giro não medido, encalhe null e caveat", sg.stock.giroMeasured === false && sg.stock.estIdle === null && sg.caveats.some((x: string) => /giro/.test(x)));

  // 8) isolamento
  check("dado de outra empresa não vaza (A tem estoque 500; E não)", small.stock.totalCapital === 500 && empty.stock.totalCapital === 0);

  // 9) rota: só gestor
  const { default: router } = await import("../src/server/routes/health.js");
  const express = (await import("express")).default;
  const profile = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id;
  const mkUser = (org: string, role: string, key: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, ?, 'active')`).run(id, org, `${id}@t.local`, role); return { userId: id, id, role, role_profile_id: profile(org, key) }; };
  const who: any = { dono: mkUser(A, "owner", "owner"), vend: mkUser(A, "agent", "vendedor") };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-anon"] ? undefined : A; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/health-center", router);
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const post = async (user: string, body: any, anon = false) => { const r = await fetch(`http://127.0.0.1:${port}/api/health-center/simulate/purchase-scenarios`, { method: "POST", headers: { "Content-Type": "application/json", "x-user": user, ...(anon ? { "x-anon": "1" } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const rd = await post("dono", { amount: 500 });
  check("rota: gestor recebe a análise (200) com executes:false", rd.status === 200 && rd.body.ok && rd.body.executes === false && rd.body.scenarios.length === 3);
  check("rota: vendedor (sem visão completa) → 403, sem números", (await post("vend", { amount: 500 })).status === 403);
  check("rota: valor inválido → 400; sem empresa → 401", (await post("dono", { amount: -5 })).status === 400 && (await post("dono", { amount: 5 }, true)).status === 401);
  server.close();

  const ui = fs.readFileSync(path.join(process.cwd(), "src/features/HealthCenterView.tsx"), "utf8");
  check("UI Simulador: modo 'Cenários de compra' consome a rota e mostra 'só análise' + rascunho sem enviar", /simulate\/purchase-scenarios/.test(ui) && /purchase-scenarios"/.test(ui) && /nada foi pedido, pago nem enviado/.test(ui) && /counterproposalDraft/.test(ui) && /res\.message \|\| res\.error/.test(ui));
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
