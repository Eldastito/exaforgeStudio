/**
 * TESTE — PRD Fase 1, homologação: rotas HTTP da Retail Ops (perfil + data do dia).
 * Fecha dois itens do checklist da IA Dev que estavam só "parciais":
 *  (1) Owner/Admin × usuário comum NAS ROTAS (não só no serviço): toda rota nova da Fase 1 que nomeia pessoas ou mostra
 *      dinheiro responde 403 a quem não é owner/admin, e 200 a owner/admin;
 *  (2) a data padrão "hoje" é a de SÃO PAULO, não a UTC. Achado: às 22:30 (BRT) o servidor está em 01:30 UTC do dia
 *      SEGUINTE — `GET /day-brief` e o cabeçalho do Insights, sem `?date=`, mostravam o dia de amanhã (tudo "aguardando",
 *      cota de amanhã) justo na hora em que o dono confere o fechamento. Relógio fixado em 22:30 BRT de 30/09/2026.
 * Também prova, via HTTP, o ranking do Insights (fechamento de valor 0 fora; Top não repete no Bottom) e o isolamento entre orgs.
 * Uso:  npm run test:fase1-routes
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fase1-routes-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-fase1-routes-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const express = (await import("express")).default;
  const { default: retailRoutes } = await import("../src/server/routes/retailops.js");
  const { RetailStoreService: Stores } = await import("../src/server/RetailStoreService.js");

  const app = express();
  app.use(express.json());
  app.use("/api/retailops", (req: any, _res: any, next: any) => {
    req.organizationId = req.headers["x-test-org"] || null;
    req.user = { userId: req.headers["x-test-user"] || "u1", role: req.headers["x-test-role"] || "owner", organizationId: req.organizationId };
    next();
  }, retailRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/retailops`;
  const call = async (method: string, p: string, org: string, role: string, body?: any, user = "u1") => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-test-org": org, "x-test-role": role, "x-test-user": user }, body: body ? JSON.stringify(body) : undefined });
    let j: any = null; try { j = await r.json(); } catch { /* sem corpo */ }
    return { status: r.status, body: j };
  };

  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, retail_official_sale_source) VALUES (?, ?, 'X', 'active', 'folha')`).run(randomUUID(), o);
  const store = (org: string, name: string) => Stores.create(org, { name, code: name.slice(0, 4) + randomUUID().slice(0, 3) } as any).id;
  const quota = (org: string, st: string, date: string, v: number) => db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, st, date, v);
  // Estado REAL: fechamento recebido (valor > 0) = 'received'; linha criada sem nada recebido = 'pending' com valor 0.
  const closing = (org: string, st: string, date: string, v: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, st, date, v > 0 ? "received" : "pending", v);

  const D = "2026-09-30", NEXT = "2026-10-01";
  const carioca = store(A, "Carioca"), avb = store(A, "Avenida Brasil"), grande = store(A, "Grande Rio");
  for (const [st, q, v] of [[carioca, 1300, 1358.7], [avb, 5700, 1599.2], [grande, 2500, 0]] as const) { quota(A, st, D, q); closing(A, st, D, v); }
  quota(A, carioca, NEXT, 9999);                                           // cota de AMANHÃ (distinta, p/ detectar a data errada)
  const sellerA = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, '1', 'Maria')`).run(sellerA, A);

  // ── (1) perfil: 403 p/ quem não é owner/admin, 200 p/ owner/admin ──
  const gated: Array<[string, string, any?]> = [
    ["GET", "/afternoon-brief"], ["PUT", "/afternoon-brief/enabled", { enabled: false }],
    ["GET", "/day-brief"], ["PUT", "/night-brief/enabled", { enabled: false }],
    ["GET", "/sellers/identity/suggestions"], ["GET", "/sellers/identity/unidentified"],
    ["POST", "/sellers/identity/not-same", { aId: sellerA, bId: sellerA }],
    ["GET", "/seller-goal-streaks"], ["PUT", "/seller-goal-streaks/alerts", { enabled: false }],
    ["GET", `/sellers/${sellerA}/aliases`], ["GET", `/sellers/${sellerA}/absences`],
    ["GET", "/commission/policies"], ["POST", "/commission/policies/import", { text: "" }],
    ["PUT", "/stock/replenishment-strategy", { strategy: "continuous_replenishment" }],
  ];
  for (const role of ["agent", "viewer", "member"]) {
    const bad = [];
    for (const [m, p, b] of gated) { const r = await call(m, p, A, role, b); if (r.status !== 403) bad.push(`${m} ${p}→${r.status}`); }
    check(`perfil '${role}': ${gated.length} rotas de pessoas/dinheiro/chaves da Fase 1 respondem 403`, bad.length === 0, bad.join(" | "));
  }
  for (const role of ["owner", "admin"]) {
    const bad = [];
    for (const [m, p, b] of gated) { const r = await call(m, p, A, role, b); if (r.status === 403 || r.status === 401) bad.push(`${m} ${p}→${r.status}`); }
    check(`perfil '${role}': nenhuma dessas rotas é barrada (pode ser 200/400 de validação, nunca 403/401)`, bad.length === 0, bad.join(" | "));
  }
  check("sem organização (401): rota da Fase 1 não responde dado", (await call("GET", "/day-brief", "", "owner")).status === 401);

  // ── (2) data padrão = São Paulo, com o relógio em 22:30 BRT de 30/09 (= 01:30 UTC de 01/10) ──
  const RealDate = Date; const FIXED = RealDate.UTC(2026, 9, 1, 1, 30, 0);
  class FakeDate extends RealDate { constructor(...a: any[]) { if (a.length === 0) super(FIXED); else super(...(a as [any])); } static now() { return FIXED; } }
  (globalThis as any).Date = FakeDate;
  let day: any, aft: any, hdr: any;
  try {
    day = await call("GET", "/day-brief", A, "owner");
    aft = await call("GET", "/afternoon-brief", A, "owner");
    hdr = await call("GET", "/insights/header", A, "owner");
  } finally { (globalThis as any).Date = RealDate; }
  check("às 22:30 BRT, /day-brief sem ?date= mostra o DIA 30 (não o dia seguinte): Carioca e Av. Brasil com venda", day.status === 200 && day.body?.night?.date === D && day.body.night.stores.some((s: any) => s.storeName === "Carioca" && s.venda?.state === "value"), JSON.stringify({ date: day.body?.night?.date, carioca: day.body?.night?.stores?.find((s: any) => s.storeName === "Carioca") }));
  check("...e o texto do fechamento traz a cota do dia 30 (1.300), não a de amanhã (9.999)", /1\.300/.test(day.body?.nightText || "") && !/9\.999/.test(day.body?.nightText || ""));
  check("às 22:30 BRT, /afternoon-brief sem ?date= também é o dia 30", aft.status === 200 && (aft.body?.snapshot?.date === D), JSON.stringify(aft.body?.snapshot?.date));
  check("às 22:30 BRT, o cabeçalho do Insights (a tela chama SEM data) é do dia 30: cota 9.500 e vendido 2.957,90", hdr.status === 200 && hdr.body?.date === D && Math.round(hdr.body.daily.quotaTotal) === 9500 && Math.abs(hdr.body.daily.realized - 2957.9) < 0.01, JSON.stringify({ date: hdr.body?.date, q: hdr.body?.daily?.quotaTotal }));
  // com ?date= explícito segue valendo (0-regressão)
  const exp = await call("GET", `/day-brief?date=${NEXT}`, A, "owner");
  check("?date= explícito continua mandando (0-regressão)", exp.body?.night?.date === NEXT);

  // ── helper: limites do fuso (BRT = UTC−3, sem horário de verão) ──
  const { todaySP } = await import("../src/server/spDate.js");
  const U = (h: number, m = 0, d = 1, mo = 9) => new RealDate(RealDate.UTC(2026, mo, d, h, m));
  check("todaySP: 01:30 UTC de 01/10 (= 22:30 BRT) → 30/09; 02:59 UTC → ainda 30/09; 03:00 UTC (00:00 BRT) → 01/10", todaySP(U(1, 30)) === "2026-09-30" && todaySP(U(2, 59)) === "2026-09-30" && todaySP(U(3, 0)) === "2026-10-01");
  check("todaySP: manhã/tarde BRT = mesma data UTC (08:00 e 16:00 BRT)", todaySP(U(11, 0, 30, 8)) === "2026-09-30" && todaySP(U(19, 0, 30, 8)) === "2026-09-30");

  // ── ranking do Insights via HTTP ──
  const r = await call("GET", `/insights/header?date=${D}`, A, "owner");
  const names = (l: any[]) => (l || []).map((s) => s.storeName);
  check("ranking: Grande Rio (fechamento de valor 0 = aguardando) fica FORA do Top e do Bottom", !names(r.body.ranking.top3).includes("Grande Rio") && !names(r.body.ranking.bottom3).includes("Grande Rio"), JSON.stringify(r.body.ranking));
  check("ranking: nenhuma loja aparece no Top E no Bottom ao mesmo tempo", names(r.body.ranking.top3).every((n: string) => !names(r.body.ranking.bottom3).includes(n)));
  check("cabeçalho: 2 de 3 lojas com fechamento e desvio só entre elas (não contra a cota da rede inteira)", r.body.daily.closedStores === 2 && Math.abs(r.body.daily.comparableVariance - (2957.9 - 7000)) < 0.01, JSON.stringify(r.body.daily));
  const informe = await call("GET", `/dashboard/informe?date=${D}`, A, "owner");
  check("informe: Grande Rio 'awaiting' e resultado do total só das lojas fechadas", informe.body.stores.find((s: any) => s.storeName === "Grande Rio")?.awaiting === true && Math.abs(informe.body.total.desvioComparable - (2957.9 - 7000)) < 0.01);

  // ── isolamento: a org B não enxerga nada da A ──
  const rb = await call("GET", `/insights/header?date=${D}`, B, "owner");
  const ib = await call("GET", `/dashboard/informe?date=${D}`, B, "owner");
  check("isolamento: a org B vê cabeçalho e informe vazios (sem lojas/fechamentos da A)", rb.body.daily.closedStores === 0 && rb.body.daily.quotaTotal === 0 && ib.body.stores.length === 0);

  // ── GERENTE DE LOJA = 'admin' COM loja atribuída (ADR-173): o papel sozinho não o barra ──
  // Achado: `requireRole("owner","admin")` deixa o gerente-admin passar e ele via a REDE inteira (venda, dinheiro, comissão de
  // todos os vendedores). Aqui: ele só enxerga a(s) loja(s) dele; rotas de rede (comissão, pessoas, chaves) exigem escopo de rede.
  const GER = "user_gerente_carioca", COADMIN = "user_coadmin_sem_loja";
  db.prepare(`INSERT INTO user_stores (id, organization_id, user_id, store_id) VALUES (?, ?, ?, ?)`).run(randomUUID(), A, GER, carioca);
  const range = "start=2026-09-01&end=2026-09-30";
  const netRoutes: Array<[string, string, any?]> = [
    ["GET", `/commission/report?${range}`], ["GET", "/afternoon-brief"], ["GET", "/day-brief"], ["GET", "/seller-goal-streaks"],
    ["GET", "/sellers/identity/suggestions"], ["GET", "/commission/policies"], ["PUT", "/night-brief/enabled", { enabled: false }],
    ["PUT", "/stock/replenishment-strategy", { strategy: "continuous_replenishment" }],
  ];
  const leaks = [];
  for (const [m, p, b] of netRoutes) { const r = await call(m, p, A, "admin", b, GER); if (r.status !== 403) leaks.push(`${m} ${p.split("?")[0]}→${r.status}`); }
  check("gerente-admin (loja atribuída): rotas de REDE (comissão de todos, pessoas, chaves) respondem 403", leaks.length === 0, leaks.join(" | "));
  const okRole = [];
  for (const who of [["owner", "u_owner"], ["admin", COADMIN]] as const) for (const [m, p, b] of netRoutes) { const r = await call(m, p, A, who[0], b, who[1]); if (r.status === 403 || r.status === 401) okRole.push(`${who[0]} ${m} ${p.split("?")[0]}→${r.status}`); }
  check("owner e admin SEM loja atribuída (co-admin) continuam acessando as rotas de rede (0-regressão)", okRole.length === 0, okRole.join(" | "));

  // ── aba Comissão: as 7 rotas sem trava + as de ESCRITA da mesma aba (que só tinham requireRole e o gerente-admin passava) ──
  const comRoutes: Array<[string, string, any?]> = [
    ["GET", `/pdv-sellers?${range}`], ["GET", `/seller-sales?${range}`], ["GET", "/commission/rules"], ["GET", "/commission/report-source"],
    ["GET", `/commission/store-report?storeId=${carioca}&${range}`], ["GET", "/commission/runs/abc"], ["GET", "/commission/plan?period=2026-09"],
    ["POST", "/seller-sales", { saleDate: D, entries: [{ sellerName: "X", valor: 1 }] }], ["PATCH", "/seller-sales/abc", {}], ["DELETE", "/seller-sales/abc"],
    ["POST", "/commission/rules", { name: "x" }], ["PATCH", "/commission/rules/abc", {}], ["PUT", "/commission/report-source", { fromRace: false }],
    ["POST", "/commission/runs", {}], ["POST", "/commission/runs/abc/compare", {}], ["POST", "/commission/runs/abc/approve", {}], ["POST", "/commission/runs/abc/reject", {}],
    ["PATCH", "/commission/runs/abc/items/def", {}], ["DELETE", "/commission/runs/abc/items/def"], ["PUT", "/commission/plan", {}], ["POST", "/commission/race/run", {}],
  ];
  const comLeaks = [];
  // Decisão do dono (TOULON, 04/10): o GERENTE da loja LÊ as vendas por vendedor da PRÓPRIA loja (`/pdv-sellers`, `/seller-sales`),
  // filtradas pelo escopo dele e SEM comissão (provado em test:retail-manager-read-scope). O resto da aba Comissão segue 403.
  const mgrMayRead = new Set(["GET /pdv-sellers", "GET /seller-sales"]);
  for (const [m, p, b] of comRoutes) { const r = await call(m, p, A, "admin", b, GER); const k = `${m} ${p.split("?")[0]}`; if (mgrMayRead.has(k) ? r.status !== 200 : r.status !== 403) comLeaks.push(`${k}→${r.status}`); }
  check(`gerente-admin: a aba Comissão (regras, apuração, aprovar, plano, escrita) responde 403 nas ${comRoutes.length - mgrMayRead.size} rotas; só a LEITURA de vendas por vendedor da própria loja abre (200 filtrado)`, comLeaks.length === 0, comLeaks.join(" | "));
  const comOk = [];
  for (const who of [["owner", "u_owner"], ["admin", COADMIN]] as const) for (const [m, p, b] of comRoutes) { const r = await call(m, p, A, who[0], b, who[1]); if (r.status === 403 || r.status === 401) comOk.push(`${who[0]} ${m} ${p.split("?")[0]}→${r.status}`); }
  check("owner e co-admin sem loja: nenhuma delas é barrada (pode dar 400/404 de validação, nunca 403/401) — 0-regressão", comOk.length === 0, comOk.join(" | "));
  const keep = [];
  for (const p of ["/commission/runs", `/commission/race?month=2026-09`]) { const r = await call("GET", p, A, "admin", undefined, GER); if (r.status === 403 || r.status === 401) keep.push(`${p}→${r.status}`); }
  check("o que já filtra por loja dentro do handler NÃO foi travado (commission/runs lista e commission/race)", keep.length === 0, keep.join(" | "));
  const noRole = [];
  for (const [m, p, b] of comRoutes) { const r = await call(m, p, A, "agent", b, "u_agent"); if (r.status !== 403) noRole.push(`${m} ${p.split("?")[0]}→${r.status}`); }
  check("perfil comum (agent): também 403 em todas", noRole.length === 0, noRole.join(" | "));

  // ── finanças das lojas (resultado, custos, aluguel, taxas de maquininha): leitura E escrita, só rede ──
  const finRoutes: Array<[string, string, any?]> = [
    ["GET", `/stores-result?period=2026-09`], ["GET", `/stores/${carioca}/result?period=2026-09`],
    ["GET", `/stores/${carioca}/costs`], ["PUT", `/stores/${carioca}/costs`, { costs: {} }],
    ["GET", `/stores/${carioca}/variable-costs`], ["PUT", `/stores/${carioca}/variable-costs`, { costs: {} }],
    ["GET", `/stores/${carioca}/financial-settings`], ["PUT", `/stores/${carioca}/financial-settings`, {}],
    ["GET", `/stores/${carioca}/pos-fees`], ["PUT", `/stores/${carioca}/pos-fees`, {}], ["GET", `/stores/${carioca}/pos-fees/expected?${range}`],
  ];
  const finLeaks = [];
  for (const [m, p, b] of finRoutes) { const r = await call(m, p, A, "admin", b, GER); if (r.status !== 403) finLeaks.push(`${m} ${p.replace(carioca, ":id").split("?")[0]}→${r.status}`); }
  check(`gerente-admin: as ${finRoutes.length} rotas de finanças das lojas (resultado, custos, aluguel, configuração financeira, taxas) respondem 403 — leitura E escrita`, finLeaks.length === 0, finLeaks.join(" | "));
  const finOk = [];
  for (const who of [["owner", "u_owner"], ["admin", COADMIN]] as const) for (const [m, p, b] of finRoutes) { const r = await call(m, p, A, who[0], b, who[1]); if (r.status === 403 || r.status === 401) finOk.push(`${who[0]} ${m} ${p.replace(carioca, ":id").split("?")[0]}→${r.status}`); }
  check("owner e co-admin sem loja: nenhuma delas é barrada (0-regressão)", finOk.length === 0, finOk.join(" | "));
  const finAgent = [];
  for (const [m, p, b] of finRoutes) { const r = await call(m, p, A, "agent", b, "u_agent"); if (r.status !== 403) finAgent.push(`${m} ${p.replace(carioca, ":id").split("?")[0]}→${r.status}`); }
  check("perfil comum (agent): também 403 em todas", finAgent.length === 0, finAgent.join(" | "));

  // ── AUTO-ESCALAÇÃO: o gerente-admin NÃO pode tirar a própria restrição nem mexer no cadastro das lojas ──
  // Achado por HTTP: `PUT /store-scope/<ele>` com lista vazia dava 200 e ele virava irrestrito; PATCH/POST/DELETE em /stores também
  // passavam. Sem isto, TODAS as travas por loja eram contornáveis por quem tem o papel admin.
  const extra = db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Loja Alvo', 'ALVO')`); const alvo = randomUUID(); extra.run(alvo, A);
  const mgmt: Array<[string, string, any?]> = [
    ["GET", `/store-scope/${GER}`], ["PUT", `/store-scope/${GER}`, { storeIds: [] }],
    ["POST", "/stores", { name: "Nova pelo gerente", code: "NPG" }], ["PATCH", `/stores/${alvo}`, { name: "Renomeada pelo gerente" }],
    ["DELETE", `/stores/${alvo}`], ["POST", "/stores/rescue-merge-orphans", {}],
  ];
  const mgLeaks = [];
  for (const [m, p, b] of mgmt) { const r = await call(m, p, A, "admin", b, GER); if (r.status !== 403) mgLeaks.push(`${m} ${p.replace(GER, ":user").replace(alvo, ":id")}→${r.status}`); }
  check(`gerente-admin: as ${mgmt.length} rotas que mexem na restrição de loja e no cadastro das lojas respondem 403`, mgLeaks.length === 0, mgLeaks.join(" | "));
  const me = await call("GET", "/store-scope/me", A, "admin", undefined, GER);
  check("depois das tentativas, o gerente CONTINUA restrito à loja dele (não virou irrestrito)", me.body?.unrestricted === false && me.body?.storeIds?.length === 1 && me.body.storeIds[0] === carioca, JSON.stringify(me.body));
  const still = db.prepare(`SELECT name FROM retail_stores WHERE id = ? AND organization_id = ?`).get(alvo, A) as any;
  check("a loja-alvo continua existindo e com o nome original (nada foi renomeado/excluído)", still?.name === "Loja Alvo" && (db.prepare(`SELECT COUNT(*) AS c FROM retail_stores WHERE organization_id = ? AND code = 'NPG'`).get(A) as any).c === 0, JSON.stringify(still));
  const mgOk = [];
  for (const who of [["owner", "u_owner"], ["admin", COADMIN]] as const) for (const [m, p, b] of mgmt) { if (m === "DELETE") continue; const r = await call(m, p, A, who[0], b, who[1]); if (r.status === 403 || r.status === 401) mgOk.push(`${who[0]} ${m} ${p.replace(GER, ":user").replace(alvo, ":id")}→${r.status}`); }
  check("owner e co-admin sem loja continuam gerindo restrição e lojas (0-regressão)", mgOk.length === 0, mgOk.join(" | "));
  const mgAgent = [];
  for (const [m, p, b] of mgmt) { const r = await call(m, p, A, "agent", b, "u_agent"); if (r.status !== 403) mgAgent.push(`${m} ${p.replace(GER, ":user").replace(alvo, ":id")}→${r.status}`); }
  check("perfil comum (agent): também 403 em todas", mgAgent.length === 0, mgAgent.join(" | "));
  // o dono SEGUE conseguindo reatribuir lojas ao gerente (fluxo legítimo da tela de usuários)
  const ownerSet = await call("PUT", `/store-scope/${GER}`, A, "owner", { storeIds: [carioca] }, "u_owner");
  check("o DONO continua atribuindo lojas ao gerente (PUT /store-scope como owner → 200)", ownerSet.status === 200 && JSON.stringify(ownerSet.body?.storeIds) === JSON.stringify([carioca]), JSON.stringify(ownerSet));

  // limpeza: o bloco acima criou/renomeou lojas auxiliares (a "Loja Alvo" e as criadas pelo owner/co-admin) — volta às 3 lojas do cenário
  db.prepare(`DELETE FROM retail_stores WHERE organization_id = ? AND id NOT IN (?, ?, ?)`).run(A, carioca, avb, grande);
  check("cenário restaurado: só as 3 lojas originais", (db.prepare(`SELECT COUNT(*) AS c FROM retail_stores WHERE organization_id = ?`).get(A) as any).c === 3);

  const gh = await call("GET", `/insights/header?date=${D}`, A, "admin", undefined, GER);
  check("gerente: o cabeçalho do Insights é só da loja dele (cota 1.300, vendido 1.358,70, 1 loja) — não da rede (9.500)", gh.status === 200 && gh.body?.daily?.quotaTotal === 1300 && Math.abs(gh.body.daily.realized - 1358.7) < 0.01 && gh.body.daily.activeStores === 1 && gh.body.scoped === true, JSON.stringify({ q: gh.body?.daily?.quotaTotal, r: gh.body?.daily?.realized, n: gh.body?.daily?.activeStores, scoped: gh.body?.scoped }));
  check("gerente: o ranking do Insights só traz a loja dele", [...(gh.body?.ranking?.top3 || []), ...(gh.body?.ranking?.bottom3 || [])].every((x: any) => x.storeName === "Carioca"), JSON.stringify(gh.body?.ranking));
  check("gerente pedindo OUTRA loja no cabeçalho (?storeId=Av. Brasil) → 403; a loja dele → 200", (await call("GET", `/insights/header?date=${D}&storeId=${avb}`, A, "admin", undefined, GER)).status === 403 && (await call("GET", `/insights/header?date=${D}&storeId=${carioca}`, A, "admin", undefined, GER)).status === 200);
  const gi = await call("GET", `/dashboard/informe?date=${D}`, A, "admin", undefined, GER);
  check("gerente: o Informe diário só lista a loja dele e o total é só dela (1.358,70), marcado como 'scoped'", gi.status === 200 && gi.body?.stores?.length === 1 && gi.body.stores[0].storeName === "Carioca" && Math.abs(gi.body.total.venda - 1358.7) < 0.01 && gi.body.scoped === true, JSON.stringify({ n: gi.body?.stores?.map((x: any) => x.storeName), v: gi.body?.total?.venda, scoped: gi.body?.scoped }));
  const { buildDailyInformeText } = await import("../src/features/retailInformeText.js");
  const gtxt = buildDailyInformeText(gi.body);
  check("texto do informe do gerente (copiar/compartilhar): 'Suas lojas — Dia', só a Carioca, sem outras lojas nem 'Empresa Dia'", /Suas lojas — Dia/.test(gtxt) && /Carioca/.test(gtxt) && !/Avenida Brasil|Grande Rio|Empresa Dia/.test(gtxt), gtxt);
  const oh = await call("GET", `/insights/header?date=${D}`, A, "owner");
  const oi = await call("GET", `/dashboard/informe?date=${D}`, A, "owner");
  check("owner: continua vendo a rede inteira (cota 9.500, 3 lojas) e não é 'scoped' — 0-regressão", Math.round(oh.body.daily.quotaTotal) === 9500 && oh.body.daily.activeStores === 3 && !oh.body.scoped && oi.body.stores.length === 3 && !oi.body.scoped);
  const co = await call("GET", `/dashboard/informe?date=${D}`, A, "admin", undefined, COADMIN);
  check("admin SEM loja atribuída (co-admin): vê a rede inteira, como antes — 0-regressão", co.status === 200 && co.body.stores.length === 3 && !co.body.scoped);
  check("stock/negative do gerente segue filtrado pela loja dele (já era assim) e não foi travado", (await call("GET", "/stock/negative", A, "admin", undefined, GER)).status === 200);

  server.close();
  console.log("\n=== PRD Fase 1 · rotas HTTP: perfil + data do dia (São Paulo) ===");
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok || !x.detail ? "" : ` — ${x.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
