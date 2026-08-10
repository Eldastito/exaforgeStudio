/**
 * TEST — ADR-160 F2 (Onda A / D2): snapshot como leitura default (cacheada).
 *
 * Prova, determinístico:
 *   - flag OFF (default): read() == build() fresco, NÃO persiste (0 regressão);
 *   - flag ON (evidence_layer_enabled): read() serve do cache TTL'd do
 *     EvidencePackageService — 1ª leitura MISS (persiste), 2ª HIT;
 *   - a FORMA é a mesma do build() (organization/period/dataQuality/domains/
 *     topPriorities) reconstruída SEM perda do pacote, + schemaVersion + _cache;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:snapshot-read-default
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-snap-read-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-snap-read-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSnapshotV2Service: SNAP } = await import("../src/server/BusinessSnapshotV2Service.js");

  const mkOrg = (evidenceOn: boolean) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, evidence_layer_enabled) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, evidenceOn ? 1 : 0); return id; };
  const countPkg = (orgId: string) => Number((db.prepare(`SELECT COUNT(*) n FROM evidence_packages WHERE organization_id = ?`).get(orgId) as any).n);
  const domainKeys = (snap: any) => Object.keys(snap.domains || {}).sort().join(",");

  // ===== 1. Flag OFF → read == build fresco, sem persistir =====
  const orgOff = mkOrg(false);
  const b = SNAP.build(orgOff);
  const r = SNAP.read(orgOff);
  check("OFF: read tem a mesma forma que build (organization/period/domains)", r.organization?.id === orgOff && !!r.period?.month && domainKeys(r) === domainKeys(b));
  check("OFF: caminho FRESCO (sem _cache, sem schemaVersion)", r._cache === undefined && r.schemaVersion === undefined);
  check("OFF: NÃO persiste (evidence_packages vazio)", countPkg(orgOff) === 0);

  // ===== 2. Flag ON → leitura cacheada (miss → hit) =====
  const orgOn = mkOrg(true);
  const r1 = SNAP.read(orgOn);
  check("ON: 1ª leitura MISS (cacheHit=false) + persiste 1 pacote", r1._cache?.cacheHit === false && countPkg(orgOn) === 1);
  const r2 = SNAP.read(orgOn);
  check("ON: 2ª leitura HIT (cacheHit=true), sem novo pacote", r2._cache?.cacheHit === true && countPkg(orgOn) === 1);
  check("ON: forma preservada (domains + topPriorities + dataQuality + schemaVersion)", !!r1.domains && Array.isArray(r1.topPriorities) && ("dataQuality" in r1) && r1.schemaVersion === 1);
  check("ON: _cache traz freshness/generatedAt/expiresAt", r2._cache?.freshness === "fresh" && !!r2._cache?.generatedAt && !!r2._cache?.expiresAt);

  // ===== 3. Fiel ao build (sem perda dos campos consumidos) =====
  const bOn = SNAP.build(orgOn);
  check("ON: domains do cache == build().domains (fiel)", JSON.stringify(r2.domains) === JSON.stringify(bOn.domains));
  check("ON: topPriorities do cache == build().topPriorities", JSON.stringify(r2.topPriorities) === JSON.stringify(bOn.topPriorities));
  check("ON: period preservado", r2.period?.month === bOn.period?.month);

  // ===== 4. Isolamento =====
  check("isolamento: pacote de orgOn não vaza pra outra org", countPkg(mkOrg(true)) === 0);
  check("isolamento: read de orgOff segue sem persistir após orgOn ligar", countPkg(orgOff) === 0);

  console.log("\n=== TEST: Snapshot como leitura default (ADR-160 F2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Snapshot como leitura default (F2) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
