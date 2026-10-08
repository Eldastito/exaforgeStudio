/**
 * TESTE — ADR-205 F4.8: comparação entre as operações de um grupo (GroupIntelligenceService).
 * Prova: FAN-OUT (uma org por chamada, nenhum SQL cruzando orgs) · razões ponderadas por operação com cobertura dita · loja nova fora · ranking só com
 * amostra mínima E mesmo nicho (senão valores lado a lado + motivo) · mês aberto sem ranking · operação que falha vira parcial sem derrubar · nada de cliente/venda
 * individual · perguntas neutras (nunca causa/ação) · confiança nunca alta · isolamento (grupo de outro dono 404; org fora do grupo não entra) · atrás da flag + owner/admin.
 * Uso: npm run test:group-intelligence
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-gint-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-gint-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { GroupIntelligenceService: G, MIN_OPERATIONS } = await import("../src/server/GroupIntelligenceService.js");
  const { OrgGroupService: GRP } = await import("../src/server/OrgGroupService.js");
  const { StoreBenchmarkService: SB } = await import("../src/server/StoreBenchmarkService.js");
  const { RetailStoreCostService } = await import("../src/server/RetailStoreCostService.js");
  const { todaySP } = await import("../src/server/spDate.js");
  const thrown = (f: () => any) => { try { f(); return null; } catch (e: any) { return e?.code || "error"; } };
  const today = todaySP(); const [ty, tm] = today.split("-").map(Number);
  const prev = tm === 1 ? `${ty - 1}-12` : `${ty}-${String(tm - 1).padStart(2, "0")}`;
  const mkOrg = (name: string, vertical: string | null) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, ?, 'active', ?)`).run(randomUUID(), id, name, vertical); return id; };
  const mkStore = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, 1)`).run(id, org, name, name.slice(0, 3)); return id; };
  const closing = (org: string, st: string, total: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total, informed_total) VALUES (?, ?, ?, ?, 'approved', ?, ?)`).run(randomUUID(), org, st, `${prev}-10`, total, total);
  const profile = (org: string, st: string, area: number | null, team: number | null, opened = "2020-01-01") => db.prepare(`INSERT INTO store_opportunity_profiles (id, organization_id, store_id, area_m2, team_size, opened_on, updated_by) VALUES (?, ?, ?, ?, ?, ?, 'u')`).run(randomUUID(), org, st, area, team, opened);

  // 4 operações moda (A,B,C,D) + 1 de outro nicho (X) + grupo
  const identity = randomUUID(); db.prepare(`INSERT INTO account_identities (id, email, status) VALUES (?, 'dono@grupo.com', 'active')`).run(identity);
  const other = randomUUID(); db.prepare(`INSERT INTO account_identities (id, email, status) VALUES (?, 'outro@grupo.com', 'active')`).run(other);
  const grp = GRP.createGroup({ name: "Grupo", ownerIdentityId: identity }), grpOther = GRP.createGroup({ name: "Outro", ownerIdentityId: other });
  const A = mkOrg("Marca A", "moda"), B = mkOrg("Marca B", "moda"), C = mkOrg("Marca C", "moda"), D = mkOrg("Marca D", "moda"), X = mkOrg("Marca X", "restaurante"), OUT = mkOrg("Fora do grupo", "moda");
  for (const o of [A, B, C]) GRP.addMember(grp.id, o);
  GRP.addMember(grpOther.id, OUT);
  // A: 1 loja 100 m², 5 pessoas, fat 100.000 → 1000/m², 20.000/pessoa
  const a1 = mkStore(A, "A1"); closing(A, a1, 100000); profile(A, a1, 100, 5);
  // B: 2 lojas; B1 200 m² 8 pessoas fat 100.000; B2 100 m² 4 pessoas fat 50.000 → 150.000/300 m² = 500/m²; 150.000/12 = 12.500/pessoa
  const b1 = mkStore(B, "B1"), b2 = mkStore(B, "B2"); closing(B, b1, 100000); closing(B, b2, 50000); profile(B, b1, 200, 8); profile(B, b2, 100, 4);
  // C: 1 loja 100 m² 10 pessoas fat 90.000 → 900/m², 9.000/pessoa; + C2 NOVA (aberta no mês passado) com dados altos que NÃO podem entrar
  const c1 = mkStore(C, "C1"), c2 = mkStore(C, "C2"); closing(C, c1, 90000); closing(C, c2, 500000); profile(C, c1, 100, 10); profile(C, c2, 10, 1, `${prev}-01`);

  // custo fixo (aluguel): A 20.000 → 20%; B 30.000+15.000 = 45.000/150.000 → 30%; C1 18.000/90.000 → 20% (C2 nova fica fora, mesmo com custo)
  RetailStoreCostService.setMany(A, a1, { aluguel: 20000 } as any); RetailStoreCostService.setMany(B, b1, { aluguel: 30000 } as any); RetailStoreCostService.setMany(B, b2, { aluguel: 15000 } as any);
  RetailStoreCostService.setMany(C, c1, { aluguel: 18000 } as any); RetailStoreCostService.setMany(C, c2, { aluguel: 99000 } as any);
  const before = ["decision_actions", "business_signals", "tasks", "contacts"].map((t) => { try { return (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c; } catch { return -1; } }).join(",");
  const r = G.compare(grp.id, { period: prev });
  const op = (id: string) => r.operations.find((o: any) => o.organizationId === id) as any;
  const met = (k: string) => r.metrics.find((m: any) => m.key === k) as any;
  check("só leitura: nada escrito (ações, sinais, tarefas, contatos)", before === ["decision_actions", "business_signals", "tasks", "contacts"].map((t) => { try { return (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c; } catch { return -1; } }).join(","));
  check("rótulos: comparação entre operações (não previsão, não executa), período fechado, 3 operações do grupo — a org fora do grupo NÃO entra", r.type === "group_intelligence" && r.isForecast === false && r.executes === false && r.periodComplete === true && r.operations.length === 3 && !r.operations.some((o: any) => o.organizationId === OUT || o.organizationId === X));
  check("razão por operação é ponderada (Σ÷Σ), não média de lojas: B = 150.000/300 m² = 500 e 150.000/12 pessoas = 12.500", op(B).values.revenue_per_m2 === 500 && op(B).values.revenue_per_person === 12500);
  check("A = 1.000/m² e 20.000/pessoa; C = 900/m² e 9.000/pessoa", op(A).values.revenue_per_m2 === 1000 && op(A).values.revenue_per_person === 20000 && op(C).values.revenue_per_m2 === 900 && op(C).values.revenue_per_person === 9000);
  check("loja NOVA fica fora da razão da operação (C2, com número inflado, não entra) e isso é dito", op(C).newStoresExcluded === 1 && op(C).coverage.revenue_per_m2.of === 1);
  check("total de faturamento = soma das operações (inclui a loja nova: é fato, não razão)", op(A).revenue === 100000 && op(B).revenue === 150000 && op(C).revenue === 590000 && r.totals.revenue === 840000 && r.totals.operationsWithRevenue === 3);
  // ranking
  const m2 = met("revenue_per_m2");
  check("3 operações do MESMO nicho + mês fechado → ranqueia com mediana (900) e posição; confiança 'baixa' (nunca alta)", m2.ranked === true && m2.median === 900 && m2.confidence === "baixa" && m2.operations.find((o: any) => o.organizationId === A).rank === 1 && m2.operations.find((o: any) => o.organizationId === B).rank === 3);
  check("posição vs mediana: A acima (+11%), C na mediana, B abaixo (-44%)", m2.operations.find((o: any) => o.organizationId === A).position === "above_median" && m2.operations.find((o: any) => o.organizationId === C).position === "near_median" && m2.operations.find((o: any) => o.organizationId === B).position === "below_median");
  check("perguntas neutras para quem está ≥25% pior (B); sem causa nem ação (nada de fechar/vender/trocar/contratar)", m2.questions.length === 1 && /Marca B/.test(m2.questions[0]) && /O que é diferente/.test(m2.questions[0]) && !/\b(feche|fechar|venda a|trocar|contrate|demita|vender)\b/i.test(m2.questions[0]));
  const fcm = met("fixed_cost_pct");
  check("custo fixo %: A 20%, B 30% (45.000/150.000), C 20% (a loja nova C2 e o custo dela ficam fora); menor é melhor → B abaixo da mediana (+50% pior) com pergunta", op(A).values.fixed_cost_pct === 20 && op(B).values.fixed_cost_pct === 30 && op(C).values.fixed_cost_pct === 20 && fcm.ranked === true && fcm.median === 20 && fcm.operations.find((o: any) => o.organizationId === B).position === "below_median" && fcm.operations.find((o: any) => o.organizationId === A).rank === 1 && fcm.questions.length === 1 && /acima da mediana/.test(fcm.questions[0]));
  check("operação SEM custo fixo cadastrado → null (não 0) e fica fora do ranking dessa métrica", (() => { db.prepare(`DELETE FROM retail_store_fixed_costs WHERE organization_id = ?`).run(C); const rr = G.compare(grp.id, { period: prev }); const ok = rr.operations.find((o: any) => o.organizationId === C).values.fixed_cost_pct === null && rr.metrics.find((m: any) => m.key === "fixed_cost_pct").ranked === false && rr.metrics.find((m: any) => m.key === "fixed_cost_pct").comparableOperations === 2; RetailStoreCostService.setMany(C, c1, { aluguel: 18000 } as any); RetailStoreCostService.setMany(C, c2, { aluguel: 99000 } as any); return ok; })());
  // amostra mínima / nicho
  check("amostra mínima: com 2 operações mostra os valores lado a lado, SEM ranking (reason amostra_minima)", (() => { const rr = G.compare(grp.id, { period: prev, benchmarkFn: (org, o) => { if (org === C) throw new Error("fora"); return SB.benchmark(org, o); } }); return rr.metrics.every((m: any) => m.ranked === false && m.reason === "amostra_minima") && rr.operations.filter((o: any) => !o.partial).length === 2; })());
  GRP.addMember(grp.id, X);
  const xs = mkStore(X, "X1"); closing(X, xs, 70000); profile(X, xs, 70, 3);
  const rx = G.compare(grp.id, { period: prev });
  check("nichos diferentes (moda + restaurante): sem ranking, motivo 'nichos_diferentes', valores lado a lado preservados", rx.sameVertical === false && rx.metrics.every((m: any) => m.ranked === false && m.reason === "nichos_diferentes") && rx.operations.find((o: any) => o.organizationId === X).values.revenue_per_m2 === 1000 && rx.caveats.some((c: string) => /nichos diferentes/.test(c)));
  db.prepare(`UPDATE organization_settings SET vertical = NULL WHERE organization_id = ?`).run(X);
  check("nicho não cadastrado conta como desconhecido: sem ranking, motivo 'nicho_desconhecido'", G.compare(grp.id, { period: prev }).metrics.every((m: any) => m.reason === "nicho_desconhecido"));
  db.prepare(`DELETE FROM org_group_members WHERE group_id = ? AND organization_id = ?`).run(grp.id, X);
  // mês aberto
  const cur = today.slice(0, 7);
  check("mês corrente (aberto): sem ranking, motivo 'mes_incompleto', e avisa", (() => { const rc = G.compare(grp.id, { period: cur }); return rc.periodComplete === false && rc.metrics.every((m: any) => m.reason === "mes_incompleto") && rc.caveats.some((c: string) => /ainda não fechou/.test(c)); })());
  // degradação graciosa
  const deg = G.compare(grp.id, { period: prev, benchmarkFn: (org, o) => { if (org === B) throw new Error("indisponível"); return SB.benchmark(org, o); } });
  check("operação que falha vira PARCIAL e sai dos totais; as outras seguem (sem erro global)", deg.partial.join() === B && op(B).partial === false && deg.operations.find((o: any) => o.organizationId === B).partial === true && deg.totals.revenue === 690000 && deg.caveats.some((c: string) => /indisponível/.test(c)));
  // fan-out: o benchmark é chamado UMA org por vez, nunca recebe grupo
  const calls: string[] = []; G.compare(grp.id, { period: prev, benchmarkFn: (org, o) => { calls.push(org); return SB.benchmark(org, o); } });
  check("FAN-OUT: uma chamada por operação do grupo, cada uma com UM orgId (nenhuma lê duas)", calls.length === 3 && new Set(calls).size === 3 && !calls.includes(OUT));
  // validação
  check("valida o período (formato e futuro) e o grupo", thrown(() => G.compare(grp.id, { period: "2026-13" })) === "invalid_period" && thrown(() => G.compare(grp.id, { period: "2099-01" })) === "invalid_period" && thrown(() => G.compare("nao-existe", {})) === "not_found");
  check("MIN_OPERATIONS = 3 e confiança nunca 'alta' em nenhuma métrica", MIN_OPERATIONS === 3 && r.metrics.every((m: any) => m.confidence !== ("alta" as string)));
  check("nada de cliente/venda individual/vendedor na saída (só agregados por operação)", !/contact|customer|cliente|seller|vendedor|phone|email/i.test(JSON.stringify(r.operations.map((o: any) => ({ ...o, businessName: undefined })))));

  // rota (flag + dono + isolamento)
  const { default: router } = await import("../src/server/routes/orgGroups.js");
  const express = (await import("express")).default;
  const mkU = (org: string, role: string, ident: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status, identity_id) VALUES (?, ?, 'U', ?, ?, 'active', ?)`).run(id, org, `${id}@t.local`, role, ident); return { userId: id, id, role, organizationId: org }; };
  const who: any = { dono: mkU(A, "owner", identity), agente: mkU(A, "agent", identity), outro: mkU(OUT, "owner", other) };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.user = who[String(req.headers["x-user"])]; req.organizationId = req.user?.organizationId; next(); });
  app.use("/api/groups", router);
  const server = http.createServer(app); await new Promise<void>((x) => server.listen(0, x));
  const port = (server.address() as any).port;
  const get = async (u: string, user: string) => { const x = await fetch(`http://127.0.0.1:${port}/api/groups${u}`, { headers: { "x-user": user } }); return { status: x.status, body: await x.json().catch(() => ({})) as any }; };
  delete process.env.FEATURE_ORG_GROUPS;
  check("rota sem a flag FEATURE_ORG_GROUPS → 404 (feature invisível)", (await get(`/${grp.id}/intelligence`, "dono")).status === 404);
  process.env.FEATURE_ORG_GROUPS = "1";
  const g = await get(`/${grp.id}/intelligence?period=${prev}`, "dono");
  check("rota com a flag: dono do grupo lê (200) e o período vale", g.status === 200 && g.body.type === "group_intelligence" && g.body.period === prev && g.body.operations.length === 3);
  check("rota: agente (sem owner/admin) 403; dono de OUTRO grupo 404 (não revela); período inválido 400", (await get(`/${grp.id}/intelligence`, "agente")).status === 403 && (await get(`/${grp.id}/intelligence`, "outro")).status === 404 && (await get(`/${grp.id}/intelligence?period=abc`, "dono")).status === 400);
  server.close();

  // composição
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/GroupIntelligenceService.ts"), "utf8").replace(/\/\*\*[\s\S]*?\*\//g, "");
  check("compõe o benchmark F4.3 e a lista de membros; o único SQL é nome/nicho da própria org, uma por vez", /StoreBenchmarkService\.benchmark/.test(src) && /OrgGroupService\.membersOf/.test(src) && (src.match(/db\.prepare/g) || []).length === 1 && /FROM organization_settings WHERE organization_id = \?/.test(src));
  check("não grava nem executa (sem INSERT/UPDATE/DELETE, sinal, ação, envio) e não toca contato/venda/vendedor", !/\b(INSERT|UPDATE|DELETE)\b|BusinessSignalService|DecisionActionService|CommandExecutor|MessageProvider|contacts|orders|seller/i.test(src));

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
