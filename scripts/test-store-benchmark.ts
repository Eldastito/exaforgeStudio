/**
 * TESTE — ADR-205 F4.3: benchmark interno normalizado entre lojas (StoreBenchmarkService).
 * Prova: normaliza por m²/pessoa/custo fixo (não ranqueia venda bruta) · sem o dado do dono → null e não compara · amostra mínima (<3 lojas → sem ranking) ·
 * loja nova (<6 meses) fora do ranking · mês corrente não ranqueia · posição vs mediana + perguntas (nunca causa/meta/fechar loja) · confiança nunca "alta" ·
 * só dono/admin grava o perfil · validações · isolamento · rotas · composição (não recalcula finanças).
 * Uso: npm run test:store-benchmark
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bench-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-bench-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { StoreBenchmarkService: B, MIN_COMPARABLE } = await import("../src/server/StoreBenchmarkService.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailStoreCostService } = await import("../src/server/RetailStoreCostService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const prev = (() => { const [y, m] = today.slice(0, 7).split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; })();
  const curMonth = today.slice(0, 7);
  const openedLongAgo = "2020-01-15";
  const closing = (org: string, store: string, month: string, total: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, 'approved', ?)`).run(randomUUID(), org, store, `${month}-10`, total);
  const owner = { userId: "u-owner", role: "owner" }, agent = { userId: "u-agent", role: "agent" };
  const thrown = (f: () => any) => { try { f(); return null; } catch (e: any) { return e?.code || "error"; } };
  const metric = (r: any, k: string) => r.metrics.find((m: any) => m.key === k);

  // Rede A: 4 lojas maduras. Faturamento igual NÃO é o ponto — o m² muda tudo.
  const A = mkOrg();
  const mk = (org: string, name: string) => RetailStoreService.create(org, { name } as any).id as string;
  const s1 = mk(A, "Centro"), s2 = mk(A, "Shopping"), s3 = mk(A, "Bairro"), s4 = mk(A, "Quiosque");
  for (const [id, rev] of [[s1, 100000], [s2, 100000], [s3, 100000], [s4, 100000]] as const) closing(A, id, prev, rev);
  // m²: 100, 200, 400, 50 → fat/m² = 1000, 500, 250, 2000 (mesma venda bruta, eficiência muito diferente)
  for (const [id, m2, eq] of [[s1, 100, 4], [s2, 200, 5], [s3, 400, 5], [s4, 50, 1]] as const) B.setProfile(A, owner, id, { areaM2: m2, teamSize: eq, openedOn: openedLongAgo });
  RetailStoreCostService.setMany(A, s1, { aluguel: 20000 }); RetailStoreCostService.setMany(A, s2, { aluguel: 30000 }); RetailStoreCostService.setMany(A, s3, { aluguel: 10000 }); RetailStoreCostService.setMany(A, s4, { aluguel: 5000 });

  const r = B.benchmark(A, { period: prev });
  check("é benchmark, não previsão nem ação: type/isForecast/executes e período fechado", r.type === "benchmark" && r.isForecast === false && r.executes === false && r.period === prev && r.periodComplete === true);
  const m2 = metric(r, "revenue_per_m2");
  check("normaliza por m²: mesma venda bruta, valores diferentes (1000/500/250/2000) — a loja grande não 'ganha' por ser grande", m2.ranked === true && m2.stores.find((x: any) => x.storeName === "Centro").value === 1000 && m2.stores.find((x: any) => x.storeName === "Quiosque").value === 2000 && m2.stores.find((x: any) => x.storeName === "Bairro").value === 250);
  check("mediana e posição vs mediana (Quiosque acima, Bairro abaixo) e rank só entre comparáveis", m2.median === 750 && m2.stores.find((x: any) => x.storeName === "Quiosque").position === "above_median" && m2.stores.find((x: any) => x.storeName === "Bairro").position === "below_median" && m2.stores.find((x: any) => x.storeName === "Quiosque").rank === 1 && m2.stores.find((x: any) => x.storeName === "Bairro").rank === 4);
  check("por pessoa e custo fixo/faturamento calculados (Centro: 25.000/pessoa; 20% de custo fixo)", metric(r, "revenue_per_person").stores.find((x: any) => x.storeName === "Centro").value === 25000 && metric(r, "fixed_cost_pct").stores.find((x: any) => x.storeName === "Centro").value === 20);
  check("custo fixo: menor é melhor — o Quiosque (5%) fica ACIMA da mediana e o Shopping (30%) abaixo", (() => { const f = metric(r, "fixed_cost_pct"); return f.stores.find((x: any) => x.storeName === "Quiosque").position === "above_median" && f.stores.find((x: any) => x.storeName === "Shopping").position === "below_median"; })());
  check("gera PERGUNTAS neutras (não conclusões) para quem está muito abaixo da mediana", m2.questions.length >= 1 && m2.questions.every((q: string) => q.endsWith("?") && !/feche|fechar|demit|contrat/i.test(q)));
  check("confiança nunca 'alta' (um mês não vê sazonalidade): 4 lojas → baixa", ["baixa", "media"].includes(m2.confidence) && m2.confidence === "baixa" && r.metrics.every((m: any) => m.confidence !== "alta"));
  check("avisos obrigatórios: correlação ≠ causa, sem sazonalidade, não é meta/fechar loja (RN-F4-8/12)", r.caveats.some((c: string) => /não prova causa/.test(c)) && r.caveats.some((c: string) => /sazonalidade/.test(c)) && r.caveats.some((c: string) => /não recomenda fechar/.test(c)));

  // sem o dado do dono: não compara, não inventa
  const C = mkOrg(); const c1 = mk(C, "L1"), c2 = mk(C, "L2"), c3 = mk(C, "L3");
  for (const id of [c1, c2, c3]) closing(C, id, prev, 50000);
  B.setProfile(C, owner, c1, { areaM2: 100, openedOn: openedLongAgo }); B.setProfile(C, owner, c2, { areaM2: 100, openedOn: openedLongAgo });
  const rc = B.benchmark(C, { period: prev });
  const mc = metric(rc, "revenue_per_m2");
  check("sem m² em 1 das 3 lojas: só 2 comparáveis → NÃO ranqueia (amostra mínima) e diz o motivo", MIN_COMPARABLE === 3 && mc.ranked === false && mc.reason === "amostra_minima" && mc.comparableStores === 2 && mc.median === null && mc.stores.every((x: any) => x.rank === null && x.position === null));
  check("a loja sem m² tem value null (null ≠ 0) e lista o que falta", mc.stores.find((x: any) => x.storeName === "L3").value === null && rc.stores.find((x: any) => x.storeName === "L3").missing.includes("area_m2") && rc.stores.find((x: any) => x.storeName === "L3").missing.includes("equipe"));
  check("por pessoa sem equipe informada em NENHUMA loja → sem ranking, tudo null", metric(rc, "revenue_per_person").ranked === false && metric(rc, "revenue_per_person").stores.every((x: any) => x.value === null));
  check("sem custo fixo cadastrado → custo fixo/faturamento null (não 0%)", metric(rc, "fixed_cost_pct").stores.every((x: any) => x.value === null));
  check("avisa quantas lojas estão com dado faltando", rc.caveats.some((c: string) => /3 de 3 loja/.test(c)));

  // faturamento zero = sem fechamento, não 'vendeu zero'
  const D = mkOrg(); const d1 = mk(D, "A"), d2 = mk(D, "B"), d3 = mk(D, "C"), d4 = mk(D, "D");
  for (const id of [d1, d2, d3]) { closing(D, id, prev, 80000); }
  for (const id of [d1, d2, d3, d4]) B.setProfile(D, owner, id, { areaM2: 100, teamSize: 3, openedOn: openedLongAgo });
  const rd = B.benchmark(D, { period: prev });
  check("loja sem fechamento no mês: faturamento null, valor null, 'faturamento_do_mes' em missing — e não derruba a amostra das outras", rd.stores.find((x: any) => x.storeName === "D").revenue === null && metric(rd, "revenue_per_m2").stores.find((x: any) => x.storeName === "D").value === null && rd.stores.find((x: any) => x.storeName === "D").missing.includes("faturamento_do_mes") && metric(rd, "revenue_per_m2").ranked === true && metric(rd, "revenue_per_m2").comparableStores === 3);

  // loja nova fica de fora
  const E = mkOrg(); const e1 = mk(E, "Antiga1"), e2 = mk(E, "Antiga2"), e3 = mk(E, "Antiga3"), e4 = mk(E, "Nova");
  for (const id of [e1, e2, e3, e4]) { closing(E, id, prev, 60000); }
  for (const id of [e1, e2, e3]) B.setProfile(E, owner, id, { areaM2: 100, openedOn: openedLongAgo });
  const recent = new Date(Date.now() - 60 * 86400e3).toISOString().slice(0, 10);
  B.setProfile(E, owner, e4, { areaM2: 30, openedOn: recent });
  const re = B.benchmark(E, { period: prev }), me = metric(re, "revenue_per_m2");
  check("loja aberta há <6 meses fica FORA do ranking (maturity 'new'), é dita em excludedNewStores e não distorce a mediana", re.stores.find((x: any) => x.storeName === "Nova").maturity === "new" && me.excludedNewStores.includes("Nova") && me.comparableStores === 3 && me.stores.find((x: any) => x.storeName === "Nova").rank === null && me.median === 600);
  check("abertura desconhecida entra (maturity 'unknown'), e a falta é dita", (() => { const F = mkOrg(); const f = mk(F, "X"); B.setProfile(F, owner, f, { areaM2: 10 }); const x = B.benchmark(F, { period: prev }).stores[0]; return x.maturity === "unknown" && x.missing.includes("data_de_abertura"); })());

  // mês corrente
  closing(A, s1, curMonth, 1000);
  const rcur = B.benchmark(A, { period: curMonth });
  check("mês corrente (incompleto): não ranqueia nenhuma métrica e explica", rcur.periodComplete === false && rcur.metrics.every((m: any) => m.ranked === false && m.reason === "mes_incompleto") && rcur.caveats.some((c: string) => /ainda não fechou/.test(c)));
  check("padrão sem period = último mês fechado", B.benchmark(A).period === prev);

  // validações
  check("período inválido ou no futuro é recusado", thrown(() => B.benchmark(A, { period: "2026-13" })) === "invalid_period" && thrown(() => B.benchmark(A, { period: "abc" })) === "invalid_period" && thrown(() => B.benchmark(A, { period: "2999-01" })) === "invalid_period");
  check("só dono/admin grava o perfil (vendedor e sem usuário → forbidden)", thrown(() => B.setProfile(A, agent, s1, { areaM2: 10 })) === "forbidden" && thrown(() => B.setProfile(A, { role: "owner" }, s1, { areaM2: 10 })) === "forbidden");
  check("loja de outra empresa → not_found (não grava perfil cruzado)", thrown(() => B.setProfile(A, owner, c1, { areaM2: 10 })) === "not_found");
  check("valida m², equipe e abertura (≤0, fracionada, futura, formato)", thrown(() => B.setProfile(A, owner, s1, { areaM2: 0 })) === "invalid_area" && thrown(() => B.setProfile(A, owner, s1, { areaM2: "abc" })) === "invalid_area" && thrown(() => B.setProfile(A, owner, s1, { teamSize: 2.5 })) === "invalid_team" && thrown(() => B.setProfile(A, owner, s1, { teamSize: 0 })) === "invalid_team" && thrown(() => B.setProfile(A, owner, s1, { openedOn: "2999-01-01" })) === "invalid_opened_on" && thrown(() => B.setProfile(A, owner, s1, { openedOn: "15/01/2020" })) === "invalid_opened_on");
  check("patch parcial mantém o resto; null/'' limpa só aquele campo; nota é saneada", (() => { B.setProfile(A, owner, s1, { teamSize: 6 }); const p = B.getProfile(A, s1)!; const ok1 = p.areaM2 === 100 && p.teamSize === 6; B.setProfile(A, owner, s1, { teamSize: null, note: "  linha\n\u0007dois " }); const q = B.getProfile(A, s1)!; B.setProfile(A, owner, s1, { teamSize: 4 }); return ok1 && q.teamSize === null && q.areaM2 === 100 && q.note === "linha dois"; })());
  check("upsert: 1 linha por loja e a edição fica na auditoria", (db.prepare(`SELECT COUNT(*) c FROM store_opportunity_profiles WHERE organization_id = ? AND store_id = ?`).get(A, s1) as any).c === 1 && (db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'STORE_OPPORTUNITY_PROFILE_SET'`).get(A) as any).c >= 5);
  check("loja inativa não entra no benchmark", (() => { const G = mkOrg(); const g = mk(G, "Inativa"); db.prepare(`UPDATE retail_stores SET active = 0 WHERE id = ?`).run(g); return B.benchmark(G, { period: prev }).stores.length === 0; })());
  check("isolamento: o benchmark da empresa C não vê lojas/perfis da A", rc.stores.every((x: any) => ![s1, s2, s3, s4].includes(x.storeId)) && B.listProfiles(C).every((x: any) => ![s1, s2, s3, s4].includes(x.storeId)));
  check("benchmark não escreve nada (read-only): sem ação, sem sinal, sem tarefa", (() => { const cnt = () => ["decision_actions", "business_signals", "tasks"].map((t) => { try { return (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE organization_id = ?`).get(A) as any).c; } catch { return -1; } }).join(","); const b = cnt(); B.benchmark(A, { period: prev }); return cnt() === b; })());

  // rotas
  const { default: router } = await import("../src/server/routes/health.js");
  const express = (await import("express")).default;
  const mkU = (org: string, role: string, key: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, ?, 'active')`).run(id, org, `${id}@t.local`, role); const pid = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id; return { userId: id, id, role, role_profile_id: pid }; };
  const who: any = { dono: mkU(A, "owner", "owner"), vend: mkU(A, "agent", "vendedor") };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-anon"] ? undefined : A; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/health-center", router);
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (m: string, u: string, user: string, body?: any, anon = false) => { const x = await fetch(`http://127.0.0.1:${port}/api/health-center${u}`, { method: m, headers: { "Content-Type": "application/json", "x-user": user, ...(anon ? { "x-anon": "1" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: x.status, body: await x.json().catch(() => ({})) as any }; };
  const g1 = await call("GET", `/benchmark/stores?period=${prev}`, "dono");
  check("rota: dono lê o benchmark (200) com ranking e caveats", g1.status === 200 && g1.body.type === "benchmark" && g1.body.metrics.length === 3 && g1.body.caveats.length >= 3);
  check("rota: vendedor não lê (403) nem grava (403); sem empresa → 401", (await call("GET", "/benchmark/stores", "vend")).status === 403 && (await call("GET", "/benchmark/profiles", "vend")).status === 403 && (await call("PUT", `/benchmark/profiles/${s1}`, "vend", { areaM2: 10 })).status === 403 && (await call("GET", "/benchmark/stores", "dono", undefined, true)).status === 401);
  const p1 = await call("PUT", `/benchmark/profiles/${s1}`, "dono", { areaM2: 120 });
  check("rota: dono grava o perfil (200); erro de regra → 400 com código; loja inexistente → 404", p1.status === 200 && p1.body.areaM2 === 120 && (await call("PUT", `/benchmark/profiles/${s1}`, "dono", { areaM2: -1 })).body.code === "invalid_area" && (await call("PUT", "/benchmark/profiles/nao-existe", "dono", { areaM2: 10 })).status === 404);
  check("rota: período inválido → 400; perfis listam as lojas ativas", (await call("GET", "/benchmark/stores?period=zzz", "dono")).status === 400 && (await call("GET", "/benchmark/profiles", "dono")).body.stores.length === 4);
  server.close();

  // fiação e composição
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/StoreBenchmarkService.ts"), "utf8");
  check("RN-F4-11: compõe faturamento e custo fixo existentes (não recalcula finanças)", /RetailStoreCostService\.monthlyRevenueAll/.test(src) && /RetailStoreCostService\.listAll/.test(src) && !/retail_daily_closings|retail_store_fixed_costs/.test(src.replace(/\/\*\*[\s\S]*?\*\//g, "")));
  check("RN-F4-1: nunca cria ação/comando/mensagem", !/DecisionActionService|CommandExecutor|MessageProvider|ApprovalPolicy|BusinessSignalService/.test(src));
  check("CREATE TABLE da F4.3 está no FIM do db.ts (convenção nº 2)", (() => { const d = fs.readFileSync(path.join(process.cwd(), "src/server/db.ts"), "utf8"); const i = d.indexOf("CREATE TABLE IF NOT EXISTS store_opportunity_profiles"); return i > 0 && d.indexOf("initDb();", i) > 0 && i > d.indexOf("CREATE TABLE IF NOT EXISTS strategic_decision_outcomes"); })());

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
