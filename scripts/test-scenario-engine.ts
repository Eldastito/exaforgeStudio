/**
 * TESTE — ADR-205 F4.1: ScenarioEngine (contrato único de simulação sobre os simuladores existentes).
 * Prova: cenário ≠ previsão · nunca executa/grava · premissas com origem (data/default/user), editáveis e versionadas · faixa sem falsa precisão ·
 * dado ausente → null/confiança baixa (nunca 0) · confiança limitada enquanto o piloto não validou · sensibilidade re-roda o cálculo canônico e ordena ·
 * casos obrigatórios do PRD §54 que a F4.1 cobre (venda −20%/+20%, preço do fornecedor, prazo, compra grande, contratação) · isolamento · rota só do gestor.
 * Uso: npm run test:scenario-engine
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-scen-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-scen-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }
const DAY = 86400e3;
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const mondayOf = (d: Date) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const E = await import("../src/server/ScenarioEngine.js");
  const { ScenarioEngine: S, toRange, PILOT_VALIDATED, SCENARIO_ENGINE_VERSION } = E;
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const week0 = mondayOf(new Date());
  const inWeek = (w: number) => fmt(new Date(week0.getTime() + (w * 7 + 2) * DAY));
  const sale = (org: string, total: number, cost: number) => { const oid = randomUUID(); db.prepare("INSERT INTO comigo_orders (id, organization_id, status, total) VALUES (?, ?, 'paid', ?)").run(oid, org, total); db.prepare("INSERT INTO comigo_order_items (id, order_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, 'Item', 1, ?, ?)").run(randomUUID(), oid, total, cost); };
  const stock = (org: string, pid: string, qty: number, cost: number) => { db.prepare("INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), org, pid, qty, cost); db.prepare("INSERT INTO stock_movements (id, organization_id, product_service_id, type, quantity) VALUES (?, ?, ?, 'saida', 1)").run(randomUUID(), org, pid); };

  // Org A (mesmo cenário do test:purchase-scenarios): caixa 10.000; aluguel 3.000 sem 5; recebível 2.000 sem 2; 30 vendas×R$40 (margem 50% → receita 30d = 1.200); estoque R$500.
  const A = mkOrg();
  F.recordEvent(A, { direction: "in", amount: 10000 });
  F.addPayable(A, { description: "Aluguel", amount: 3000, dueDate: inWeek(5) });
  F.addReceivable(A, { description: "Cliente", amount: 2000, dueDate: inWeek(2), probability: 1 });
  for (let i = 0; i < 30; i++) sale(A, 40, 20);
  stock(A, "pA", 5, 100);
  const Z = mkOrg(); // vazia
  const snap = () => JSON.stringify(["decision_actions", "purchase_orders", "purchase_requisitions", "payables", "receivables", "financial_events"].map((t) => { try { return (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE organization_id = ?`).get(A) as any).c; } catch { return -1; } }));

  // 1) contrato
  const before = snap();
  const outs: any = { purchase: S.run(A, "purchase", { amount: 500 }), sales_change: S.run(A, "sales_change", { changePct: -20 }), hire: S.run(A, "hire", { monthlyCost: 600 }) };
  for (const k of Object.keys(outs)) {
    const o = outs[k];
    check(`${k}: contrato (scenario, não previsão, não executa, versão, premissas, confiança)`, o.ok && o.type === "scenario" && o.isForecast === false && o.executes === false && o.kind === k && o.engineVersion === SCENARIO_ENGINE_VERSION && /^[0-9a-f]{12}$/.test(o.assumptionsVersion) && o.assumptions.length > 0 && !!o.confidence?.level, JSON.stringify(o).slice(0, 200));
    check(`${k}: o texto diz "não é uma previsão" e não promete`, /não é uma previsão|Não é uma previsão/.test(o.statement) && !/vai (acontecer|render|vender)|certamente|garant/i.test(o.statement), o.statement);
  }
  check("nada é criado/gravado/pago por nenhuma simulação (RN-F4-1)", snap() === before);

  // 2) validação
  const uk: any = S.run(A, "nova_loja", {}), ua: any = S.run(A, "purchase", { amount: 500, margem: 90 });
  check("tipo desconhecido e premissa desconhecida são recusados (sem cenário inventado)", uk.ok === false && uk.reason === "unknown_kind" && ua.ok === false && ua.reason === "unknown_assumption");
  check("premissa inválida: compra sem valor, venda sem %, variação fora da faixa, contratação sem custo", S.run(A, "purchase", {}).ok === false && S.run(A, "sales_change", {}).reason === "premissa_invalida" && S.run(A, "sales_change", { changePct: -100 }).reason === "premissa_fora_da_faixa" && S.run(A, "hire", {}).ok === false);

  // 3) faixa
  const r1 = toRange([1283472.19], "BRL"), r2 = toRange([1150000, 1350000], "BRL"), r3 = toRange([12345, 9876], "BRL"), r4 = toRange([], "BRL"), r5 = toRange([null, undefined], "dias");
  check("faixa: valor pontual vira ≈ arredondado, nunca centavos (R$ 1.283.472,19 → ≈ R$ 1,28 mi)", r1.display === "≈ R$ 1,28 mi", String(r1.display));
  check("faixa em milhões: R$ 1,15 mi – R$ 1,35 mi", r2.display === "R$ 1,15 mi – R$ 1,35 mi", String(r2.display));
  check("faixa < 1 mi: 2 algarismos e sem centavos; low ≤ high", r3.display === "R$ 9.900 – R$ 12.000" && r3.low! <= r3.high!, String(r3.display));
  check("sem valores → null (não 0)", r4.display === null && r4.low === null && r5.display === null);
  const anyCents = (o: any) => JSON.stringify(o.metrics.map((m: any) => m.range.display)).match(/R\$ -?[\d.]+,\d{2}(?! mi)/);
  check("nenhuma faixa exibida traz centavos", !anyCents(outs.purchase) && !anyCents(outs.sales_change) && !anyCents(outs.hire));

  // 4) premissas: origem, edição e versão
  const p500: any = outs.purchase, p9: any = S.run(A, "purchase", { amount: 9000, minCash: 1000, payInWeeks: 3 });
  const src = (o: any, k: string) => o.assumptions.find((x: any) => x.key === k);
  check("origem das premissas: informada=user, omitida=default (declarada), medida=data", src(p500, "amount").source === "user" && src(p500, "minCash").source === "default" && !!src(p500, "minCash").note && src(p9, "minCash").source === "user" && src(p9, "payInWeeks").source === "user" && src(p500, "margin").source === "data");
  check("só são editáveis as premissas do usuário; as do motor (±30%, margem, horizonte) não", src(p500, "amount").editable && src(p500, "salesSpeedFactor").editable === false && src(p500, "margin").editable === false && src(p500, "horizon").editable === false);
  check("alterar a premissa muda a versão e o resultado; repetir não muda", p500.assumptionsVersion !== p9.assumptionsVersion && S.run(A, "purchase", { amount: 500 }).assumptionsVersion === p500.assumptionsVersion && p500.metrics[0].base !== p9.metrics[0].base);

  // 5) casos do PRD §54 — compra
  const base = (o: any) => o.metrics[0].base as number, cons = (o: any) => o.metrics[0].conservative as number, fav = (o: any) => o.metrics[0].favorable as number;
  check("compra: conservador ≤ base ≤ favorável no menor caixa (3 cenários)", p500.cases === "three" && cons(p500) <= base(p500) && base(p500) <= fav(p500));
  const big: any = S.run(A, "purchase", { amount: 14000, minCash: 1000 });
  check("compra grande de coleção: fura o caixa conservador (menor caixa < mínimo) e o veredito é 'not_recommended'", big.ok && cons(big) < 1000 && big.verdict === "not_recommended");
  const price: any = S.run(A, "purchase", { amount: 10800 }), price0: any = S.run(A, "purchase", { amount: 9000 });
  check("fornecedor aumenta o preço (+20%): o menor caixa piora em ~R$ 1.800", base(price0) - base(price) > 1790 && base(price0) - base(price) < 1810, `${base(price0)} → ${base(price)}`);
  const pre: any = S.run(A, "purchase", { amount: 9000, payInWeeks: 0 }), post: any = S.run(A, "purchase", { amount: 9000, payInWeeks: 6 });
  check("prazo reduz (pagar antes) nunca melhora o menor caixa", cons(pre) <= cons(post));

  // 6) sensibilidade
  const sens = price0.sensitivity;
  check("sensibilidade: ranqueada (1..n), com a saída medida e 'swing' numérico em ordem decrescente", sens.length === 2 && sens[0].rank === 1 && sens[1].rank === 2 && sens[0].swing >= sens[1].swing && sens.every((r: any) => typeof r.swing === "number" && /caixa/i.test(r.output)));
  check("a variável que mais move o caixa conservador é o valor da compra (±20% de 9.000 ⇒ ~R$ 3.600)", sens[0].driver === "amount" && Math.abs(sens[0].swing - 3600) < 5, JSON.stringify(sens));
  check("a sensibilidade declara o que NÃO modela (entrada, markdown)", price0.caveats.some((c: string) => /entrada/.test(c) && /markdown|remarcação/.test(c)));

  // 7) vendas ±X%
  const dn: any = outs.sales_change, up: any = S.run(A, "sales_change", { changePct: 20 });
  const m = (o: any, k: string) => o.metrics.find((x: any) => x.key === k);
  check("venda cai 20%: receita 1.200 → 960 e lucro bruto −R$ 120/mês", dn.cases === "single" && m(dn, "revenue_today").base === 1200 && m(dn, "revenue_with_change").base === 960 && m(dn, "gross_profit_delta").base === -120, JSON.stringify(dn.metrics.map((x: any) => x.base)));
  check("venda cresce 20%: receita → 1.440 e lucro bruto +R$ 120/mês", m(up, "revenue_with_change").base === 1440 && m(up, "gross_profit_delta").base === 120);
  check("sensibilidade das vendas: a variação % pesa mais que 5 p.p. de margem", dn.sensitivity[0].driver === "changePct" && dn.sensitivity[0].swing === 120 && dn.sensitivity[1].driver === "margin" && dn.sensitivity[1].swing === 24, JSON.stringify(dn.sensitivity));
  check("não afirma resultado nem ponto de equilíbrio: custos fixos ficam de fora, declarado", dn.caveats.some((c: string) => /Custos fixos/.test(c)) && !/ponto de equilíbrio (é|será)/.test(dn.statement));
  const noSales: any = S.run(Z, "sales_change", { changePct: -20 });
  check("sem vendas nem base informada → recusa com motivo (não inventa)", noSales.ok === false && noSales.reason === "sem_vendas");
  const noMargin: any = S.run(Z, "sales_change", { changePct: -20, baseRevenue30: 50000 });
  check("base informada pelo usuário, sem margem: receita calculada, lucro null (não 0), confiança baixa, origem 'user'", noMargin.ok && m(noMargin, "gross_profit_delta").base === null && noMargin.confidence.level === "baixa" && noMargin.assumptions.find((x: any) => x.key === "baseRevenue30").source === "user" && m(noMargin, "gross_profit_delta").range.display === null);

  // 8) contratação
  const h: any = outs.hire;
  check("contratação (R$ 600/mês, margem 50%): precisa de R$ 1.200/mês a mais = 100% da receita de hoje", m(h, "extra_revenue_needed").base === 1200 && m(h, "pct_of_current").base === 100, JSON.stringify(h.metrics.map((x: any) => x.base)));
  check("contratação: sensibilidade ao custo (±20% de 600 ⇒ R$ 480) e aviso de que não estima quanto o contratado vende", h.sensitivity[0].driver === "monthlyCost" && Math.abs(h.sensitivity[0].swing - 480) < 0.5 && h.caveats.some((c: string) => /não estima o quanto/i.test(c)));
  check("contratação sem margem cadastrada → recusa com motivo", S.run(Z, "hire", { monthlyCost: 600 }).ok === false);

  // 9) confiança
  check("gate do piloto: PILOT_VALIDATED=false ⇒ nenhuma confiança 'alta', com o motivo dito", PILOT_VALIDATED === false && [p500, dn, h].every((o: any) => o.confidence.level !== "alta") && p500.confidence.reasons.some((r: string) => /não foram conferidos|em uso real/.test(r)), JSON.stringify(p500.confidence));
  const ze: any = S.run(Z, "purchase", { amount: 1000 });
  check("org sem dados: compra com confiança baixa, cobertura null (não 0) e veredito insufficient_data", ze.ok && ze.confidence.level === "baixa" && ze.metrics.find((x: any) => x.key === "coverage_days_after").base === null && ze.verdict === "insufficient_data");
  check("dado ausente reduz a confiança e é dito (razões não vazias)", ze.confidence.reasons.length > 0);

  // 10) isolamento
  check("isolamento: a org vazia não herda caixa/estoque/vendas da org A", ze.metrics[0].base !== p500.metrics[0].base && S.run(Z, "hire", { monthlyCost: 600 }).ok === false);

  // 11) rota
  const { default: router } = await import("../src/server/routes/health.js");
  const express = (await import("express")).default;
  const mkU = (org: string, role: string, key: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, ?, 'active')`).run(id, org, `${id}@t.local`, role); const pid = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id; return { userId: id, id, role, role_profile_id: pid }; };
  const who: any = { dono: mkU(A, "owner", "owner"), vend: mkU(A, "agent", "vendedor") };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-anon"] ? undefined : A; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/health-center", router);
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (m: string, u: string, user: string, body?: any, anon = false) => { const r = await fetch(`http://127.0.0.1:${port}/api/health-center${u}`, { method: m, headers: { "Content-Type": "application/json", "x-user": user, ...(anon ? { "x-anon": "1" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const rd = await call("POST", "/simulate/scenario", "dono", { kind: "sales_change", inputs: { changePct: -20 } });
  check("rota: gestor recebe o cenário (200), executes:false", rd.status === 200 && rd.body.ok && rd.body.executes === false && rd.body.kind === "sales_change");
  check("rota: vendedor → 403 sem números", (await call("POST", "/simulate/scenario", "vend", { kind: "hire", inputs: { monthlyCost: 600 } })).status === 403);
  check("rota: kind desconhecido → 400; sem empresa → 401", (await call("POST", "/simulate/scenario", "dono", { kind: "nova_loja" })).status === 400 && (await call("POST", "/simulate/scenario", "dono", { kind: "hire", inputs: { monthlyCost: 1 } }, true)).status === 401);
  const kinds = await call("GET", "/simulate/scenario/kinds", "dono");
  check("rota: catálogo lista os 3 tipos e as premissas editáveis de cada um", kinds.status === 200 && kinds.body.kinds.map((k: any) => k.kind).join() === "purchase,sales_change,hire" && kinds.body.kinds.every((k: any) => k.inputs.length > 0));
  server.close();

  // 12) §42: nada de motor financeiro paralelo
  const src2 = fs.readFileSync(path.join(process.cwd(), "src/server/ScenarioEngine.ts"), "utf8");
  check("RN-F4-11: o motor não toca o banco nem recalcula caixa/estoque (só compõe os serviços existentes)", !/from "\.\/db\.js"/.test(src2) && /PurchaseScenarioService/.test(src2) && /DecisionSimulatorService/.test(src2) && !/db\.prepare/.test(src2));

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
