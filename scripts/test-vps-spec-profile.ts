/**
 * TEST — VpsSpecProfileService + integração no headroom (PRD 7 / ADR-164 F2 host/infra).
 * DB-backed, det. Prova (§9/§68, RN-PRC-4/6, §59):
 *   - sem perfil → configured:false (honesto, não inventa spec);
 *   - set valida números positivos; get devolve o perfil;
 *   - GLOBAL (platform_settings, sem organization_id);
 *   - headroom usa o nº de cores do PERFIL (cpuBasis 'spec') em vez do que o Node vê;
 *   - capacityContext deriva uso absoluto de memória do % × RAM do perfil;
 *   - recurso de host ganha configuredLimit, mas segue not_available (uso exige provider).
 *
 * Uso: npm run test:vps-spec-profile
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vps-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-vps-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { VpsSpecProfileService: VPS } = await import("../src/server/VpsSpecProfileService.js");
  const { CapacityHeadroomService: CAP } = await import("../src/server/CapacityHeadroomService.js");
  const now = Date.parse("2026-08-12T15:00:00Z");

  // ═══════════════ 1. sem perfil → honesto ═══════════════
  check("1.1 sem perfil → configured:false", VPS.get().configured === false);
  check("1.2 effectiveCpuCount null sem perfil", VPS.effectiveCpuCount() === null);

  // ═══════════════ 2. set/get + validação ═══════════════
  VPS.set({ vcpu: 4, ramMb: 8192, storageGb: 160, os: "Ubuntu 22.04", orchestration: "coolify", containerCpuLimit: 2, containerMemMb: 4096, dbPath: "/data/app.db", dbSizeBytes: 52428800 });
  const p = VPS.get();
  check("2.1 configured:true após set", p.configured === true && p.vcpu === 4 && p.ramMb === 8192);
  check("2.2 effectiveCpuCount = container limit (2, precede vCPU)", VPS.effectiveCpuCount() === 2);
  let threw = false; try { VPS.set({ vcpu: -1 }); } catch { threw = true; }
  check("2.3 número inválido é rejeitado", threw === true);
  // set inválido não corrompeu o perfil anterior? (o throw aconteceu antes do INSERT)
  check("2.4 perfil anterior preservado após set inválido", VPS.get().vcpu === 4);

  // ═══════════════ 3. GLOBAL (platform_settings, sem organization_id) ═══════════════
  const cols = (db.prepare("PRAGMA table_info(platform_settings)").all() as any[]).map((c) => c.name);
  check("3.1 perfil vive em platform_settings GLOBAL (sem organization_id)", !cols.includes("organization_id") && !!db.prepare("SELECT 1 FROM platform_settings WHERE key='platform_vps_spec_profile'").get());

  // ═══════════════ 4. headroom usa o nº de cores do PERFIL (cpuBasis 'spec') ═══════════════
  // load 3.0 com container limit 2 → 1.5/core (PLAN/ACT), NÃO 3.0/os.cpus.
  const s = CAP.snapshot({ now, runtime: { memUsedPct: 50, load1m: 3.0, cpuCount: 8 } });
  const cpu = s.resources.find((r: any) => r.resource === "host.load_per_core");
  check("4.1 cpuBasis 'spec' (usa o perfil, não o Node)", cpu.cpuBasis === "spec" && cpu.cpuCount === 2);
  check("4.2 load 3.0/2 cores = 1.5/core (perfil), não 3.0/8", cpu.value === 1.5);

  // ═══════════════ 5. capacityContext deriva uso absoluto de memória ═══════════════
  check("5.1 capacityContext configured + memUsedMb = 50% × 8192 = 4096", s.capacityContext.configured === true && s.capacityContext.memUsedMb === 4096);

  // ═══════════════ 6. recurso de host: limite conhecido, mas uso ainda not_available ═══════════════
  const disk = s.resources.find((r: any) => r.resource === "disk.used_pct");
  check("6.1 disco: configuredLimit=160 mas segue not_available (uso exige provider)", disk.available === false && disk.reason === "requires_host_provider" && disk.configuredLimit === 160);

  // ═══════════════ 7. clear volta ao honesto ═══════════════
  VPS.clear();
  check("7.1 clear → configured:false", VPS.get().configured === false);
  const s2 = CAP.snapshot({ now, runtime: { memUsedPct: 50, load1m: 3.0, cpuCount: 8 } });
  check("7.2 sem perfil → cpuBasis 'node' (comportamento pré-F2)", s2.resources.find((r: any) => r.resource === "host.load_per_core").cpuBasis === "node");

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} vps-spec-profile: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
