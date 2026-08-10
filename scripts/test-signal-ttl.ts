/**
 * TEST — PRD 2 F2.2 (§52-53, §78-79, CA15): freshness + enforcement de TTL.
 * Corrige o filtro `expires_at` (bug ISO vs datetime('now') achado na F2.1) e
 * adiciona o sweep `expireStale` que marca sinais vencidos como `expired`.
 *
 * Prova (determinístico):
 *   - attention: expiry PASSADO some; FUTURO e NULL permanecem;
 *   - expireStale marca só os abertos vencidos → 'expired'; idempotente;
 *   - não toca futuro/NULL nem já-resolvido;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:signal-ttl
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-signal-ttl-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-signal-ttl-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const PAST = new Date(Date.now() - 3600e3).toISOString();
const FUTURE = new Date(Date.now() + 3600e3).toISOString();

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const org = mkOrg();
  const pub = (dedupeKey: string, expiresAt?: string) => BS.publish(org, { domain: "inventory", signalType: "stockout_risk", severity: "risk", basis: "fact", confidence: 0.9, sourceService: "test", evidence: {}, dedupeKey, expiresAt });
  const rowOf = (id: string) => db.prepare(`SELECT * FROM business_signals WHERE id = ?`).get(id) as any;
  const inAtt = (id: string) => BS.attention(org).items.some((i: any) => i.id === id);

  const past = pub("k-past", PAST);
  const future = pub("k-future", FUTURE);
  const none = pub("k-none");

  // ===== 1. Filtro corrigido =====
  check("1.1 expiry PASSADO some do attention (bug F2.1 corrigido)", !inAtt(past.id));
  check("1.2 expiry FUTURO permanece", inAtt(future.id));
  check("1.3 sem expiry (NULL) permanece", inAtt(none.id));

  // ===== 2. expireStale (enforcement) =====
  const sweep = BS.expireStale(org);
  check("2.1 expireStale marca só o vencido (1) → status expired", sweep.expired === 1 && rowOf(past.id).status === "expired");
  check("2.2 futuro e NULL seguem open", rowOf(future.id).status === "open" && rowOf(none.id).status === "open");
  check("2.3 idempotente: 2ª passada não marca nada", BS.expireStale(org).expired === 0);

  // ===== 3. Não toca já-resolvido =====
  const resolvedPast = pub("k-resolved-past", PAST);
  BS.resolve(org, resolvedPast.id);
  BS.expireStale(org);
  check("3.1 sinal já resolvido com expiry passado NÃO vira expired", rowOf(resolvedPast.id).status === "resolved");

  // ===== 4. Isolamento multi-tenant =====
  const orgB = mkOrg();
  const bPast = BS.publish(orgB, { domain: "inventory", signalType: "x", severity: "risk", basis: "fact", confidence: 1, sourceService: "test", evidence: {}, dedupeKey: "b-past", expiresAt: PAST });
  BS.expireStale(org); // sweep de A não pode tocar B
  check("4.1 sweep de A não expira sinal de B", rowOf(bPast.id).status === "open");
  check("4.2 sweep de B expira o de B", BS.expireStale(orgB).expired === 1);

  console.log("\n=== TEST: TTL enforcement F2.2 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ TTL enforcement F2.2 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
