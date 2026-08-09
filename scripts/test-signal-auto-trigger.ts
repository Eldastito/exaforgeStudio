/**
 * TEST — Espinha Única F4 (ADR-158 D6): auto-disparo GENÉRICO sinal→process_instance.
 *
 * Prova, determinístico e sem IA:
 *   - opt-in DUPLO: sem `signal_auto_trigger_enabled` + `execution_runtime_enabled`
 *     o roteador é no-op (respeita a flag);
 *   - PREVIEW (dryRun) mostra o que dispararia mesmo com flag off;
 *   - com as flags ligadas, um sinal MAPEADO e ABERTO inicia o processo
 *     correspondente (instância nasce em `detected` — auto-iniciar ≠ efeito
 *     externo) e o sinal vira `acknowledged`;
 *   - idempotência em 2 camadas (sinal acknowledged sai da varredura + dedup de
 *     subject) — rerodar NÃO duplica processo;
 *   - sinal não-mapeado é ignorado (fica aberto);
 *   - mapeamento sem definição ativa vira `skipped` (best-effort, não derruba);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:signal-auto-trigger
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-signal-auto-trigger-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-signal-auto-trigger-123456";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: SS } = await import("../src/server/BusinessSignalService.js");
  const { SignalProcessRouterService: R } = await import("../src/server/SignalProcessRouterService.js");
  const { SalesRecoveryPlaybookService: SR } = await import("../src/server/SalesRecoveryPlaybook.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const enable = (orgId: string) => db.prepare(`UPDATE organization_settings SET signal_auto_trigger_enabled = 1, execution_runtime_enabled = 1 WHERE organization_id = ?`).run(orgId);
  const countInstances = (orgId: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM process_instances WHERE organization_id = ?`).get(orgId) as any).n);
  const sigStatus = (orgId: string, id: string) => (db.prepare(`SELECT status FROM business_signals WHERE id = ? AND organization_id = ?`).get(id, orgId) as any)?.status;
  // Publica um churn_risk_high aberto (mapeado → sales_recovery_v1).
  const churn = (orgId: string, contactId: string) => SS.publish(orgId, {
    domain: "churn", signalType: "churn_risk_high", severity: "risk", basis: "estimate", confidence: 0.8,
    impactAmount: 500, impactUnit: "BRL", sourceService: "test", subjectType: "contact",
    sourceEntityType: "contact", sourceEntityId: contactId, evidence: { score: 0.9 }, dedupeKey: `churn:${contactId}`,
  });

  const orgA = mkOrg();
  SR.seed(orgA, "test");                    // define sales_recovery_v1 (idempotente)
  const sigA = churn(orgA, "contact_1");

  // ===== 1. Flag OFF → no-op (respeita opt-in) =====
  const off = R.routeOrg(orgA);
  check("flag off: flagEnabled=false", off.flagEnabled === false);
  check("flag off: nada disparado", off.triggered.length === 0);
  check("flag off: sinal segue aberto", sigStatus(orgA, sigA.id) === "open");
  check("flag off: nenhuma instância criada", countInstances(orgA) === 0);

  // ===== 2. PREVIEW (dryRun) mostra o que dispararia mesmo com flag off =====
  const prev = R.routeOrg(orgA, { dryRun: true });
  check("preview: 1 sinal previsto", prev.previews.length === 1);
  check("preview: mapeia churn→sales_recovery_v1", prev.previews[0]?.processType === "sales_recovery_v1" && prev.previews[0]?.signalId === sigA.id);
  check("preview: não dispara de verdade (nada acknowledged)", sigStatus(orgA, sigA.id) === "open" && countInstances(orgA) === 0);

  // ===== 3. Flags ON → dispara o processo; sinal vira acknowledged =====
  enable(orgA);
  const run1 = R.routeOrg(orgA, { actor: "tester" });
  check("on: flagEnabled=true", run1.flagEnabled === true);
  check("on: 1 processo disparado", run1.triggered.length === 1 && run1.triggered[0].processType === "sales_recovery_v1");
  check("on: instância criada em 'detected' (auto-iniciar ≠ efeito externo)",
    (db.prepare(`SELECT status FROM process_instances WHERE id = ?`).get(run1.triggered[0].instanceId) as any)?.status === "detected");
  check("on: instância NÃO é dedup de pré-existente", run1.triggered[0].deduped === false);
  check("on: sinal roteado vira acknowledged", sigStatus(orgA, sigA.id) === "acknowledged");
  check("on: exatamente 1 instância", countInstances(orgA) === 1);

  // ===== 4. Idempotência: rerodar não duplica (sinal fora do 'open') =====
  // Detector re-publica o mesmo sinal (dedupe) — status NÃO reabre.
  churn(orgA, "contact_1");
  check("idempotência: republicar por dedupe não reabre (segue acknowledged)", sigStatus(orgA, sigA.id) === "acknowledged");
  const run2 = R.routeOrg(orgA, { actor: "tester" });
  check("idempotência: 2ª rodada não dispara nada", run2.triggered.length === 0);
  check("idempotência: continua com 1 instância", countInstances(orgA) === 1);

  // ===== 5. Sinal não-mapeado é ignorado (fica aberto) =====
  const unmapped = SS.publish(orgA, { domain: "finance", signalType: "cash_below_minimum", severity: "risk", basis: "fact", confidence: 1, sourceService: "test", evidence: {}, dedupeKey: "fin:x" });
  const run3 = R.routeOrg(orgA, { actor: "tester" });
  check("não-mapeado: não dispara", run3.triggered.length === 0);
  check("não-mapeado: segue aberto", sigStatus(orgA, unmapped.id) === "open");

  // ===== 6. Mapeamento sem definição ativa → skipped (best-effort) =====
  // promise_broken mapeia p/ receivable_collection_v1, que NÃO foi semeado aqui.
  const orgC = mkOrg();
  enable(orgC);
  const brokenSig = SS.publish(orgC, { domain: "collection", signalType: "promise_broken", severity: "risk", basis: "fact", confidence: 1, sourceService: "test", subjectType: "contact", sourceEntityType: "contact", sourceEntityId: "c9", evidence: {}, dedupeKey: "col:c9" });
  const run4 = R.routeOrg(orgC, { actor: "tester" });
  check("sem definição: nada disparado", run4.triggered.length === 0);
  check("sem definição: vira skipped com motivo", run4.skipped.length === 1 && /vers.o ativa/i.test(run4.skipped[0].reason));
  check("sem definição: sinal NÃO é acknowledged (segue aberto)", sigStatus(orgC, brokenSig.id) === "open");
  check("sem definição: nenhuma instância", countInstances(orgC) === 0);

  // ===== 7. routeSignal (por id) respeita flag + garantias =====
  const orgD = mkOrg();
  SR.seed(orgD, "test");
  const sigD = churn(orgD, "contact_7");
  const rsOff = R.routeSignal(orgD, sigD.id);      // flag off ainda
  check("routeSignal flag off: no-op", rsOff.triggered.length === 0 && sigStatus(orgD, sigD.id) === "open");
  enable(orgD);
  const rsOn = R.routeSignal(orgD, sigD.id, { actor: "tester" });
  check("routeSignal on: dispara 1", rsOn.triggered.length === 1 && rsOn.triggered[0].signalId === sigD.id);
  check("routeSignal on: sinal acknowledged", sigStatus(orgD, sigD.id) === "acknowledged");
  const rsAgain = R.routeSignal(orgD, sigD.id, { actor: "tester" });
  check("routeSignal idempotente: 2ª vez skipped (não está aberto)", rsAgain.triggered.length === 0 && rsAgain.skipped.length === 1);

  // ===== 8. Isolamento multi-tenant =====
  const orgB = mkOrg();
  enable(orgB);
  SR.seed(orgB, "test");
  const sigB = churn(orgB, "contact_1");            // mesmo contactId de orgA, org diferente
  // Rotear orgA de novo NÃO toca no sinal de orgB.
  R.routeOrg(orgA, { actor: "tester" });
  check("isolamento: sinal de orgB segue aberto após rotear orgA", sigStatus(orgB, sigB.id) === "open");
  check("isolamento: orgB sem instância até rotear orgB", countInstances(orgB) === 0);
  const runB = R.routeOrg(orgB, { actor: "tester" });
  check("isolamento: rotear orgB dispara só o dela", runB.triggered.length === 1 && countInstances(orgB) === 1);

  console.log("\n=== TEST: Auto-disparo sinal→processo (ADR-158 F4) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Auto-disparo sinal→processo (F4) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
