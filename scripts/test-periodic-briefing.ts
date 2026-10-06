/**
 * TESTE — ADR-204 F3.10: briefing SEMANAL comercial e MENSAL (compõe o que existe, sem motor/tabela/canal novo).
 * Prova: compõe resultado×meta, lojas abaixo, equipe, metas, impacto (associado), prioridades · mensal olha o mês FECHADO ·
 * dinheiro role-gated (sem visão completa: restricted, sem número) · seção sem dado diz por quê (nunca preenche) · notCovered honesto ·
 * publish = 1 sinal SEM R$ (idempotente por período, só com algo notável, opt-in) · Scheduler só segunda/dia 1–3 · isolamento · rotas.
 * Uso: npm run test:periodic-briefing
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pbrief-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pbrief-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }
const DAY = 86400e3;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PeriodicBriefingService: B } = await import("../src/server/PeriodicBriefingService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const profile = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id;
  const mkUser = (org: string, role: string, key: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, ?, 'active')`).run(id, org, `${id}@t.local`, role); return { userId: id, id, role, role_profile_id: profile(org, key) }; };
  const O = mkOrg(), P = mkOrg(), E = mkOrg();
  const dono = mkUser(O, "owner", "owner"), vend = mkUser(O, "agent", "vendedor");
  const mkStore = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, 1)`).run(id, org, name, name.slice(0, 3)); return id; };
  const seedDays = (org: string, store: string, from: string, to: string, sold: number, quota: number) => {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      db.prepare(`INSERT OR REPLACE INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total, informed_total) VALUES (?, ?, ?, ?, 'approved', ?, ?)`).run(randomUUID(), org, store, d, sold, sold);
      db.prepare(`INSERT OR REPLACE INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, store, d, quota);
    }
  };
  // segunda 02/11/2026 12:00Z (SP). semanal → asOf 01/11; mensal → mês FECHADO de outubro (asOf 31/10).
  const MON = new Date("2026-11-02T15:00:00Z"), TUE = new Date("2026-11-03T15:00:00Z");
  const fraca = mkStore(O, "Fraca"), forte = mkStore(O, "Forte");
  seedDays(O, fraca, "2026-10-01", "2026-11-01", 500, 1000);     // 50% da cota → abaixo
  seedDays(O, forte, "2026-10-01", "2026-11-01", 1200, 1000);    // 120% → bateu
  // uma ação medida com custo (F3.8) pro impacto
  const act = randomUUID(); db.prepare("INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, correlation_id) VALUES (?,?,'comercial','campanha','t','done','c1')").run(act, O);
  db.prepare("INSERT INTO action_outcomes (id, organization_id, action_id, expected_value, realized_value, basis, measurement_method, intervention_cost) VALUES (?,?,?,?,?,'fact','manual',?)").run(randomUUID(), O, act, 1000, 900, 100);

  const wk: any = B.compose(O, dono, { period: "week", now: MON });
  const mo: any = B.compose(O, dono, { period: "month", now: MON });
  const sec = (b: any, k: string) => b.sections.find((s: any) => s.key === k);

  check("semanal: asOf = ontem (01/11); mensal: asOf = último dia do mês FECHADO (31/10)", wk.asOf === "2026-11-01" && mo.asOf === "2026-10-31");
  check("chave do período: segunda da semana (26/10) × mês (2026-10)", wk.periodKey === "2026-10-26" && mo.periodKey === "2026-10");
  check("resultado: mostra a rede com % da meta", sec(wk, "resultado").available && /da meta/.test(sec(wk, "resultado").lines[0]) && sec(mo, "resultado").available);
  check("lojas: a abaixo da meta aparece e a que bateu NÃO", sec(wk, "lojas").lines.some((l: string) => /Fraca/.test(l)) && !sec(wk, "lojas").lines.some((l: string) => /Forte/.test(l)));
  check("mensal não tem 'previsão' (mês já fechado); semanal tem a seção (com dado ou com o motivo)", !sec(mo, "previsao") && !!sec(wk, "previsao") && (sec(wk, "previsao").available || /insuficiente/.test(sec(wk, "previsao").reason)));
  check("impacto: 'associado', sem causal, e líquido (900−100=800) só onde há custo", /ASSOCIADOS/.test(sec(wk, "impacto").lines.join(" ")) && /800/.test(sec(wk, "impacto").lines.join(" ")));
  check("sem metas cadastradas: seção diz por quê (não inventa)", !sec(wk, "metas").available && /nenhuma meta/.test(sec(wk, "metas").reason));
  check("não coberto declarado (margem, estoque, clientes/campanhas)", wk.notCovered.map((n: any) => n.topic).join("|").includes("margem") && wk.notCovered.length === 3 && /Não coberto/.test(wk.text));
  check("resumo: 1 loja abaixo e notável", wk.summary.storesBelow === 1 && wk.notable === true);

  // dinheiro role-gated
  const wv: any = B.compose(O, vend, { period: "week", now: MON });
  check("sem visão completa: resultado/lojas/impacto restritos, SEM nenhum número, e restricted=true", wv.restricted && sec(wv, "resultado").restricted && sec(wv, "resultado").lines.length === 0 && sec(wv, "impacto").restricted && !/\d{3,}/.test(wv.sections.filter((s: any) => s.restricted).map((s: any) => s.lines.join("")).join("")));
  check("sem visão completa: summary não afirma 0 (null≠0)", wv.summary.storesBelow === null);

  // empresa sem nada
  const eb: any = B.compose(E, mkUser(E, "owner", "owner"), { period: "week", now: MON });
  check("org vazia: nada notável, seções com motivo, nunca inventa", eb.notable === false && eb.sections.filter((s: any) => s.available).length === 0 && eb.sections.every((s: any) => !s.available || s.lines.length));

  // publish
  const sigs = (org: string) => db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND source_service = 'PeriodicBriefingService'").all(org) as any[];
  check("publish desligado (opt-in) → não publica", B.publish(O, { period: "week", now: MON }).reason === "disabled" && sigs(O).length === 0);
  B.setEnabled(O, true);
  const p1 = B.publish(O, { period: "week", now: MON });
  check("publish ligado: 1 sinal semanal na espinha", p1.published && sigs(O).length === 1 && sigs(O)[0].signal_type === "weekly_commercial_briefing" && sigs(O)[0].status === "open");
  const ev = sigs(O)[0];
  check("o sinal NÃO carrega dinheiro (sem impacto, sem R$ no texto/evidência)", ev.impact_amount == null && !/R\$|(900|800|1200|500)/.test(String(ev.evidence_json)) && /loja abaixo/.test(String(ev.evidence_json)));
  B.publish(O, { period: "week", now: MON });
  check("idempotente: mesmo período não duplica", sigs(O).length === 1);
  B.publish(O, { period: "month", now: MON });
  check("mensal publica o seu (tipo próprio) e não colide com o semanal", sigs(O).length === 2 && sigs(O).some((s: any) => s.signal_type === "monthly_briefing"));
  check("org vazia nunca publica (nada notável)", B.publish(E, { period: "week", now: MON, force: true }).reason === "nothing_notable" && sigs(E).length === 0);

  // Scheduler: só segunda / dia 1–3 e só opt-in
  B.setEnabled(P, true); const pf = mkStore(P, "PFraca"); seedDays(P, pf, "2026-10-01", "2026-11-04", 100, 1000);
  const before = sigs(P).length;
  B.pass(new Date("2026-11-04T15:00:00Z"));      // quarta, dia 4 → nada
  check("pass fora de segunda/dia 1–3: não publica", sigs(P).length === before);
  B.pass(new Date("2026-11-02T15:00:00Z"));      // segunda, dia 2 → semanal + mensal
  check("pass na segunda dia 2: publica semanal e mensal só da org com opt-in (O já tinha, E não ligou)", sigs(P).length === 2 && sigs(E).length === 0);
  void TUE;

  // isolamento
  check("sinais não vazam entre empresas", sigs(O).every((s: any) => s.organization_id === O) && sigs(P).every((s: any) => s.organization_id === P));

  // rotas
  const { default: router } = await import("../src/server/routes/ux.js");
  const express = (await import("express")).default;
  const who: any = { dono, vend };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = O; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/ux", router);
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (m: string, u: string, user: string, body?: any) => { const r = await fetch(`http://127.0.0.1:${port}/api/ux${u}`, { method: m, headers: { "Content-Type": "application/json", "x-user": user }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const g1 = await call("GET", "/briefing/week", "dono");
  check("rota GET /briefing/week: 200 com seções e texto", g1.status === 200 && g1.body.period === "week" && g1.body.sections.length >= 5 && /Briefing semanal/.test(g1.body.text));
  check("rota GET /briefing/month: 200", (await call("GET", "/briefing/month", "dono")).body.period === "month");
  check("rota: period inválido → 400", (await call("GET", "/briefing/year", "dono")).status === 400);
  const gv = await call("GET", "/briefing/week", "vend");
  check("rota: vendedor recebe a versão restrita (sem números)", gv.status === 200 && gv.body.restricted === true && gv.body.sections.find((s: any) => s.key === "resultado").lines.length === 0);
  check("rota enabled: dono liga/lê; vendedor não (403)", (await call("PUT", "/briefing/enabled", "dono", { enabled: false })).body.enabled === false && (await call("GET", "/briefing/enabled", "dono")).body.enabled === false && (await call("PUT", "/briefing/enabled", "vend", { enabled: true })).status === 403);
  server.close();

  const sch = fs.readFileSync(path.join(process.cwd(), "src/server/Scheduler.ts"), "utf8");
  check("Scheduler chama PeriodicBriefingService.pass()", /PeriodicBriefingService\.js/.test(sch) && /PeriodicBriefingService\.pass\(\)/.test(sch));

  const ui = fs.readFileSync(path.join(process.cwd(), "src/features/ResultsView.tsx"), "utf8");
  check("UI Resultados: botões Semanal/Mensal consomem /api/ux/briefing/:period e só renderizam o texto", /briefing-block/.test(ui) && /\/api\/ux\/briefing\/\$\{p\}/.test(ui) && /Semanal/.test(ui) && /Mensal/.test(ui));
  check("UI: interruptor da entrega só aparece se a rota /briefing/enabled responde (dono/admin) e liga/desliga via PUT", /briefing-delivery/.test(ui) && /\/api\/ux\/briefing\/enabled/.test(ui) && /method: 'PUT'/.test(ui) && /sem permissão: não mostra/.test(ui) && /enabled !== null/.test(ui));
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
