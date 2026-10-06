/**
 * TESTE — ADR-204 F3.8 Impact Ledger 2.0: custo da intervenção + confiança + "associado" (sem controle).
 * Prova: custo/confiança gravados e VALIDADOS (negativo/NaN/enum inválido → null) · custo desconhecido ≠ 0 (fora do líquido) ·
 * líquido só com FATO e custo conhecido (estimate nunca entra) · sem custo algum → net null · confiança contada (unreported honesto) ·
 * causalidade SEMPRE 'associated' (incremental null, sem holdout) · idempotência por event_key preserva custo ·
 * Resultados: R$ do líquido role-gated, rótulos/contagens sempre · rota grava custo/confiança · isolamento · 0-regressão (legado sem custo).
 * Uso: npm run test:impact-ledger-v2
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ilv2-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ilv2-1234567890";
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OutcomeMeasurementService: OM } = await import("../src/server/OutcomeMeasurementService.js");
  const { ExecutionResultsService: ER } = await import("../src/server/ExecutionResultsService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const O = mkOrg(), P = mkOrg();
  const mkAct = (org: string) => { const id = randomUUID(); db.prepare("INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, correlation_id) VALUES (?,?,'comercial','campanha','t','done',?)").run(id, org, "c:" + id); return id; };

  // 1) grava custo + confiança
  const a1 = mkAct(O);
  const o1: any = OM.record(O, a1, { expectedValue: 1000, realizedValue: 800, basis: "fact", interventionCost: 150, confidence: "high" });
  check("custo e confiança gravados", o1.intervention_cost === 150 && o1.confidence === "high");

  // 2) validação: inválido vira null (nunca 0, nunca lixo)
  const v = (x: any, c: any) => OM.record(O, mkAct(O), { realizedValue: 1, basis: "fact", interventionCost: x, confidence: c }) as any;
  const bad1 = v(-5, "altissima"), bad2 = v("abc", "HIGH"), bad3 = v("", ""), bad4 = v(null, undefined);
  check("custo negativo/NaN/vazio/null → null (desconhecido, não 0)", bad1.intervention_cost === null && bad2.intervention_cost === null && bad3.intervention_cost === null && bad4.intervention_cost === null);
  check("confiança fora do enum → null", bad1.confidence === null && bad2.confidence === null && bad3.confidence === null);
  const zero = v(0, "low");
  check("custo 0 declarado é aceito (≠ desconhecido)", zero.intervention_cost === 0 && zero.confidence === "low");

  // 3) líquido: só fato COM custo conhecido
  const P1 = mkOrg();
  const x1 = mkAct(P1), x2 = mkAct(P1), x3 = mkAct(P1), x4 = mkAct(P1);
  OM.record(P1, x1, { realizedValue: 1000, basis: "fact", interventionCost: 200, confidence: "high" });
  OM.record(P1, x2, { realizedValue: 500, basis: "fact", interventionCost: 100, confidence: "medium" });
  OM.record(P1, x3, { realizedValue: 700, basis: "fact" });                                   // sem custo: fora do líquido, não vira 0
  OM.record(P1, x4, { realizedValue: 9999, basis: "estimate", interventionCost: 1 });         // estimativa nunca entra
  let t: any = OM.ledger(P1).totals;
  check("líquido = Σrealizado − Σcusto SÓ onde o custo é conhecido (1500 − 300 = 1200)", t.net.net === 1200 && t.net.cost === 300 && t.net.realizedWhereCostKnown === 1500);
  check("custo desconhecido contado à parte (1 fato sem custo), estimativa fora", t.net.costKnownCount === 2 && t.net.costUnknownCount === 1);
  check("confiança contada com 'unreported' honesto", t.confidence.high === 1 && t.confidence.medium === 1 && t.confidence.low === 0 && t.confidence.unreported === 2);
  check("causalidade SEMPRE 'associated' e incremental null (sem grupo de controle)", t.causality.basis === "associated" && t.causality.incremental === null && /controle/.test(t.causality.reason));

  // 4) sem custo algum → net null (não inventa 0); legado intacto
  const L = mkOrg(); OM.record(L, mkAct(L), { realizedValue: 300, basis: "fact" });
  t = OM.ledger(L).totals;
  check("org só com legado (sem custo): net null, cost null, realizado total preservado", t.net.net === null && t.net.cost === null && t.realized === 300 && t.net.costUnknownCount === 1);

  // 5) idempotência por event_key preserva o 1º (custo não duplica)
  const e = mkAct(O);
  OM.record(O, e, { realizedValue: 100, basis: "fact", interventionCost: 40, eventKey: "k1" });
  OM.record(O, e, { realizedValue: 100, basis: "fact", interventionCost: 40, eventKey: "k1" });
  check("mesmo event_key 2× não duplica custo", (db.prepare("SELECT COUNT(*) c, SUM(intervention_cost) s FROM action_outcomes WHERE organization_id=? AND event_key='k1'").get(O) as any).s === 40);

  // 6) isolamento
  check("outra empresa não vê custo/líquido da primeira", OM.ledger(mkOrg()).totals.net.net === null && OM.ledger(P1).totals.net.cost === 300);

  // 7) Resultados: R$ role-gated, rótulos sempre
  const profile = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id;
  const mkUser = (org: string, role: string, key: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, ?, 'active')`).run(id, org, `${id}@t.local`, role); return { userId: id, id, role, role_profile_id: profile(org, key) }; };
  const dono = mkUser(P1, "owner", "owner"), vend = mkUser(P1, "agent", "vendedor");
  const rd: any = ER.results(P1, dono), rv: any = ER.results(P1, vend);
  check("Resultados (gestor): líquido e custo visíveis + 'associated'", rd.impactReading.net.net === 1200 && rd.impactReading.net.cost === 300 && rd.impactReading.net.restricted === false && rd.impactReading.causality.basis === "associated");
  check("Resultados (sem dinheiro): R$ some, contagens e rótulo seguem", rv.impactReading.net.net === null && rv.impactReading.net.cost === null && rv.impactReading.net.restricted === true && rv.impactReading.net.costUnknownCount === 1 && rv.impactReading.causality.basis === "associated" && rv.impactReading.confidence.high === 1);

  // 8) rota grava custo e confiança
  const { default: router } = await import("../src/server/routes/actions.js");
  const express = (await import("express")).default;
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = P1; req.user = dono; next(); });
  app.use("/api/actions", router);
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const act = mkAct(P1);
  const r = await fetch(`http://127.0.0.1:${port}/api/actions/${act}/outcomes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ realizedValue: 50, basis: "fact", interventionCost: 12.5, confidence: "medium" }) });
  const body: any = await r.json();
  check("rota POST /:id/outcomes grava custo e confiança", r.status === 201 && body.intervention_cost === 12.5 && body.confidence === "medium");
  server.close();

  // 9) UI
  const ui = fs.readFileSync(path.join(process.cwd(), "src/features/ResultsView.tsx"), "utf8");
  check("UI Resultados: mostra 'associados', líquido só com custo e itens sem custo/baixa confiança", /impact-reading/.test(ui) && /associados/.test(ui) && /fora do líquido/.test(ui) && /confiança baixa/.test(ui));

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
