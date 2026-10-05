/**
 * TESTE — ADR-204 F3.1a: PISO DE AUTONOMIA (RN-F3-2) + mapa derivado de níveis 0–4 (RN-F3-1).
 * ----------------------------------------------------------------------------
 * A lista "sempre exige aprovação humana" do PRD Fase 3 §4 era só advisória (`enforced:false`) e o
 * `dispatchGoverned` auto-aprova. Prova, nos serviços REAIS:
 *   A) a lista cobre cada categoria do §4 e NÃO pega cobrança/mensagem/rascunho/refund (0-regressão);
 *   B) propose: tipo do piso nunca nasce aprovado — nem com banda `allow`, política 'none' ou teto de
 *      automação; o contrato continua podendo ENDURECER (deny lança);
 *   C) approve: rótulo de sistema ("runtime"/"rule"/"ai"/vazio) NÃO aprova tipo do piso; pessoa aprova;
 *      tipo comum segue aprovável por qualquer ator (0-regressão);
 *   D) execute: tipo do piso só executa com aprovação humana REGISTRADA (legado aprovado sem pessoa é
 *      recusado e AUDITADO com error_code `human_approval_missing`); tipo comum inalterado;
 *   E) dispatchGoverned recusa tipo do piso (sem criar ação nem semear política) e segue valendo p/ mensagem;
 *   F) autonomyLevel: mapa 0–4 derivado; `autonomous` ≠ nível 4; piso trava em ≤ 2; isolado por org;
 *   G) rotas GET /autonomy-floor e /autonomy-level.
 *
 * Uso:  npm run test:autonomy-floor
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-autonomy-floor-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-autonomy-floor-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const throws = (fn: () => any) => { try { fn(); return false; } catch { return true; } };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ApprovalPolicyService: P } = await import("../src/server/ApprovalPolicyService.js");
  const { DecisionActionService: D } = await import("../src/server/DecisionActionService.js");
  const { CommandExecutorService: X } = await import("../src/server/CommandExecutorService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const A = mkOrg(), B = mkOrg();
  const setPolicy = (orgId: string, domain: string, actionType: string, o: { autonomy?: string; mode?: string; max?: number | null; bands?: any[] }) => {
    const cur = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?`).get(orgId, domain, actionType) as any;
    if (cur) {
      db.prepare(`UPDATE agent_policies SET autonomy_level = ?, execution_mode = ?, max_auto_amount = ?, active = 1 WHERE id = ?`).run(o.autonomy || "suggest", o.mode || "assisted", o.max ?? null, cur.id);
      if (o.bands) db.prepare(`UPDATE agent_policies SET config_json = ? WHERE id = ?`).run(JSON.stringify({ bands: o.bands }), cur.id);
    } else {
      db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, max_auto_amount, config_json, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
        .run(randomUUID(), orgId, domain, actionType, o.autonomy || "suggest", o.mode || "assisted", o.max ?? null, o.bands ? JSON.stringify({ bands: o.bands }) : null);
    }
  };

  // ── A) a lista ──
  const human = P.humanOnlyTypes();
  const cats: Record<string, string[]> = {
    compras: ["create_purchase_order", "choose_supplier"], pagamentos: ["issue_payment", "pay_bill"], "transferência de dinheiro": ["transfer_funds", "pix_transfer"],
    "contratação/demissão": ["hire", "dismiss"], "alteração salarial": ["change_salary"], "comissão consolidada": ["consolidate_commission", "pay_commission"],
    "desconto relevante": ["grant_large_discount"], "preço em massa": ["bulk_price_change", "change_price"], empréstimo: ["take_loan"],
    "compromisso contratual": ["sign_contract"], "comunicação jurídica": ["send_legal_notice"],
  };
  for (const [cat, types] of Object.entries(cats)) check(`piso cobre ${cat} (${types.join(", ")})`, types.every((t) => P.isHumanOnly(t)));
  check("lista pública é ordenada e sem duplicata", human.length === new Set(human).size && [...human].sort().join() === human.join());
  const free = ["collection", "collection_followup", "collection_resend_pix", "prepare_purchase", "send_quote_request", "create_task", "retail_transfer", "refund", "asaas_pix_charge", "social_publish", "sales_recovery_send", "prospect_outreach_whatsapp"];
  check("NÃO pega cobrança/mensagem/rascunho/transferência de ESTOQUE/refund (0-regressão)", free.every((t) => !P.isHumanOnly(t)), free.filter((t) => P.isHumanOnly(t)).join());
  check("é por TIPO, não por domínio: `finance`+collection continua livre", !P.isHumanOnly("collection") && P.isFinancialOrDestructive("finance", "collection"));
  check("isHumanOnly tolera vazio/nulo", !P.isHumanOnly(null) && !P.isHumanOnly(undefined) && !P.isHumanOnly(""));

  // ── B) propose ──
  const naive = D.propose(A, { domain: "procurement", actionType: "create_purchase_order", title: "Compra", expectedImpact: 100 });
  check("sem bandas: compra segue exigindo aprovação (two_step da matriz)", naive.status === "awaiting_approval" && naive.approval_policy === "two_step");
  P.setBands(A, "procurement", "create_purchase_order", [{ upTo: 2000, state: "allow" }, { upTo: null, state: "deny" }]);
  const bandAllow = D.propose(A, { domain: "procurement", actionType: "create_purchase_order", title: "Compra pequena", expectedImpact: 1000 });
  check("banda `allow` NÃO auto-aprova compra: nasce awaiting_approval (piso)", bandAllow.status === "awaiting_approval" && bandAllow.approval_policy !== "none", `${bandAllow.status}/${bandAllow.approval_policy}`);
  check("o contrato ainda endurece: banda `deny` acima de 2000 lança", throws(() => D.propose(A, { domain: "procurement", actionType: "create_purchase_order", title: "Compra grande", expectedImpact: 9000 })));
  setPolicy(A, "hr", "change_salary", { autonomy: "execute", mode: "autonomous", max: 1_000_000 });
  const sal = D.propose(A, { domain: "hr", actionType: "change_salary", title: "Reajuste", expectedImpact: 50 });
  check("política `execute/autonomous` + teto alto NÃO libera salário: awaiting_approval", sal.status === "awaiting_approval" && sal.approval_policy !== "none", `${sal.status}/${sal.approval_policy}`);
  const price = D.propose(A, { domain: "sales", actionType: "change_price", title: "Preço" });
  check("change_price segue exigindo o dono (papel owner preservado)", price.status === "awaiting_approval" && price.approval_role === "owner");
  const task = D.propose(A, { domain: "tasks", actionType: "create_task", title: "T" });
  check("tarefa interna segue 'none' → aprovada (0-regressão)", task.status === "approved" && task.approval_policy === "none");
  P.setBands(A, "finance", "refund", [{ upTo: 500, state: "allow" }, { upTo: null, state: "deny" }]);
  check("refund com banda do dono segue auto-aprovando (decisão D8 em aberto, ADR-159 preservado)", D.propose(A, { domain: "finance", actionType: "refund", title: "Estorno", expectedImpact: 100 }).status === "approved");

  // ── C) approve ──
  const sys = ["runtime", "rule", "ai", "system", "scheduler", "agent:cobranca", "mission-runner", "", "   "];
  const r1 = D.propose(A, { domain: "procurement", actionType: "choose_supplier", title: "Fornecedor" });
  for (const s of sys) if (s.trim()) check(`approve por rótulo de sistema "${s}" é RECUSADO no piso`, throws(() => D.approve(A, r1.id, s)));
  check("approve sem identidade segue lançando (ADR-159 D2)", throws(() => D.approve(A, r1.id, undefined)));
  check("…e a ação continua aguardando (nada aprovou)", D.get(A, r1.id).status === "awaiting_approval" && D.get(A, r1.id).approvals.length === 0);
  D.approve(A, r1.id, "user-1");
  check("two_step: 1 pessoa não basta; a 2ª DISTINTA aprova", D.get(A, r1.id).status === "awaiting_approval" && D.approve(A, r1.id, "user-2").status === "approved");
  const commonA = D.propose(A, { domain: "x", actionType: "collection", title: "Cobrança" });
  check("tipo comum: rótulo 'runtime' ainda aprova (0-regressão)", D.approve(A, commonA.id, "runtime").status === "approved");

  // ── D) execute ──
  let effects = 0;
  X.registerHandler({
    key: "FloorTestHandler", commandTypes: ["floor_test_cmd"],
    prepare: (_o, a) => ({ summary: `prep ${a.title}`, artifact: { kind: "draft" } }),
    execute: async (_o, a) => { effects++; return { summary: `ok ${a.title}`, artifact: { kind: "done" }, effect: "floor_test", externalRef: "ref-1" }; },
  });
  setPolicy(A, "procurement", "create_purchase_order", { autonomy: "execute", mode: "approved_execution" });
  setPolicy(A, "procurement", "choose_supplier", { autonomy: "execute", mode: "approved_execution" });
  const okAct = D.propose(A, { domain: "procurement", actionType: "choose_supplier", title: "Escolha", commandType: "floor_test_cmd" });
  D.approve(A, okAct.id, "user-1"); D.approve(A, okAct.id, "user-2");
  const rOk = await X.execute(A, okAct.id);
  check("restrita + aprovada por PESSOAS → executa", rOk.ok === true && effects === 1);
  // legado: aprovada sem nenhuma pessoa (política 'none' antiga)
  const legId = randomUUID();
  db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, approval_policy, created_by, priority_score, command_type, correlation_id) VALUES (?, ?, 'procurement', 'create_purchase_order', 'Legado', 'approved', 'none', 'rule', 1, 'floor_test_cmd', ?)`).run(legId, A, randomUUID());
  let legMsg = "";
  try { await X.execute(A, legId); } catch (e: any) { legMsg = String(e?.message || e); }
  check("restrita 'approved' SEM pessoa (legado) → recusada, não executa", /sem aprovação de uma pessoa/.test(legMsg) && effects === 1, legMsg);
  const legLog = db.prepare(`SELECT error_code FROM action_execution_log WHERE action_id = ? AND organization_id = ?`).get(legId, A) as any;
  check("…e a recusa é AUDITADA (error_code human_approval_missing)", legLog?.error_code === "human_approval_missing");
  const sysId = randomUUID();
  db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, approval_policy, created_by, priority_score, command_type, correlation_id) VALUES (?, ?, 'procurement', 'create_purchase_order', 'Sistema', 'approved', 'single', 'rule', 1, 'floor_test_cmd', ?)`).run(sysId, A, randomUUID());
  db.prepare(`INSERT INTO action_approvals (id, organization_id, action_id, approver_user_id, decision) VALUES (?, ?, ?, 'runtime', 'approved')`).run(randomUUID(), A, sysId);
  check("restrita aprovada só por rótulo de sistema (inserção direta) → recusada", await X.execute(A, sysId).then(() => false, () => true) && effects === 1);
  setPolicy(A, "tasks", "floor_common", { autonomy: "execute", mode: "approved_execution" });
  const common = D.propose(A, { domain: "tasks", actionType: "floor_common", title: "Comum", commandType: "floor_test_cmd" });
  D.approve(A, common.id, "runtime");
  check("tipo comum aprovado por 'runtime' executa como sempre (0-regressão)", (await X.execute(A, common.id)).ok === true && effects === 2);

  // ── E) dispatchGoverned ──
  const before = (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id = ?`).get(A) as any).n;
  const polBefore = (db.prepare(`SELECT COUNT(*) n FROM agent_policies WHERE organization_id = ?`).get(A) as any).n;
  let dmsg = "";
  try { await X.dispatchGoverned(A, { domain: "finance", actionType: "pay_supplier", title: "Pagar", commandType: "floor_test_cmd", commandPayload: {} }); } catch (e: any) { dmsg = String(e?.message || e); }
  check("dispatchGoverned RECUSA tipo do piso", /exige aprovação de uma pessoa/.test(dmsg), dmsg);
  check("…sem criar ação, sem semear política e sem efeito", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id = ?`).get(A) as any).n === before
    && (db.prepare(`SELECT COUNT(*) n FROM agent_policies WHERE organization_id = ?`).get(A) as any).n === polBefore && effects === 2);
  const ref = await X.dispatchGoverned(A, { domain: "finance", actionType: "collection_followup", title: "Cobrança", commandType: "floor_test_cmd", commandPayload: {} });
  check("dispatchGoverned segue valendo p/ mensagem/cobrança (domínio finance, 0-regressão)", ref === "ref-1" && effects === 3);

  // ── F) mapa de níveis ──
  const L = (o: string, d: string, t: string) => P.autonomyLevel(o, { domain: d, actionType: t });
  check("sem política → nível 1 (recomendar)", L(B, "x", "create_task").level === 1);
  setPolicy(B, "x", "t_observe", { autonomy: "observe" }); setPolicy(B, "x", "t_suggest", { autonomy: "suggest" }); setPolicy(B, "x", "t_prepare", { autonomy: "prepare" });
  check("observe → 0 · suggest → 1 · prepare → 2", L(B, "x", "t_observe").level === 0 && L(B, "x", "t_suggest").level === 1 && L(B, "x", "t_prepare").level === 2);
  setPolicy(B, "x", "t_exec_assisted", { autonomy: "execute", mode: "assisted" });
  check("execute + assisted (efeito bloqueado) → 2 (prepara e aguarda)", L(B, "x", "t_exec_assisted").level === 2);
  setPolicy(B, "x", "t_exec_manual", { autonomy: "execute", mode: "approved_execution" });
  check("execute + approved_execution SEM limite pré-autorizado → 2 (pessoa aprova)", L(B, "x", "t_exec_manual").level === 2);
  setPolicy(B, "x", "t_exec_limit", { autonomy: "execute", mode: "approved_execution", max: 500 });
  check("execute + approved_execution + limite do dono → 3", L(B, "x", "t_exec_limit").level === 3);
  setPolicy(B, "x", "t_exec_band", { autonomy: "execute", mode: "approved_execution", bands: [{ upTo: 100, state: "allow" }, { upTo: null, state: "require_approval", role: "owner" }] });
  check("…ou banda `allow` do dono → 3", L(B, "x", "t_exec_band").level === 3);
  setPolicy(B, "x", "t_auto", { autonomy: "execute", mode: "autonomous", max: 500 });
  const lvAuto = L(B, "x", "t_auto");
  check("`autonomous` NÃO vira nível 4: 3 + level4Blocked (D1)", lvAuto.level === 3 && lvAuto.level4Blocked === true);
  setPolicy(B, "procurement", "create_purchase_order", { autonomy: "execute", mode: "autonomous", max: 999999 });
  const lvBuy = L(B, "procurement", "create_purchase_order");
  check("tipo do piso fica TRAVADO em ≤ 2 mesmo com execute/autonomous/teto", lvBuy.level <= 2 && lvBuy.humanOnly && lvBuy.capped, JSON.stringify(lvBuy));
  check("isolamento: a política da org B não vaza p/ A", L(A, "x", "t_exec_limit").level === 1);
  check("todo nível traz o porquê em linguagem de negócio", [lvAuto, lvBuy, L(B, "x", "t_observe")].every((l) => typeof l.reason === "string" && l.reason.length > 10));

  // ── G) rotas ──
  const express = (await import("express")).default;
  const router = (await import("../src/server/routes/actions.js")).default;
  const app = express();
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-org"]; req.user = { userId: "u1" }; next(); });
  app.use("/api/actions", router);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const get = (p: string, org: string | null = B) => fetch(`http://127.0.0.1:${port}${p}`, { headers: org ? { "x-org": org } : {} }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const f = await get("/api/actions/autonomy-floor");
  check("GET /autonomy-floor: lista do piso + 5 níveis, o 4 desabilitado", f.status === 200 && f.body.humanOnly.includes("create_purchase_order") && f.body.levels.length === 5 && f.body.levels[4].enabled === false);
  const lv = await get("/api/actions/autonomy-level?domain=procurement&actionType=create_purchase_order");
  check("GET /autonomy-level: devolve nível derivado + humanOnly", lv.status === 200 && lv.body.humanOnly === true && lv.body.level <= 2);
  check("GET /autonomy-level sem parâmetros → 400", (await get("/api/actions/autonomy-level")).status === 400);
  check("rotas exigem organização (401)", (await get("/api/actions/autonomy-floor", null)).status === 401);
  await new Promise<void>((r) => server.close(() => r()));

  console.log("\n=== ADR-204 F3.1a: piso de autonomia + níveis 0–4 ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} autonomy-floor: ${results.length - failures}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } process.exit(1); });
