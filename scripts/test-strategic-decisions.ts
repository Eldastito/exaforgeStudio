/**
 * TESTE — ADR-205 F4.2: decisão estratégica → hipótese → resultado real (StrategicDecisionService).
 * Prova: registrar NUNCA executa · só dono/admin · snapshot do cenário congelado e calculado no servidor · faixa esperada (e tolerância declarada p/ caso único) ·
 * resultado append-only (última vale) · comparação dentro/abaixo/acima, sem expectativa/sem resultado nunca "acerta" · calibração com Wilson (null sem amostra) ·
 * lembrete de revisão via business_signals (idempotente, resolve sozinho) · diretriz (memória) revisável · isolamento · rotas · Scheduler ligado.
 * Uso: npm run test:strategic-decisions
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-strat-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-strat-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }
const DAY = 86400e3;
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const mondayOf = (d: Date) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { StrategicDecisionService: S } = await import("../src/server/StrategicDecisionService.js");
  const { ScenarioEngine } = await import("../src/server/ScenarioEngine.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const week0 = mondayOf(new Date());
  const inWeek = (w: number) => fmt(new Date(week0.getTime() + (w * 7 + 2) * DAY));
  const sale = (org: string, total: number, cost: number) => { const oid = randomUUID(); db.prepare("INSERT INTO comigo_orders (id, organization_id, status, total) VALUES (?, ?, 'paid', ?)").run(oid, org, total); db.prepare("INSERT INTO comigo_order_items (id, order_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, 'Item', 1, ?, ?)").run(randomUUID(), oid, total, cost); };
  const stock = (org: string, pid: string, qty: number, cost: number) => { db.prepare("INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), org, pid, qty, cost); db.prepare("INSERT INTO stock_movements (id, organization_id, product_service_id, type, quantity) VALUES (?, ?, ?, 'saida', 1)").run(randomUUID(), org, pid); };
  const A = mkOrg(), B = mkOrg();
  F.recordEvent(A, { direction: "in", amount: 10000 }); F.addPayable(A, { description: "Aluguel", amount: 3000, dueDate: inWeek(5) }); F.addReceivable(A, { description: "Cliente", amount: 2000, dueDate: inWeek(2), probability: 1 });
  for (let i = 0; i < 30; i++) sale(A, 40, 20); stock(A, "pA", 5, 100);
  const owner = { userId: "u-owner", role: "owner" }, agent = { userId: "u-agent", role: "agent" };
  const today = fmt(new Date()), future = fmt(new Date(Date.now() + 10 * DAY)), past = fmt(new Date(Date.now() - 10 * DAY));
  const thrown = (f: () => any) => { try { f(); return null; } catch (e: any) { return e?.code || "error"; } };
  const cnt = (t: string, org = A) => (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE organization_id = ?`).get(org) as any).c;
  const snap = () => JSON.stringify(["decision_actions", "purchase_orders", "purchase_requisitions", "payables", "receivables", "tasks"].map((t) => { try { return cnt(t); } catch { return -1; } }));

  // 1) registrar compra: snapshot, faixa esperada, nada executa
  const before = snap();
  const d1 = S.register(A, owner, { category: "purchase", title: "Comprar coleção de verão", hypothesis: "Vende em 90 dias", reviewOn: future, inputs: { amount: 9000, minCash: 1000, payInWeeks: 3 } });
  const sc = ScenarioEngine.run(A, "purchase", { amount: 9000, minCash: 1000, payInWeeks: 3 });
  check("registrar NÃO cria ação/pedido/conta/tarefa (RN-F4-1) e nasce 'considering', executes:false", snap() === before && d1.status === "considering" && d1.executes === false);
  check("o cenário foi calculado PELO SERVIDOR e congelado (versão de premissas = a do motor)", d1.scenario?.type === "scenario" && d1.assumptionsVersion === sc.assumptionsVersion && d1.engineVersion === sc.engineVersion && d1.scenario.assumptionsVersion === sc.assumptionsVersion);
  const m0 = sc.metrics!.find((m) => m.key === "min_cash_with_purchase")!;
  check("faixa esperada = faixa do cenário (menor caixa conservador..favorável)", d1.expectation.metric === "min_cash_with_purchase" && d1.expectation.low === m0.range.low && d1.expectation.high === m0.range.high && d1.expectation.toleranceDeclared === null);
  check("guarda a confiança do cenário na hora da decisão (limitada a média)", d1.confidenceAtDecision === "media" || d1.confidenceAtDecision === "baixa");

  // 2) validação e permissão
  check("só dono/admin registra (vendedor → forbidden)", thrown(() => S.register(A, agent, { category: "other", title: "Teste" })) === "forbidden" && thrown(() => S.register(A, { role: "owner" }, { category: "other", title: "Teste" })) === "forbidden");
  const n0 = cnt("strategic_decisions");
  check("categoria inválida, título curto, data passada/inválida, tolerância inválida e premissa de cenário inválida são recusados SEM gravar",
    thrown(() => S.register(A, owner, { category: "nova_loja", title: "X" })) === "invalid_category" && thrown(() => S.register(A, owner, { category: "other", title: "ab" })) === "invalid_title"
    && thrown(() => S.register(A, owner, { category: "other", title: "Ok ok", reviewOn: past })) === "invalid_review_date" && thrown(() => S.register(A, owner, { category: "other", title: "Ok ok", reviewOn: "amanhã" })) === "invalid_review_date"
    && thrown(() => S.register(A, owner, { category: "purchase", title: "Compra", tolerancePct: 500, inputs: { amount: 100 } })) === "invalid_tolerance"
    && thrown(() => S.register(A, owner, { category: "purchase", title: "Compra", inputs: {} })) === "scenario_failed" && thrown(() => S.register(A, owner, { category: "principle", title: "Diretriz", inputs: { x: 1 } })) === "invalid_input"
    && cnt("strategic_decisions") === n0);
  check("texto livre: controle removido, truncado (dado do dono, não instrução)", (() => { const d = S.register(A, owner, { category: "other", title: "  Linha1\n\tLinha2\u0007 " + "x".repeat(300), hypothesis: "h".repeat(5000) }); return !/[\n\t\u0007]/.test(d.title) && d.title.length <= 160 && d.hypothesis.length === 1000; })());

  // 3) decidir
  check("decidir: só 'decided'/'rejected', só uma vez, só dono; registra quem e quando", thrown(() => S.decide(A, d1.id, agent, { status: "decided" })) === "forbidden" && thrown(() => S.decide(A, d1.id, owner, { status: "talvez" })) === "invalid_status");
  const dd = S.decide(A, d1.id, owner, { status: "decided", rationale: "Caixa aguenta" });
  check("decidida: status, decidedBy e rationale", dd.status === "decided" && dd.decidedBy === "u-owner" && !!dd.decidedAt && dd.rationale === "Caixa aguenta");
  check("decidir de novo é recusado (invalid_state)", thrown(() => S.decide(A, d1.id, owner, { status: "rejected" })) === "invalid_state");
  const rej = S.decide(A, S.register(A, owner, { category: "other", title: "Abrir quiosque" }).id, owner, { status: "rejected" });
  check("recusar é um desfecho válido e fica registrado", rej.status === "rejected");
  check("auditado, sem PII (só ids/categoria)", (db.prepare("SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type LIKE 'STRATEGIC_DECISION_%'").get(A) as any).c >= 4);

  // 4) snapshot congelado
  for (let i = 0; i < 20; i++) sale(A, 500, 100); F.addPayable(A, { description: "Novo", amount: 8000, dueDate: inWeek(1) });
  const after = S.get(A, d1.id);
  check("snapshot CONGELADO: mudar vendas/caixa depois não altera o cenário nem a faixa esperada (conv. nº 3)", JSON.stringify(after.scenario.metrics) === JSON.stringify(sc.metrics) && after.expectation.low === m0.range.low && after.assumptionsVersion === sc.assumptionsVersion);
  check("…e um cenário NOVO agora já daria outro resultado (prova que o congelamento importa)", JSON.stringify(ScenarioEngine.run(A, "purchase", { amount: 9000, minCash: 1000, payInWeeks: 3 }).metrics) !== JSON.stringify(sc.metrics));

  // 5) resultado + comparação
  check("sem resultado → 'no_actual' (nunca 'acertou')", S.get(A, d1.id).comparison.status === "no_actual" && S.get(A, d1.id).comparison.actual === null);
  check("resultado só em decisão 'decided'; só dono; valor numérico; base fact|estimate", thrown(() => S.recordOutcome(A, S.register(A, owner, { category: "other", title: "Só considerando" }).id, owner, { actual: 1 })) === "invalid_state"
    && thrown(() => S.recordOutcome(A, d1.id, agent, { actual: 1 })) === "forbidden" && thrown(() => S.recordOutcome(A, d1.id, owner, { actual: "abc" })) === "invalid_actual" && thrown(() => S.recordOutcome(A, d1.id, owner, { actual: 1, basis: "chute" })) === "invalid_basis");
  const mid = (m0.range.low! + m0.range.high!) / 2;
  const within = S.recordOutcome(A, d1.id, owner, { actual: mid, basis: "fact", note: "fechamento de dezembro" });
  check("dentro da faixa → 'within', desvio 0, base declarada", within.comparison.status === "within" && within.comparison.deviation === 0 && within.comparison.actual.basis === "fact");
  const below = S.recordOutcome(A, d1.id, owner, { actual: m0.range.low! - 500, basis: "estimate" });
  check("append-only: nova medição vale (a última) e a anterior continua no histórico", below.comparison.status === "below" && below.comparison.deviation === 500 && below.outcomes.length === 2 && cnt("strategic_decision_outcomes") === 2);
  const above = S.recordOutcome(A, d1.id, owner, { actual: m0.range.high! + 100 });
  check("acima da faixa → 'above' com % de desvio e isBacktest:false (resultado real, não promessa)", above.comparison.status === "above" && above.comparison.deviation === 100 && above.comparison.isBacktest === false && above.comparison.deviationPct !== null);

  // 6) caso único: tolerância declarada (org limpa: margem 50% → contratação de R$ 600 exige R$ 1.200)
  const H = mkOrg(); for (let i = 0; i < 30; i++) sale(H, 40, 20);
  const hr = S.register(H, owner, { category: "hire", title: "Contratar vendedor", inputs: { monthlyCost: 600 } });
  check("cenário de caso ÚNICO: faixa = valor ± 20% (tolerância declarada, não dado): 1.200 → 960–1.440", hr.expectation.metric === "extra_revenue_needed" && hr.expectation.low === 960 && hr.expectation.high === 1440 && hr.expectation.toleranceDeclared === 20);
  const hr2 = S.register(H, owner, { category: "hire", title: "Contratar 2", inputs: { monthlyCost: 600 }, tolerancePct: 5 });
  check("a tolerância é editável (5% → 1.140–1.260)", hr2.expectation.low === 1140 && hr2.expectation.high === 1260 && hr2.expectation.toleranceDeclared === 5);
  const sx = S.register(H, owner, { category: "sales_change", title: "Vendas -20%", inputs: { changePct: -20 }, expectMetric: "revenue_with_change" });
  check("métrica esperada escolhível; inexistente é recusada", sx.expectation.metric === "revenue_with_change" && thrown(() => S.register(H, owner, { category: "sales_change", title: "Vendas", inputs: { changePct: -20 }, expectMetric: "lucro_magico" })) === "metric_not_found");

  // 7) diretriz (memória estratégica)
  const pr = S.register(A, owner, { category: "principle", title: "Priorizar margem sobre crescimento", rationale: "Caixa apertado", reviewOn: today });
  check("diretriz não tem cenário nem número esperado: comparação 'no_expectation' (nunca 'acertou')", pr.scenario === null && pr.expectation === null && pr.comparison.status === "no_expectation");
  S.decide(A, pr.id, owner, { status: "decided" });
  check("diretriz decidida aparece nas diretrizes ativas; considerando/recusada não", S.principles(A).map((p: any) => p.id).join() === pr.id);
  const rv = S.revoke(A, pr.id, owner, "Mudou a estratégia");
  check("revogar é revisão explícita: sai das ativas, fica no histórico com o motivo", rv.status === "revoked" && /Revogada: Mudou a estratégia/.test(rv.rationale) && S.principles(A).length === 0 && !!S.get(A, pr.id));
  check("só 'decided' se revoga", thrown(() => S.revoke(A, pr.id, owner, "x")) === "invalid_state" && thrown(() => S.revoke(H, hr.id, owner, "x")) === "invalid_state");

  // 8) calibração
  const C = mkOrg(); for (let i = 0; i < 30; i++) sale(C, 40, 20);
  check("calibração sem amostra: n=0, taxa e intervalo null (não 0%), confiança 'insufficient'", (() => { const c = S.calibration(C); return c.n === 0 && c.hitRate === null && c.interval === null && c.confidence === "insufficient"; })());
  const mk = (title: string, actual: number) => { const d = S.register(C, owner, { category: "hire", title, inputs: { monthlyCost: 600 } }); S.decide(C, d.id, owner, { status: "decided" }); S.recordOutcome(C, d.id, owner, { actual }); return d.id; };
  mk("Contratação 1", 1200); mk("Contratação 2", 1000); mk("Contratação 3", 100); mk("Contratação 4", 5000);
  const cal = S.calibration(C);
  check("calibração: 4 resultados → 1 dentro (1.200), 1 dentro (1.000 ≥ 960), 1 abaixo, 1 acima; taxa 0,5 com intervalo de Wilson", cal.n === 4 && cal.within === 2 && cal.below === 1 && cal.above === 1 && cal.hitRate === 0.5 && cal.interval.lower < 0.5 && cal.interval.upper > 0.5, JSON.stringify(cal));
  check("amostra pequena é dita (intervalo largo ≠ prova) e quebra por categoria", cal.confidence !== "high" && /não é prova/.test(cal.note) && cal.byCategory.hire.n === 4);
  const pendingOnly = S.register(C, owner, { category: "hire", title: "sem resultado", inputs: { monthlyCost: 600 } }); S.decide(C, pendingOnly.id, owner, { status: "decided" });
  check("decisão sem resultado e recusada/revogada NÃO entram na calibração", S.calibration(C).n === 4);

  // 9) lembrete de revisão
  const D = mkOrg(); for (let i = 0; i < 30; i++) sale(D, 40, 20);
  const due1 = S.register(D, owner, { category: "hire", title: "Contratar (revisar hoje)", inputs: { monthlyCost: 600 }, reviewOn: today }); S.decide(D, due1.id, owner, { status: "decided" });
  const notYet = S.register(D, owner, { category: "hire", title: "Contratar (futuro)", inputs: { monthlyCost: 600 }, reviewOn: future }); S.decide(D, notYet.id, owner, { status: "decided" });
  check("due(): só decidida com revisão vencida e SEM resultado", S.due(D, today).map((x: any) => x.id).join() === due1.id && S.due(D, fmt(new Date(Date.now() + 30 * DAY))).length === 2);
  const sigs = () => (db.prepare("SELECT status FROM business_signals WHERE organization_id = ? AND dedupe_key = ?").all(D, `strategic_review:${due1.id}`) as any[]);
  check("lembrete publica UM sinal em business_signals (conv. nº 12), idempotente", S.publishReviewReminders(D, today).published === 1 && S.publishReviewReminders(D, today).published === 1 && sigs().length === 1 && sigs()[0].status === "open");
  check("o sinal é fato sem dinheiro (não inventa impacto) e aponta a decisão", (() => { const r = db.prepare("SELECT basis, impact_amount, severity FROM business_signals WHERE organization_id = ? AND dedupe_key = ?").get(D, `strategic_review:${due1.id}`) as any; return r.basis === "fact" && r.impact_amount === null && r.severity === "attention"; })());
  S.recordOutcome(D, due1.id, owner, { actual: 1200 });
  check("registrar o resultado RESOLVE o lembrete sozinho e some do due()", sigs()[0].status === "resolved" && S.due(D, today).length === 0);
  const pd = S.register(D, owner, { category: "principle", title: "Diretriz a revisar", reviewOn: today }); S.decide(D, pd.id, owner, { status: "decided" });
  check("diretriz com revisão vencida também lembra", S.due(D, today).map((x: any) => x.id).join() === pd.id && S.publishReviewReminders(D, today).published === 1);
  S.revisit(D, pd.id, owner, { reviewOn: future, note: "Segue valendo" });
  check("revisitar reconfirma, marca a próxima revisão e resolve o lembrete", S.due(D, today).length === 0 && (db.prepare("SELECT status FROM business_signals WHERE organization_id = ? AND dedupe_key = ?").get(D, `strategic_review:${pd.id}`) as any).status === "resolved" && S.get(D, pd.id).reviewOn === future && thrown(() => S.revisit(D, pd.id, owner, { reviewOn: past })) === "invalid_review_date");
  const E = mkOrg(); check("pass(): publica só nas empresas com revisão vencida (isolamento)", (() => { S.pass(new Date(Date.now() + 40 * DAY)); return (db.prepare("SELECT COUNT(*) c FROM business_signals WHERE organization_id = ? AND domain = 'strategic'").get(E) as any).c === 0 && (db.prepare("SELECT COUNT(*) c FROM business_signals WHERE organization_id = ? AND domain = 'strategic'").get(D) as any).c >= 1; })());

  // 10) isolamento
  check("isolamento: outra empresa não vê, não decide e não registra resultado", S.get(B, d1.id) === null && S.list(B).length === 0 && thrown(() => S.decide(B, d1.id, owner, { status: "decided" })) === "not_found" && thrown(() => S.recordOutcome(B, d1.id, owner, { actual: 1 })) === "not_found" && S.calibration(B).n === 0);

  // 11) rotas
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
  const rc = await call("POST", "/strategic/decisions", "dono", { category: "hire", title: "Via rota", inputs: { monthlyCost: 600 } });
  check("rota: dono registra (201) com cenário congelado e executes:false", rc.status === 201 && rc.body.scenario?.kind === "hire" && rc.body.executes === false);
  check("rota: vendedor não vê (403 leitura) nem escreve (403)", (await call("GET", "/strategic/decisions", "vend")).status === 403 && (await call("POST", "/strategic/decisions", "vend", { category: "other", title: "Nada" })).status === 403);
  check("rota: erro de regra → 400 com código; id inexistente → 404; sem empresa → 401", (await call("POST", "/strategic/decisions", "dono", { category: "x", title: "abc" })).body.code === "invalid_category" && (await call("GET", "/strategic/decisions/nao-existe", "dono")).status === 404 && (await call("GET", "/strategic/decisions", "dono", undefined, true)).status === 401);
  const rd = await call("POST", `/strategic/decisions/${rc.body.id}/decide`, "dono", { status: "decided" });
  const ro = await call("POST", `/strategic/decisions/${rc.body.id}/outcome`, "dono", { actual: (rc.body.expectation.low + rc.body.expectation.high) / 2, basis: "fact" });
  check("rota: decidir (200) e registrar resultado (201) → comparação 'within'", rd.status === 200 && ro.status === 201 && ro.body.comparison.status === "within");
  const rl = await call("GET", "/strategic/decisions?status=decided", "dono"), rcal = await call("GET", "/strategic/calibration", "dono"), rdue = await call("GET", "/strategic/due", "dono"), rpr = await call("GET", "/strategic/principles", "dono");
  check("rota: lista/filtra, calibração, vencidas e diretrizes respondem 200", rl.status === 200 && rl.body.decisions.every((d: any) => d.status === "decided") && rcal.status === 200 && rcal.body.n >= 1 && rdue.status === 200 && Array.isArray(rdue.body.due) && rpr.status === 200 && Array.isArray(rpr.body.principles));
  server.close();

  // 12) fiação e §42
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/StrategicDecisionService.ts"), "utf8"), sch = fs.readFileSync(path.join(process.cwd(), "src/server/Scheduler.ts"), "utf8");
  check("RN-F4-1: o serviço nunca cria ação/comando/mensagem (sem DecisionAction, CommandExecutor, MessageProvider)", !/DecisionActionService|CommandExecutor|MessageProvider|ApprovalPolicy/.test(src));
  check("Scheduler chama o passe de revisão (sem 2º scheduler)", /StrategicDecisionService\.js"\)\.then\(\(m\) => m\.StrategicDecisionService\.pass\(\)\)/.test(sch));
  check("RN-F4-11: o serviço só COMPÕE o ScenarioEngine (não recalcula caixa/estoque)", /ScenarioEngine\.run/.test(src) && !/CashForecastService|PurchaseScenarioService|DecisionSimulatorService/.test(src));

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
