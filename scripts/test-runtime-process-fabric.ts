/**
 * TEST — ZappFlow Execution Runtime, Fatia 1.1 (ADR-152): Process Fabric.
 *
 * Cobre: PlaybookEngine puro (validação, evaluateCondition, chooseNextStep);
 * defineProcess (versionamento, rejeição de step inválido/duplicado/referência
 * quebrada); startForSubject (dedupe por subject vivo, contexto persistido,
 * transição inicial auditada); startFromSignal (contexto carrega evidência do
 * sinal); FSM (transições válidas passam, inválidas viola); advance +
 * completeStep (roteamento por condição, fim do playbook → completed,
 * successCondition, fallback e escalation por step.onFailure); cancel;
 * isolamento multi-tenant; gate por flag `execution_runtime_enabled`.
 *
 * Determinístico (sem chave OpenAI). Uso: npm run test:runtime-process-fabric
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-runtime-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-runtime-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ProcessRuntimeService: R } = await import("../src/server/ProcessRuntimeService.js");
  const { validateDefinition, evaluateCondition, chooseNextStep } = await import("../src/server/PlaybookEngine.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, execution_runtime_enabled) VALUES (?, ?, 'X', 'active', 1)`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();
  const orgB = mkOrg();

  // Playbook de teste com 3 caminhos: auto_approve, escalate, fail (por successCondition).
  const goodPlaybook = {
    steps: [
      {
        id: "fetch",
        commandType: "alterdata_fetch",
        successCondition: { op: "truthy", path: "results.fetch.ok" },
        next: "decide",
      },
      {
        id: "decide",
        commandType: "reconcile",
        // roteamento por condição: variance <= 0.05 e docs completos → auto_approve; senão escalate.
        next: [
          { when: { op: "and", conditions: [
              { op: "lte", path: "results.decide.variance", value: 0.05 },
              { op: "truthy", path: "results.decide.docsComplete" },
            ] }, next: "auto_approve" },
          { next: "escalate" }, // default
        ],
      },
      {
        id: "auto_approve",
        commandType: "post_financial",
        next: "$end",
      },
      {
        id: "escalate",
        commandType: "notify_manager",
        onFailure: "escalate",
        next: "$end",
      },
    ],
  };

  // ===== 1. PlaybookEngine — validação =====
  check("playbook válido passa", validateDefinition(goodPlaybook).ok);
  const badRef = validateDefinition({ steps: [{ id: "a", commandType: "x", next: "inexistente" }] });
  check("referência quebrada em next é rejeitada", !badRef.ok && badRef.errors.some((e) => /inexistente/.test(e.message)));
  const dupId = validateDefinition({ steps: [{ id: "a", commandType: "x", next: "$end" }, { id: "a", commandType: "y", next: "$end" }] });
  check("id duplicado rejeitado", !dupId.ok && dupId.errors.some((e) => /duplicado/.test(e.message)));
  const noCmd = validateDefinition({ steps: [{ id: "a", next: "$end" }] });
  check("commandType obrigatório", !noCmd.ok);
  const fallbackNoStep = validateDefinition({ steps: [{ id: "a", commandType: "x", onFailure: "fallback", next: "$end" }] });
  check("onFailure=fallback exige fallbackStep", !fallbackNoStep.ok);

  // ===== 2. PlaybookEngine — evaluateCondition / chooseNextStep =====
  check("truthy nested", evaluateCondition({ op: "truthy", path: "a.b.c" }, { a: { b: { c: 1 } } }) === true);
  check("truthy ausente", evaluateCondition({ op: "truthy", path: "a.x" }, { a: {} }) === false);
  check("and true", evaluateCondition({ op: "and", conditions: [{ op: "eq", path: "s", value: "ok" }, { op: "gte", path: "n", value: 10 }] }, { s: "ok", n: 15 }) === true);
  check("and false", evaluateCondition({ op: "and", conditions: [{ op: "eq", path: "s", value: "ok" }, { op: "gte", path: "n", value: 100 }] }, { s: "ok", n: 15 }) === false);
  check("not", evaluateCondition({ op: "not", condition: { op: "eq", path: "s", value: "x" } }, { s: "y" }) === true);
  check("chooseNextStep por regra", chooseNextStep(goodPlaybook as any, "decide", { results: { decide: { variance: 0.02, docsComplete: true } } }) === "auto_approve");
  check("chooseNextStep default", chooseNextStep(goodPlaybook as any, "decide", { results: { decide: { variance: 0.5, docsComplete: false } } }) === "escalate");
  check("chooseNextStep $end quando next=$end", chooseNextStep(goodPlaybook as any, "auto_approve", {}) === "$end");

  // ===== 3. defineProcess — validação, versionamento =====
  let threw = false;
  try { R.defineProcess(orgA, { processType: "retail_closing", name: "X", steps: { steps: [{ id: "a", commandType: "x", next: "z" }] } } as any); } catch { threw = true; }
  check("defineProcess bloqueia playbook inválido", threw);
  const v1 = R.defineProcess(orgA, { processType: "retail_closing", name: "Fechamento diário", steps: goodPlaybook as any });
  check("defineProcess cria v1", v1.version === 1 && v1.active === 1);
  const v2 = R.defineProcess(orgA, { processType: "retail_closing", name: "Fechamento diário", steps: goodPlaybook as any });
  check("defineProcess incrementa versão", v2.version === 2);
  const latest = R.latestActiveDefinition(orgA, "retail_closing");
  check("latestActiveDefinition devolve v2", latest?.version === 2);
  R.setActive(orgA, v2.id, false);
  const latest2 = R.latestActiveDefinition(orgA, "retail_closing");
  check("setActive(false) volta para v1", latest2?.version === 1);
  R.setActive(orgA, v2.id, true); // restaura

  // ===== 4. startForSubject — cria instância detected, contexto, transição inicial =====
  const inst = R.startForSubject(orgA, { processType: "retail_closing", subjectType: "store_day", subjectId: "loja_x_2026-08-03", context: { date: "2026-08-03" } });
  check("instância nasce em 'detected'", inst.status === "detected" && inst.current_step === "fetch");
  check("contexto persistido", inst.context?.date === "2026-08-03");
  const trans1 = R.listTransitions(orgA, inst.id);
  check("transição inicial auditada (null → detected)", trans1.length === 1 && trans1[0].from_state === null && trans1[0].to_state === "detected");

  // ===== 5. Dedupe: mesmo subject vivo devolve a mesma instância =====
  const dup = R.startForSubject(orgA, { processType: "retail_closing", subjectType: "store_day", subjectId: "loja_x_2026-08-03" });
  check("subject com instância viva NÃO duplica", dup.id === inst.id);

  // ===== 6. FSM — transições válidas e inválidas =====
  threw = false;
  try { R.transition(orgA, inst.id, "completed"); } catch { threw = true; }
  check("transição inválida (detected → completed) bloqueada", threw);
  const adv = R.advance(orgA, inst.id);
  check("advance de detected transiciona pra planned", adv.instance.status === "planned" && adv.nextStep?.id === "fetch");
  R.transition(orgA, inst.id, "authorized");
  R.transition(orgA, inst.id, "queued");
  R.transition(orgA, inst.id, "executing");
  check("FSM avançou detected→planned→authorized→queued→executing", R.getInstance(orgA, inst.id)?.status === "executing");

  // ===== 7. completeStep — roteamento por condição =====
  R.completeStep(orgA, inst.id, { stepResult: { ok: true } });
  check("step 'fetch' concluído aponta pra 'decide'", R.getInstance(orgA, inst.id)?.current_step === "decide");
  R.completeStep(orgA, inst.id, { stepResult: { variance: 0.02, docsComplete: true } });
  check("regra do 'decide' escolheu 'auto_approve'", R.getInstance(orgA, inst.id)?.current_step === "auto_approve");
  const done = R.completeStep(orgA, inst.id, { stepResult: { posted: true } });
  check("último step ($end) → status completed", done.status === "completed" && !!done.completed_at);
  check("result_json acumula os step results", done.result?.fetch?.ok === true && done.result?.decide?.variance === 0.02 && done.result?.auto_approve?.posted === true);

  // ===== 8. onFailure=escalate =====
  const inst2 = R.startForSubject(orgA, { processType: "retail_closing", subjectType: "store_day", subjectId: "loja_y_2026-08-03" });
  R.advance(orgA, inst2.id); // → planned
  R.transition(orgA, inst2.id, "authorized");
  R.transition(orgA, inst2.id, "queued");
  R.transition(orgA, inst2.id, "executing");
  R.completeStep(orgA, inst2.id, { stepResult: { ok: true } });
  R.completeStep(orgA, inst2.id, { stepResult: { variance: 0.5, docsComplete: false } }); // → escalate step
  check("regra default → 'escalate'", R.getInstance(orgA, inst2.id)?.current_step === "escalate");
  const esc = R.completeStep(orgA, inst2.id, { stepResult: { notified: false }, success: false });
  check("onFailure=escalate transiciona pra 'escalated'", esc.status === "escalated");

  // ===== 9. successCondition falha → failed =====
  const inst3 = R.startForSubject(orgA, { processType: "retail_closing", subjectType: "store_day", subjectId: "loja_z_2026-08-03" });
  R.advance(orgA, inst3.id);
  R.transition(orgA, inst3.id, "authorized");
  R.transition(orgA, inst3.id, "queued");
  R.transition(orgA, inst3.id, "executing");
  const bad = R.completeStep(orgA, inst3.id, { stepResult: { ok: false } }); // successCondition exige ok=true
  check("successCondition falha → status failed", bad.status === "failed");

  // ===== 10. cancel =====
  const inst4 = R.startForSubject(orgA, { processType: "retail_closing", subjectType: "store_day", subjectId: "loja_w_2026-08-03" });
  const cancelled = R.cancel(orgA, inst4.id, { reason: "abandonado" });
  check("cancel funciona em qualquer estado vivo", cancelled.status === "cancelled");
  threw = false;
  try { R.transition(orgA, inst4.id, "planned"); } catch { threw = true; }
  check("cancelled é terminal — sem transição de saída", threw);

  // ===== 11. startFromSignal — contexto carrega evidência =====
  const sig = BusinessSignalService.publish(orgA, {
    domain: "finance", signalType: "receivable_overdue", severity: "attention", basis: "fact", confidence: 1,
    impactAmount: 4200, impactUnit: "BRL", sourceService: "TestPublisher",
    evidence: { invoiceId: "inv-4587", customerName: "Maria" }, dedupeKey: "test-receivable-overdue-inv-4587",
  });
  const instFromSig = R.startFromSignal(orgA, sig.id, { processType: "retail_closing", subjectType: "invoice", subjectId: "inv-4587" });
  check("startFromSignal carrega evidência do sinal no contexto", instFromSig.context?.signal?.evidence?.invoiceId === "inv-4587" && instFromSig.context?.signal?.impactAmount === 4200);
  check("expectedValue default = impactAmount do sinal", Number(instFromSig.expected_value) === 4200);

  // ===== 12. Isolamento multi-tenant =====
  const otherOrg = R.getInstance(orgB, inst.id);
  check("orgB não vê instância de orgA", otherOrg === null);
  threw = false;
  try { R.transition(orgB, inst.id, "measured"); } catch { threw = true; }
  check("transição cross-tenant recusada", threw);
  const defOther = R.listDefinitions(orgB);
  check("orgB não vê definições de orgA", defOther.length === 0);

  // ===== 13. Flag opt-in bloqueada por default em novas orgs =====
  const orgC = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'C', 'active')`).run(randomUUID(), orgC);
  const flag = db.prepare(`SELECT execution_runtime_enabled FROM organization_settings WHERE organization_id = ?`).get(orgC) as any;
  check("execution_runtime_enabled default = 0 (sem quebrar orgs existentes)", Number(flag?.execution_runtime_enabled) === 0);

  // ===== 14. Auditoria — cada transição gera linha =====
  const transInst = R.listTransitions(orgA, inst.id);
  check("cada transição gera linha em process_transitions", transInst.length >= 6); // detected + planned + authorized + queued + executing + step*3 + completed

  // ===== 15. Referência não-existente ao subject retorna nova instância (não é dedupe) =====
  const another = R.startForSubject(orgA, { processType: "retail_closing", subjectType: "store_day", subjectId: "loja_nova_qualquer" });
  check("subject novo cria instância nova", another.id !== inst.id && another.status === "detected");

  // ===== Resultado =====
  console.log("\n=== ADR-152 Fatia 1.1 (Process Fabric) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
