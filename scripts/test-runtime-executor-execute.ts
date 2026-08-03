/**
 * TEST — ADR-152 Fatia 2.2: modo `execute` governado no CommandExecutorService.
 *
 * Foca nos GUARDAS (autonomy=execute + execution_mode≥approved_execution +
 * policy=approved), NÃO no efeito externo — nesta fatia handlers rodam NO-OP
 * (a 2.3 sobe efeito real com ConfirmationEngine.expect). Cada rejeição
 * escreve uma linha AUDITADA em action_execution_log com error_code
 * explícito — a Fase 3 vai listar isso na aba Operações.
 *
 * Cobertura: os 3 guardas; ordem correta de recusa; auditoria com
 * error_code por causa; retrocompat (execute sem política ativa é 400 —
 * "assisted" default protege orgs existentes); idempotência (ação já
 * done/cancelled → 400 sem re-executar); isolamento cross-tenant;
 * prepare continua funcionando (regressão da C5); action_execution_log
 * separa mode=prepare de mode=execute.
 *
 * Determinístico. Uso: npm run test:runtime-executor-execute
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-runtime-exec-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-runtime-exec-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { CommandExecutorService } = await import("../src/server/CommandExecutorService.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();
  const orgB = mkOrg();

  const setPolicy = (orgId: string, domain: string, actionType: string, opts: { autonomy?: string; mode?: string; active?: 0 | 1 }) => {
    const cur = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?`).get(orgId, domain, actionType) as any;
    if (cur) {
      db.prepare(`UPDATE agent_policies SET autonomy_level = COALESCE(?, autonomy_level), execution_mode = COALESCE(?, execution_mode), active = COALESCE(?, active) WHERE id = ?`)
        .run(opts.autonomy || null, opts.mode || null, opts.active ?? null, cur.id);
    } else {
      db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), orgId, domain, actionType, opts.autonomy || "suggest", opts.mode || "assisted", opts.active ?? 1);
    }
  };

  const mkApprovedAction = (orgId: string) => {
    // collection = single approval (matriz padrão). Approve pra ficar 'approved'.
    const a = DecisionActionService.propose(orgId, { domain: "finance", actionType: "collection", title: "Cobrar 1000", expectedImpact: 1000, commandType: "collection" });
    DecisionActionService.approve(orgId, a.id, "u-approver");
    return a.id;
  };
  const errorCodeOfLast = (orgId: string, actionId: string): string | null => {
    const r = db.prepare(`SELECT error_code FROM action_execution_log WHERE organization_id = ? AND action_id = ? AND mode = 'execute' ORDER BY started_at DESC LIMIT 1`).get(orgId, actionId) as any;
    return r?.error_code || null;
  };
  const logsCount = (orgId: string, actionId: string, mode: string) => (db.prepare(`SELECT COUNT(*) c FROM action_execution_log WHERE organization_id = ? AND action_id = ? AND mode = ?`).get(orgId, actionId, mode) as any).c;

  // ===== 1. Sem política ativa → policy_missing =====
  const a1 = mkApprovedAction(orgA);
  let threw = false;
  try { await CommandExecutorService.execute(orgA, a1); } catch { threw = true; }
  check("execute sem política ativa recusa (policy_missing)", threw && errorCodeOfLast(orgA, a1) === "policy_missing");

  // ===== 2. Política inativa também recusa =====
  const a2 = mkApprovedAction(orgA);
  setPolicy(orgA, "finance", "collection", { autonomy: "execute", mode: "approved_execution", active: 0 });
  threw = false;
  try { await CommandExecutorService.execute(orgA, a2); } catch { threw = true; }
  check("execute com política inativa recusa (policy_missing)", threw && errorCodeOfLast(orgA, a2) === "policy_missing");

  // ===== 3. autonomy_level != 'execute' → autonomy_below_execute =====
  setPolicy(orgA, "finance", "collection", { autonomy: "prepare", mode: "approved_execution", active: 1 });
  const a3 = mkApprovedAction(orgA);
  threw = false;
  try { await CommandExecutorService.execute(orgA, a3); } catch { threw = true; }
  check("autonomy=prepare bloqueia execute (autonomy_below_execute)", threw && errorCodeOfLast(orgA, a3) === "autonomy_below_execute");

  // ===== 4. execution_mode='assisted' (default) bloqueia efeito externo =====
  setPolicy(orgA, "finance", "collection", { autonomy: "execute", mode: "assisted", active: 1 });
  const a4 = mkApprovedAction(orgA);
  threw = false;
  try { await CommandExecutorService.execute(orgA, a4); } catch { threw = true; }
  check("execution_mode=assisted (default) bloqueia efeito (execution_mode_blocked)", threw && errorCodeOfLast(orgA, a4) === "execution_mode_blocked");

  // ===== 5. execution_mode='shadow' também bloqueia =====
  setPolicy(orgA, "finance", "collection", { autonomy: "execute", mode: "shadow", active: 1 });
  const a5 = mkApprovedAction(orgA);
  threw = false;
  try { await CommandExecutorService.execute(orgA, a5); } catch { threw = true; }
  check("execution_mode=shadow bloqueia efeito (execution_mode_blocked)", threw && errorCodeOfLast(orgA, a5) === "execution_mode_blocked");

  // ===== 6. Guardas satisfeitas: approved_execution roda o handler (noop-2.2) =====
  setPolicy(orgA, "finance", "collection", { autonomy: "execute", mode: "approved_execution", active: 1 });
  const a6 = mkApprovedAction(orgA);
  const r6 = await CommandExecutorService.execute(orgA, a6);
  check("guardas ok em approved_execution → executa", r6.ok === true && r6.mode === "execute" && r6.executionMode === "approved_execution");
  check("handler retorna NO-OP com effect='noop-2.2'", r6.result?.effect === "noop-2.2" && r6.result?.artifact?.kind === "collection_draft");
  check("ação recebe executed_at", !!(DecisionActionService.get(orgA, a6) as any).executed_at);
  check("action_execution_log escrito com mode=execute + status=done", logsCount(orgA, a6, "execute") === 1);
  const doneRow = db.prepare(`SELECT status, response_json FROM action_execution_log WHERE organization_id = ? AND action_id = ? AND mode = 'execute'`).get(orgA, a6) as any;
  check("log 'done' com response_json populado", doneRow?.status === "done" && !!doneRow?.response_json);

  // ===== 7. autonomous também executa =====
  setPolicy(orgA, "finance", "collection", { autonomy: "execute", mode: "autonomous", active: 1 });
  const a7 = mkApprovedAction(orgA);
  const r7 = await CommandExecutorService.execute(orgA, a7);
  check("autonomous também executa", r7.ok === true && r7.executionMode === "autonomous");

  // ===== 8. G3 — ação não aprovada (awaiting_approval) recusa =====
  setPolicy(orgA, "finance", "collection", { autonomy: "execute", mode: "approved_execution", active: 1 });
  const a8 = DecisionActionService.propose(orgA, { domain: "finance", actionType: "collection", title: "Cobrar", expectedImpact: 500, commandType: "collection" });
  threw = false;
  try { await CommandExecutorService.execute(orgA, a8.id); } catch { threw = true; }
  check("ação awaiting_approval recusada (action_not_approved)", threw && errorCodeOfLast(orgA, a8.id) === "action_not_approved");

  // ===== 9. G3 idempotência — ação já 'done' não re-executa =====
  const a9 = mkApprovedAction(orgA);
  DecisionActionService.complete(orgA, a9, { resultAmount: 500 });
  threw = false;
  try { await CommandExecutorService.execute(orgA, a9); } catch { threw = true; }
  check("ação já 'done' recusada como terminal (action_terminal)", threw && errorCodeOfLast(orgA, a9) === "action_terminal");

  // ===== 10. Ação cancelled também recusa como terminal =====
  const a10 = mkApprovedAction(orgA);
  DecisionActionService.cancel(orgA, a10);
  threw = false;
  try { await CommandExecutorService.execute(orgA, a10); } catch { threw = true; }
  check("ação cancelled recusada como terminal", threw && errorCodeOfLast(orgA, a10) === "action_terminal");

  // ===== 11. Sem command_type registrado no handler → no_handler =====
  const a11 = DecisionActionService.propose(orgA, { domain: "finance", actionType: "collection", title: "X", expectedImpact: 100, commandType: "inventado_qualquer" });
  DecisionActionService.approve(orgA, a11.id, "u-approver");
  threw = false;
  try { await CommandExecutorService.execute(orgA, a11.id); } catch { threw = true; }
  check("commandType desconhecido → no_handler (auditado antes das guardas de política)", threw && errorCodeOfLast(orgA, a11.id) === "no_handler");

  // ===== 12. Ordem correta: ação não aprovada tem precedência sobre falta de política =====
  // (Se ação está awaiting_approval, retornamos action_not_approved mesmo sem policy — falha estrutural primeiro).
  const orgC = mkOrg();
  const a12 = DecisionActionService.propose(orgC, { domain: "finance", actionType: "collection", title: "Y", expectedImpact: 100, commandType: "collection" });
  // Sem policy na orgC, sem approve
  threw = false;
  try { await CommandExecutorService.execute(orgC, a12.id); } catch { threw = true; }
  check("ação não aprovada sempre recusa primeiro (mesmo sem policy)", threw && errorCodeOfLast(orgC, a12.id) === "action_not_approved");

  // ===== 13. Isolamento cross-tenant =====
  setPolicy(orgA, "finance", "collection", { autonomy: "execute", mode: "approved_execution", active: 1 });
  const a13 = mkApprovedAction(orgA);
  threw = false;
  try { await CommandExecutorService.execute(orgB, a13); } catch { threw = true; }
  check("orgB não executa ação de orgA", threw);

  // ===== 14. Regressão: prepare continua funcionando (não regride C5) =====
  const a14 = mkApprovedAction(orgA);
  const prepared = CommandExecutorService.prepare(orgA, a14);
  check("prepare continua funcionando após F2.2", prepared.ok === true && prepared.mode === "prepare" && prepared.result?.artifact?.kind === "collection_draft");
  check("prepare NÃO exige autonomy=execute (comportamento C5 preserva)", logsCount(orgA, a14, "prepare") === 1);
  const modes = db.prepare(`SELECT DISTINCT mode FROM action_execution_log WHERE organization_id = ? ORDER BY mode`).all(orgA) as any[];
  check("action_execution_log separa mode='prepare' de mode='execute'", modes.length === 2 && modes.map(m => m.mode).join(",") === "execute,prepare");

  // ===== 15. registerHandler permite plugar handler custom em runtime (a 2.3 usa) =====
  let externalCalled = 0;
  CommandExecutorService.registerHandler({
    key: "TestSendHandler", commandTypes: ["test_send_msg"],
    prepare: (_o, a) => ({ summary: `Mensagem preparada: ${a.title}`, artifact: { kind: "msg_draft" } }),
    execute: async (_o, a) => { externalCalled++; return { summary: `Mensagem enviada: ${a.title}`, artifact: { kind: "msg_sent", externalRef: "msg-abc-123" }, effect: "sent_msg", externalRef: "msg-abc-123" }; },
  });
  setPolicy(orgA, "test", "send_msg", { autonomy: "execute", mode: "approved_execution", active: 1 });
  const a15 = DecisionActionService.propose(orgA, { domain: "test", actionType: "send_msg", title: "Oi", commandType: "test_send_msg" });
  DecisionActionService.approve(orgA, a15.id, "u-approver");
  const r15 = await CommandExecutorService.execute(orgA, a15.id);
  check("handler custom com execute próprio é chamado", externalCalled === 1 && r15.result?.effect === "sent_msg");
  check("externalRef é propagado no result", r15.result?.externalRef === "msg-abc-123");

  // ===== Resultado =====
  console.log("\n=== ADR-152 Fatia 2.2 (execute governado no CommandExecutorService) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
