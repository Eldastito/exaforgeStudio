/**
 * TESTE — ADR-205 F4.4: plano de período do dono + plano × realizado (StrategicPlanService).
 * Prova: plano é intenção humana (só dono/admin; nada executa) · mês/trimestre/ano validados · linhas validadas (meta, orçamento por categoria, evento dentro do período) ·
 * versionado e append-only (revisar = nova versão, a antiga fica) · um plano em aberto por período · realizado SEMPRE derivado (sem fechamento → null, não 0) ·
 * ritmo = régua linear declarada (ahead/on_pace/behind/met/missed/not_started) · orçamento só do que foi lançado (null sem contas a pagar) · impacto de caixa declarado, à parte ·
 * isolamento · rotas · não escreve ação/sinal/tarefa.
 * Uso: npm run test:strategic-plan
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-plan-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-plan-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { StrategicPlanService: P, periodRange } = await import("../src/server/StrategicPlanService.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const [ty, tm] = today.split("-").map(Number); const pad = (n: number) => String(n).padStart(2, "0");
  const curMonth = `${ty}-${pad(tm)}`;
  const nextMonth = tm === 12 ? `${ty + 1}-01` : `${ty}-${pad(tm + 1)}`;
  const prevMonth = tm === 1 ? `${ty - 1}-12` : `${ty}-${pad(tm - 1)}`;
  const curQuarter = `${ty}-Q${Math.ceil(tm / 3)}`;
  const owner = { userId: "u-owner", role: "owner" }, agent = { userId: "u-agent", role: "agent" };
  const thrown = (f: () => any) => { try { f(); return null; } catch (e: any) { return e?.code || "error"; } };
  const mkStore = (org: string, name: string) => RetailStoreService.create(org, { name } as any).id as string;
  const closing = (org: string, store: string, month: string, day: string, total: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, 'approved', ?)`).run(randomUUID(), org, store, `${month}-${day}`, total);
  const dayIn = (month: string, d: number) => `${month}-${pad(d)}`;
  const A = mkOrg();

  // períodos
  check("periodRange: mês, trimestre e ano; chave inválida → null", periodRange("month", "2026-02")!.to === "2026-02-28" && periodRange("quarter", "2026-Q4")!.from === "2026-10-01" && periodRange("quarter", "2026-Q4")!.to === "2026-12-31" && periodRange("year", "2026")!.to === "2026-12-31" && periodRange("month", "2026-13") === null && periodRange("quarter", "2026-Q5") === null && periodRange("year", "26") === null);

  // criar
  const lines = [
    { kind: "revenue_target", amount: 100000 },
    { kind: "budget", category: "compras", amount: 30000 },
    { kind: "budget", category: "marketing", amount: 5000 },
    { kind: "event", label: "Lançamento da coleção", eventDate: dayIn(curMonth, 28 > 0 ? 28 : 28), cashImpact: -8000 },
  ];
  const before = ["decision_actions", "business_signals", "tasks", "purchase_orders"].map((t) => { try { return (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE organization_id = ?`).get(A) as any).c; } catch { return -1; } }).join(",");
  const p1 = P.create(A, owner, { periodType: "month", periodKey: curMonth, title: "Plano do mês", objective: "Fechar o mês acima do anterior", lines });
  check("cria como RASCUNHO v1, é intenção do dono (basis owner_plan), não previsão nem ação", p1.status === "draft" && p1.version === 1 && p1.basis === "owner_plan" && p1.isForecast === false && p1.executes === false && p1.lines.length === 4);
  check("criar NÃO cria ação, sinal, tarefa nem pedido (RN-F4-1)", ["decision_actions", "business_signals", "tasks", "purchase_orders"].map((t) => { try { return (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE organization_id = ?`).get(A) as any).c; } catch { return -1; } }).join(",") === before);
  check("só dono/admin cria (vendedor e sem usuário → forbidden)", thrown(() => P.create(A, agent, { periodType: "month", periodKey: nextMonth, title: "Teste plano" })) === "forbidden" && thrown(() => P.create(A, { role: "owner" }, { periodType: "month", periodKey: nextMonth, title: "Teste plano" })) === "forbidden");

  // validações
  const n0 = (db.prepare(`SELECT COUNT(*) c FROM strategic_plans WHERE organization_id = ?`).get(A) as any).c;
  const mk = (extra: any) => () => P.create(A, owner, { periodType: "quarter", periodKey: curQuarter, title: "Trimestre", ...extra });
  check("recusa SEM gravar: tipo/período inválidos, período que já terminou, título curto, linhas inválidas",
    thrown(() => P.create(A, owner, { periodType: "semana", periodKey: "x", title: "Plano ok" })) === "invalid_period_type" && thrown(() => P.create(A, owner, { periodType: "month", periodKey: "2026-13", title: "Plano ok" })) === "invalid_period"
    && thrown(() => P.create(A, owner, { periodType: "month", periodKey: "2020-01", title: "Plano ok" })) === "invalid_period" && thrown(mk({ title: "ab" })) === "invalid_title"
    && thrown(mk({ lines: "x" })) === "invalid_lines" && thrown(mk({ lines: [{ kind: "revenue_target", amount: 0 }] })) === "invalid_amount" && thrown(mk({ lines: [{ kind: "revenue_target", amount: "abc" }] })) === "invalid_amount"
    && thrown(mk({ lines: [{ kind: "budget", category: "viagem", amount: 10 }] })) === "invalid_category" && thrown(mk({ lines: [{ kind: "budget", category: "compras", amount: -5 }] })) === "invalid_amount"
    && thrown(mk({ lines: [{ kind: "event", label: "ab", eventDate: dayIn(curMonth, 5) }] })) === "invalid_label" && thrown(mk({ lines: [{ kind: "event", label: "Evento fora", eventDate: "2020-01-01" }] })) === "invalid_event_date"
    && thrown(mk({ lines: [{ kind: "event", label: "Evento caixa", eventDate: dayIn(curMonth, 5), cashImpact: "xx" }] })) === "invalid_cash_impact" && thrown(mk({ lines: [{ kind: "festa" }] })) === "invalid_kind"
    && thrown(mk({ lines: Array.from({ length: 61 }, () => ({ kind: "revenue_target", amount: 1 })) })) === "too_many_lines"
    && (db.prepare(`SELECT COUNT(*) c FROM strategic_plans WHERE organization_id = ?`).get(A) as any).c === n0);
  check("um plano em aberto por período (duplicado → plan_exists); outro período pode", thrown(() => P.create(A, owner, { periodType: "month", periodKey: curMonth, title: "Outro plano" })) === "plan_exists" && !thrown(() => P.create(A, owner, { periodType: "month", periodKey: nextMonth, title: "Plano do próximo mês", lines: [{ kind: "revenue_target", amount: 1000 }] })));
  check("texto livre: controle removido e truncado", (() => { const x = P.create(A, owner, { periodType: "year", periodKey: String(ty), title: "  Ano\n\tinteiro\u0007 " + "x".repeat(300), objective: "o".repeat(2000) }); return !/[\n\t\u0007]/.test(x.title) && x.title.length <= 160 && x.objective!.length === 600; })());

  // ativar / revisar / encerrar
  check("só dono ativa; plano vazio não ativa; ativa rascunho com linhas; não ativa duas vezes", thrown(() => P.activate(A, p1.id, agent)) === "forbidden" && (() => { const e = P.list(A, { periodType: "year" })[0]; return thrown(() => P.activate(A, e.id, owner)) === "empty_plan"; })() && P.activate(A, p1.id, owner).status === "active" && thrown(() => P.activate(A, p1.id, owner)) === "invalid_state");
  const p2 = P.revise(A, p1.id, owner, { lines: [{ kind: "revenue_target", amount: 120000 }, { kind: "budget", category: "compras", amount: 30000 }, { kind: "event", label: "Lançamento da coleção", eventDate: dayIn(curMonth, 28), cashImpact: -8000 }], changeNote: "Meta subiu" });
  check("revisar = NOVA versão (v2); a v1 continua guardada (append-only) e o status ativo é mantido", p2.version === 2 && p2.status === "active" && p2.versions.length === 2 && p2.versions[0].version === 1 && p2.versions[0].lines === 4 && p2.versions[1].lines === 3 && p2.changeNote === "Meta subiu" && (db.prepare(`SELECT COUNT(*) c FROM strategic_plan_lines WHERE organization_id = ? AND plan_id = ? AND version = 1`).get(A, p1.id) as any).c === 4);
  check("o plano exibe só as linhas da versão atual; revisão inválida não cria versão", p2.lines.find((l: any) => l.kind === "revenue_target").amount === 120000 && thrown(() => P.revise(A, p1.id, owner, { lines: [{ kind: "budget", category: "x", amount: 1 }] })) === "invalid_category" && P.get(A, p1.id)!.version === 2 && thrown(() => P.revise(A, p1.id, agent, { lines: [] })) === "forbidden");

  // acompanhamento — sem dado
  const T0 = P.track(A, p1.id);
  check("sem nenhum fechamento: realizado null (NÃO zero), ritmo null, e diz a fonte", T0.type === "plan_tracking" && T0.isForecast === false && T0.executes === false && T0.revenue.target === 120000 && T0.revenue.actual === null && T0.revenue.progressPct === null && T0.revenue.paceStatus === null && T0.revenue.source === "retail_daily_closings");
  check("orçamento sem contas a pagar lançadas → committed/paid/remaining null (não finge R$ 0)", T0.budgets[0].planned === 30000 && T0.budgets[0].committed === null && T0.budgets[0].remaining === null && T0.budgets[0].overBudget === null && T0.caveats.some((c: string) => /não estão sendo lançadas/.test(c)));

  // com fechamentos
  const s1 = mkStore(A, "Loja 1"), s2 = mkStore(A, "Loja 2");
  closing(A, s1, curMonth, "02", 30000); closing(A, s2, curMonth, "03", 30000);   // 60.000 de 120.000 = 50%
  const first = `${curMonth}-01`, daysInMonth = periodRange("month", curMonth)!.to.slice(8) as string;
  const asOfEarly = `${curMonth}-10`, asOfLate = `${curMonth}-${daysInMonth}`;
  const tEarly = P.track(A, p1.id, { asOf: asOfEarly });
  check("realizado vem dos fechamentos (60.000 de 120.000 = 50%); ritmo calculado pela régua linear", tEarly.revenue.actual === 60000 && tEarly.revenue.progressPct === 50 && tEarly.revenue.elapsedPct === Math.round((10 / Number(daysInMonth)) * 10000) / 100);
  check("dia 10 com 50% feito → 'ahead'; último dia do período com 50% → 'behind' (ainda não terminou)", tEarly.revenue.paceStatus === "ahead" && P.track(A, p1.id, { asOf: asOfLate }).revenue.paceStatus === "behind");
  closing(A, s1, curMonth, "05", 70000); // 130.000 ≥ meta de 120.000
  const afterEnd = (() => { const [y, m] = curMonth.split("-").map(Number); return m === 12 ? `${y + 1}-01-02` : `${y}-${pad(m + 1)}-02`; })();
  const tMet = P.track(A, p1.id, { asOf: afterEnd });
  check("depois do fim do período: meta batida (130.000 de 120.000) → 'met', finished=true, 108,33%", tMet.finished === true && tMet.revenue.paceStatus === "met" && tMet.revenue.progressPct === 108.33);
  check("depois do fim do período: meta NÃO batida → 'missed'", (() => { const M = mkOrg(); const ms = mkStore(M, "L"); closing(M, ms, curMonth, "04", 1000); const x = P.create(M, owner, { periodType: "month", periodKey: curMonth, title: "Plano miss", lines: [{ kind: "revenue_target", amount: 50000 }] }); return P.track(M, x.id, { asOf: afterEnd }).revenue.paceStatus === "missed"; })());
  const tNext = P.track(A, P.list(A).find((x: any) => x.periodKey === nextMonth)!.id);
  check("período que ainda não começou → not_started, realizado null", tNext.started === false && tNext.revenue.actual === null && tNext.revenue.paceStatus === "not_started");
  closing(A, s1, prevMonth, "10", 100000);
  check("contexto: realizado do período anterior e quanto a meta cresce sobre ele (120.000 vs 100.000 = +20%)", P.track(A, p1.id).revenue.previousPeriod.actual === 100000 && P.track(A, p1.id).revenue.targetVsPreviousPct === 20);

  // orçamento com contas a pagar
  F.addPayable(A, { description: "Fornecedor A", amount: 20000, dueDate: dayIn(curMonth, 20), category: "compras" });
  F.addPayable(A, { description: "Fornecedor B", amount: 15000, dueDate: dayIn(curMonth, 25), category: "Compras" });
  F.addPayable(A, { description: "Outro mês", amount: 99999, dueDate: dayIn(nextMonth, 5), category: "compras" });
  F.addPayable(A, { description: "Sem categoria", amount: 777, dueDate: dayIn(curMonth, 6) });
  const pay = F.addPayable(A, { description: "Cancelada", amount: 5000, dueDate: dayIn(curMonth, 7), category: "compras" }) as any;
  db.prepare(`UPDATE payables SET status = 'canceled' WHERE id = ?`).run(pay.id);
  const tb = P.track(A, p1.id), bud = tb.budgets.find((b: any) => b.category === "compras")!;
  check("orçamento: comprometido = contas lançadas na categoria DENTRO do período (sem canceladas, sem outro mês, sem categoria) → 35.000 de 30.000 = estourou", bud.committed === 35000 && bud.paid === 0 && bud.remaining === -5000 && bud.overBudget === true);
  check("a mesma conta paga entra em 'paid'", (() => { const row = db.prepare(`SELECT id FROM payables WHERE organization_id = ? AND description = 'Fornecedor A'`).get(A) as any; db.prepare(`UPDATE payables SET status = 'paid' WHERE id = ?`).run(row.id); const b = P.track(A, p1.id).budgets.find((x: any) => x.category === "compras")!; return b.paid === 20000 && b.committed === 35000; })());

  // calendário
  const cal = P.track(A, p1.id, { asOf: `${curMonth}-10` }).calendar;
  check("calendário: evento com dias até, impacto declarado somado à parte e rotulado como declarado (não projeção)", cal.events.length === 1 && cal.events[0].daysUntil === 18 && cal.events[0].passed === false && cal.declaredCashImpactTotal === -8000 && /DECLARADO/.test(cal.note));
  check("evento sem impacto declarado → total null (não 0)", (() => { const B = mkOrg(); const x = P.create(B, owner, { periodType: "month", periodKey: curMonth, title: "Plano B", lines: [{ kind: "event", label: "Feira de rua", eventDate: dayIn(curMonth, 28) }] }); return P.track(B, x.id).calendar.declaredCashImpactTotal === null; })());

  // encerrar
  const closed = P.close(A, p1.id, owner, "Mês fechado");
  check("encerrar (só dono); encerrado não revisa nem reencerra; a história continua legível", thrown(() => P.close(A, p1.id, agent)) === "forbidden" && closed.status === "closed" && closed.closedAt !== null && thrown(() => P.revise(A, p1.id, owner, { lines: [] })) === "plan_closed" && thrown(() => P.close(A, p1.id, owner)) === "invalid_state" && P.get(A, p1.id)!.versions.length === 2);
  check("depois de encerrar, o período pode ganhar um plano novo (índice parcial só vale p/ rascunho/ativo)", !thrown(() => P.create(A, owner, { periodType: "month", periodKey: curMonth, title: "Plano refeito" })));

  // isolamento
  const C = mkOrg();
  check("isolamento: outra empresa não vê, não revisa, não acompanha nem lista", P.get(C, p1.id) === null && P.list(C).length === 0 && thrown(() => P.revise(C, p1.id, owner, { lines: [] })) === "not_found" && thrown(() => P.track(C, p1.id)) === "not_found" && thrown(() => P.activate(C, p1.id, owner)) === "not_found");
  check("acompanhar NÃO escreve nada (read-only)", (() => { const c = () => ["decision_actions", "business_signals", "tasks", "strategic_plans", "strategic_plan_lines"].map((t) => (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE organization_id = ?`).get(A) as any).c).join(","); const b = c(); P.track(A, p1.id); return c() === b; })());
  check("lista filtra por tipo e status", P.list(A, { periodType: "month" }).every((x: any) => x.periodType === "month") && P.list(A, { status: "closed" }).every((x: any) => x.status === "closed") && P.list(A, { status: "closed" }).length === 1);

  // rotas
  const { default: router } = await import("../src/server/routes/health.js");
  const express = (await import("express")).default;
  const mkU = (org: string, role: string, key: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, ?, 'active')`).run(id, org, `${id}@t.local`, role); const pid = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id; return { userId: id, id, role, role_profile_id: pid }; };
  const R = mkOrg();
  const who: any = { dono: mkU(R, "owner", "owner"), vend: mkU(R, "agent", "vendedor") };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-anon"] ? undefined : R; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/health-center", router);
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (m: string, u: string, user: string, body?: any, anon = false) => { const x = await fetch(`http://127.0.0.1:${port}/api/health-center${u}`, { method: m, headers: { "Content-Type": "application/json", "x-user": user, ...(anon ? { "x-anon": "1" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: x.status, body: await x.json().catch(() => ({})) as any }; };
  const rc = await call("POST", "/plans", "dono", { periodType: "month", periodKey: curMonth, title: "Plano via rota", lines: [{ kind: "revenue_target", amount: 50000 }] });
  check("rota: dono cria (201); vendedor não lê (403) nem escreve (403); sem empresa → 401", rc.status === 201 && rc.body.status === "draft" && (await call("GET", "/plans", "vend")).status === 403 && (await call("POST", "/plans", "vend", { periodType: "month", periodKey: nextMonth, title: "Nada aqui" })).status === 403 && (await call("GET", "/plans", "dono", undefined, true)).status === 401);
  const ra = await call("POST", `/plans/${rc.body.id}/activate`, "dono"), rv = await call("PUT", `/plans/${rc.body.id}`, "dono", { lines: [{ kind: "revenue_target", amount: 60000 }] });
  check("rota: ativar (200) e revisar (200, v2)", ra.status === 200 && ra.body.status === "active" && rv.status === 200 && rv.body.version === 2);
  const rt = await call("GET", `/plans/${rc.body.id}/track?asOf=${curMonth}-10`, "dono"), rg = await call("GET", `/plans/${rc.body.id}`, "dono"), rl = await call("GET", "/plans?status=active", "dono");
  check("rota: acompanhar, detalhar e listar respondem 200", rt.status === 200 && rt.body.type === "plan_tracking" && rg.status === 200 && rg.body.versions.length === 2 && rl.status === 200 && rl.body.plans.length === 1);
  check("rota: erro de regra → 400 com código; plano inexistente → 404; encerrar → 200", (await call("POST", "/plans", "dono", { periodType: "month", periodKey: curMonth, title: "Duplicado" })).body.code === "plan_exists" && (await call("GET", "/plans/nao-existe", "dono")).status === 404 && (await call("GET", "/plans/nao-existe/track", "dono")).status === 404 && (await call("POST", `/plans/${rc.body.id}/close`, "dono", { note: "fim" })).body.status === "closed");
  server.close();

  // fiação e composição
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/StrategicPlanService.ts"), "utf8");
  check("RN-F4-1: o serviço nunca cria ação/comando/mensagem/sinal", !/DecisionActionService|CommandExecutor|MessageProvider|ApprovalPolicy|BusinessSignalService/.test(src));
  check("RN-F4-11: compõe faturamento (RetailStoreCostService) e contas a pagar (FinancialLedgerService); não recalcula caixa/previsão", /RetailStoreCostService\.monthlyRevenueAll/.test(src) && /FinancialLedgerService\.tracking/.test(src) && !/CashForecastService|PurchaseScenarioService|DecisionSimulatorService|ScenarioEngine/.test(src.replace(/\/\*\*[\s\S]*?\*\//g, "")));
  check("tabelas da F4.4 no FIM do db.ts (convenção nº 2)", (() => { const d = fs.readFileSync(path.join(process.cwd(), "src/server/db.ts"), "utf8"); const i = d.indexOf("CREATE TABLE IF NOT EXISTS strategic_plans"); return i > d.indexOf("CREATE TABLE IF NOT EXISTS store_opportunity_profiles") && d.indexOf("initDb();", i) > 0; })());

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
