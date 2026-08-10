/**
 * TEST — PRD 2 F4.2 (§26, §67, §88-90): registry + contrato de detector. Os
 * detectores se declaram num lugar único; a decisão roda pela primitiva F4.1;
 * o evaluate() monta um SignalInput pronto pra publish (sem publicar).
 *
 * Prova (determinístico):
 *   - register/get/list/byDomain/byVertical; validação do contrato (§67);
 *   - evaluate: anomalia → fires + signal (dedupe/severity/basis/TTL/subject/
 *     recommendedProcess); normal/cooldown/minSample → não dispara (fail-safe);
 *   - o signal emitido é PUBLICÁVEL no ledger (contrato válido);
 *   - defaults por vertical (§90): universal entra sempre; específico só na sua.
 *
 * Uso: npm run test:anomaly-registry
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-anomaly-reg-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-anomaly-reg-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
function throws(fn: () => any): boolean { try { fn(); return false; } catch { return true; } }

const NOW = Date.parse("2026-08-10T12:00:00Z");

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AnomalyDetectorRegistry: REG } = await import("../src/server/AnomalyDetectorRegistry.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");

  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);

  // ===== 1. Registry + contrato =====
  check("1.1 pack default: sales_conversion_drop registrado", !!REG.get("sales_conversion_drop"));
  REG.register({ name: "test_universal", domain: "ops", purpose: "t", metric: "x", method: "relative", direction: "both", threshold: 0.5, minSample: 1, cooldownMs: 0, ttlMs: 3600e3, severity: "attention", basis: "estimate" });
  check("1.2 register + get + byDomain", !!REG.get("test_universal") && REG.byDomain("ops").some((d: any) => d.name === "test_universal"));
  check("1.3 contrato validado: severity/basis/minSample inválidos barram", throws(() => REG.register({ name: "bad", domain: "d", purpose: "p", metric: "m", method: "relative", direction: "drop", threshold: 0.2, minSample: 0, cooldownMs: 0, ttlMs: 1, severity: "risk", basis: "fact" } as any)) && throws(() => REG.register({ name: "bad2", domain: "d", purpose: "p", metric: "m", method: "relative", direction: "drop", threshold: 0.2, minSample: 1, cooldownMs: 0, ttlMs: 1, severity: "oops", basis: "fact" } as any)));

  // ===== 2. evaluate — anomalia dispara + signal montado =====
  const sample = new Array(30).fill(26); // baseline 26, minSample 30 satisfeito
  const ev = REG.evaluate("sales_conversion_drop", { current: 17, sample, subjectId: "funnel-1", impactAmount: 13400, impactUnit: "BRL", evidence: { nota: "18 propostas paradas" }, now: NOW });
  check("2.1 anomalia dispara (fires)", ev.fires && !!ev.signal);
  check("2.2 signal com dedupe/severity/basis/subject corretos", ev.signal!.dedupeKey === "sales_conversion_drop:funnel-1" && ev.signal!.severity === "risk" && ev.signal!.basis === "fact" && ev.signal!.subjectType === "funnel" && ev.signal!.subjectId === "funnel-1");
  check("2.3 TTL = now + 24h; recommendedProcess na evidência", ev.signal!.expiresAt === new Date(NOW + 24 * 3600e3).toISOString() && ev.signal!.evidence.recommendedProcessType === "sales_recovery_v1");
  check("2.4 evidência traz metric/current/baseline", ev.signal!.evidence.metric === "conversionRate" && ev.signal!.evidence.current === 17 && ev.signal!.evidence.baseline === 26);

  // ===== 3. Fail-safe: normal / cooldown / minSample =====
  check("3.1 dentro do normal NÃO dispara", !REG.evaluate("sales_conversion_drop", { current: 25, sample, now: NOW }).fires);
  check("3.2 cooldown ativo NÃO dispara", !REG.evaluate("sales_conversion_drop", { current: 17, sample, lastFiredAt: new Date(NOW - 3600e3).toISOString(), now: NOW }).fires);
  check("3.3 amostra < minSample NÃO dispara", !REG.evaluate("sales_conversion_drop", { current: 17, sample: new Array(10).fill(26), now: NOW }).fires);

  // ===== 4. O signal emitido é publicável (contrato válido) =====
  const pub = BS.publish(org, ev.signal!);
  const row = db.prepare(`SELECT * FROM business_signals WHERE id = ?`).get(pub.id) as any;
  check("4.1 publish do signal emitido cai no ledger com TTL + subject", !!row && row.signal_type === "sales_conversion_drop" && row.expires_at != null && row.subject_id === "funnel-1");

  // ===== 5. Defaults por vertical (§90) =====
  check("5.1 universal entra em qualquer vertical", REG.byVertical("clinica").some((d: any) => d.name === "test_universal"));
  check("5.2 específico (retail/moda/servicos) NÃO entra em clinica", !REG.byVertical("clinica").some((d: any) => d.name === "sales_conversion_drop") && REG.byVertical("retail").some((d: any) => d.name === "sales_conversion_drop"));

  console.log("\n=== TEST: Detector registry F4.2 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Detector registry F4.2 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
