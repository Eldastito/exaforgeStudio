/**
 * TEST — Contrato de telemetria de plataforma (PRD 7 / ADR-164 F1). DB-backed, det.
 * Prova (§9/§10, RN-PRC-3/4/6):
 *   - contrato provider-agnóstico: fachada consulta sem conhecer o provider;
 *   - NullTelemetryProvider é o padrão e responde HONESTAMENTE available:false
 *     (ausência NUNCA vira saúde — RN-PRC-6);
 *   - flag + provider ativo vivem em platform_settings (GLOBAL, não per-tenant — RN-PRC-4);
 *   - registrar/ativar um provider real passa a servir dados normalizados com proveniência;
 *   - desligar a flag volta ao Null (honesto).
 *
 * Uso: npm run test:platform-telemetry-contract
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ptc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ptc-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PlatformTelemetryService: TEL } = await import("../src/server/PlatformTelemetryService.js");
  const { NullTelemetryProvider } = await import("../src/server/PlatformTelemetryContract.js");
  TEL.resetProviders();

  // ═══════════════ 1. Null é o padrão + honesto (RN-PRC-6) ═══════════════
  const r0 = TEL.queryMetric({ metric: "host.cpu.util" });
  check("1.1 padrão: available=false (sem provider real)", r0.available === false && r0.value === null && r0.source === "null");
  check("1.2 motivo declarado (not_configured), não inventa", r0.reason === "not_configured");
  const h0 = TEL.providerHealth();
  check("1.3 saúde do provider: available=false, NUNCA 'healthy'", h0.available === false && !/health|ok|ready/i.test(h0.reason || "") && h0.activeProvider === "null");
  check("1.4 flag default desligada", h0.enabled === false && TEL.isEnabled() === false);

  // ═══════════════ 2. flag em platform_settings (GLOBAL, não per-tenant) ═══════════════
  TEL.setEnabled(true);
  check("2.1 flag ligada refletida", TEL.isEnabled() === true);
  const stored = db.prepare(`SELECT value FROM platform_settings WHERE key = 'platform_telemetry_enabled'`).get() as any;
  check("2.2 persistido em platform_settings (global)", stored?.value === "1");
  // Nunca em organization_settings (não há coluna nem uso per-tenant).
  const orgCols = (db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[]).map((c: any) => c.name);
  check("2.3 NÃO cria coluna per-tenant de telemetria de plataforma", !orgCols.some((c: string) => /platform_telemetry/.test(c)));

  // ═══════════════ 3. ligado mas sem provider real → ainda Null (honesto) ═══════════════
  check("3.1 flag ligada sem provider → cai no Null", TEL.activeProvider().name === "null" && TEL.queryMetric({ metric: "host.cpu.util" }).available === false);

  // ═══════════════ 4. registrar + ativar provider real serve dados normalizados ═══════════════
  const fake = {
    name: "fake",
    queryMetric: (q: any) => ({ metric: q.metric, available: true, value: 37, observedAt: "2026-08-12T12:00:00Z", source: "fake" }),
    queryRange: (q: any) => ({ metric: q.metric, available: true, points: [{ ts: "2026-08-12T12:00:00Z", value: 37 }], source: "fake" }),
    health: () => ({ available: true, source: "fake", checkedAt: "2026-08-12T12:00:00Z" }),
  };
  TEL.register(fake as any);
  check("4.1 registrado aparece no registry", TEL.registered().includes("fake"));
  TEL.setActiveProvider("fake");
  const r1 = TEL.queryMetric({ metric: "host.cpu.util" });
  check("4.2 serve valor normalizado com proveniência", r1.available === true && r1.value === 37 && r1.source === "fake" && !!r1.observedAt);
  const rg = TEL.queryRange({ metric: "host.cpu.util", from: "a", to: "b" });
  check("4.3 série temporal normalizada", rg.available === true && rg.points.length === 1 && rg.points[0].value === 37);
  check("4.4 saúde reflete o provider ativo", TEL.providerHealth().activeProvider === "fake" && TEL.providerHealth().available === true);

  // ═══════════════ 5. provider inexistente é recusado ═══════════════
  let threw = false; try { TEL.setActiveProvider("prometheus"); } catch { threw = true; }
  check("5.1 ativar provider não registrado é recusado", threw === true);

  // ═══════════════ 6. desligar volta ao Null (honesto) ═══════════════
  TEL.setEnabled(false);
  check("6.1 flag OFF → Null mesmo com 'fake' ativo salvo", TEL.activeProvider().name === "null" && TEL.queryMetric({ metric: "x" }).available === false);

  // sanidade de tipo do Null direto
  const n = new NullTelemetryProvider(() => "2026-01-01T00:00:00Z");
  check("6.2 NullProvider.health tem checkedAt e available=false", n.health().available === false && n.health().checkedAt === "2026-01-01T00:00:00Z");

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} platform-telemetry-contract: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
