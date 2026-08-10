/**
 * TEST — PRD 2 F2.3 (§75, CA14): fecha o furo da espinha de observabilidade.
 * O processo iniciado a partir de um sinal passa a carregar o `correlation_id`
 * da cadeia (antes ficava fora do trace).
 *
 * Prova (determinístico):
 *   - startFromSignal → process_instances.correlation_id = correlation do sinal;
 *   - startForSubject aceita correlationId explícito;
 *   - a thread (PRD 1 F6) agora costura o processo iniciado direto pelo router
 *     (sem decision_action) via correlation_id;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:signal-process-spine
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-signal-spine-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-signal-spine-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { ProcessRuntimeService: PR } = await import("../src/server/ProcessRuntimeService.js");
  const { FalaTuThreadService: FT } = await import("../src/server/FalaTuThreadService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PermissionService.seedSystemProfiles(id); return id; };
  const org = mkOrg();
  const owner = { userId: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'owner'`).get(org) as any)?.id, role: "owner" };

  // Definição de processo ativa (mínima válida).
  const def = PR.defineProcess(org, { processType: "test_proc", name: "Proc de teste", steps: { steps: [{ id: "a", commandType: "noop", next: "$end" }] } } as any);
  PR.setActive(org, def.id, true);

  // ===== 1. startFromSignal propaga o correlation_id do sinal =====
  const sig = BS.publish(org, { domain: "inventory", signalType: "stockout_risk", severity: "risk", basis: "fact", confidence: 0.9, sourceService: "test", evidence: { summary: "SKU zerado" }, dedupeKey: "k1", subjectType: "product", subjectId: "sku-1" });
  const inst = PR.startFromSignal(org, sig.id, { processType: "test_proc", subjectType: "product", subjectId: "sku-1" }, "test");
  check("1.1 processo nasce 'detected'", inst.status === "detected");
  check("1.2 processo herda o correlation_id do sinal", inst.correlation_id === sig.correlationId);

  // ===== 2. startForSubject aceita correlationId explícito =====
  const inst2 = PR.startForSubject(org, { processType: "test_proc", subjectType: "product", subjectId: "sku-2", correlationId: "corr-EXPLICIT" }, "test");
  check("2.1 correlationId explícito persiste", inst2.correlation_id === "corr-EXPLICIT");

  // ===== 3. A thread costura o processo via correlation_id (sem decision_action) =====
  const th = FT.thread(org, owner, sig.correlationId);
  const exec = th.events.find((e: any) => e.stage === "execucao");
  check("3.1 thread inclui o estágio execução do processo iniciado pelo router", !!exec && exec.title === "test_proc");
  check("3.2 thread também traz o sinal na cadeia", th.events.some((e: any) => e.stage === "sinal"));

  // ===== 4. Isolamento multi-tenant =====
  const orgB = mkOrg();
  check("4.1 processo de A não aparece na thread de B", FT.thread(orgB, owner, sig.correlationId).events.length === 0);
  check("4.2 getInstance de A não resolve sob B", PR.getInstance(orgB, inst.id) == null);

  console.log("\n=== TEST: Espinha sinal→processo F2.3 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Espinha sinal→processo F2.3 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
