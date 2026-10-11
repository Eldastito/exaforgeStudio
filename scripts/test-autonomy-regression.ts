/**
 * TESTE — ADR-206 F5.4: ESCADA ÚNICA + REGRESSÃO AUTOMÁTICA de autonomia (só pra baixo).
 * Prova, nos serviços REAIS:
 *   A) escada: cada política ganha um degrau nomeado (observe/shadow/recommend/prepare/auto/paused) coerente com o nível derivado;
 *   B) gatilho com prova: falhas reais do handler (amostra mínima + Wilson) OU reversões; recusa de guarda NÃO conta; amostra pequena não dispara;
 *   C) só desce: auto → prepare; quem já está abaixo (prepare/recommend/shadow/paused) nunca é tocado; nada sobe; sem caminho de subida no código;
 *   D) opt-in: sem a flag, apply não age (assess segue read-only); com a flag age e é idempotente;
 *   E) auditado (AUTONOMY_REGRESSED, ator de sistema) + avisa o dono em business_signals (sem tabela de alerta paralela);
 *   F) janela recomeça na regressão: depois de rebaixar, o passado não pune de novo; novas falhas após re-elevação humana contam;
 *   G) isolamento por empresa; rotas montadas; Scheduler com o passe.
 * Uso: npm run test:autonomy-regression
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-areg-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-areg-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AutonomyRegressionService: R } = await import("../src/server/AutonomyRegressionService.js");
  const { AutonomyKillSwitchService: K } = await import("../src/server/AutonomyKillSwitchService.js");
  const mkOrg = (flag = 1) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, autonomy_regression_enabled) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, flag); return id; };
  const pol = (org: string, domain: string, type: string, level: string, mode: string, maxAuto: number | null = 100) =>
    db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, max_auto_amount, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(randomUUID(), org, domain, type, level, mode, maxAuto);
  const act = (org: string, domain: string, type: string, status = "done", approved = true) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, approved_at, created_by) VALUES (?, ?, ?, ?, 't', ?, ?, 'ai')`).run(id, org, domain, type, status, approved ? "2026-01-01 00:00:00" : null);
    return id;
  };
  const exec = (org: string, actionId: string, status: "done" | "failed", code: string | null = null) =>
    db.prepare(`INSERT INTO action_execution_log (id, organization_id, action_id, attempt, handler, mode, status, error_code) VALUES (?, ?, ?, 1, 'h', 'execute', ?, ?)`).run(randomUUID(), org, actionId, status, code);
  const modeOf = (org: string, d: string, t: string) => (db.prepare("SELECT execution_mode m FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?").get(org, d, t) as any).m;
  const runs = (org: string, d: string, t: string, ok: number, bad: number, code: string | null = "handler_error") => {
    for (let i = 0; i < ok; i++) exec(org, act(org, d, t), "done");
    for (let i = 0; i < bad; i++) exec(org, act(org, d, t), "failed", code);
  };

  // ── A) escada ──
  const o1 = mkOrg();
  pol(o1, "fin", "auto_t", "execute", "approved_execution");
  pol(o1, "fin", "prep_t", "prepare", "assisted");
  pol(o1, "fin", "sug_t", "suggest", "assisted");
  pol(o1, "fin", "obs_t", "observe", "assisted");
  pol(o1, "fin", "shadow_t", "execute", "shadow");
  pol(o1, "fin", "paused_t", "execute", "approved_execution");
  K.pause(o1, { domain: "fin", actionType: "paused_t", reason: "teste de pausa", by: "user-1" });
  const lad = R.ladder(o1).policies; const rung = (t: string) => lad.find((p) => p.actionType === t)!.rung;
  check("escada: execute+approved_execution+teto → auto", rung("auto_t") === "auto");
  check("escada: prepare → prepare · suggest → recommend · observe → observe", rung("prep_t") === "prepare" && rung("sug_t") === "recommend" && rung("obs_t") === "observe");
  check("escada: modo sombra aparece como shadow", rung("shadow_t") === "shadow");
  check("escada: pausa do dono aparece como paused", rung("paused_t") === "paused");
  check("escada: cada política tem degrau e motivo", lad.length === 6 && lad.every((p) => p.rung && p.reason));

  // ── B) gatilho ──
  const o2 = mkOrg();
  pol(o2, "fin", "t_few", "execute", "approved_execution");   // 2 falhas em 3: amostra pequena
  pol(o2, "fin", "t_bad", "execute", "approved_execution");   // 4 falhas em 6
  pol(o2, "fin", "t_good", "execute", "approved_execution");  // 1 falha em 20
  pol(o2, "fin", "t_guard", "execute", "approved_execution"); // só recusas de guarda
  pol(o2, "fin", "t_rev", "execute", "approved_execution");   // reversões
  runs(o2, "fin", "t_few", 1, 2); runs(o2, "fin", "t_bad", 2, 4); runs(o2, "fin", "t_good", 19, 1);
  runs(o2, "fin", "t_guard", 0, 12, "execution_mode_blocked");
  act(o2, "fin", "t_rev", "cancelled", true); act(o2, "fin", "t_rev", "cancelled", true);
  const as = R.assess(o2); const get = (t: string) => as.assessed.find((a) => a.actionType === t)!;
  check("amostra pequena (2/3) NÃO dispara", get("t_few").regress === false);
  check("4 falhas em 6 dispara (Wilson inferior acima do piso)", get("t_bad").regress === true && get("t_bad").attempts === 6 && get("t_bad").failed === 4);
  check("1 falha em 20 NÃO dispara", get("t_good").regress === false);
  check("recusa de guarda de política NÃO conta como falha", get("t_guard").failed === 0 && get("t_guard").regress === false);
  check("2 reversões (aprovada e cancelada) dispara", get("t_rev").regress === true && get("t_rev").reversed === 2);
  check("ação cancelada SEM ter sido aprovada não conta reversão", (() => { pol(o2, "fin", "t_rev0", "execute", "approved_execution"); act(o2, "fin", "t_rev0", "cancelled", false); act(o2, "fin", "t_rev0", "cancelled", false); return R.assessType(o2, "fin", "t_rev0").reversed === 0; })());
  check("assess é read-only (nada mudou)", ["t_few", "t_bad", "t_good", "t_guard", "t_rev"].every((t) => modeOf(o2, "fin", t) === "approved_execution"));
  check("motivos explicam em linguagem de dono", get("t_bad").reasons.length === 1 && /falha/.test(get("t_bad").reasons[0]));

  // ── D) opt-in ──
  const off = mkOrg(0); pol(off, "fin", "x", "execute", "approved_execution"); runs(off, "fin", "x", 0, 8);
  check("sem a flag: apply não age (mas assess enxerga)", R.apply(off).enabled === false && modeOf(off, "fin", "x") === "approved_execution" && R.assess(off).wouldRegress.length === 1);

  // ── C/E) só desce + auditoria + aviso ──
  db.prepare("UPDATE action_execution_log SET started_at = datetime('now','-1 hour') WHERE organization_id = ?").run(o2); // o histórico é anterior à regressão (determinístico, sem corrida de segundo)
  db.prepare("UPDATE decision_actions SET created_at = datetime('now','-1 hour') WHERE organization_id = ?").run(o2);
  const ap = R.apply(o2);
  check("apply rebaixa exatamente os que merecem (t_bad, t_rev)", ap.enabled && ap.regressed.map((r) => r.actionType).sort().join() === "t_bad,t_rev", JSON.stringify(ap.regressed));
  check("rebaixou auto → prepare (execution_mode assisted, nível 2)", modeOf(o2, "fin", "t_bad") === "assisted" && R.rungOf(o2, "fin", "t_bad").rung === "prepare");
  check("quem não merecia segue em auto", ["t_few", "t_good", "t_guard"].every((t) => R.rungOf(o2, "fin", t).rung === "auto"));
  check("auditoria AUTONOMY_REGRESSED com ator de SISTEMA e motivos", (() => { const r = db.prepare("SELECT actor_user_id a, metadata_json m FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'AUTONOMY_REGRESSED'").all(o2) as any[]; return r.length === 2 && r.every((x) => String(x.a).startsWith("system:") && /reasons/.test(String(x.m || ""))); })());
  check("avisa o dono pela espinha (business_signals governance/autonomy_regressed)", (db.prepare("SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND domain = 'governance' AND signal_type = 'autonomy_regressed' AND status = 'open'").get(o2) as any).n === 2);
  check("idempotente: segunda rodada não rebaixa de novo nem duplica aviso", R.apply(o2).regressed.length === 0 && (db.prepare("SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = 'autonomy_regressed'").get(o2) as any).n === 2);

  // só desce: nada abaixo é tocado
  const o3 = mkOrg();
  pol(o3, "fin", "p", "prepare", "assisted"); pol(o3, "fin", "s", "suggest", "assisted"); pol(o3, "fin", "sh", "execute", "shadow"); pol(o3, "fin", "pa", "execute", "approved_execution");
  for (const t of ["p", "s", "sh", "pa"]) runs(o3, "fin", t, 0, 10);
  K.pause(o3, { domain: "fin", actionType: "pa", reason: "pausa do dono", by: "u" });
  const before = db.prepare("SELECT action_type, autonomy_level, execution_mode FROM agent_policies WHERE organization_id = ? ORDER BY action_type").all(o3);
  const ap3 = R.apply(o3);
  const after = db.prepare("SELECT action_type, autonomy_level, execution_mode FROM agent_policies WHERE organization_id = ? ORDER BY action_type").all(o3);
  check("só desce: prepare/recommend/shadow/paused com histórico péssimo NÃO são tocados", ap3.regressed.length === 0 && JSON.stringify(before) === JSON.stringify(after));
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/AutonomyRegressionService.ts"), "utf8");
  check("sem caminho de subida no código (nenhum UPDATE que ponha approved_execution/autonomous/execute)", !/SET[^`"']*= *'(approved_execution|autonomous|execute)'/.test(src) && !/autonomy_level *= *'execute'/.test(src));

  // ── F) janela recomeça ──
  check("depois de rebaixar, o mesmo passado não pune de novo", R.assessType(o2, "fin", "t_bad").attempts === 0 && R.assessType(o2, "fin", "t_rev").reversed === 0);
  db.prepare("UPDATE agent_policies SET execution_mode = 'approved_execution' WHERE organization_id = ? AND action_type = 't_bad'").run(o2); // re-elevação HUMANA
  db.prepare("UPDATE business_signals SET detected_at = datetime('now','-30 minutes') WHERE organization_id = ? AND dedupe_key = 'autonomy_regressed:fin:t_bad'").run(o2);
  check("re-elevado por pessoa: o passado anterior à regressão não conta", R.assess(o2).assessed.find((a) => a.actionType === "t_bad")!.regress === false);
  runs(o2, "fin", "t_bad", 0, 6);
  check("falhas NOVAS depois da re-elevação voltam a contar", R.assess(o2).assessed.find((a) => a.actionType === "t_bad")!.regress === true);

  // ── G) isolamento e fiação ──
  const o4 = mkOrg(); pol(o4, "fin", "t_bad", "execute", "approved_execution");
  check("isolamento: histórico ruim de outra empresa não rebaixa esta", R.assessType(o4, "fin", "t_bad").attempts === 0 && R.apply(o4).regressed.length === 0);
  check("isolamento: ladder só mostra a própria empresa", R.ladder(o4).policies.length === 1);
  const routes = fs.readFileSync(path.join(process.cwd(), "src/server/routes/actions.ts"), "utf8");
  check("rotas montadas (ladder, regression, enabled só do dono)", /"\/autonomy\/ladder"/.test(routes) && /"\/autonomy\/regression"/.test(routes) && /regression\/enabled[\s\S]{0,200}canGovernAutonomy/.test(routes));
  const sch = fs.readFileSync(path.join(process.cwd(), "src/server/Scheduler.ts"), "utf8");
  check("Scheduler roda o passe", sch.includes("AutonomyRegressionService") && sch.includes("runAll()"));
  check("runAll só pega empresas com a flag", (() => { const r = R.runAll(); return r.orgs >= 3 && !R.isEnabled(off); })());
  const dbsrc = fs.readFileSync(path.join(process.cwd(), "src/server/db.ts"), "utf8");
  check("sem tabela nova (só 1 coluna opt-in)", !/CREATE TABLE IF NOT EXISTS (autonomy_regress|autonomy_ladder|autonomy_events)/.test(dbsrc) && /ADD COLUMN autonomy_regression_enabled/.test(dbsrc));

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : r.d ? "  → " + r.d : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
