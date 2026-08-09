/**
 * TEST — ADR-159 F2 (D1): endurecimento do choke-point de execução externa.
 *
 * Foca nos dois furos concretos do CommandExecutorService como PONTO ÚNICO:
 *   (1) IDEMPOTÊNCIA REAL do efeito externo — no sucesso o execute grava
 *       `executed_at` mas mantém status 'approved' (e `executed_at` também é
 *       setado pelo prepare), então NENHUM dos dois trava um 2º execute. Antes,
 *       reexecutar DUPLICAVA o efeito (2 PIX/2 WhatsApp). Agora um execute já
 *       concluído com sucesso (mode='execute' status='done') bloqueia o reprocesso
 *       (`action_already_executed`); retry pós-FALHA segue liberado; prepare não
 *       bloqueia.
 *   (2) RN-159-3 — toda tentativa (execute/prepare/rejeição) auditada COM
 *       `correlation_id` (fio do ciclo ADR-158) no `action_execution_log`.
 *
 * Determinístico. Uso: npm run test:choke-point-hardening
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-choke-point-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-choke-point-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { CommandExecutorService: X } = await import("../src/server/CommandExecutorService.js");
  const { DecisionActionService: D } = await import("../src/server/DecisionActionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const setPolicy = (orgId: string, domain: string, actionType: string, opts: { autonomy?: string; mode?: string; active?: 0 | 1 } = {}) =>
    db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), orgId, domain, actionType, opts.autonomy || "execute", opts.mode || "approved_execution", opts.active ?? 1);
  // ORDER BY attempt DESC (não started_at — granularidade de segundo colide a
  // linha 'done' com a rejeição do mesmo segundo). O attempt é monotônico por ação.
  const lastExecLog = (orgId: string, actionId: string) => db.prepare(`SELECT status, error_code, correlation_id FROM action_execution_log WHERE organization_id = ? AND action_id = ? AND mode = 'execute' ORDER BY attempt DESC LIMIT 1`).get(orgId, actionId) as any;
  const doneExecLog = (orgId: string, actionId: string) => db.prepare(`SELECT correlation_id FROM action_execution_log WHERE organization_id = ? AND action_id = ? AND mode = 'execute' AND status = 'done' LIMIT 1`).get(orgId, actionId) as any;

  // Handler governado de teste: conta efeitos e pode falhar UMA vez (simula timeout).
  let sendCount = 0;
  let failNext = false;
  X.registerHandler({
    key: "TestGovernedSend", commandTypes: ["test_governed_send"],
    prepare: (_o: string, a: any) => ({ artifact: { kind: "draft" }, summary: a.title }),
    execute: async (_o: string, a: any) => { if (failNext) { failNext = false; throw new Error("provider timeout"); } sendCount++; return { summary: `Enviado: ${a.title}`, artifact: { kind: "msg_sent", externalRef: `ref-${sendCount}` }, effect: "sent", externalRef: `ref-${sendCount}` }; },
  });

  const orgA = mkOrg();
  setPolicy(orgA, "test", "gov_send");
  const mkAction = (orgId: string) => { const a = D.propose(orgId, { domain: "test", actionType: "gov_send", title: "Enviar", commandType: "test_governed_send" }); D.approve(orgId, a.id, "u-approver"); return a.id; };

  // ===== 1. Execute governado roda o handler + grava correlationId no log 'done' =====
  const id1 = mkAction(orgA);
  const corr1 = (D.get(orgA, id1) as any).correlation_id;
  const r1 = await X.execute(orgA, id1);
  check("execute ok, handler chamado 1×", r1.ok === true && sendCount === 1);
  check("ação tem correlation_id (fio ADR-158)", !!corr1);
  check("RN-159-3: log 'done' de execute carrega o correlationId da ação", doneExecLog(orgA, id1)?.correlation_id === corr1);

  // ===== 2. IDEMPOTÊNCIA: 2º execute é recusado, handler NÃO re-chamado =====
  let threw = false;
  try { await X.execute(orgA, id1); } catch { threw = true; }
  check("2º execute recusado (action_already_executed)", threw && lastExecLog(orgA, id1)?.error_code === "action_already_executed");
  check("efeito NÃO duplicado (handler segue em 1 chamada)", sendCount === 1);
  check("recusa idempotente também carrega correlationId", lastExecLog(orgA, id1)?.correlation_id === corr1);

  // ===== 3. Retry pós-FALHA é permitido (idempotência só trava SUCESSO) =====
  const id2 = mkAction(orgA);
  failNext = true;
  const before2 = sendCount;
  threw = false;
  try { await X.execute(orgA, id2); } catch { threw = true; }
  check("execute que falha audita handler_error", threw && lastExecLog(orgA, id2)?.error_code === "handler_error");
  check("falha NÃO incrementa efeito", sendCount === before2);
  const r2b = await X.execute(orgA, id2); // sem 'done' anterior → retry roda
  check("retry após falha roda o handler (não bloqueado)", r2b.ok === true && sendCount === before2 + 1);
  const r2c_threw = await (async () => { try { await X.execute(orgA, id2); return false; } catch { return true; } })();
  check("após o retry bem-sucedido, novo execute vira idempotente", r2c_threw && lastExecLog(orgA, id2)?.error_code === "action_already_executed");

  // ===== 4. prepare NÃO bloqueia execute (executed_at sobrecarregado não trava) =====
  const id3 = mkAction(orgA);
  X.prepare(orgA, id3);
  const before3 = sendCount;
  const r3 = await X.execute(orgA, id3);
  check("prepare antes não bloqueia o execute", r3.ok === true && sendCount === before3 + 1);
  const prepLog = db.prepare(`SELECT correlation_id FROM action_execution_log WHERE organization_id = ? AND action_id = ? AND mode = 'prepare' AND status = 'done' LIMIT 1`).get(orgA, id3) as any;
  check("RN-159-3: log de prepare também carrega correlationId", prepLog?.correlation_id === (D.get(orgA, id3) as any).correlation_id);

  // ===== 5. Rejeição por guarda também é auditada COM correlationId =====
  const orgX = mkOrg(); // sem policy → policy_missing
  const idX = D.propose(orgX, { domain: "test", actionType: "gov_send", title: "X", commandType: "test_governed_send" });
  D.approve(orgX, idX.id, "u-approver");
  const corrX = (D.get(orgX, idX.id) as any).correlation_id;
  threw = false;
  try { await X.execute(orgX, idX.id); } catch { threw = true; }
  check("rejeição policy_missing auditada", threw && lastExecLog(orgX, idX.id)?.error_code === "policy_missing");
  check("RN-159-3: log de rejeição carrega correlationId", lastExecLog(orgX, idX.id)?.correlation_id === corrX);

  // ===== 6. Isolamento multi-tenant =====
  const orgB = mkOrg();
  threw = false;
  try { await X.execute(orgB, id3); } catch { threw = true; } // ação de orgA
  check("orgB não executa ação de orgA", threw);
  check("execução de orgA não vazou log em orgB", !doneExecLog(orgB, id3));

  console.log("\n=== TEST: Choke-point hardening (ADR-159 F2/D1) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Choke-point hardening (F2) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
