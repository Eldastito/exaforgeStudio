/**
 * TESTE — ADR-204 F3.1c: KILL SWITCH de autonomia + TRAVAS de segurança no `execute` (RN-F3-7/RN-F3-10, PRD §37).
 * ----------------------------------------------------------------------------
 * Prova, nos serviços REAIS:
 *   A) kill switch por EMPRESA e por TIPO: bloqueia todo efeito (inclusive de ação já aprovada por pessoa e via
 *      `dispatchGoverned`), com recusa AUDITADA; propor/preparar/aprovar/explicar seguem; retomar libera; histórico
 *      preservado; idempotente; isolado por empresa;
 *   B) travas opt-in (confiança mínima · teto de valor · idade do dado): cada uma recusa com código próprio e
 *      "Não executei porque…"; valor/idade DESCONHECIDOS também recusam (não se prova); sem trava = 0-regressão;
 *   C) nível 0–3 enxerga a pausa; snapshot e explicação citam as travas;
 *   D) rotas: pausar/retomar/configurar só dono (ou admin master); leitura p/ qualquer usuário da empresa.
 *
 * Uso:  npm run test:autonomy-guard
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-autonomy-guard-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-autonomy-guard-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const throws = (fn: () => any) => { try { fn(); return false; } catch { return true; } };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ApprovalPolicyService: P } = await import("../src/server/ApprovalPolicyService.js");
  const { DecisionActionService: D } = await import("../src/server/DecisionActionService.js");
  const { CommandExecutorService: X } = await import("../src/server/CommandExecutorService.js");
  const { ExecutionTraceService: T } = await import("../src/server/ExecutionTraceService.js");
  const { AutonomyKillSwitchService: K } = await import("../src/server/AutonomyKillSwitchService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const { MASTER_ADMIN_EMAIL } = await import("../src/server/config/secret.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const A = mkOrg(), B = mkOrg();
  const profile = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id;
  const mkUser = (org: string, role: string, key: string, name: string, email?: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')`).run(id, org, name, email || `${id}@t.local`, role);
    return { userId: id, id, role, role_profile_id: profile(org, key), name, email: email || `${id}@t.local` };
  };
  const maria = mkUser(A, "owner", "owner", "Maria Dona");
  const joao = mkUser(A, "admin", "vendedor", "João Vendedor");
  const mestre = mkUser(A, "admin", "vendedor", "Admin Master", MASTER_ADMIN_EMAIL);
  const setPolicy = (org: string, domain: string, t: string, o: { autonomy?: string; mode?: string; max?: number | null } = {}) => {
    const cur = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?`).get(org, domain, t) as any;
    if (cur) db.prepare(`UPDATE agent_policies SET autonomy_level = ?, execution_mode = ?, max_auto_amount = ?, active = 1 WHERE id = ?`).run(o.autonomy || "execute", o.mode || "approved_execution", o.max ?? null, cur.id);
    else db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, max_auto_amount, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(randomUUID(), org, domain, t, o.autonomy || "execute", o.mode || "approved_execution", o.max ?? null);
  };
  let effects = 0;
  X.registerHandler({ key: "GuardHandler", commandTypes: ["guard_cmd"], prepare: (_o, a) => ({ summary: `prep ${a.title}`, artifact: {} }), execute: async (_o, a) => { effects++; return { summary: a.title, artifact: {}, effect: "ok", externalRef: "g1" }; } });
  const mk = (org: string, type: string, extra: any = {}) => { const a = D.propose(org, { domain: "ops", actionType: type, title: `Ação ${type}`, commandType: "guard_cmd", ...extra }); D.approve(org, a.id, maria.userId); return a; };
  const tryExec = async (org: string, id: string) => { try { await X.execute(org, id); return { ok: true, msg: "" }; } catch (e: any) { return { ok: false, msg: String(e?.message || e) }; } };
  const lastCode = (org: string, id: string) => (db.prepare(`SELECT error_code FROM action_execution_log WHERE organization_id = ? AND action_id = ? AND status = 'failed' ORDER BY started_at DESC, attempt DESC LIMIT 1`).get(org, id) as any)?.error_code;

  setPolicy(A, "ops", "g_one"); setPolicy(A, "ops", "g_two"); setPolicy(B, "ops", "g_one");

  // ── A) kill switch ──
  check("sem pausa: tudo como sempre", K.isPaused(A, "ops", "g_one") === null && K.status(A).paused === false);
  check("pausar exige identidade e motivo", throws(() => K.pause(A, { reason: "x", by: "" })) && throws(() => K.pause(A, { reason: "", by: maria.userId })) && throws(() => K.pause(A, { reason: "ab", by: maria.userId })));
  check("tipo exige domínio · só domínio não é suportado", throws(() => K.pause(A, { actionType: "g_one", reason: "teste", by: maria.userId })) && throws(() => K.pause(A, { domain: "ops", reason: "teste", by: maria.userId })));

  const ready = mk(A, "g_one");
  const p1 = K.pause(A, { reason: "Suspeita de erro na integração", by: maria.userId });
  check("pausa da EMPRESA registrada (scope org, com motivo e quem)", p1.scope === "org" && p1.reason === "Suspeita de erro na integração" && p1.pausedBy === maria.userId);
  check("pausar de novo é idempotente (mesma pausa)", K.pause(A, { reason: "outra", by: maria.userId }).id === p1.id && K.status(A).active.length === 1);
  const rPaused = await tryExec(A, ready.id);
  check("ação JÁ APROVADA por pessoa NÃO executa com a empresa pausada", !rPaused.ok && /pausada pelo dono/.test(rPaused.msg) && effects === 0, rPaused.msg);
  check("…recusa AUDITADA (autonomy_paused)", lastCode(A, ready.id) === "autonomy_paused");
  check("explicação: 'Não executei porque o dono pausou a autonomia'", /Não executei porque o dono pausou a autonomia/.test(T.explain(A, ready.id)!.notExecutedBecause || ""));
  const whilePaused = D.propose(A, { domain: "ops", actionType: "g_two", title: "Nova durante a pausa", commandType: "guard_cmd" });
  check("propor, aprovar e preparar continuam funcionando durante a pausa", !!whilePaused.id && D.approve(A, whilePaused.id, maria.userId).status === "approved" && !!X.prepare(A, whilePaused.id));
  const before = effects;
  const dg = await X.dispatchGoverned(A, { domain: "ops", actionType: "g_dispatch", title: "Mensagem", commandType: "guard_cmd", commandPayload: {} }).then(() => "ok", (e) => String(e?.message || e));
  check("dispatchGoverned também respeita a pausa (sem efeito)", /pausada pelo dono/.test(String(dg)) && effects === before, String(dg));
  const lvPaused = P.autonomyLevel(A, { domain: "ops", actionType: "g_one" });
  check("nível 0–3 enxerga a pausa: ≤ 2 e paused=true", lvPaused.paused === true && lvPaused.level <= 2 && /pausada/.test(lvPaused.reason));
  check("isolamento: a pausa da empresa A não atinge a B", K.isPaused(B, "ops", "g_one") === null && (await tryExec(B, mk(B, "g_one").id)).ok === true);

  check("retomar libera: 1 pausa encerrada", K.resume(A, { by: maria.userId }).resumed === 1 && K.isPaused(A, "ops", "g_one") === null);
  check("…e a ação aprovada agora executa", (await tryExec(A, ready.id)).ok === true);
  const hist = K.status(A).history;
  check("histórico preservado (nada é apagado)", hist.length === 1 && hist[0].reason === "Suspeita de erro na integração" && hist[0].resumed_by === maria.userId);
  check("retomar sem pausa ativa → 0", K.resume(A, { by: maria.userId }).resumed === 0);

  K.pause(A, { domain: "ops", actionType: "g_one", reason: "só este tipo", by: maria.userId });
  const t1 = mk(A, "g_one"), t2 = mk(A, "g_two");
  check("pausa por TIPO: bloqueia o tipo pausado", !(await tryExec(A, t1.id)).ok && /este tipo de ação/.test((await tryExec(A, t1.id)).msg));
  check("…e NÃO bloqueia os outros tipos", (await tryExec(A, t2.id)).ok === true);
  K.resume(A, { domain: "ops", actionType: "g_one", by: maria.userId });
  check("retomar o tipo libera", (await tryExec(A, t1.id)).ok === true);

  // ── B) travas ──
  const noGate = mk(A, "g_two", { confidence: 0.1, expectedImpact: 99999 });
  check("sem trava configurada: confiança baixa e valor alto executam como sempre (0-regressão)", (await tryExec(A, noGate.id)).ok === true);
  check("setGates exige política ativa existente", throws(() => P.setGates(A, "ops", "sem_politica", { minConfidence: 0.5 })));
  check("setGates valida os números", throws(() => P.setGates(A, "ops", "g_two", { minConfidence: 1.5 })) && throws(() => P.setGates(A, "ops", "g_two", { maxExecuteAmount: -1 })) && throws(() => P.setGates(A, "ops", "g_two", { maxDataAgeMinutes: 0 })));
  const g = P.setGates(A, "ops", "g_two", { minConfidence: 0.8, maxExecuteAmount: 500, maxDataAgeMinutes: 30 });
  check("travas gravadas e lidas", g.minConfidence === 0.8 && g.maxExecuteAmount === 500 && g.maxDataAgeMinutes === 30 && P.gatesFor(A, "ops", "g_two").maxExecuteAmount === 500);
  const fresh = new Date(Date.now() - 10 * 60000).toISOString(), old = new Date(Date.now() - 120 * 60000).toISOString();
  const okAll = mk(A, "g_two", { confidence: 0.9, expectedImpact: 300, commandPayload: { dataAsOf: fresh } });
  check("dentro de todas as travas → executa", (await tryExec(A, okAll.id)).ok === true);
  const lowConf = mk(A, "g_two", { confidence: 0.6, expectedImpact: 300, commandPayload: { dataAsOf: fresh } });
  const rLow = await tryExec(A, lowConf.id);
  check("confiança abaixo do mínimo → recusa (confidence_below_min)", !rLow.ok && lastCode(A, lowConf.id) === "confidence_below_min", rLow.msg);
  const bigAmt = mk(A, "g_two", { confidence: 0.9, expectedImpact: 700, commandPayload: { dataAsOf: fresh } });
  check("valor acima do teto → recusa (amount_above_limit)", !(await tryExec(A, bigAmt.id)).ok && lastCode(A, bigAmt.id) === "amount_above_limit");
  const noAmt = mk(A, "g_two", { confidence: 0.9, commandPayload: { dataAsOf: fresh } });
  check("valor DESCONHECIDO com teto configurado → recusa (amount_unknown)", !(await tryExec(A, noAmt.id)).ok && lastCode(A, noAmt.id) === "amount_unknown");
  const stale = mk(A, "g_two", { confidence: 0.9, expectedImpact: 300, commandPayload: { dataAsOf: old } });
  const rStale = await tryExec(A, stale.id);
  check("dado mais velho que o limite → recusa (data_stale)", !rStale.ok && lastCode(A, stale.id) === "data_stale" && /acima do limite de 30 min/.test(rStale.msg), rStale.msg);
  const noDate = mk(A, "g_two", { confidence: 0.9, expectedImpact: 300 });
  check("sem data do dado com limite configurado → recusa (data_freshness_unknown)", !(await tryExec(A, noDate.id)).ok && lastCode(A, noDate.id) === "data_freshness_unknown");
  const viaEvidence = mk(A, "g_two", { confidence: 0.9, expectedImpact: 300 });
  db.prepare(`UPDATE decision_actions SET evidence_json = ? WHERE id = ?`).run(JSON.stringify({ dataAsOf: fresh }), viaEvidence.id);
  check("a data do dado também pode vir da evidência da ação", (await tryExec(A, viaEvidence.id)).ok === true);
  check("a recusa vira 'Não executei porque…' em palavras de negócio", /Não executei porque .*teto de execução/.test(T.explain(A, bigAmt.id)!.notExecutedBecause || "") && /Não executei porque .*mais velho/.test(T.explain(A, stale.id)!.notExecutedBecause || ""));
  const eff = effects;
  await tryExec(A, bigAmt.id); await tryExec(A, stale.id);
  check("recusadas não produzem efeito", effects === eff);

  P.setGates(A, "ops", "g_two", { maxExecuteAmount: null });
  check("limpar uma trava (null) mantém as outras", P.gatesFor(A, "ops", "g_two").maxExecuteAmount === undefined && P.gatesFor(A, "ops", "g_two").minConfidence === 0.8);
  check("sem o teto, a ação grande passa a executar (as demais travas satisfeitas)", (await tryExec(A, bigAmt.id)).ok === true);
  P.setGates(A, "ops", "g_two", { minConfidence: null, maxDataAgeMinutes: null });
  check("todas limpas → gatesFor vazio", Object.keys(P.gatesFor(A, "ops", "g_two")).length === 0);
  check("isolamento: travas da empresa A não existem na B", Object.keys(P.gatesFor(B, "ops", "g_one")).length === 0);

  // ── C) snapshot e explicação citam as travas ──
  P.setGates(A, "ops", "g_one", { maxExecuteAmount: 1000 });
  const snapAct = D.propose(A, { domain: "ops", actionType: "g_one", title: "Com trava", commandType: "guard_cmd", expectedImpact: 50 });
  check("o snapshot da proposta registra as travas vigentes", snapAct.policy_snapshot.gates?.maxExecuteAmount === 1000);
  check("a explicação cita 'Travas de segurança ativas… teto de valor'", /Travas de segurança ativas.*teto de valor/.test(T.explain(A, snapAct.id)!.policy.summary));
  const plain = D.propose(A, { domain: "ops", actionType: "g_two", title: "Sem trava", commandType: "guard_cmd" });
  check("sem travas: snapshot.gates vazio e nada é citado", Object.keys(plain.policy_snapshot.gates).length === 0 && !/Travas de segurança/.test(T.explain(A, plain.id)!.policy.summary));

  // ── D) rotas ──
  const express = (await import("express")).default;
  const router = (await import("../src/server/routes/actions.js")).default;
  const app = express();
  app.use(express.json());
  const who: Record<string, any> = { maria, joao, mestre };
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-org"] || undefined; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/actions", router);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = (method: string, p: string, user: string, body?: any, org: string | null = A) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json", ...(org ? { "x-org": org } : {}), "x-user": user }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  check("GET /autonomy/status: qualquer usuário da empresa lê (canGovern só p/ dono)", (await call("GET", "/api/actions/autonomy/status", "joao")).body?.canGovern === false && (await call("GET", "/api/actions/autonomy/status", "maria")).body?.canGovern === true);
  check("pausar: vendedor recebe 403", (await call("POST", "/api/actions/autonomy/pause", "joao", { reason: "teste" })).status === 403);
  const rp = await call("POST", "/api/actions/autonomy/pause", "maria", { reason: "Conferindo a integração" });
  check("pausar: dono → 201 e a pausa vale", rp.status === 201 && rp.body.scope === "org" && K.isPaused(A, "ops", "g_one") !== null);
  check("pausar sem motivo → 400", (await call("POST", "/api/actions/autonomy/pause", "maria", { reason: "" })).status === 400);
  check("retomar: vendedor 403 · dono 200", (await call("POST", "/api/actions/autonomy/resume", "joao", {})).status === 403 && (await call("POST", "/api/actions/autonomy/resume", "maria", {})).body?.resumed === 1);
  check("admin MASTER da plataforma também pode pausar/retomar", (await call("POST", "/api/actions/autonomy/pause", "mestre", { reason: "intervenção da plataforma" })).status === 201 && (await call("POST", "/api/actions/autonomy/resume", "mestre", {})).status === 200);
  check("trava PUT: vendedor 403", (await call("PUT", "/api/actions/autonomy/gates", "joao", { domain: "ops", actionType: "g_two", minConfidence: 0.5 })).status === 403);
  const rg = await call("PUT", "/api/actions/autonomy/gates", "maria", { domain: "ops", actionType: "g_two", minConfidence: 0.7 });
  check("trava PUT: dono grava", rg.status === 200 && rg.body.gates.minConfidence === 0.7);
  check("trava PUT sem política / valor inválido → 400", (await call("PUT", "/api/actions/autonomy/gates", "maria", { domain: "ops", actionType: "inexistente", minConfidence: 0.7 })).status === 400 && (await call("PUT", "/api/actions/autonomy/gates", "maria", { domain: "ops", actionType: "g_two", minConfidence: 7 })).status === 400);
  check("GET gates devolve a configuração · sem parâmetros 400", (await call("GET", "/api/actions/autonomy/gates?domain=ops&actionType=g_two", "joao")).body?.gates?.minConfidence === 0.7 && (await call("GET", "/api/actions/autonomy/gates", "joao")).status === 400);
  check("sem organização → 401", (await call("GET", "/api/actions/autonomy/status", "maria", undefined, null)).status === 401);
  check("rota nova não captura ids de ação (GET /:id continua)", (await call("GET", `/api/actions/${plain.id}`, "maria")).status === 200);
  await new Promise<void>((r) => server.close(() => r()));

  console.log("\n=== ADR-204 F3.1c: kill switch + travas de segurança ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} autonomy-guard: ${results.length - failures}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } process.exit(1); });
