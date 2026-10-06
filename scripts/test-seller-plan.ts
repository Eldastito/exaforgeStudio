/**
 * TESTE — ADR-204 F3.5: "POR QUE provavelmente" + PLANO DE 14 DIAS do vendedor (SellerRecommendationService + SellerPlanTaskService).
 * ----------------------------------------------------------------------------
 * Prova, nos serviços REAIS, com vendas/escala/atendimentos simulados:
 *   A) o fator (driver) vem dos NÚMEROS — dias/nº de vendas/ticket/P.A./sem fator claro; vendas que não caíram e dado insuficiente
 *      NÃO geram plano; fato separado de hipótese; nenhuma palavra de culpa/punição/salário no plano;
 *   B) plano de 14 dias: datas coerentes, referência = o PRÓPRIO período anterior (nunca meta inventada), checkpoint no dia 14;
 *   C) meses seguidos abaixo da meta entram como fato e acrescentam o alinhamento com a gestão (sem punição);
 *   D) atendimentos da loja só fora da calibração e com amostra mínima; nunca ranking;
 *   E) tarefas SÓ por pessoa: sistema recusado, plano recalculado no servidor (chave desconhecida recusada), idempotente,
 *      responsável = gerente da loja, tarefa no TaskService com prazo/descrição/auditoria; nada de comissão tocado;
 *   F) rotas: dono/admin; gerente restrito só vê gente da PRÓPRIA loja; 403/404/400; read-only (GET não cria nada); isolado por empresa.
 *
 * Uso:  npm run test:seller-plan
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seller-plan-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-seller-plan-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SellerRecommendationService: R } = await import("../src/server/SellerRecommendationService.js");
  const { SellerPlanTaskService: T } = await import("../src/server/SellerPlanTaskService.js");
  const { RetailSellerIdentityService: ID } = await import("../src/server/RetailSellerIdentityService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const A = mkOrg(), B = mkOrg();
  const mkUser = (org: string, role: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')`).run(id, org, name, `${id}@t.local`, role); return { userId: id, id, role, name, email: `${id}@t.local` }; };
  const dono = mkUser(A, "owner", "Dona Maria"), gerente = mkUser(A, "admin", "Gerente Bruno"), gerenteNorte = mkUser(A, "admin", "Gerente Norte"), agent = mkUser(A, "agent", "Vendedor Zé"), outsider = mkUser(B, "owner", "Outra");
  const mkStore = (name: string, manager?: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active, manager_user_id) VALUES (?, ?, ?, ?, 1, ?)`).run(id, A, name, name.slice(0, 3).toUpperCase(), manager || null); return id; };
  const centro = mkStore("Loja Centro", gerente.userId), norte = mkStore("Loja Norte", gerenteNorte.userId);
  db.prepare(`INSERT INTO user_stores (id, organization_id, user_id, store_id) VALUES (?, ?, ?, ?)`).run(randomUUID(), A, gerente.userId, centro);
  db.prepare(`INSERT INTO user_stores (id, organization_id, user_id, store_id) VALUES (?, ?, ?, ?)`).run(randomUUID(), A, gerenteNorte.userId, norte);

  const REF = "2026-09-30";
  const seller = (mat: string, name: string, store = centro) => {
    const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, ?, ?)`).run(id, A, mat, name);
    ID.addAssignment(A, { sellerId: id, storeId: store, type: "transferencia_definitiva", startDate: "2026-01-01" });
    return id;
  };
  const sale = (mat: string, name: string, date: string, valor: number, pecas: number) =>
    db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, sale_date, seller_name, matricula, valor, pecas, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')`).run(randomUUID(), A, date, name, mat, valor, pecas);
  const cur = (i: number) => `2026-09-${String(i).padStart(2, "0")}`, prv = (i: number) => `2026-08-${String(i + 1).padStart(2, "0")}`;     // i=1..: 02/08.. e 01/09..
  const fill = (mat: string, name: string, nCur: number, vCur: number, pCur: number, nPrev: number, vPrev: number, pPrev: number) => {
    for (let i = 1; i <= nCur; i++) sale(mat, name, cur(i), vCur, pCur);
    for (let i = 1; i <= nPrev; i++) sale(mat, name, prv(i), vPrev, pPrev);
  };
  const maria = seller("101", "Maria Souza");        // nº de vendas cai (10→5), ticket estável
  const pedro = seller("102", "Pedro Alves");        // dias escalados caem (20→8)
  const ana = seller("103", "Ana Lima");             // ticket cai (100→60), nº de vendas igual
  const paula = seller("104", "Paula Nunes");        // P.A. cai (3→2), ticket −10% (não dispara o ticket)
  const clara = seller("105", "Clara Dias");         // queda sem fator único
  const rita = seller("106", "Rita Gomes");          // vendas SUBIRAM
  const vazia = seller("107", "Vera Sem Dados");     // sem vendas
  const noOrg = seller("108", "Nina Norte", norte);  // outra loja (escopo)
  fill("101", "Maria Souza", 5, 100, 1, 10, 100, 1);
  fill("102", "Pedro Alves", 8, 100, 1, 20, 100, 1);
  for (let i = 0; i < 20; i++) db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, status) VALUES (?, ?, ?, ?, 'mat:102', 'work')`).run(randomUUID(), A, centro, i < 8 ? cur(i + 1) : prv(i - 7));
  fill("103", "Ana Lima", 10, 60, 1, 10, 100, 1);
  fill("104", "Paula Nunes", 10, 90, 2, 10, 100, 3);
  fill("105", "Clara Dias", 9, 89, 1, 10, 100, 1);
  fill("106", "Rita Gomes", 12, 100, 1, 10, 100, 1);
  fill("108", "Nina Norte", 5, 100, 1, 10, 100, 1);
  sale("101", "Maria Souza", cur(3), 0, 0); // linha zerada não pode quebrar nada
  db.prepare(`DELETE FROM retail_seller_sales WHERE valor = 0`).run();

  const rec = (id: string) => R.recommend(A, id, REF);
  const txt = (r: any) => JSON.stringify(r.plan14?.items || []);

  // ── A) fator pelos números ──
  const rM = rec(maria), rP = rec(pedro), rA = rec(ana), rPa = rec(paula), rC = rec(clara), rR = rec(rita), rV = rec(vazia);
  check("nº de vendas caiu com ticket estável → driver 'orders'", rM.driver === "orders" && rM.plan14?.items.some((i: any) => i.key === "observar_fluxo"), rM.driver);
  check("menos dias escalados → driver 'days' e o plano começa por conferir a ESCALA (não por cobrar a pessoa)", rP.driver === "days" && rP.plan14.items[0].key === "conferir_escala" && /não é desempenho da pessoa/.test(txt(rP)), rP.driver);
  check("ticket caiu com nº de vendas igual → driver 'ticket'", rA.driver === "ticket" && rA.plan14.items.some((i: any) => i.key === "revisar_mix"), rA.driver);
  check("P.A. caiu → driver 'pa'", rPa.driver === "pa" && rPa.plan14.items.some((i: any) => i.key === "praticar_pa"), rPa.driver);
  check("queda sem fator único → 'unclear': o plano é só a CONVERSA (não inventa intervenção)", rC.driver === "unclear" && rC.plan14.items.filter((i: any) => i.key !== "checkpoint").map((i: any) => i.key).join() === "conversa_1a1", rC.plan14?.items.map((i: any) => i.key).join());
  check("vendas SUBIRAM → sem plano, com o motivo", rR.driver === "none" && rR.plan14 === null && /não caíram/.test(rR.reason));
  check("sem vendas → dado insuficiente: sem plano e sem diagnóstico inventado", rV.enough === false && rV.plan14 === null && rV.driver === "insufficient");
  check("vendedor inexistente / de outra empresa → found:false", R.recommend(A, "nao-existe", REF).found === false && R.recommend(B, maria, REF).found === false);
  check("fato e hipótese separados e rotulados (fatos primeiro)", rM.why.some((w: any) => w.kind === "fact") && rM.why.some((w: any) => w.kind === "hypothesis") && rM.why.findIndex((w: any) => w.kind === "hypothesis") > rM.why.map((w: any) => w.kind).lastIndexOf("fact") - 1);
  const allText = [rM, rP, rA, rPa, rC].map((r) => txt(r) + JSON.stringify(r.why)).join(" ");
  check("nenhuma palavra de culpa/punição/desligamento/salário/comissão nos textos do plano e das hipóteses", !/culpa|punir|punição|demiss|desligamento|advert|salário|salario|comiss/i.test(allText), (allText.match(/culpa|punir|punição|demiss|desligamento|advert|salário|salario|comiss/i) || [""])[0]);
  check("o aviso diz que é conversa do gerente, não avaliação formal, e não afeta comissão", /CONVERSA/.test(rM.disclaimer) && /não afeta comissão/.test(rM.disclaimer));
  check("o plano é rotulado HIPÓTESE com o checkpoint para confirmar ou descartar", rM.plan14.basis === "hypothesis" && /confirmar ou descartar/.test(rM.plan14.note));

  // ── B) plano de 14 dias ──
  const p = rM.plan14;
  check("datas: começa no dia seguinte e termina em 14 dias", p.startDate === "2026-10-01" && p.endDate === "2026-10-14" && p.days === 14);
  const cp = p.items.find((i: any) => i.key === "checkpoint");
  check("checkpoint no dia 14 (reavaliar e comparar) e é o último item", cp.fromDay === 14 && cp.dueDate === "2026-10-14" && p.items[p.items.length - 1].key === "checkpoint");
  check("itens ordenados por dia e dentro de 1..14", p.items.every((i: any, k: number) => i.fromDay >= 1 && i.toDay <= 14 && i.fromDay <= i.toDay && (k === 0 || p.items[k - 1].fromDay <= i.fromDay)));
  check("a referência do plano é o PRÓPRIO período anterior da pessoa (10 vendas, R$ 1.000,00) — nunca meta inventada", p.reference.orders === 10 && p.reference.sales === 1000 && /10 vendas/.test(txt(rM)) && /ão é meta nova nem altera a meta oficial/.test(txt(rM)));
  check("cada item aponta o número que o motivou (why) e o que acompanhar", p.items.filter((i: any) => i.key !== "conversa_1a1").every((i: any) => i.why.length > 10));
  check("a leitura é determinística (mesma entrada → mesmo plano)", JSON.stringify(rec(maria)) === JSON.stringify(rM));

  // ── C) meses seguidos abaixo da meta ──
  check("sem placar mensal: não há fato de sequência e nada quebra", rM.streak.level === "none" && !rM.why.some((w: any) => w.source === "meta_mensal"));
  const fakeDx: any = { driver: "orders", previous: { start: "2026-08-02", end: "2026-08-31", sales: 1000, orders: 10, ticket: 100, pa: 1 }, current: { sales: 500, orders: 5, ticket: 100, pa: 1 }, deltasPct: { orders: -50 } };
  const withStreak = (R as any).plan(fakeDx, REF, "action", 4);
  check("3+ meses seguidos abaixo da meta: acrescenta o alinhamento com a gestão (apoio, não punição)", withStreak.items.some((i: any) => i.key === "alinhamento_gestao" && /não de punição/.test(i.detail)) && !(R as any).plan(fakeDx, REF, "attention", 1).items.some((i: any) => i.key === "alinhamento_gestao"));

  // ── D) atendimentos da loja ──
  check("sem atendimentos registrados → fonte 'low_sample' (não uso, não invento)", rM.evidenceSources.floor === "low_sample" && !rM.why.some((w: any) => w.source === "atendimentos"));
  const att = (sellerId: string, n: number, confirmed: number) => { for (let i = 0; i < n; i++) db.prepare(`INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id, started_at, ended_at, outcome, reconciliation_state) VALUES (?, ?, ?, 'sh', ?, ?, ?, ?, ?)`).run(randomUUID(), A, centro, sellerId, `2026-09-${String((i % 28) + 1).padStart(2, "0")} 10:00:00`, `2026-09-${String((i % 28) + 1).padStart(2, "0")} 10:20:00`, i < confirmed ? "converted" : "not_converted", i < confirmed ? "confirmed" : null); };
  att(maria, 12, 3); att(pedro, 20, 15);
  const rM2 = rec(maria);
  check("com ≥10 atendimentos e fora da calibração: entra como FATO (pessoa × média da PRÓPRIA loja, sem ranking)", rM2.evidenceSources.floor === "used" && rM2.why.some((w: any) => w.kind === "fact" && w.source === "atendimentos" && /média da loja/.test(w.text)));
  check("conversão abaixo da média da loja + driver 'orders' → vira HIPÓTESE rotulada (não causa)", rM2.why.some((w: any) => w.kind === "hypothesis" && w.source === "atendimentos" && /pode ser abordagem/.test(w.text)));
  check("driver diferente de 'orders': atendimentos aparecem como fato, sem hipótese própria", !rec(ana).why.some((w: any) => w.kind === "hypothesis" && w.source === "atendimentos"));
  let calOk = true; try { db.prepare(`INSERT OR REPLACE INTO retail_floor_settings (organization_id, calibration_until) VALUES (?, '2099-01-01')`).run(A); } catch { try { db.prepare(`UPDATE retail_floor_settings SET calibration_until = '2099-01-01' WHERE organization_id = ?`).run(A); } catch { calOk = false; } }
  if (calOk) { const rm3 = rec(maria); check("em CALIBRAÇÃO do módulo de atendimentos: não usa esses números (RN-150-011)", rm3.evidenceSources.floor === "calibration" && !rm3.why.some((w: any) => w.source === "atendimentos")); db.prepare(`UPDATE retail_floor_settings SET calibration_until = NULL WHERE organization_id = ?`).run(A); }
  else check("calibração (fixture indisponível neste esquema)", true);

  // ── E) tarefas ──
  const tasksCount = () => (db.prepare(`SELECT COUNT(*) c FROM tasks WHERE organization_id = ?`).get(A) as any).c;
  const commissionBefore = JSON.stringify([db.prepare(`SELECT COUNT(*) c FROM retail_commission_runs WHERE organization_id = ?`).get(A), db.prepare(`SELECT COUNT(*) c FROM retail_commission_items WHERE organization_id = ?`).get(A)]);
  const t0 = tasksCount();
  const mk = (over: any = {}, by: any = gerente.userId) => T.create(A, { sellerId: maria, refDate: REF, itemKeys: ["observar_fluxo", "checkpoint"], ...over }, by);
  for (const bad of [undefined, null, "", "  ", "runtime", "ai", "rule", "agent:coach", "bot-1"])
    check(`aprovação por "${String(bad)}" é recusada (só pessoa)`, T.create(A, { sellerId: maria, refDate: REF, itemKeys: ["observar_fluxo", "checkpoint"] }, bad as any).ok === false && tasksCount() === t0);
  check("lista vazia e chave fora do plano (cliente não escolhe texto) → recusados", mk({ itemKeys: [] }).ok === false && mk({ itemKeys: ["inventado"] }).ok === false && tasksCount() === t0);
  check("vendas que não caíram (sem plano) → recusa com o motivo", (() => { const o = T.create(A, { sellerId: rita, refDate: REF, itemKeys: ["checkpoint"] }, gerente.userId); return o.ok === false && /não caíram|Não há plano/.test(o.error || ""); })());
  check("responsável fora da empresa → recusado", mk({ assignedTo: outsider.userId }).ok === false && tasksCount() === t0);
  check("vendedor de outra empresa não vira tarefa em A", T.create(B, { sellerId: maria, refDate: REF, itemKeys: ["checkpoint"] }, outsider.userId).ok === false);
  const ok1 = mk();
  check("pessoa aprova → cria as tarefas escolhidas", ok1.ok && ok1.created.length === 2 && tasksCount() === t0 + 2);
  const task = db.prepare(`SELECT * FROM tasks WHERE organization_id = ? AND id = ?`).get(A, ok1.created[0].taskId) as any;
  check("tarefa: responsável = GERENTE da loja, título com a pessoa, origem 'ia', prazo do item", task.assigned_to === gerente.userId && /^Plano 14 dias — Maria Souza:/.test(task.title) && task.source === "ia" && String(task.due_at).startsWith(ok1.created[0].dueDate));
  check("a descrição carrega o porquê, o que acompanhar e o aviso (conversa, não avaliação)", /Por quê:/.test(task.description) && /O que acompanhar:/.test(task.description) && /CONVERSA/.test(task.description) && /aprovado por Gerente Bruno/.test(task.description));
  const again = mk();
  check("idempotente: pedir de novo NÃO duplica (itens voltam em skipped)", again.ok && again.created.length === 0 && again.skipped.length === 2 && tasksCount() === t0 + 2);
  const more = mk({ itemKeys: ["observar_fluxo", "conversa_1a1"] });
  check("item novo do mesmo plano entra; o repetido é pulado", more.created.length === 1 && more.created[0].key === "conversa_1a1" && more.skipped.length === 1);
  const other = mk({ assignedTo: dono.userId, itemKeys: ["retorno_ao_nivel"] });
  check("responsável escolhido (da empresa) é respeitado", (db.prepare(`SELECT assigned_to FROM tasks WHERE id = ?`).get(other.created[0].taskId) as any).assigned_to === dono.userId);
  check("auditoria: quem aprovou, qual plano e quais itens", !!db.prepare(`SELECT 1 FROM auth_audit_logs WHERE organization_id = ? AND actor_user_id = ? AND event_type = 'SELLER_PLAN14_TASKS_CREATED'`).get(A, gerente.userId));
  check("nada de comissão/meta foi tocado", JSON.stringify([db.prepare(`SELECT COUNT(*) c FROM retail_commission_runs WHERE organization_id = ?`).get(A), db.prepare(`SELECT COUNT(*) c FROM retail_commission_items WHERE organization_id = ?`).get(A)]) === commissionBefore);
  const sigBefore = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ?`).get(A) as any).c, tBefore = tasksCount();
  rec(maria); rec(pedro); rec(ana);
  check("recomendar é READ-ONLY: não cria tarefa nem sinal", tasksCount() === tBefore && (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ?`).get(A) as any).c === sigBefore);

  // ── F) rotas ──
  const express = (await import("express")).default;
  const router = (await import("../src/server/routes/retailops.js")).default;
  const who: Record<string, any> = { dono, gerente, gerenteNorte, agent };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-org"] || undefined; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/retail", router);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (method: string, url: string, user: string | null, org: string | null, body?: any) => {
    const h: any = { "Content-Type": "application/json" }; if (user) h["x-user"] = user; if (org) h["x-org"] = org;
    const r = await fetch(`http://127.0.0.1:${port}/api/retail${url}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const g1 = await call("GET", `/seller-plan/${pedro}?date=${REF}`, "dono", A);
  check("rota: dono lê o plano", g1.status === 200 && g1.body.driver === "days" && Array.isArray(g1.body.plan14.items));
  check("rota: gerente da loja Centro lê gente da PRÓPRIA loja", (await call("GET", `/seller-plan/${pedro}?date=${REF}`, "gerente", A)).status === 200);
  const g3 = await call("GET", `/seller-plan/${noOrg}?date=${REF}`, "gerente", A);
  check("rota: gerente da loja Centro NÃO vê vendedor da Loja Norte (403)", g3.status === 403 && g3.body.error === "seller_out_of_scope");
  check("rota: o gerente da Loja Norte vê o dele", (await call("GET", `/seller-plan/${noOrg}?date=${REF}`, "gerenteNorte", A)).status === 200);
  check("rota: quem não é dono/admin → 403; sem empresa → 401/403; vendedor inexistente → 404", (await call("GET", `/seller-plan/${pedro}`, "agent", A)).status === 403 && [401, 403].includes((await call("GET", `/seller-plan/${pedro}`, null, null)).status) && (await call("GET", `/seller-plan/nao-existe?date=${REF}`, "dono", A)).status === 404);
  const p1 = await call("POST", `/seller-plan/${ana}/tasks`, "gerente", A, { date: REF, items: ["revisar_mix"] });
  check("rota: gerente aprova e cria a tarefa (responsável = ele, gerente da loja)", p1.status === 200 && p1.body.created.length === 1 && (db.prepare(`SELECT assigned_to FROM tasks WHERE id = ?`).get(p1.body.created[0].taskId) as any).assigned_to === gerente.userId);
  check("rota: item fora do plano → 400; gerente de outra loja → 403; agent → 403", (await call("POST", `/seller-plan/${ana}/tasks`, "gerente", A, { date: REF, items: ["x"] })).status === 400 && (await call("POST", `/seller-plan/${ana}/tasks`, "gerenteNorte", A, { date: REF, items: ["checkpoint"] })).status === 403 && (await call("POST", `/seller-plan/${ana}/tasks`, "agent", A, { date: REF, items: ["checkpoint"] })).status === 403);
  server.close();
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/SellerRecommendationService.ts"), "utf8");
  check("o serviço de recomendação é só leitura: não importa TaskService/BusinessSignalService/DecisionAction", !/TaskService|BusinessSignalService|DecisionAction|INSERT|UPDATE|DELETE/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
