/**
 * TEST — ExecutionTrace de ciclo COMPLETO (PRD 8 / ADR-165 F8).
 * DB-backed, det. Prova que o trace agora inclui os elos que a auditoria F0 apontou como
 * faltantes — execução (action_execution_log) e confirmação (action_confirmations) —
 * entre a decisão e o outcome:
 *   - executions vêm por correlation_id; confirmations por action_id (não têm correlation_id);
 *   - summary conta executions + confirmations além de signals/actions/outcomes;
 *   - closedLoop mantém a semântica pré-F8 (não regride);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:execution-trace-fullcycle
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-trace8-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-trace8-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { ExecutionTraceService: T } = await import("../src/server/ExecutionTraceService.js");
  const ORG = "org-1", OTHER = "org-2";
  const CID = "cid-full";

  db.prepare("INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, correlation_id) VALUES (?,?,?,?,?,?,?)")
    .run("act-1", ORG, "collection", "send_reminder", "Cobrar", "done", CID);
  db.prepare("INSERT INTO action_execution_log (id, organization_id, action_id, handler, status, correlation_id) VALUES (?,?,?,?,?,?)")
    .run("exec-1", ORG, "act-1", "asaas", "done", CID);
  db.prepare("INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status) VALUES (?,?,?,?,?)")
    .run("conf-1", ORG, "act-1", "asaas_payment_webhook", "confirmed");
  db.prepare("INSERT INTO action_outcomes (id, organization_id, action_id, measurement_method, basis, realized_value, correlation_id) VALUES (?,?,?,?,?,?,?)")
    .run("out-1", ORG, "act-1", "derived", "fact", 100, CID);

  const tr = T.trace(ORG, CID);

  // ═══════════════ 1. novos elos presentes ═══════════════
  check("1.1 executions no trace (por correlation_id)", Array.isArray(tr.executions) && tr.executions.length === 1 && tr.executions[0].id === "exec-1");
  check("1.2 confirmations no trace (por action_id)", Array.isArray(tr.confirmations) && tr.confirmations.length === 1 && tr.confirmations[0].id === "conf-1");

  // ═══════════════ 2. summary conta os novos elos ═══════════════
  check("2.1 summary.executions = 1", tr.summary.executions === 1);
  check("2.2 summary.confirmations = 1", tr.summary.confirmations === 1);
  check("2.3 summary mantém actions/outcomes", tr.summary.actions === 1 && tr.summary.outcomes === 1);
  check("2.4 closedLoop mantém semântica (sinal ausente → false)", tr.summary.closedLoop === false);

  // ═══════════════ 3. confirmação sem correlation_id ainda aparece (linkada por action) ═══════════════
  // (conf-1 não tem coluna correlation_id — provado por vir no trace mesmo assim)
  check("3.1 confirmação sem correlation_id entra pelo action_id", tr.confirmations.some((c: any) => c.action_id === "act-1"));

  // ═══════════════ 4. isolamento multi-tenant ═══════════════
  const trB = T.trace(OTHER, CID);
  check("4.1 outra org vê fio vazio (executions/confirmations)", trB.executions.length === 0 && trB.confirmations.length === 0);

  // ═══════════════ 5. fio vazio tem os arrays novos ═══════════════
  const empty = T.trace(ORG, "cid-inexistente");
  check("5.1 fio inexistente → arrays vazios (não undefined)", Array.isArray(empty.executions) && Array.isArray(empty.confirmations) && empty.summary.executions === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} execution-trace-fullcycle: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
