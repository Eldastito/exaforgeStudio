/**
 * TEST — F1.2a: dedup do inbound Meta/Cloud + Instagram (PRD WhatsApp Unificado,
 * achado X2 / INV-02).
 *
 * O handler `/api/webhooks/meta` (server.ts) passou a chamar
 * `claimWebhookEvent(provider, messageId)` ANTES de despachar a mensagem, com
 * provider='whatsapp_cloud'|'instagram' e messageId = wamid (message.id) ou
 * mid (messaging.message.mid). Sem isso, um retry da Meta reprocessava a mesma
 * mensagem → contato/ticket/resposta em duplicidade.
 *
 * Este teste trava o CONTRATO que o handler usa, com os provider strings REAIS
 * (o test:security-webhook cobre o primitivo com 'evolution'/'meta'):
 *  - wamid do WhatsApp Cloud: 1ª vez processa, replay ignora.
 *  - mid do Instagram: 1ª vez processa, replay ignora.
 *  - mesmo id em providers diferentes → independentes (chave é (provider,id)).
 *  - messageId vazio → processa (honesto: sem id não há como deduplicar).
 *  - replay não duplica a linha (UNIQUE).
 *
 * Uso: npm run test:meta-webhook-dedup
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-meta-dedup-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-meta-dedup-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { claimWebhookEvent } = await import("../src/server/webhookSecurity.js");

  // ── WhatsApp Cloud (wamid) ──
  const wamid = `wamid.${randomUUID().replace(/-/g, "")}`;
  check("1.1 wamid 1ª vez → processa (true)", claimWebhookEvent("whatsapp_cloud", wamid) === true);
  check("1.2 wamid replay → ignora (false)", claimWebhookEvent("whatsapp_cloud", wamid) === false);
  check("1.3 wamid 3º replay → ainda ignora", claimWebhookEvent("whatsapp_cloud", wamid) === false);

  // ── Instagram (mid) ──
  const mid = `mid.${randomUUID().replace(/-/g, "")}`;
  check("2.1 mid 1ª vez → processa (true)", claimWebhookEvent("instagram", mid) === true);
  check("2.2 mid replay → ignora (false)", claimWebhookEvent("instagram", mid) === false);

  // ── Independência por provider (chave é (provider, id)) ──
  const shared = `id_${randomUUID().slice(0, 10)}`;
  check("3.1 shared id sob whatsapp_cloud → processa", claimWebhookEvent("whatsapp_cloud", shared) === true);
  check("3.2 MESMO id sob instagram → processa (namespaces distintos)", claimWebhookEvent("instagram", shared) === true);
  check("3.3 replay do shared sob whatsapp_cloud → ignora", claimWebhookEvent("whatsapp_cloud", shared) === false);

  // ── Sem id → processa (honesto) ──
  check("4.1 messageId vazio → processa (não há como deduplicar)", claimWebhookEvent("whatsapp_cloud", "") === true && claimWebhookEvent("instagram", null) === true);

  // ── UNIQUE: replay não duplica linha ──
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM webhook_inbound_events WHERE provider='whatsapp_cloud' AND event_id=?`).get(wamid) as any).n;
  check("5.1 replay não duplica a linha (UNIQUE)", n === 1);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} meta-webhook-dedup: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
