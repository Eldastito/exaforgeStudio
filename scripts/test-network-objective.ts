/**
 * TESTE — ADR-204 F3.6b: objetivo da REDE ("+10% no mês") dividido por loja — só recomenda; tarefa só por pessoa.
 * Prova: parte da PROJEÇÃO (F3.4), +pct proporcional por loja · R$/dia útil que falta e comparação com o dia típico (esforço) · loja sem projeção fica FORA com motivo e
 * NÃO entra na soma da rede · meta oficial só lida (nunca alterada) · pct inválido recusado · gerente de loja vê só a(s) dela(s), sem total da rede ·
 * tarefa só por pessoa (sistema recusado), plano recalculado no servidor, idempotente, só lojas projetáveis e no alcance, responsável = gerente da loja · auditoria · isolamento · rotas.
 * Uso: npm run test:network-objective
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-netobj-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-netobj-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }
const DAY = 86400e3;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dowOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { NetworkObjectiveService: N } = await import("../src/server/NetworkObjectiveService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const profile = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id;
  const mkUser = (org: string, role: string, key: string, name = "U") => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')`).run(id, org, name, `${id}@t.local`, role); return { userId: id, id, role, role_profile_id: profile(org, key), name }; };
  const A = mkOrg(), B = mkOrg();
  const dono = mkUser(A, "owner", "owner", "Dona"), gerente = mkUser(A, "admin", "owner", "Gerente");
  const mkStore = (org: string, name: string, manager?: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active, manager_user_id) VALUES (?, ?, ?, ?, 1, ?)`).run(id, org, name, name.slice(0, 3), manager || null); return id; };
  const BASE = [2000, 1500, 1600, 1700, 1800, 2600, 3200];
  const noise = (i: number) => ((i % 5) - 2) * 60;
  const seed = (org: string, store: string, from: string, to: string, mult = 1) => { let i = 0; for (let d = from; d <= to; d = addDays(d, 1), i++) { const t = (BASE[dowOf(d)] + noise(i)) * mult; db.prepare(`INSERT OR REPLACE INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total, informed_total) VALUES (?, ?, ?, ?, 'approved', ?, ?)`).run(randomUUID(), org, store, d, t, t); } };
  const ASOF = "2026-10-10", MONTH = "2026-10", NOW = Date.parse("2026-10-11T12:00:00Z");
  const carioca = mkStore(A, "Carioca", gerente.userId), madureira = mkStore(A, "Madureira"), bangu = mkStore(A, "Bangu"), nova = mkStore(A, "Nova");
  seed(A, carioca, "2026-03-01", ASOF); seed(A, madureira, "2026-03-01", ASOF, 0.5); seed(A, bangu, addDays(ASOF, -42), ASOF);
  db.prepare(`INSERT INTO retail_store_monthly_goals (id, organization_id, store_id, month, goal_amount) VALUES (?, ?, ?, ?, 60000)`).run(randomUUID(), A, carioca, MONTH);
  db.prepare(`INSERT INTO retail_store_monthly_goals (id, organization_id, store_id, month, goal_amount) VALUES (?, ?, ?, ?, 25000)`).run(randomUUID(), A, madureira, MONTH);
  const goalsBefore = JSON.stringify(db.prepare("SELECT store_id, goal_amount FROM retail_store_monthly_goals WHERE organization_id = ? ORDER BY store_id").all(A));

  // 1) validação
  check("pct inválido (0, negativo, >100, texto) é recusado", [0, -5, 101, "abc", null].every((p) => N.plan(A, { pct: p as any, month: MONTH, now: NOW }).ok === false));

  // 2) plano
  const p: any = N.plan(A, { pct: 10, month: MONTH, now: NOW });
  const c = p.stores.find((s: any) => s.storeId === carioca), m = p.stores.find((s: any) => s.storeId === madureira);
  check("duas lojas projetáveis (Carioca e Madureira); Bangu e Nova ficam de fora com o motivo", p.ok && p.stores.length === 2 && p.excluded.length === 2 && p.excluded.every((e: any) => !!e.reason && ["insufficient_history", "no_closings"].includes(e.status)));
  check("baseline = projeção (F3.4) e o extra é +10% proporcional por loja", Math.abs(c.extra - c.baseline * 0.1) < 0.02 && Math.abs(m.extra - m.baseline * 0.1) < 0.02 && Math.abs(c.target - (c.baseline + c.extra)) < 0.02);
  check("loja maior recebe o maior extra (ordem decrescente)", p.stores[0].storeId === carioca && c.extra > m.extra);
  check("R$/dia útil = extra ÷ dias que faltam e compara com o dia típico (esforço)", c.daysLeft > 0 && Math.abs(c.extraPerDay - c.extra / c.daysLeft) < 0.02 && c.extraVsTypicalPct != null && ["leve", "moderado", "alto"].includes(c.effort));
  check("com +10% sobre o que já falta o esforço por dia fica coerente: Carioca +10% do mês em 21 dias ⇒ maior que 10% do dia típico", c.extraVsTypicalPct > 10);
  check("a meta oficial é só LIDA: aparece com o % da projeção e do alvo (Carioca 60.000)", c.goal.amount === 60000 && c.goal.baselineVsGoalPct != null && c.goal.targetVsGoalPct > c.goal.baselineVsGoalPct);
  check("a rede soma SÓ as lojas projetáveis e diz quantas ficaram de fora", p.network.storesPlanned === 2 && p.network.storesExcluded === 2 && Math.abs(p.network.extra - (c.extra + m.extra)) < 0.02);
  check("é recomendação: executes:false e nenhuma meta mudou", p.executes === false && JSON.stringify(db.prepare("SELECT store_id, goal_amount FROM retail_store_monthly_goals WHERE organization_id = ? ORDER BY store_id").all(A)) === goalsBefore);
  check("premissa do esforço declarada em notes; estimativa, não promessa", p.notes.some((x: string) => /não calibrada/.test(x)));
  const p20: any = N.plan(A, { pct: 20, month: MONTH, now: NOW });
  check("o dobro de % dobra o extra", Math.abs(p20.stores.find((s: any) => s.storeId === carioca).extra - 2 * c.extra) < 0.05);

  // 3) escopo de loja: gerente restrito
  const pg: any = N.plan(A, { pct: 10, month: MONTH, now: NOW }, { storeIds: [carioca] });
  check("gerente de uma loja vê só a dele e NÃO recebe o total da rede", pg.stores.length === 1 && pg.stores[0].storeId === carioca && pg.network === null && pg.notes.some((x: string) => /só as suas lojas/.test(x)));

  // 4) mês fechado
  const done: any = N.plan(A, { pct: 10, month: "2026-09", now: NOW });
  check("mês já fechado: nenhuma loja projetável, sem número inventado", done.ok && done.stores.length === 0 && done.network === null);

  // 5) tarefas — só por pessoa
  const taskCount = () => (db.prepare("SELECT COUNT(*) c FROM tasks WHERE organization_id = ?").get(A) as any).c;
  check("sem identificar quem aprova → recusa", N.createTasks(A, { pct: 10, month: MONTH, storeIds: [carioca], now: NOW }, "").ok === false);
  check("rótulo de sistema/IA é recusado", N.createTasks(A, { pct: 10, month: MONTH, storeIds: [carioca], now: NOW }, "ai").ok === false && taskCount() === 0);
  check("sem lojas escolhidas / loja sem projeção / loja fora do alcance → recusa e nada criado", !N.createTasks(A, { pct: 10, month: MONTH, storeIds: [], now: NOW }, dono.userId).ok && !N.createTasks(A, { pct: 10, month: MONTH, storeIds: [bangu], now: NOW }, dono.userId).ok && !N.createTasks(A, { pct: 10, month: MONTH, storeIds: [madureira], now: NOW }, dono.userId, { allowedStoreIds: [carioca] }).ok && taskCount() === 0);
  const ok1: any = N.createTasks(A, { pct: 10, month: MONTH, storeIds: [carioca, madureira], now: NOW }, dono.userId);
  check("pessoa cria 1 tarefa por loja escolhida", ok1.ok && ok1.created.length === 2 && taskCount() === 2);
  const tcar = db.prepare("SELECT * FROM tasks WHERE organization_id = ? AND title LIKE '%Carioca%'").get(A) as any;
  const tmad = db.prepare("SELECT * FROM tasks WHERE organization_id = ? AND title LIKE '%Madureira%'").get(A) as any;
  check("responsável = gerente da loja; sem gerente → quem criou", tcar.assigned_to === gerente.userId && tmad.assigned_to === dono.userId);
  check("a tarefa explica base, esforço e que nenhuma meta foi alterada", /projeção de R\$/.test(tcar.description) && /Meta oficial da loja: R\$ 60\.000,00/.test(tcar.description) && /nenhuma meta oficial foi alterada/.test(tcar.description) && /\+10%/.test(tcar.title));
  const again: any = N.createTasks(A, { pct: 10, month: MONTH, storeIds: [carioca, madureira], now: NOW }, dono.userId);
  check("idempotente: pedir de novo não duplica (vai pra skipped)", again.ok && again.created.length === 0 && again.skipped.length === 2 && taskCount() === 2);
  check("outro % é outro objetivo (cria de novo)", N.createTasks(A, { pct: 15, month: MONTH, storeIds: [carioca], now: NOW }, dono.userId).created.length === 1);
  check("auditoria registra quem criou, sem texto livre", (db.prepare("SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'NETWORK_OBJECTIVE_TASKS_CREATED'").get(A) as any).c >= 2);
  check("a meta oficial continua intacta depois das tarefas", JSON.stringify(db.prepare("SELECT store_id, goal_amount FROM retail_store_monthly_goals WHERE organization_id = ? ORDER BY store_id").all(A)) === goalsBefore);

  // 6) isolamento
  const pb: any = N.plan(B, { pct: 10, month: MONTH, now: NOW });
  check("outra empresa não vê lojas nem projeção da primeira", pb.ok && pb.stores.length === 0 && pb.excluded.length === 0);

  // 7) rotas
  const { default: router } = await import("../src/server/routes/retailops.js");
  const express = (await import("express")).default;
  const vend = mkUser(A, "agent", "vendedor");
  const who: any = { dono, gerente, vend };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = A; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/retailops", router);
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (m: string, u: string, user: string, body?: any) => { const r = await fetch(`http://127.0.0.1:${port}/api/retailops${u}`, { method: m, headers: { "Content-Type": "application/json", "x-user": user }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const g = await call("GET", `/network-objective?pct=10&month=${MONTH}`, "dono");
  check("rota GET: dono recebe o plano (200) com lojas e rede", g.status === 200 && g.body.ok && Array.isArray(g.body.stores) && g.body.executes === false);
  check("rota GET: pct inválido → 400; vendedor → 403", (await call("GET", "/network-objective?pct=0", "dono")).status === 400 && (await call("GET", "/network-objective?pct=10", "vend")).status === 403);
  const pt = await call("POST", "/network-objective/tasks", "vend", { pct: 10, storeIds: [carioca] });
  check("rota POST tasks: vendedor → 403", pt.status === 403);
  const pt2 = await call("POST", "/network-objective/tasks", "dono", { pct: 10, month: MONTH, storeIds: ["nao-existe"] });
  check("rota POST tasks: loja inexistente → 400 (nada criado)", pt2.status === 400 && pt2.body.ok === false);
  server.close();

  const ui = fs.readFileSync(path.join(process.cwd(), "src/features/RetailOpsView.tsx"), "utf8");
  check("UI: card do objetivo da rede consome o plano, mostra esforço/projeção e cria tarefas só por clique", /network-objective-card/.test(ui) && /\/api\/retailops\/network-objective\?pct=/.test(ui) && /\/api\/retailops\/network-objective\/tasks/.test(ui) && /Criar tarefas/.test(ui) && /não é promessa/.test(ui));

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
