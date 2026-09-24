/**
 * TESTE — Guard anti-lockout do enforcement do webhook do WhatsApp.
 * ----------------------------------------------------------------------------
 * Ligar o enforcement às cegas (sem a Evolution já mandar o segredo) derruba o
 * WhatsApp de entrada de TODOS os tenants (config global). O guard só deixa
 * ligar quando um segredo VÁLIDO foi visto recentemente. Prova:
 *   - sem segredo válido recente → canEnable=false (bloqueia);
 *   - após noteValidSecretSeen → canEnable=true (libera);
 *   - segredo válido antigo (fora da janela) → volta a bloquear;
 *   - já enforçado → canEnable=true (idempotente, não trava rollback→religar).
 *
 * Uso:  npm run test:webhook-enforce-guard
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-wh-enforce-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-wh-enforce-1234567890";
delete process.env.WEBHOOK_SECRET;
delete process.env.WEBHOOK_STRICT;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const w = await import("../src/server/webhookSecurity.js");
  const NOW = 1_000_000_000_000;
  const WINDOW = 30 * 60 * 1000;

  // ── 0. Estado inicial: nada visto, não enforçado ──
  check("0.1 sem segredo válido → getLastValidSecretAt null", w.getLastValidSecretAt() === null);
  check("0.2 não enforçado + nada recente → canEnable=false", w.enforcementReadiness(WINDOW, NOW).canEnable === false, JSON.stringify(w.enforcementReadiness(WINDOW, NOW)));

  // ── 1. Viu segredo válido agora → libera ──
  w.noteValidSecretSeen(NOW);
  check("1.1 registra o instante", w.getLastValidSecretAt() === NOW);
  const r1 = w.enforcementReadiness(WINDOW, NOW + 60_000); // 1 min depois
  check("1.2 dentro da janela → recentValid + canEnable", r1.recentValid === true && r1.canEnable === true, JSON.stringify(r1));

  // ── 2. Segredo válido ANTIGO (fora da janela) → bloqueia de novo ──
  const r2 = w.enforcementReadiness(WINDOW, NOW + 40 * 60 * 1000); // 40 min depois
  check("2.1 fora da janela → recentValid=false, canEnable=false", r2.recentValid === false && r2.canEnable === false, JSON.stringify(r2));

  // ── 3. Já enforçado → canEnable=true mesmo sem visto recente (idempotente) ──
  w.setWebhookEnforced(true);
  const r3 = w.enforcementReadiness(WINDOW, NOW + 40 * 60 * 1000);
  check("3.1 enforçado → enforced=true e canEnable=true", r3.enforced === true && r3.canEnable === true, JSON.stringify(r3));
  w.setWebhookEnforced(false);
  check("3.2 desligar volta enforced=false", w.enforcementReadiness(WINDOW, NOW + 40 * 60 * 1000).enforced === false);

  // ── 4. usingEnv refletido (env força enforcement; toggle nem se aplica) ──
  process.env.WEBHOOK_SECRET = "whk_env_forced_secret_value";
  const r4 = w.enforcementReadiness(WINDOW, NOW + 40 * 60 * 1000);
  check("4.1 com env: usingEnv=true e enforced=true", r4.usingEnv === true && r4.enforced === true, JSON.stringify(r4));
  delete process.env.WEBHOOK_SECRET;

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} webhook-enforce-guard: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
