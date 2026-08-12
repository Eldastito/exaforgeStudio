/**
 * TEST — Mobile readiness / hardening (PRD 6 / ADR-163 F11). Determinístico, puro.
 * Prova (§75-§79, CA1):
 *   - cliente pleno → todos os fluxos suportados;
 *   - cliente pelado → cada fluxo sem suporte tem FALLBACK e nada bloqueia (CA1);
 *   - núcleo (aprovar) funciona em qualquer navegador;
 *   - notas contextuais iOS (voz fora do Safari / push sem PWA);
 *   - dicas sanitizadas (plataforma/browser desconhecidos → "other"); manifest do PWA.
 *
 * Uso: npm run test:mobile-readiness
 */
import { randomUUID } from "crypto";
process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mob-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { MobileReadinessService: MOB } = await import("../src/server/MobileReadinessService.js");
  const user = { userId: "u1", role: "owner" };
  const flow = (r: any, k: string) => r.flows.find((f: any) => f.key === k);

  // ═══════════════ 1. cliente pleno (iOS Safari PWA, tudo presente) ═══════════════
  const full = MOB.assess("org1", user, { platform: "ios", browser: "safari", serviceWorker: true, mediaRecorder: true, pushManager: true, fileInput: true, standalone: true });
  check("1.1 voz suportada", flow(full, "capture_voice").supported === true);
  check("1.2 push suportado", flow(full, "receive_push").supported === true);
  check("1.3 anexo suportado", flow(full, "capture_attachment").supported === true);
  check("1.4 aprovar suportado (núcleo)", flow(full, "approve_action").supported === true);
  check("1.5 pwaInstallable (SW + não-desktop)", full.pwaInstallable === true);
  check("1.6 todos com caminho (CA1)", full.allCriticalHavePath === true);

  // ═══════════════ 2. cliente pelado (nada suportado) — CA1 garante fallback ═══════════════
  const bare = MOB.assess("org1", user, { platform: "android", browser: "chrome", serviceWorker: false, mediaRecorder: false, pushManager: false, fileInput: false, standalone: false });
  check("2.1 voz sem suporte → fallback type_text", flow(bare, "capture_voice").supported === false && flow(bare, "capture_voice").fallback === "type_text");
  check("2.2 push sem suporte → fallback in_app_bell", flow(bare, "receive_push").supported === false && flow(bare, "receive_push").fallback === "in_app_bell");
  check("2.3 anexo sem file input → fallback WhatsApp (conector opcional, CA1)", flow(bare, "capture_attachment").fallback === "share_whatsapp");
  check("2.4 aprovar AINDA funciona (núcleo browser-first)", flow(bare, "approve_action").supported === true);
  check("2.5 CA1: nada bloqueia + todos têm caminho", bare.flows.every((f: any) => f.blocking === false) && bare.allCriticalHavePath === true);

  // ═══════════════ 3. notas contextuais iOS ═══════════════
  const iosChrome = MOB.assess("org1", user, { platform: "ios", browser: "chrome", mediaRecorder: true, serviceWorker: true, pushManager: true, standalone: false });
  check("3.1 iOS fora do Safari: nota sobre voz", /safari/i.test(flow(iosChrome, "capture_voice").note || ""));
  check("3.2 iOS sem PWA: nota sobre push exigir instalação", /instalado|inicial|pwa/i.test(flow(iosChrome, "receive_push").note || ""));

  // ═══════════════ 4. sanitização de dicas ═══════════════
  const junk = MOB.assess("org1", user, { platform: "PwnOS" as any, browser: "<script>" as any });
  check("4.1 plataforma desconhecida → 'other'", junk.platform === "other");
  check("4.2 browser desconhecido → 'other'", junk.browser === "other");
  check("4.3 sem dicas ainda dá caminho (defaults seguros)", junk.allCriticalHavePath === true);

  // ═══════════════ 5. manifest do PWA ═══════════════
  const m = MOB.pwaManifest();
  check("5.1 manifest standalone + start_url", m.display === "standalone" && m.start_url === "/" && !!m.name);

  // ── relatório ──
  void randomUUID;
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mobile-readiness: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
