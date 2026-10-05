/**
 * TESTE — ADR-204 F3.1b: snapshot da política + "POR QUE o ZapFlow fez isso?" (RN-F3-8, PRD §35/§36/§37).
 * ----------------------------------------------------------------------------
 * Prova, nos serviços REAIS:
 *   A) `propose` grava a FOTO da política que governou a ação (origem da regra, aprovações exigidas, piso, nível 0–3);
 *   B) a foto é a "da época": mudar a política depois NÃO a altera; ação anterior ao registro é dita como tal
 *      (nunca reconstruída com a política de hoje);
 *   C) `explain` responde em evidência de NEGÓCIO: recomendação+base+confiança, sinal de origem sem jargão,
 *      política, quem autorizou (pessoa × automática), execução ou "não executei porque…", resultado;
 *   D) dinheiro role-gated (§73): sem visão ampla os valores vêm null + restricted, o fato permanece;
 *   E) isolamento multi-tenant e rota GET /api/actions/:id/why (404 p/ domínio invisível, não vaza existência);
 *   F) `trace` por correlationId passa a trazer o snapshot parseado.
 *
 * Uso:  npm run test:action-why
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-action-why-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-action-why-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ApprovalPolicyService: P } = await import("../src/server/ApprovalPolicyService.js");
  const { DecisionActionService: D } = await import("../src/server/DecisionActionService.js");
  const { CommandExecutorService: X } = await import("../src/server/CommandExecutorService.js");
  const { ExecutionTraceService: T } = await import("../src/server/ExecutionTraceService.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const A = mkOrg(), B = mkOrg();
  const profile = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id;
  const mkUser = (org: string, role: string, key: string, name: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')`).run(id, org, name, `${id}@t.local`, role);
    return { userId: id, id, role, role_profile_id: profile(org, key), name };
  };
  const maria = mkUser(A, "owner", "owner", "Maria Souza");
  const joao = mkUser(A, "admin", "vendedor", "João Vendedor");
  const setPolicy = (org: string, domain: string, t: string, o: { autonomy?: string; mode?: string; max?: number | null }) => {
    const cur = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?`).get(org, domain, t) as any;
    if (cur) db.prepare(`UPDATE agent_policies SET autonomy_level = ?, execution_mode = ?, max_auto_amount = ?, active = 1 WHERE id = ?`).run(o.autonomy || "suggest", o.mode || "assisted", o.max ?? null, cur.id);
    else db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, max_auto_amount, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(randomUUID(), org, domain, t, o.autonomy || "suggest", o.mode || "assisted", o.max ?? null);
  };

  // ── A) snapshot gravado na proposta ──
  const task = D.propose(A, { domain: "tasks", actionType: "create_task", title: "Ligar pro fornecedor" });
  const sT = task.policy_snapshot;
  check("snapshot gravado e parseado em get()", !!sT && sT.version === 1 && typeof sT.capturedAt === "string");
  check("matriz padrão: source default_matrix · 0 aprovações · não é do piso", sT.source === "default_matrix" && sT.requiredApprovals === 0 && sT.humanOnly === false && sT.floorApplied === false);
  check("traz o nível de autonomia derivado (0–3) com o porquê", [0, 1, 2, 3].includes(sT.autonomy.level) && typeof sT.autonomy.reason === "string");

  P.setBands(A, "procurement", "create_purchase_order", [{ upTo: 2000, state: "allow" }, { upTo: null, state: "require_approval", role: "gerente" }]);
  const buy = D.propose(A, { domain: "procurement", actionType: "create_purchase_order", title: "Comprar tecidos", expectedImpact: 1000 });
  check("compra com banda `allow`: source bands · piso apertou (floorApplied) · humanOnly · 1 aprovação", buy.policy_snapshot.source === "bands" && buy.policy_snapshot.floorApplied === true && buy.policy_snapshot.humanOnly === true && buy.policy_snapshot.requiredApprovals === 1, JSON.stringify(buy.policy_snapshot));
  check("amount absoluto gravado", buy.policy_snapshot.amount === 1000);

  setPolicy(A, "sales", "send_campaign", { autonomy: "prepare" });
  const camp = D.propose(A, { domain: "sales", actionType: "send_campaign", title: "Campanha reativação", description: "Chamar clientes inativos há 60 dias.", expectedImpact: 4000, basis: "estimate", confidence: 0.85 });
  check("política da org: source agent_policy", camp.policy_snapshot.source === "agent_policy");

  // ── B) foto da época ──
  const before = JSON.stringify(camp.policy_snapshot);
  setPolicy(A, "sales", "send_campaign", { autonomy: "execute", mode: "autonomous", max: 99999 });
  P.setBands(A, "sales", "send_campaign", [{ upTo: null, state: "allow" }]);
  check("mudar a política depois NÃO altera a foto da época", JSON.stringify(D.get(A, camp.id).policy_snapshot) === before);
  const legacyId = randomUUID();
  db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, approval_policy, created_by, priority_score, correlation_id) VALUES (?, ?, 'sales', 'send_campaign', 'Legado', 'approved', 'none', 'rule', 1, ?)`).run(legacyId, A, randomUUID());
  check("ação anterior ao registro: policy_snapshot null (não inventa)", D.get(A, legacyId).policy_snapshot === null);
  const exLegacy = T.explain(A, legacyId)!;
  check("explain da legada diz que não há foto — e NÃO usa a política de hoje", exLegacy.policy.recorded === false && /não há foto do que valia na época/.test(exLegacy.policy.summary) && !/banda|autonom/i.test(exLegacy.policy.summary));

  // ── C) explain em evidência de negócio ──
  const sig = BS.publish(A, { domain: "inventory", signalType: "retail_store_stockout", severity: "risk", basis: "fact", confidence: 1, sourceService: "t", sourceEntityType: "retail_store", sourceEntityId: "s1", evidence: { store: "Carioca" }, dedupeKey: `why:${randomUUID()}` } as any);
  setPolicy(A, "inventory", "prepare_purchase", { autonomy: "suggest" });
  const withSig = D.propose(A, { signalId: sig.id, domain: "inventory", actionType: "prepare_purchase", title: "Preparar compra de camisetas", description: "Repor a grade que zerou.", expectedImpact: 2500, basis: "fact", confidence: 0.9 });
  const ex = T.explain(A, withSig.id)!;
  check("recomendação original + base (fato) + confiança em palavras", ex.recommendation.text === "Repor a grade que zerou." && ex.recommendation.basisLabel === "fato" && ex.recommendation.confidenceBand === "alta");
  check("sinal de origem em linguagem de negócio, sem identificador técnico", !!ex.evidence.signal?.title && !/retail_store_stockout|inventory|runtime|signal_type/.test(JSON.stringify(ex.lines)));
  check("política descrita: origem + aprovações + nível", /Regra aplicada/.test(ex.policy.summary) && /Nível de autonomia/.test(ex.policy.summary));
  check("ainda aguardando: 'Aguardando aprovação de 1 pessoa' + 'Não executei porque ainda aguarda aprovação'", /Aguardando aprovação de 1 pessoa/.test(ex.authorization.summary) && /ainda aguarda aprovação/.test(ex.notExecutedBecause || ""));
  const exBuy = T.explain(A, buy.id)!;
  check("compra: explica que o ZapFlow NUNCA aprova esse tipo sozinho e que a trava de segurança atuou", /NUNCA aprova sozinho/.test(exBuy.policy.summary) && /trava de segurança/.test(exBuy.policy.summary));

  // autorização por pessoa (nome) × automática
  D.approve(A, withSig.id, maria.userId, { reason: "ok, pode repor" });
  const exAp = T.explain(A, withSig.id)!;
  check("autorizada por PESSOA, com o nome", /Autorizada por Maria Souza/.test(exAp.authorization.summary) && exAp.authorization.byPerson === true && exAp.authorization.automatic === false);
  const exAuto = T.explain(A, task.id)!;
  check("ação 'none' → autorizada automaticamente dentro da política (ninguém precisou aprovar)", exAuto.authorization.automatic === true && /automaticamente/.test(exAuto.authorization.summary));
  const common = D.propose(A, { domain: "tasks", actionType: "collection", title: "Cobrança X" });
  D.approve(A, common.id, "runtime");
  const exRt = T.explain(A, common.id)!;
  check("aprovada só por rótulo de sistema → automática (não finge que foi pessoa)", exRt.authorization.automatic === true && exRt.authorization.byPerson === false);
  const rej = D.propose(A, { domain: "tasks", actionType: "prepare_campaign", title: "Campanha ruim" });
  D.reject(A, rej.id, maria.userId, { reason: "desconto demais" });
  check("rejeitada: quem e por quê", /Rejeitada por Maria Souza.*desconto demais/.test(T.explain(A, rej.id)!.authorization.summary));

  // execução: "não executei porque…" e sucesso
  X.registerHandler({ key: "WhyHandler", commandTypes: ["why_cmd"], prepare: (_o, a) => ({ summary: a.title, artifact: {} }), execute: async (_o, a) => ({ summary: a.title, artifact: {}, effect: "ok", externalRef: "r1" }) });
  const noPol = D.propose(A, { domain: "ops", actionType: "why_type", title: "Sem política", commandType: "why_cmd" });
  D.approve(A, noPol.id, maria.userId);
  await X.execute(A, noPol.id).then(() => null, () => null);
  const exNoPol = T.explain(A, noPol.id)!;
  check("recusa do executor em palavras de negócio: 'Não executei porque … política ativa'", /Não executei porque .*política ativa/.test(exNoPol.notExecutedBecause || "") && exNoPol.execution.lastRefusal?.errorCode === "policy_missing");
  const legBuy = randomUUID();
  db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, approval_policy, created_by, priority_score, command_type, correlation_id) VALUES (?, ?, 'procurement', 'create_purchase_order', 'Legado compra', 'approved', 'none', 'rule', 1, 'why_cmd', ?)`).run(legBuy, A, randomUUID());
  setPolicy(A, "procurement", "create_purchase_order", { autonomy: "execute", mode: "approved_execution" });
  await X.execute(A, legBuy).then(() => null, () => null);
  check("piso recusou: 'Não executei porque … nunca executa sem a aprovação de uma pessoa'", /nunca executa sem a aprovação de uma pessoa/.test(T.explain(A, legBuy)!.notExecutedBecause || ""));
  setPolicy(A, "ops", "why_ok", { autonomy: "execute", mode: "approved_execution" });
  const okAct = D.propose(A, { domain: "ops", actionType: "why_ok", title: "Executa", commandType: "why_cmd", expectedImpact: 700, basis: "estimate" });
  D.approve(A, okAct.id, maria.userId);
  await X.execute(A, okAct.id);
  D.complete(A, okAct.id, { resultAmount: 650 });
  const exOk = T.explain(A, okAct.id, { canSeeMoney: true })!;
  check("executada: 'Executada em …' e sem 'não executei'", exOk.execution.executed === true && /Executada/.test(exOk.lines.join(" ")) && exOk.notExecutedBecause === null);
  check("resultado medido: esperado × realizado (quem pode ver dinheiro)", exOk.outcome.measured === true && exOk.outcome.expected === 700 && exOk.outcome.realized === 650 && exOk.impact.expected === 700);

  // ── D) dinheiro role-gated ──
  const exGated = T.explain(A, okAct.id, { canSeeMoney: false })!;
  check("sem visão ampla: impacto e resultado em null + restricted (o fato permanece)", exGated.impact.expected === null && exGated.impact.restricted === true && exGated.outcome.measured === true && exGated.outcome.expected === null && exGated.outcome.realized === null && exGated.outcome.restricted === true);
  check("…e o texto não vaza os valores", !/700|650/.test(exGated.lines.join(" ")) && /reservados ao gestor/.test(exGated.lines.join(" ")));

  // ── E) isolamento + rota ──
  check("isolamento: outra org não explica a ação (null)", T.explain(B, withSig.id) === null && T.explain(A, "inexistente") === null);
  const express = (await import("express")).default;
  const router = (await import("../src/server/routes/actions.js")).default;
  const app = express();
  const who: Record<string, any> = { maria, joao };
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-org"] || undefined; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/actions", router);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const get = (p: string, user: string, org: string | null = A) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { ...(org ? { "x-org": org } : {}), "x-user": user } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const rOwner = await get(`/api/actions/${okAct.id}/why`, "maria");
  check("GET /:id/why (dono): 200 com a história e os valores", rOwner.status === 200 && rOwner.body.impact.expected === 700 && Array.isArray(rOwner.body.lines) && rOwner.body.lines.length >= 4);
  const salesAct = D.propose(A, { domain: "sales", actionType: "prepare_campaign", title: "Campanha vendas", expectedImpact: 1200 });
  const rSales = await get(`/api/actions/${salesAct.id}/why`, "joao");
  check("vendedor vê ação do domínio dele, MAS sem dinheiro (restricted)", rSales.status === 200 && rSales.body.impact.expected === null && rSales.body.impact.restricted === true, JSON.stringify(rSales.body)?.slice(0, 160));
  const finAct = D.propose(A, { domain: "finance", actionType: "collection", title: "Cobrança financeira", expectedImpact: 900 });
  check("domínio invisível ao papel → 404 (não vaza existência)", (await get(`/api/actions/${finAct.id}/why`, "joao")).status === 404);
  check("ação de OUTRA org → 404", (await get(`/api/actions/${okAct.id}/why`, "maria", B)).status === 404);
  check("sem organização → 401", (await get(`/api/actions/${okAct.id}/why`, "maria", null)).status === 401);
  await new Promise<void>((r) => server.close(() => r()));

  // ── F) trace traz o snapshot ──
  const tr = T.trace(A, withSig.correlation_id);
  check("trace por correlationId: a ação traz policy_snapshot parseado", tr.actions.length >= 1 && tr.actions[0].policy_snapshot?.version === 1);

  console.log("\n=== ADR-204 F3.1b: snapshot da política + 'por que o ZapFlow fez isso?' ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} action-why: ${results.length - failures}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } process.exit(1); });
