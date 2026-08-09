/**
 * TEST — Espinha Única / Rastreabilidade ponta-a-ponta (ADR-158, Onda 0 F1).
 *
 * Verifica que o `correlation_id` amarra sinal → decisão → outcome num único
 * fio (PRD 0 §50), com herança automática, dedupe estável, isolamento por org
 * e compatibilidade com linhas legadas. Determinístico, sem chave de IA.
 *
 * Uso: npm run test:execution-trace
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-trace-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-trace-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: S } = await import("../src/server/BusinessSignalService.js");
  const { DecisionActionService: D } = await import("../src/server/DecisionActionService.js");
  const { OutcomeMeasurementService: O } = await import("../src/server/OutcomeMeasurementService.js");
  const { ExecutionTraceService: T } = await import("../src/server/ExecutionTraceService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();
  const orgB = mkOrg();

  // ===== 1. Sinal sem correlationId ENRAÍZA a própria cadeia (= id do sinal) =====
  const sig = S.publish(orgA, {
    domain: "finance", signalType: "overdue_receivable", severity: "risk", basis: "fact",
    confidence: 0.9, impactAmount: 4200, impactUnit: "BRL", sourceService: "FinanceSignalPublisher",
    evidence: { invoices: 3 }, dedupeKey: "overdue:cliente-42",
  });
  check("sinal retorna correlationId", !!sig.correlationId);
  check("correlationId enraíza no próprio sinal (= id)", sig.correlationId === sig.id);
  check("schema_version do sinal = 1", (db.prepare("SELECT schema_version v FROM business_signals WHERE id=?").get(sig.id) as any).v === 1);

  // ===== 2. Decisão com signalId HERDA o correlation_id do sinal =====
  const act = D.propose(orgA, {
    domain: "finance", actionType: "collection", title: "Cobrar R$ 4.200 vencidos",
    expectedImpact: 4200, impactUnit: "BRL", basis: "fact", signalId: sig.id,
  });
  check("ação herda correlation_id do sinal", act.correlation_id === sig.correlationId);
  check("cobrança nasce aguardando aprovação", act.status === "awaiting_approval");

  // ===== 3. Concluir gera outcome que HERDA o mesmo fio =====
  D.approve(orgA, act.id, "user-1");
  const done = D.complete(orgA, act.id, { resultAmount: 3800, categoryOutcomes: { revenueRecovered: 3800 } });
  check("ação concluída", done.status === "done");
  const outs = O.forAction(orgA, act.id);
  check("outcome herda correlation_id da ação", outs.length === 1 && outs[0].correlation_id === sig.correlationId);

  // ===== 4. trace() reconstrói o fio inteiro e detecta loop fechado =====
  const tr = T.trace(orgA, sig.correlationId);
  check("trace: 1 sinal", tr.summary.signals === 1);
  check("trace: 1 ação", tr.summary.actions === 1);
  check("trace: 1 outcome", tr.summary.outcomes === 1);
  check("trace: loop fechado (sinal+ação+outcome)", tr.summary.closedLoop === true);
  check("trace: correlationForSignal resolve o fio", T.correlationForSignal(orgA, sig.id) === sig.correlationId);

  // ===== 5. Dedupe NÃO troca o correlation_id nem duplica o sinal no fio =====
  const sig2 = S.publish(orgA, {
    domain: "finance", signalType: "overdue_receivable", severity: "critical", basis: "fact",
    confidence: 0.95, impactAmount: 4200, impactUnit: "BRL", sourceService: "FinanceSignalPublisher",
    evidence: { invoices: 4 }, dedupeKey: "overdue:cliente-42",
  });
  check("republicar (dedupe) mantém o mesmo correlationId", sig2.deduped === true && sig2.correlationId === sig.correlationId);
  check("trace segue com 1 sinal após dedupe", T.trace(orgA, sig.correlationId).summary.signals === 1);

  // ===== 6. Decisão SEM sinal e SEM correlationId enraíza fio próprio =====
  const orphan = D.propose(orgA, { domain: "tasks", actionType: "create_task", title: "Conferir estoque" });
  check("ação órfã ganha correlation_id próprio", !!orphan.correlation_id && orphan.correlation_id !== sig.correlationId);
  const trOrphan = T.trace(orgA, orphan.correlation_id);
  check("trace do fio órfão: só a ação, loop aberto", trOrphan.summary.actions === 1 && trOrphan.summary.signals === 0 && trOrphan.summary.closedLoop === false);

  // ===== 7. correlationId explícito é respeitado (propagação manual) =====
  const cid = randomUUID();
  const act2 = D.propose(orgA, { domain: "finance", actionType: "collection", title: "Ação com fio explícito", correlationId: cid });
  check("correlationId explícito é usado", act2.correlation_id === cid);

  // ===== 8. Isolamento multi-tenant: org B não enxerga o fio de A =====
  const trB = T.trace(orgB, sig.correlationId);
  check("isolamento: org B vê fio vazio para correlationId de A", trB.summary.signals === 0 && trB.summary.actions === 0 && trB.summary.outcomes === 0);
  check("isolamento: correlationForSignal de A não resolve em B", T.correlationForSignal(orgB, sig.id) === null);

  console.log("\n=== TEST: Espinha Única — Rastreabilidade (ADR-158 F1) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Espinha Única / Rastreabilidade OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
