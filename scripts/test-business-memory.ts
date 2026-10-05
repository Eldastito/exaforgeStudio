/**
 * TESTE — ADR-204 F3.2: MEMÓRIA EMPRESARIAL (padrão ≠ regra sem confirmação do gestor — RN-F3-4).
 * ----------------------------------------------------------------------------
 * Prova, nos serviços REAIS:
 *   A) estágios derivados: observado → hipótese (validated) → REGRA só com decisão de uma PESSOA; sistema/IA nunca decide;
 *      isolado por empresa; dormente não se confirma; histórico append-only; `learn` NÃO apaga nem rebaixa a decisão;
 *   B) rejeitar: o padrão deixa de alertar (sinal resolvido, não republicado); revogar devolve a hipótese;
 *   C) a PERGUNTA "considera uma regra?" vai pro ledger (`business_signals`, domínio memory): só hipótese sem decisão,
 *      top-3, N real de ocorrências (não inventa semanas), some ao decidir, volta ao revogar;
 *   D) read-model `overview`: regras/hipóteses/observados/rejeitados + preferências + políticas + aprendizados; hipótese
 *      NUNCA aparece como regra; limiar de alerta (R$) só p/ quem vê dinheiro; isolado;
 *   E) rotas + fiação do front.
 *
 * Uso:  npm run test:business-memory
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-business-memory-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-business-memory-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const noLLM = async () => ({});

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PatternMemoryService: P } = await import("../src/server/PatternMemoryService.js");
  const { BusinessMemoryService: M } = await import("../src/server/BusinessMemoryService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const A = mkOrg(), B = mkOrg();
  const profile = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id;
  const mkUser = (org: string, role: string, key: string, name: string) => {
    const id = randomUUID(); const email = `${id}@t.local`;
    db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')`).run(id, org, name, email, role);
    return { userId: id, id, role, role_profile_id: profile(org, key), name, email };
  };
  const maria = mkUser(A, "owner", "owner", "Maria Dona");
  const joao = mkUser(A, "agent", "vendedor", "João Vendedor");

  const cand = (key: string, evidence: number, confidence: number) => ({
    scopeId: null, patternType: `mem_${key}`, patternKey: key, evidenceCount: evidence, confidence,
    impactAmount: evidence, impactUnit: "units", evidence: { k: key }, fallbackDescription: `Padrão ${key}.`,
  });
  const opts = (types: string[]) => ({ handledTypes: types, sourceService: "TestMemory", hypothesizer: noLLM });
  const get = (org: string, type: string) => (db.prepare(`SELECT * FROM business_patterns WHERE organization_id = ? AND pattern_type = ?`).get(org, type) as any);
  const openAsk = (org: string, pid: string) => db.prepare(`SELECT 1 FROM business_signals WHERE organization_id = ? AND dedupe_key = ? AND status = 'open'`).get(org, `memory:confirm:${pid}`);
  const openAlert = (org: string, type: string) => db.prepare(`SELECT 1 FROM business_signals WHERE organization_id = ? AND domain = 'ops' AND signal_type = ? AND status = 'open'`).get(org, type);

  // ── A) estágios ──
  check("stageOf: sem decisão segue o status automático", P.stageOf({ status: "validated" }) === "hypothesis" && P.stageOf({ status: "candidate" }) === "observed" && P.stageOf({ status: "dormant" }) === "dormant");
  check("stageOf: a decisão do gestor vence o status", P.stageOf({ status: "candidate", manager_decision: "confirmed" }) === "rule" && P.stageOf({ status: "validated", manager_decision: "rejected" }) === "rejected");

  await P.learn(A, "ops", [cand("alfa", 4, 0.8), cand("beta", 4, 0.8), cand("gama", 1, 0.3)], opts(["mem_alfa", "mem_beta", "mem_gama"]));
  const alfa = get(A, "mem_alfa"), beta = get(A, "mem_beta"), gama = get(A, "mem_gama");
  check("learn cria hipótese (validated) e observado (candidate); nada é regra", alfa.status === "validated" && gama.status === "candidate" && !alfa.manager_decision && !gama.manager_decision);
  check("hipótese publica o alerta do padrão (comportamento F-anterior intacto)", !!openAlert(A, "mem_alfa"));

  for (const bad of [undefined, null, "", "   ", "runtime", "ai", "rule", "system", "scheduler", "agent:memoria", "bot-1", "cron"])
    check(`decide recusa autor "${String(bad)}" (só pessoa)`, P.decide(A, alfa.id, "confirmed", bad as any).ok === false);
  check("decisão inválida e padrão inexistente recusados", P.decide(A, alfa.id, "xpto" as any, maria.userId).ok === false && P.decide(A, "nao-existe", "confirmed", maria.userId).ok === false);
  check("isolamento: outra empresa não decide sobre padrão alheio", P.decide(B, alfa.id, "confirmed", maria.userId).ok === false);
  check("nada mudou depois das recusas", !get(A, "mem_alfa").manager_decision && P.decisions(A, alfa.id).length === 0);
  check("revogar sem decisão é recusado", P.decide(A, alfa.id, "revoked", maria.userId).ok === false);

  const c1 = P.decide(A, alfa.id, "confirmed", maria.userId, "  vale pra toda a loja  ");
  check("pessoa confirma → regra", c1.ok && c1.stage === "rule" && get(A, "mem_alfa").manager_decision === "confirmed" && get(A, "mem_alfa").manager_decided_by === maria.userId);
  check("nota é guardada aparada", get(A, "mem_alfa").manager_note === "vale pra toda a loja");
  check("o alerta do padrão continua (confirmar não silencia)", !!openAlert(A, "mem_alfa"));
  check("confirmar um observado (candidate) também é permitido", P.decide(A, gama.id, "confirmed", maria.userId).ok === true && P.stageOf(get(A, "mem_gama")) === "rule");
  P.decide(A, gama.id, "revoked", maria.userId);

  // learn NÃO apaga nem rebaixa a decisão — mesmo quando o padrão some e decai.
  await P.learn(A, "ops", [cand("beta", 4, 0.8)], opts(["mem_alfa", "mem_beta", "mem_gama"]));
  const alfa2 = get(A, "mem_alfa");
  check("learn reavalia a recorrência mas NÃO toca a decisão do gestor", alfa2.manager_decision === "confirmed" && alfa2.manager_decided_by === maria.userId && alfa2.status !== "validated", `${alfa2.status}/${alfa2.manager_decision}`);
  check("regra continua regra mesmo com o padrão decaído", P.stageOf(alfa2) === "rule");
  await P.learn(A, "ops", [], opts(["mem_alfa", "mem_gama"]));
  await P.learn(A, "ops", [], opts(["mem_alfa", "mem_gama"]));
  await P.learn(A, "ops", [], opts(["mem_alfa", "mem_gama"]));
  check("dormente não pode ser confirmado", get(A, "mem_gama").status === "dormant" && P.decide(A, gama.id, "confirmed", maria.userId).ok === false);
  check("regra segue regra depois de DORMIR (a pessoa decidiu)", get(A, "mem_alfa").status === "dormant" && P.stageOf(get(A, "mem_alfa")) === "rule");

  // ── B) rejeitar / revogar ──
  await P.learn(A, "ops", [cand("delta", 4, 0.8)], opts(["mem_delta"]));
  const delta = get(A, "mem_delta");
  check("delta é hipótese com alerta aberto", delta.status === "validated" && !!openAlert(A, "mem_delta"));
  const rj = P.decide(A, delta.id, "rejected", maria.userId, "ruído");
  check("rejeitar → estágio rejected e o alerta do padrão é resolvido", rj.ok && rj.stage === "rejected" && P.publishSignals(A, "ops", { sourceService: "T", handledTypes: ["mem_delta"] }).published === 0 && !openAlert(A, "mem_delta"));
  await P.learn(A, "ops", [cand("delta", 5, 0.9)], opts(["mem_delta"]));
  check("rejeitado NÃO volta a alertar mesmo com a recorrência subindo", !openAlert(A, "mem_delta") && P.stageOf(get(A, "mem_delta")) === "rejected");
  const rv = P.decide(A, delta.id, "revoked", maria.userId);
  check("revogar devolve a hipótese e limpa a decisão", rv.ok && rv.stage === "hypothesis" && get(A, "mem_delta").manager_decision === null && get(A, "mem_delta").manager_note === null);
  const hist = P.decisions(A, delta.id);
  check("histórico append-only: rejected, revoked — nada some", hist.length === 2 && hist.map((h: any) => h.decision).sort().join() === "rejected,revoked" && hist.every((h: any) => h.decided_by === maria.userId));
  check("auditoria registra a decisão (quem, quando, o quê)", (db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND actor_user_id = ? AND event_type IN ('PATTERN_CONFIRMED','PATTERN_REJECTED','PATTERN_REVOKED')`).get(A, maria.userId) as any).c >= 3);

  // ── C) a pergunta no ledger ──
  const p0 = P.requestConfirmations(A);
  const askedIds = (db.prepare(`SELECT source_entity_id id FROM business_signals WHERE organization_id = ? AND domain='memory' AND signal_type='pattern_confirmation' AND status='open'`).all(A) as any[]).map((r) => r.id);
  check("pergunta só p/ hipótese SEM decisão (beta, delta) — não p/ regra nem observado", askedIds.includes(beta.id) && askedIds.includes(delta.id) && !askedIds.includes(alfa.id) && !askedIds.includes(gama.id), JSON.stringify(askedIds));
  const sig = db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(A, `memory:confirm:${beta.id}`) as any;
  const ev = JSON.parse(sig.evidence_json || "{}");
  check("o sinal é hipótese, severidade info, sem dinheiro inventado", sig.basis === "hypothesis" && sig.severity === "info" && sig.impact_amount == null);
  check("a pergunta carrega o N real de ocorrências (não inventa semanas)", Number(ev.occurrences) === Number(get(A, "mem_beta").occurrences) && !/semana/i.test(JSON.stringify(ev)));
  check("idempotente: repetir não duplica", (() => { P.requestConfirmations(A); return (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(A, `memory:confirm:${beta.id}`) as any).c === 1; })());
  P.decide(A, beta.id, "confirmed", maria.userId);
  check("decidir resolve a pergunta", !openAsk(A, beta.id));
  P.decide(A, beta.id, "revoked", maria.userId);
  P.requestConfirmations(A);
  check("revogar traz a pergunta de volta", !!openAsk(A, beta.id));
  for (let i = 0; i < 5; i++) await P.learn(A, "ops", [cand(`extra${i}`, 4, 0.9)], opts([`mem_extra${i}`]));
  const open = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ? AND domain='memory' AND signal_type='pattern_confirmation' AND status='open'`).get(A) as any).c;
  check("limite: no máximo 3 perguntas abertas por vez (sem ruído)", open <= 3, String(open));
  check("empresa B não ganhou nada", (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ? AND domain='memory'`).get(B) as any).c === 0);

  // ── D) overview ──
  db.prepare(`UPDATE organization_settings SET proactive_awake_start = 7, alert_min_amount = 250 WHERE organization_id = ?`).run(A);
  db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'finance', 'collection', 'prepare', 'assisted', 1)`).run(randomUUID(), A);
  P.decide(A, delta.id, "rejected", maria.userId);
  const ov = M.overview(A, { canSeeMoney: true });
  check("regras = só o que a pessoa confirmou", ov.rules.length === 1 && ov.rules[0].id === alfa.id && ov.rules[0].confirmedBy === maria.userId);
  check("hipótese NUNCA aparece como regra", ov.hypotheses.every((h: any) => !ov.rules.some((r: any) => r.id === h.id)) && ov.hypotheses.some((h: any) => h.id === beta.id));
  check("pergunta usa as ocorrências reais e a 1ª data", ov.hypotheses.every((h: any) => new RegExp(`Identifiquei isso ${h.occurrences} vez`).test(h.question) && /Considera uma regra da empresa\?/.test(h.question)));
  check("rejeitados listados à parte", ov.rejected.length === 1 && ov.rejected[0].id === delta.id);
  check("contagens batem com as listas", ov.counts.rules === ov.rules.length && ov.counts.hypotheses === ov.hypotheses.length && ov.counts.rejected === ov.rejected.length);
  check("compõe preferências + políticas + piso (sem motor novo)", ov.preferences.awakeStart === 7 && ov.policies.some((p: any) => p.label === "Cobrança") && ov.alwaysHuman.length >= 6 && Array.isArray(ov.learnings));
  check("limiar de alerta (R$) só p/ quem vê dinheiro", ov.preferences.alertMinAmount === 250 && !("alertMinAmount" in M.overview(A, { canSeeMoney: false }).preferences));
  const ovB = M.overview(B, { canSeeMoney: true });
  check("isolado: B não vê nada de A", ovB.counts.rules === 0 && ovB.counts.hypotheses === 0 && ovB.policies.length === 0);

  // ── E) rotas ──
  const express = (await import("express")).default;
  const router = (await import("../src/server/routes/insights.js")).default;
  const who: Record<string, any> = { maria, joao };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-org"] || undefined; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/insights", router);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (method: string, url: string, user: string | null, org: string | null, body?: any) => {
    const h: any = { "Content-Type": "application/json" }; if (user) h["x-user"] = user; if (org) h["x-org"] = org;
    const r = await fetch(`http://127.0.0.1:${port}/api/insights${url}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const gamaId = gama.id, extra = get(A, "mem_extra0").id;
  const r1 = await call("POST", `/patterns/${extra}/decision`, "maria", A, { decision: "confirmed", note: "ok" });
  check("rota: dono confirma", r1.status === 200 && r1.body.ok && r1.body.stage === "rule");
  const r2 = await call("POST", `/patterns/${extra}/decision`, "joao", A, { decision: "revoked" });
  check("rota: quem não é dono/admin toma 403 e nada muda", r2.status === 403 && get(A, "mem_extra0").manager_decision === "confirmed");
  const r3 = await call("POST", `/patterns/${gamaId}/decision`, "maria", A, { decision: "confirmed" });
  check("rota: dormente → 400 com motivo", r3.status === 400 && /parou de aparecer/.test(r3.body.error));
  const r4 = await call("POST", `/patterns/${extra}/decision`, "maria", B, { decision: "revoked" });
  check("rota: outra empresa → 400 (não enxerga o padrão)", r4.status === 400 && get(A, "mem_extra0").manager_decision === "confirmed");
  const r5 = await call("GET", `/memory`, "maria", A);
  check("rota: GET /memory entrega o read-model", r5.status === 200 && r5.body.counts.rules >= 2 && r5.body.preferences.alertMinAmount === 250);
  const r6 = await call("GET", `/memory`, "joao", A);
  check("rota: sem visão de dinheiro não recebe o limiar", r6.status === 200 && !("alertMinAmount" in r6.body.preferences));
  const r7 = await call("GET", `/patterns/${extra}/decisions`, "maria", A);
  check("rota: histórico das decisões", r7.status === 200 && r7.body.decisions.length === 1);
  check("rota: sem empresa → 401", (await call("GET", `/memory`, null, null)).status === 401);
  server.close();

  // ── fiação do front ──
  const root = path.resolve(process.cwd());
  const ui = fs.readFileSync(path.join(root, "src/features/InsightsView.tsx"), "utf8");
  check("front: botões Sim, é regra / Não é regra / Desfazer chamam /decision", /patterns\/\$\{p\.id\}\/decision/.test(ui) && /Sim, é regra/.test(ui) && /Não é regra/.test(ui) && /Desfazer decisão/.test(ui));
  check("front: validado aparece como 'hipótese' (não como regra) até haver decisão", /'hipótese'/.test(ui) && /regra da empresa/.test(ui));

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
