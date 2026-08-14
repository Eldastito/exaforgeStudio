/**
 * TEST — Webhook default-on switch + anti-replay (SEC-F5/F6 / SEC-05, achados A3/A7). DB-backed.
 *
 * Prova:
 *  - F5: `isWebhookEnforced()` liga por `WEBHOOK_SECRET`, `WEBHOOK_STRICT=1`, config, ou org clínica.
 *  - F6: `claimWebhookEvent(provider,eventId)` deixa passar a 1ª vez e BLOQUEIA o replay; sem
 *    event_id não bloqueia (não há como deduplicar); erro de storage nunca derruba a entrega.
 *
 * Uso: npm run test:security-webhook
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sec-whk-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-sec-whk-1";
delete process.env.WEBHOOK_SECRET; delete process.env.WEBHOOK_STRICT;

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const whk = await import("../src/server/webhookSecurity.js");

  // ── F5: enforcement liga pelos gatilhos certos ──
  check("F5.1 sem segredo/flag/clínica → não exige (default histórico)", whk.isWebhookEnforced() === false);
  process.env.WEBHOOK_STRICT = "1";
  check("F5.2 WEBHOOK_STRICT=1 → EXIGE (opt-in, sem depender de clínica)", whk.isWebhookEnforced() === true);
  delete process.env.WEBHOOK_STRICT;
  process.env.WEBHOOK_SECRET = "whk_env";
  check("F5.3 WEBHOOK_SECRET no ambiente → EXIGE", whk.isWebhookEnforced() === true);
  delete process.env.WEBHOOK_SECRET;
  check("F5.4 removida a env → volta a não exigir", whk.isWebhookEnforced() === false);
  // org clínica também liga
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, enabled_modules) VALUES (?, 'org_clin', 'Clin', 'active', 'agenda,clinica')`).run(`os-clin`);
  check("F5.5 org com módulo clínica → EXIGE (Fase 30)", whk.isWebhookEnforced() === true);

  // ── F6: anti-replay ──
  const evt = `msg_${randomUUID().slice(0, 8)}`;
  check("F6.1 1ª vez do evento → processa (true)", whk.claimWebhookEvent("evolution", evt) === true);
  check("F6.2 replay do MESMO evento → ignora (false)", whk.claimWebhookEvent("evolution", evt) === false);
  check("F6.3 3º replay → ainda ignora", whk.claimWebhookEvent("evolution", evt) === false);
  check("F6.4 evento diferente → processa", whk.claimWebhookEvent("evolution", `outro_${randomUUID().slice(0,6)}`) === true);
  check("F6.5 mesmo id em OUTRO provider → processa (chave é (provider,event_id))", whk.claimWebhookEvent("meta", evt) === true);
  check("F6.6 sem event_id → processa (não há como deduplicar; não bloqueia 1ª entrega)", whk.claimWebhookEvent("evolution", null) === true && whk.claimWebhookEvent("evolution", "") === true);

  // persistiu exatamente uma linha do primeiro evento
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM webhook_inbound_events WHERE provider='evolution' AND event_id=?`).get(evt) as any).n;
  check("F6.7 replay não duplica a linha (UNIQUE)", n === 1);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} security-webhook: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
