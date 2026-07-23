/**
 * TEST — CommandExecutorService / Maestro 2.0 governado (ADR-136, Epic 2 — C5).
 * Prepare-only, auditável, sem efeito externo. Determinístico, sem chave de IA.
 *
 * Uso: npm run test:command-executor
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-executor-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-executor-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { DecisionActionService: D } = await import("../src/server/DecisionActionService.js");
  const { CommandExecutorService: X } = await import("../src/server/CommandExecutorService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();

  // ===== 1. Registro de handlers =====
  check("handlers registrados incluem create_task e collection", X.canHandle("create_task") && X.canHandle("collection"));
  check("comando desconhecido não tem handler", !X.canHandle("launch_rocket"));

  // ===== 2. Preparar create_task (nasce approved) → artefato + executed_at =====
  const t = D.propose(orgA, { domain: "tasks", actionType: "create_task", title: "Conferir estoque", commandType: "create_task" });
  check("create_task nasce aprovada (pronta p/ preparar)", t.status === "approved");
  const prep = X.prepare(orgA, t.id);
  check("prepare roda em modo 'prepare' (sem execute)", prep.ok === true && prep.mode === "prepare");
  check("handler tipado correto (TaskCommandHandler)", prep.handler === "TaskCommandHandler");
  check("artefato é um rascunho de tarefa", prep.result?.artifact?.kind === "task_draft" && prep.result.artifact.title === "Conferir estoque");
  check("ação marcada como preparada (executed_at)", !!D.get(orgA, t.id).executed_at);
  check("execução auditada com status 'done'", prep.execution.status === "done" && prep.execution.attempt === 1);

  // ===== 3. Preparar collection produz mensagem ancorada no valor =====
  const c = D.propose(orgA, { domain: "finance", actionType: "collection", title: "Cobrar", expectedImpact: 4200, commandType: "collection" });
  D.approve(orgA, c.id, "user-1");
  const prepC = X.prepare(orgA, c.id);
  check("collection preparada com valor no rascunho", prepC.result?.artifact?.kind === "collection_draft" && prepC.result.artifact.amount === 4200 && /4200|4\.200/.test(prepC.result.artifact.message));
  check("cobrança não é enviada (canal manual, sem efeito externo)", prepC.result.artifact.channel === "manual");

  // ===== 4. Só prepara ação APROVADA =====
  const pend = D.propose(orgA, { domain: "finance", actionType: "collection", title: "Aguardando", commandType: "collection" });
  let threwPend = false;
  try { X.prepare(orgA, pend.id); } catch { threwPend = true; }
  check("não prepara ação que aguarda aprovação", threwPend && D.get(orgA, pend.id).status === "awaiting_approval");

  // ===== 5. Comando sem handler → recusa AUDITADA (log 'failed'), nada roda =====
  const noh = D.propose(orgA, { domain: "tasks", actionType: "create_task", title: "Comando fantasma", commandType: "launch_rocket" });
  let threwNoh = false;
  try { X.prepare(orgA, noh.id); } catch { threwNoh = true; }
  check("comando sem handler é recusado", threwNoh);
  const nohLogs = X.executions(orgA, noh.id);
  check("recusa fica auditada (failed/no_handler)", nohLogs.length === 1 && nohLogs[0].status === "failed" && nohLogs[0].error_code === "no_handler");
  check("ação sem handler NÃO é marcada como preparada", !D.get(orgA, noh.id).executed_at);

  // ===== 6. Ação sem command_type → erro claro =====
  const nocmd = D.propose(orgA, { domain: "tasks", actionType: "create_task", title: "Sem comando" });
  let threwNoCmd = false;
  try { X.prepare(orgA, nocmd.id); } catch (e: any) { threwNoCmd = /command_type/.test(e.message); }
  check("ação sem command_type é rejeitada", threwNoCmd);

  // ===== 7. Re-preparar incrementa a tentativa (auditoria de retentativa) =====
  X.prepare(orgA, t.id);
  const tLogs = X.executions(orgA, t.id);
  check("re-preparar incrementa attempt", tLogs.length === 2 && tLogs[0].attempt === 2);

  // ===== 8. Isolamento por organização =====
  const orgB = mkOrg();
  let threwIso = false;
  try { X.prepare(orgB, t.id); } catch { threwIso = true; }
  check("isolamento: org B não prepara ação de A", threwIso && X.executions(orgB, t.id).length === 0);

  console.log("\n=== TEST: CommandExecutorService / Maestro 2.0 (ADR-136 C5) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Command Executor OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
