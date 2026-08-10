/**
 * TEST — PRD 2 F8 (§41-42, §71-74, CA20): expansão conservadora do roteamento
 * sinal→processo. Novo mapeamento explícito (§72) + mecanismo recommendedProcessType
 * com allowlist de processos MADUROS. Auto-trigger ≠ auto-execute (§43) mantido.
 *
 * Prova (determinístico):
 *   - mapa explícito novo (stalled_opportunities → sales_recovery_v1) dispara;
 *   - recommendedProcessType MADURO (do detector, F4.2) dispara sem estar no mapa;
 *   - recommendedProcessType NÃO-maduro / sem recomendação → NÃO dispara (§42);
 *   - processo nasce 'detected' (nenhum efeito externo);
 *   - opt-in duplo respeitado; preview (dryRun) mostra sem disparar; isolamento.
 *
 * Uso: npm run test:signal-routing-expansion
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-routing-exp-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-routing-exp-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { ProcessRuntimeService: PR } = await import("../src/server/ProcessRuntimeService.js");
  const { SignalProcessRouterService: R } = await import("../src/server/SignalProcessRouterService.js");

  const mkOrg = (enable: boolean) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, execution_runtime_enabled, signal_auto_trigger_enabled) VALUES (?, ?, 'X', 'active', ?, ?)`).run(randomUUID(), id, enable ? 1 : 0, enable ? 1 : 0);
    // Definição ativa do playbook maduro.
    const def = PR.defineProcess(id, { processType: "sales_recovery_v1", name: "Recuperação Comercial", steps: { steps: [{ id: "a", commandType: "noop", next: "$end" }] } } as any);
    PR.setActive(id, def.id, true);
    return id;
  };
  const org = mkOrg(true);
  const pub = (over: any) => BS.publish(org, { domain: "sales", severity: "risk", basis: "fact", confidence: 0.9, sourceService: "test", evidence: {}, ...over });

  const stalled = pub({ signalType: "stalled_opportunities", dedupeKey: "st", sourceEntityType: "ticket", sourceEntityId: "t-1" });
  const rpSig = pub({ signalType: "sales_conversion_drop", dedupeKey: "rp", evidence: { recommendedProcessType: "sales_recovery_v1" }, sourceEntityType: "funnel", sourceEntityId: "f-1" });
  const immature = pub({ signalType: "weird", dedupeKey: "im", evidence: { recommendedProcessType: "immature_proc" }, sourceEntityType: "x", sourceEntityId: "x-1" });
  const plain = pub({ signalType: "plain", dedupeKey: "pl", sourceEntityType: "y", sourceEntityId: "y-1" });

  // ===== 1. Preview (dryRun) — o que dispararia =====
  const prev = R.routeOrg(org, { dryRun: true });
  const prevIds = prev.previews.map((p: any) => p.signalId);
  check("1.1 preview inclui o mapa explícito novo (stalled_opportunities)", prevIds.includes(stalled.id) && prev.previews.find((p: any) => p.signalId === stalled.id)?.processType === "sales_recovery_v1");
  check("1.2 preview inclui o recommendedProcessType MADURO", prevIds.includes(rpSig.id));
  check("1.3 preview NÃO inclui processo não-maduro nem sinal sem recomendação", !prevIds.includes(immature.id) && !prevIds.includes(plain.id));

  // ===== 2. Disparo real =====
  const run = R.routeOrg(org, { actor: "test" });
  const triggered = run.triggered;
  check("2.1 disparou os 2 roteáveis (explícito + maduro)", triggered.length === 2 && triggered.every((t: any) => t.processType === "sales_recovery_v1"));
  const inst = PR.getInstance(org, triggered[0].instanceId);
  check("2.2 processo nasce 'detected' (auto-trigger ≠ auto-execute)", inst.status === "detected");
  check("2.3 não-maduro e sem-recomendação NÃO viraram processo", db.prepare(`SELECT COUNT(*) n FROM process_instances WHERE organization_id = ?`).get(org) !== null && !triggered.some((t: any) => [immature.id, plain.id].includes(t.signalId)));
  check("2.4 sinais roteados viram acknowledged (idempotência)", (db.prepare(`SELECT status FROM business_signals WHERE id = ?`).get(stalled.id) as any).status === "acknowledged");

  // ===== 3. Opt-in duplo: flags off → no-op real =====
  const orgOff = mkOrg(false);
  const offSig = BS.publish(orgOff, { domain: "sales", signalType: "stalled_opportunities", severity: "risk", basis: "fact", confidence: 1, sourceService: "test", evidence: {}, dedupeKey: "off", sourceEntityType: "ticket", sourceEntityId: "o-1" });
  check("3.1 flags off: disparo real é no-op; preview ainda mostra", R.routeOrg(orgOff).triggered.length === 0 && R.routeOrg(orgOff, { dryRun: true }).previews.length === 1);

  // ===== 4. Isolamento =====
  check("4.1 roteamento de A não afeta B", !R.routeOrg(orgOff, { dryRun: true }).previews.some((p: any) => p.signalId === stalled.id) && offSig.id !== stalled.id);

  console.log("\n=== TEST: Routing expansion F8 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Routing expansion F8 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
