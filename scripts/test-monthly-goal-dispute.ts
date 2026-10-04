/**
 * TESTE — Meta mensal da loja: o dono define, o gerente CONFERE e contesta (RetailMonthlyGoalService.dispute)
 * ----------------------------------------------------------------------------
 * Decisão do dono (TOULON, 04/10): manter o que a conta da TOULON já tem (a meta mensal por loja é do dono) e o gerente
 * da loja confere se está certa. Prova, pelas rotas reais:
 *   - gerente LÊ só a meta da própria loja e a resposta diz `canEdit:false`; dono recebe `canEdit:true`;
 *   - gerente NÃO salva nem remove meta (403) — a meta continua do dono;
 *   - gerente CONTESTA a meta da própria loja → aviso na espinha (o quê / onde / o que fazer), visível ao dono e à loja,
 *     nunca à outra loja; idempotente por loja+mês; não contesta outra loja (403); exige explicação;
 *   - dono corrige a meta → o aviso fecha sozinho e a loja é avisada; a meta nunca foi alterada pela contestação.
 *
 * Uso:  npm run test:monthly-goal-dispute
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";
import express from "express";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-goal-dispute-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-goal-dispute-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");
  const { StoreSignalScopeService: SC } = await import("../src/server/StoreSignalScopeService.js");
  const routes = (await import("../src/server/routes/retailops.js")).default;

  const ORG = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'TOULON', 'active')`).run(randomUUID(), ORG);
  P.seedSystemProfiles(ORG);
  const gerente = (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'gerente'").get(ORG) as any).id;
  const mk = (name: string, role: string, profile: string | null) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status, role_profile_id) VALUES (?, ?, ?, ?, ?, 'active', ?)`).run(id, ORG, name, `${name}@t.com`, role, profile); return id; };
  const gabriel = mk("Gabriel", "admin", gerente), bruno = mk("Bruno", "owner", null), outro = mk("Outro", "admin", gerente);
  const carioca = randomUUID(), grande = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Carioca', 'CAR', 1)`).run(carioca, ORG);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Grande Rio', 'GRD', 1)`).run(grande, ORG);
  db.prepare(`INSERT INTO user_stores (organization_id, user_id, store_id) VALUES (?, ?, ?)`).run(ORG, gabriel, carioca);
  db.prepare(`INSERT INTO user_stores (organization_id, user_id, store_id) VALUES (?, ?, ?)`).run(ORG, outro, grande);

  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => {
    const uid = String(req.headers["x-uid"] || "");
    const row = uid ? (db.prepare("SELECT id, role, role_profile_id FROM users WHERE id = ?").get(uid) as any) : null;
    if (row) { req.organizationId = ORG; req.user = { userId: row.id, role: row.role, role_profile_id: row.role_profile_id, organizationId: ORG }; }
    next();
  });
  app.use("/api/retailops", routes);
  const server = http.createServer(app);
  const port: number = await new Promise((r) => server.listen(0, () => r((server.address() as any).port)));
  const call = async (uid: string, method: string, url: string, body?: any) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/retailops${url}`, { method, headers: { "Content-Type": "application/json", "x-uid": uid }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json, text };
  };
  const M = "2026-10";
  await call(bruno, "PUT", "/monthly-goals", { storeId: carioca, month: M, goalAmount: 60000 });
  await call(bruno, "PUT", "/monthly-goals", { storeId: grande, month: M, goalAmount: 90000 });

  // ── leitura ──
  let r = await call(gabriel, "GET", `/monthly-goals?month=${M}`);
  check("gerente LÊ só a meta da própria loja e a resposta diz que ele NÃO edita", r.status === 200 && r.json.canEdit === false && r.json.stores.length === 1 && r.json.stores[0].storeId === carioca && r.json.stores[0].goalAmount === 60000, r.text.slice(0, 140));
  r = await call(bruno, "GET", `/monthly-goals?month=${M}`);
  check("dono lê todas e pode editar", r.json.canEdit === true && r.json.stores.length === 2);

  // ── gerente não altera a meta ──
  check("gerente NÃO salva meta (403)", (await call(gabriel, "PUT", "/monthly-goals", { storeId: carioca, month: M, goalAmount: 1 })).status === 403);
  check("gerente NÃO remove meta (403)", (await call(gabriel, "DELETE", "/monthly-goals", { storeId: carioca, month: M })).status === 403);

  // ── contestar ──
  r = await call(gabriel, "POST", "/monthly-goals/dispute", { storeId: carioca, month: M, note: "a meta de outubro é R$ 80.000" });
  check("gerente contesta a meta da PRÓPRIA loja (201)", r.status === 201 && r.json.ok === true, r.text.slice(0, 120));
  check("não contesta outra loja (403)", (await call(gabriel, "POST", "/monthly-goals/dispute", { storeId: grande, month: M, note: "errada" })).status === 403);
  check("sem explicação → 400 (diz o que falta)", (await call(gabriel, "POST", "/monthly-goals/dispute", { storeId: carioca, month: M, note: "" })).status === 400);
  const loja = (await call(gabriel, "GET", `/monthly-goals?month=${M}`)).json.stores[0].goalAmount;
  check("a contestação NUNCA altera a meta (continua R$ 60.000)", loja === 60000);

  const sig = () => db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND signal_type = 'retail_monthly_goal_disputed'").all(ORG) as any[];
  check("nasce UM aviso na espinha, amarrado à loja, aberto", sig().length === 1 && sig()[0].source_entity_id === carioca && sig()[0].status === "open");
  const ev = JSON.parse(sig()[0].evidence_json);
  check("o aviso diz O QUE (quem/loja/mês/valor atual/motivo), ONDE e o que FAZER", /Gabriel/.test(ev.what) && /Carioca/.test(ev.what) && /60\.000/.test(ev.what) && /80\.000/.test(ev.what) && /Meta mensal por loja/.test(ev.where) && /corrija a meta/i.test(ev.todo), ev.what);
  await call(gabriel, "POST", "/monthly-goals/dispute", { storeId: carioca, month: M, note: "continua errada" });
  check("contestar de novo não duplica (idempotente por loja+mês)", sig().length === 1);
  const hidFor = (uid: string, role: string) => SC.hiddenFor(ORG, { userId: uid, role });
  check("o gerente da loja enxerga o aviso; o gerente de OUTRA loja não; o dono vê tudo", !hidFor(gabriel, "admin")!.has(sig()[0].id) && hidFor(outro, "admin")!.has(sig()[0].id) && hidFor(bruno, "owner") === null);

  // ── dono corrige ──
  await call(bruno, "PUT", "/monthly-goals", { storeId: carioca, month: M, goalAmount: 80000 });
  check("dono corrige a meta → o aviso fecha sozinho", sig()[0].status === "resolved");
  const done = db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND signal_type = 'retail_monthly_goal_dispute_resolved'").all(ORG) as any[];
  check("…e a loja é avisada com o valor novo", done.length === 1 && /80\.000/.test(JSON.parse(done[0].evidence_json).what) && done[0].source_entity_id === carioca);
  await call(bruno, "PUT", "/monthly-goals", { storeId: carioca, month: M, goalAmount: 81000 });
  check("corrigir de novo sem contestação aberta não gera aviso novo", (db.prepare("SELECT COUNT(*) c FROM business_signals WHERE organization_id = ? AND signal_type = 'retail_monthly_goal_dispute_resolved'").get(ORG) as any).c === 1);

  console.log("\n=== Meta mensal da loja: dono define, gerente confere ===");
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok || !x.detail ? "" : ` — ${x.detail}`}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} monthly-goal-dispute: ${results.length - failures}/${results.length} checks`);
  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } process.exit(1); });
