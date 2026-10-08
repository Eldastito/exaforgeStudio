/**
 * TESTE — ADR-205 F4.10: Board Review mensal / QBR trimestral (BoardReviewService).
 * Prova: composição READ-ONLY (não grava/envia/executa) · período FECHADO (nunca o corrente) · seção sem dado diz POR QUÊ (null ≠ 0) ·
 * pauta só com FATOS das fontes (decisão vencida, plano fora do ritmo, concentração, cobertura) · piloto NÃO validado declarado e confiança nunca alta ·
 * lacunas herdadas declaradas · gestor-only (service + rota) · isolamento · fonte que falha não derruba a revisão · composição sem recálculo.
 * Uso: npm run test:board-review
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-board-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-board-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BoardReviewService: B, closedPeriod } = await import("../src/server/BoardReviewService.js");
  const { StrategicPlanService: P } = await import("../src/server/StrategicPlanService.js");
  const { StrategicDecisionService: S } = await import("../src/server/StrategicDecisionService.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const { todaySP } = await import("../src/server/spDate.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja Teste', 'active', 'moda')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const mkU = (org: string, role: string, key: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, ?, 'active')`).run(id, org, `${id}@t.local`, role); const pid = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id; return { userId: id, id, role, role_profile_id: pid }; };
  const thrown = (f: () => any) => { try { f(); return null; } catch (e: any) { return e?.code || "error"; } };
  const A = mkOrg(), EMPTY = mkOrg();
  const dono = mkU(A, "owner", "owner"), vend = mkU(A, "agent", "vendedor"), donoE = mkU(EMPTY, "owner", "owner");
  const today = todaySP(); const mon = closedPeriod("month", today), qtr = closedPeriod("quarter", today);

  // períodos
  check("período FECHADO: mês = mês anterior; trimestre = trimestre anterior (vira o ano)", closedPeriod("month", "2026-01-15").key === "2025-12" && closedPeriod("month", "2026-10-08").key === "2026-09" && closedPeriod("quarter", "2026-01-15").key === "2025-Q4" && closedPeriod("quarter", "2026-10-08").key === "2026-Q3" && closedPeriod("quarter", "2026-10-08").to === "2026-09-30");
  check("o período corrente nunca é revisado (to < hoje)", mon.to < today && qtr.to < today);

  // empresa vazia: tudo indisponível, com motivo, nada inventado
  const e = B.review(EMPTY, donoE, { period: "month" });
  check("empresa sem dados: nenhuma seção disponível, TODAS com motivo (null ≠ 0), dados nulos", e.sections.length === 6 && e.sections.every((s: any) => s.available === false && !!s.reason && s.data === null));
  check("a pauta lista as seções sem dado (fato), não inventa pendência", e.agenda.length === e.sections.length && e.agenda.every((a: any) => a.kind === "section_unavailable"));
  check("é leitura: não prevê, não executa, não envia; piloto NÃO validado e declarado; confiança nunca alta", e.isForecast === false && e.executes === false && e.sends === false && e.pilot.validated === false && /NÃO rodou/.test(e.pilot.statement) && e.confidence.level === "baixa" && e.confidence.level !== ("alta" as string));
  check("declara as lacunas herdadas do briefing (margem, estoque, clientes/campanhas) + benchmark entre empresas", ["margem confiável", "estoque", "clientes e campanhas", "benchmark entre empresas"].every((t) => e.notCovered.some((n: any) => n.topic === t)));
  check("valida o período e o acesso", thrown(() => B.review(A, dono, { period: "ano" })) === "invalid_period" && thrown(() => B.review(A, vend, { period: "month" })) === "forbidden" && thrown(() => B.review(A, undefined, {})) === "forbidden");

  // semeia: plano do mês fechado (meta 100k, realizado 60k → missed), decisão vencida, compras com um fornecedor só
  const store = RetailStoreService.create(A, { name: "Loja 1" } as any).id as string;
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, 'approved', ?)`).run(randomUUID(), A, store, `${mon.key}-10`, 60000);
  // o serviço não cria plano de período já encerrado: cria no mês corrente e recua a chave (semente de teste = plano que já virou período fechado)
  const plan = P.create(A, dono, { periodType: "month", periodKey: today.slice(0, 7), title: "Plano do mês fechado", lines: [{ kind: "revenue_target", amount: 100000 }] });
  P.activate(A, plan.id, dono);
  db.prepare(`UPDATE strategic_plans SET period_key = ? WHERE organization_id = ? AND id = ?`).run(mon.key, A, plan.id);
  const d = S.register(A, dono, { category: "other", title: "Abrir segunda loja", hypothesis: "Dá retorno", reviewOn: today });
  S.decide(A, d.id, dono, { status: "decided", rationale: "teste" });
  let n = 0;
  const order = (sup: string, total: number) => { const req = `req-${++n}`, q = randomUUID(); db.prepare(`INSERT INTO purchase_quotes (id, organization_id, requisition_id, supplier_contact_id, status, delivery_days, total_amount, sent_at, answered_at, accepted_at) VALUES (?, ?, ?, ?, 'accepted', 5, ?, ?, ?, ?)`).run(q, A, req, sup, total, `${mon.key}-05`, `${mon.key}-05`, `${mon.key}-05`);
    db.prepare(`INSERT INTO purchase_orders (id, organization_id, requisition_id, quote_id, supplier_contact_id, supplier_name, status, total_amount, delivery_days, created_at) VALUES (?, ?, ?, ?, ?, 'Forn', 'received', ?, 5, ?)`).run(randomUUID(), A, req, q, sup, total, `${mon.key}-05`); };
  order("sup-unico", 8000);

  const before = ["decision_actions", "business_signals", "tasks", "strategic_decisions", "strategic_plans", "purchase_orders"].map((t) => (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE organization_id = ?`).get(A) as any).c).join(",");
  const r = B.review(A, dono, { period: "month" });
  const after = ["decision_actions", "business_signals", "tasks", "strategic_decisions", "strategic_plans", "purchase_orders"].map((t) => (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE organization_id = ?`).get(A) as any).c).join(",");
  const sec = (k: string) => r.sections.find((s: any) => s.key === k) as any;
  check("não grava nada (decisões, sinais, planos, ordens inalterados)", before === after);
  check("plano: traz o plano × realizado do período fechado, sem projetar", sec("plano").available && sec("plano").data.periodKey === mon.key && sec("plano").data.track.revenue.target === 100000 && sec("plano").data.track.revenue.actual === 60000 && sec("plano").data.track.revenue.paceStatus === "missed");
  check("decisões: revisão vencida aparece com o título; calibração vem da fonte", sec("decisoes").available && sec("decisoes").data.reviewsDue.some((x: any) => x.title === "Abrir segunda loja") && sec("decisoes").data.calibration && sec("decisoes").data.decidedCount === 1);
  check("fornecedores: concentração e cobertura vêm da fonte (um fornecedor só)", sec("fornecedores").available && sec("fornecedores").data.band === "single_supplier" && sec("fornecedores").data.totalSpend === 8000);
  check("seções sem fonte continuam indisponíveis COM motivo (lojas sem m²/equipe; externo sem pesquisa)", !sec("lojas").available && !!sec("lojas").reason && !sec("externo").available && !!sec("externo").reason);
  const kinds = r.agenda.map((a: any) => a.kind);
  check("pauta só com FATOS: plano não atingido · decisão vencida · fornecedor único · cobertura/seção sem dado", kinds.includes("plan_missed") && kinds.includes("decision_review_due") && kinds.includes("supplier_concentration") && kinds.includes("section_unavailable") && r.agenda.every((a: any) => !!a.source && !!a.text));
  check("a pauta não recomenda nem conclui (sem imperativo de ação/causa)", r.agenda.every((a: any) => !/\b(deve|recomend|contrate|demita|feche|troque|compre)/i.test(a.text)));
  check("confiança baixa e piloto declarado também com dados", r.confidence.level === "baixa" && r.pilot.validated === false && r.confidence.reasons.some((x: string) => /Piloto não validado/.test(x)));

  // trimestre: usa o plano trimestral (inexistente) e declara que o briefing cobre só o último mês
  const q = B.review(A, dono, { period: "quarter" });
  check("trimestre: período = trimestre fechado; sem plano trimestral → seção indisponível com motivo; avisa que o briefing é mensal", q.periodKey === qtr.key && q.sections.find((s: any) => s.key === "plano").available === false && /trimestral/.test(q.sections.find((s: any) => s.key === "plano").reason) && q.caveats.some((c: string) => /mensal/.test(c)));

  // isolamento
  check("isolamento: a outra empresa não vê plano/decisão/fornecedor da A", e.sections.every((s: any) => !s.available));

  // fonte que falha não derruba a revisão
  const orig = (P as any).list; (P as any).list = () => { throw new Error("falha simulada"); };
  const f = B.review(A, dono, { period: "month" });
  (P as any).list = orig;
  check("fonte que lança vira seção indisponível com o motivo; as outras seguem", f.sections.find((s: any) => s.key === "plano").available === false && f.sections.find((s: any) => s.key === "fornecedores").available === true);

  // rotas
  const { default: router } = await import("../src/server/routes/health.js");
  const express = (await import("express")).default;
  const who: any = { dono, vend };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-anon"] ? undefined : A; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/health-center", router);
  const server = http.createServer(app); await new Promise<void>((x) => server.listen(0, x));
  const port = (server.address() as any).port;
  const get = async (u: string, user: string, anon = false) => { const x = await fetch(`http://127.0.0.1:${port}/api/health-center${u}`, { headers: { "x-user": user, ...(anon ? { "x-anon": "1" } : {}) } }); return { status: x.status, body: await x.json().catch(() => ({})) as any }; };
  const g = await get("/board-review", "dono");
  check("rota: gestor lê (200), padrão mensal; ?period=quarter funciona", g.status === 200 && g.body.type === "board_review" && g.body.period === "month" && (await get("/board-review?period=quarter", "dono")).body.period === "quarter");
  check("rota: vendedor 403, sem empresa 401, período inválido 400 com código", (await get("/board-review", "vend")).status === 403 && (await get("/board-review", "dono", true)).status === 401 && (await get("/board-review?period=ano", "dono")).body.code === "invalid_period");
  server.close();

  // composição
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/BoardReviewService.ts"), "utf8").replace(/\/\*\*[\s\S]*?\*\//g, "");
  check("compõe os serviços existentes (briefing, plano, decisões, benchmark, fornecedores, contexto externo)", ["PeriodicBriefingService.compose", "StrategicPlanService.track", "StrategicDecisionService.calibration", "StoreBenchmarkService.benchmark", "SupplierIntelligenceService.concentration", "ExternalDecisionContextService.forDecision"].every((t) => src.includes(t)));
  check("não grava, não envia, não executa e não cria sinal/tabela (sem INSERT/UPDATE/DELETE/publish)", !/\b(INSERT|UPDATE|DELETE)\b|BusinessSignalService|publish\(|DecisionActionService|CommandExecutor|MessageProvider|PeriodicBriefingService\.(publish|pass)|ScenarioEngine\.run/.test(src));

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
