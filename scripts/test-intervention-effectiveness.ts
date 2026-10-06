/**
 * TESTE — ADR-204 F3.7 Learning Loop: eficácia por INTERVENÇÃO (esperado × realizado).
 * Prova: só `assured` ensina (medida sem confirmação fica de fora) · só base `fact` (estimate nunca soma) ·
 * amostra mínima (<5 → sem taxa/veredito) · banda de Wilson + veredito conservador · atingiu = realizado ≥ esperado e só com esperado>0 ·
 * R$ role-gated (taxa/contagem sempre) · isolamento multi-tenant · rota + UI.
 * Uso: npm run test:intervention-effectiveness
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-interv-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-interv-1234567890";
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { InterventionEffectivenessService: S, INTERVENTION_MIN_SAMPLE } = await import("../src/server/InterventionEffectivenessService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const O = mkOrg(), P = mkOrg();

  let n = 0;
  // ação concluída; assured = confirmação confirmed + outcome fact (a escada do PRD 8)
  const mk = (org: string, type: string, o: { exp: number | null; real: number; basis?: string; confirmed?: boolean; domain?: string }) => {
    const id = `a${++n}_${randomUUID().slice(0, 4)}`;
    db.prepare("INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, correlation_id, completed_at) VALUES (?,?,?,?,?,'done',?,CURRENT_TIMESTAMP)").run(id, org, o.domain || "comercial", type, type, "corr:" + id);
    db.prepare("INSERT INTO action_outcomes (id, organization_id, action_id, expected_value, realized_value, basis, measurement_method) VALUES (?,?,?,?,?,?,'manual')").run(randomUUID(), org, id, o.exp, o.real, o.basis || "fact");
    if (o.confirmed !== false) db.prepare("INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status, confirmed_at) VALUES (?,?,?,'manual','confirmed',CURRENT_TIMESTAMP)").run(randomUUID(), org, id);
    return id;
  };
  const find = (r: any, t: string) => r.items.find((i: any) => i.actionType === t);

  // 1) amostra insuficiente: 4 assured com meta → sem taxa/veredito
  for (let i = 0; i < 4; i++) mk(O, "campanha_x", { exp: 100, real: 150 });
  let r: any = S.summary(O, { canSeeMoney: true });
  let c = find(r, "campanha_x");
  check("4 casos (< mínimo) → insufficient_sample, SEM taxa nem banda", c.sample === 4 && c.verdict === "insufficient_sample" && c.hitRate === null && c.interval === null && c.realizationPct === null && c.expectedTotal === null);
  check("mínimo de amostra declarado (5)", r.minSample === 5 && INTERVENTION_MIN_SAMPLE === 5);

  // 2) 5º caso → taxa, banda de Wilson e veredito
  mk(O, "campanha_x", { exp: 100, real: 150 });
  r = S.summary(O, { canSeeMoney: true }); c = find(r, "campanha_x");
  check("5 de 5 atingiram → hitRate 1, banda presente, piso ≥ 50% → works", c.sample === 5 && c.hits === 5 && c.hitRate === 1 && c.interval.lower >= 0.5 && c.verdict === "works" && !!c.confidence);
  check("realização = Σrealizado/Σesperado (750/500 = 150%) e R$ visível ao dono", c.realizationPct === 150 && c.expectedTotal === 500 && c.realizedTotal === 750);

  // 3) intervenção fraca: 5 casos, todos abaixo do esperado → weak
  for (let i = 0; i < 5; i++) mk(O, "desconto_y", { exp: 100, real: 20 });
  r = S.summary(O, { canSeeMoney: true }); let d = find(r, "desconto_y");
  check("5 de 5 abaixo do esperado → hitRate 0 (não null), teto < 50% → weak", d.hitRate === 0 && d.hits === 0 && d.verdict === "weak" && d.realizationPct === 20);
  check("ranking: works antes de weak", r.items.findIndex((i: any) => i.actionType === "campanha_x") < r.items.findIndex((i: any) => i.actionType === "desconto_y"));

  // 4) misto → inconclusive
  for (let i = 0; i < 3; i++) mk(O, "misto_z", { exp: 100, real: 120 });
  for (let i = 0; i < 2; i++) mk(O, "misto_z", { exp: 100, real: 10 });
  const z = find(S.summary(O, { canSeeMoney: true }), "misto_z");
  check("3 de 5 → banda larga cruza 50% → inconclusive (não conclui no ruído)", z.hits === 3 && z.sample === 5 && z.verdict === "inconclusive");

  // 5) DONE ≠ exemplo: medida sem confirmação NÃO ensina
  for (let i = 0; i < 6; i++) mk(O, "sem_conf", { exp: 100, real: 200, confirmed: false });
  const sc = find(S.summary(O, { canSeeMoney: true }), "sem_conf");
  check("6 medidas sem confirmação → fora da conta (assured 0, sample 0, só contagem)", sc.assured === 0 && sc.sample === 0 && sc.measuredNotAssured === 6 && sc.verdict === "insufficient_sample" && sc.hitRate === null);

  // 6) estimate nunca entra
  for (let i = 0; i < 6; i++) mk(O, "so_estimativa", { exp: 100, real: 200, basis: "estimate" });
  const se = find(S.summary(O, { canSeeMoney: true }), "so_estimativa");
  check("só estimativa → não ensina nem soma (estimateOnly 6, sample 0)", se.estimateOnly === 6 && se.sample === 0 && se.assured === 0 && se.hitRate === null);

  // 7) sem meta (esperado nulo/0) não vira "acerto" nem "erro"
  for (let i = 0; i < 6; i++) mk(O, "sem_meta", { exp: null, real: 80 });
  const sm = find(S.summary(O, { canSeeMoney: true }), "sem_meta");
  check("assured sem esperado → conta como assured mas NÃO entra na amostra (null≠0)", sm.assured === 6 && sm.sample === 0 && sm.hitRate === null && sm.verdict === "insufficient_sample");

  // 8) fato + estimativa na mesma ação: só o fato conta
  const mixed = mk(O, "fato_e_estim", { exp: 100, real: 100 });
  db.prepare("INSERT INTO action_outcomes (id, organization_id, action_id, expected_value, realized_value, basis, measurement_method) VALUES (?,?,?,?,?,'estimate','manual')").run(randomUUID(), O, mixed, 9999, 9999);
  const fe = find(S.summary(O, { canSeeMoney: true }), "fato_e_estim");
  check("estimativa na mesma ação não infla esperado/realizado (assured 1, sample 1)", fe.assured === 1 && fe.sample === 1 && fe.hits === 1);

  // 9) R$ role-gated; taxa e contagens sempre
  const nm = find(S.summary(O, { canSeeMoney: false }), "campanha_x");
  check("sem permissão de dinheiro: taxa/% aparecem, R$ some", nm.hitRate === 1 && nm.realizationPct === 150 && nm.expectedTotal === null && nm.realizedTotal === null);

  // 10) filtro de domínio + isolamento
  mk(O, "financeiro_k", { exp: 10, real: 10, domain: "financeiro" });
  check("filtro por domínio", S.summary(O, { domain: "financeiro" }).items.every((i: any) => i.domain === "financeiro") && S.summary(O, { domain: "financeiro" }).items.length === 1);
  check("outra empresa não vê nada (isolamento)", S.summary(P, { canSeeMoney: true }).items.length === 0);
  mk(P, "campanha_x", { exp: 100, real: 100 });
  check("outra empresa não contamina a contagem da primeira", find(S.summary(O, { canSeeMoney: true }), "campanha_x").actions === 5);

  // 11) determinismo/read-only
  const before = JSON.stringify((db.prepare("SELECT COUNT(*) c FROM action_outcomes").get() as any)) + JSON.stringify((db.prepare("SELECT COUNT(*) c FROM decision_actions").get() as any));
  S.summary(O, { canSeeMoney: true }); S.summary(O, { canSeeMoney: true });
  check("read-only: nada é escrito", before === JSON.stringify((db.prepare("SELECT COUNT(*) c FROM action_outcomes").get() as any)) + JSON.stringify((db.prepare("SELECT COUNT(*) c FROM decision_actions").get() as any)));

  // 12) rota + UI
  const { default: router } = await import("../src/server/routes/executive.js");
  const express = (await import("express")).default;
  const profile = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id;
  const mkUser = (org: string, role: string, key: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, ?, 'active')`).run(id, org, `${id}@t.local`, role); return { userId: id, id, role, role_profile_id: profile(org, key) }; };
  const who: any = { dono: mkUser(O, "owner", "owner"), vend: mkUser(O, "agent", "vendedor") };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-org"] || undefined; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/executive", router);
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const get = async (u: string, user: string, org?: string) => { const r = await fetch(`http://127.0.0.1:${port}/api/executive${u}`, { headers: { "x-user": user, ...(org ? { "x-org": org } : {}) } }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const rd = await get("/intervention-effectiveness", "dono", O);
  const rv = await get("/intervention-effectiveness", "vend", O);
  check("rota: dono recebe itens com R$", rd.status === 200 && find(rd.body, "campanha_x").expectedTotal === 500);
  check("rota: vendedor (sem dinheiro) recebe taxa mas não R$", rv.status === 200 && find(rv.body, "campanha_x").hitRate === 1 && find(rv.body, "campanha_x").expectedTotal === null);
  check("rota: sem empresa → 401", (await get("/intervention-effectiveness", "dono")).status === 401);
  server.close();
  const ui = fs.readFileSync(path.join(process.cwd(), "src/features/ExecutiveView.tsx"), "utf8");
  check("UI: seção na aba 'O que funciona' consome a rota e mostra faixa + 'sem confirmação, fora da conta'", /intervention-effectiveness/.test(ui) && /faixa \$\{Math\.round/.test(ui) && /fora da conta/.test(ui));

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
