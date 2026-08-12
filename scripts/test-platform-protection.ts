/**
 * TEST — PlatformProtectionModeService: Protection Mode shadow-first (PRD 7 / ADR-164 F11).
 * DB-backed, det. Prova (§93-98, §102, CA23, RN-PRC-7, D1):
 *   - flag nasce DESLIGADO (shadow) → active:false mesmo sob estresse (§102);
 *   - saúde degradada → postura PROTECTED; watch → CAUTIOUS; saudável → NORMAL;
 *   - headroom CRITICAL força PROTECTED;
 *   - enforcement ligado + postura != NORMAL → active:true;
 *   - neverDefers sempre lista operação crítica (CA23), e ela nunca entra em wouldDefer;
 *   - determinismo.
 *
 * Uso: npm run test:platform-protection
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-prot-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-prot-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { PlatformProtectionModeService: PM } = await import("../src/server/PlatformProtectionModeService.js");
  const now = Date.parse("2026-08-12T15:00:00Z");

  const healthy = { operational: { state: "healthy" } };
  const watch = { operational: { state: "watch" } };
  const degraded = { operational: { state: "degraded" } };
  const hrOk = { resources: [{ resource: "host.mem_used_pct", available: true, zone: "HEALTHY" }] };
  const hrCrit = { resources: [{ resource: "host.mem_used_pct", available: true, zone: "CRITICAL" }] };
  const hrAct = { resources: [{ resource: "host.load_per_core", available: true, zone: "ACT" }] };

  // ═══════════════ 1. shadow por padrão (flag desligado) — §102 ═══════════════
  check("1.1 flag nasce desligado (shadow)", PM.isEnforcing() === false);
  const s1 = PM.assess({ now, health: degraded, headroom: hrCrit });
  check("1.2 degradado+CRITICAL → PROTECTED", s1.state === "PROTECTED");
  check("1.3 shadow → active:false mesmo em PROTECTED (§102, não altera nada)", s1.active === false && s1.shadow === true);

  // ═══════════════ 2. mapeamento de postura ═══════════════
  check("2.1 saudável + headroom ok → NORMAL", PM.assess({ now, health: healthy, headroom: hrOk }).state === "NORMAL");
  check("2.2 watch → CAUTIOUS", PM.assess({ now, health: watch, headroom: hrOk }).state === "CAUTIOUS");
  check("2.3 headroom ACT (com saúde ok) → CAUTIOUS", PM.assess({ now, health: healthy, headroom: hrAct }).state === "CAUTIOUS");
  check("2.4 headroom CRITICAL (com saúde ok) → PROTECTED", PM.assess({ now, health: healthy, headroom: hrCrit }).state === "PROTECTED");

  // ═══════════════ 3. enforcement ligado → active quando postura != NORMAL ═══════════════
  PM.setEnforcing(true);
  check("3.1 flag persistido → isEnforcing true", PM.isEnforcing() === true);
  const s3 = PM.assess({ now, health: degraded, headroom: hrCrit });
  check("3.2 enforcing + PROTECTED → active:true", s3.active === true && s3.shadow === false);
  const s3n = PM.assess({ now, health: healthy, headroom: hrOk });
  check("3.3 enforcing + NORMAL → active:false (nada a diferir)", s3n.active === false && s3n.wouldDefer.length === 0);

  // ═══════════════ 4. CA23 — operação crítica NUNCA é diferida ═══════════════
  const crit = PM.assess({ now, health: degraded, headroom: hrCrit });
  check("4.1 neverDefers lista operação crítica de cliente (CA23)", crit.neverDefers.some((x: string) => /crítica de cliente/i.test(x)));
  check("4.2 wouldDefer não intersecta neverDefers (nunca difere crítico)", crit.wouldDefer.length > 0 && crit.wouldDefer.every((x: string) => !crit.neverDefers.includes(x)));

  // ═══════════════ 5. determinismo ═══════════════
  const a = PM.assess({ now, health: degraded, headroom: hrCrit });
  const b = PM.assess({ now, health: degraded, headroom: hrCrit });
  check("5.1 mesmas entradas → mesmo resultado", JSON.stringify(a) === JSON.stringify(b));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} platform-protection: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
