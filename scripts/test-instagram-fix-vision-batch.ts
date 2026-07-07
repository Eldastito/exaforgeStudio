/**
 * TEST — Instagram DM fix (host + subscribed_apps + falha visível) +
 *        Vision storage calculator §16.2 + Vision access logs §19.1 +
 *        Vision event.reviewed webhook.
 * -----------------------------------------------------------------------
 * Roda num banco TEMPORÁRIO. Uso: npm run test:instagram-fix-vision-batch
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ig-vision-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ig-vision-1234567890abcdef";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  // ==== PART 1: Instagram send host correction ====
  console.log("\n=== PART 1: Instagram DM send fix ===");
  const { default: db } = await import("../src/server/db.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");

  // Interceptamos o fetch global para inspecionar host/endpoint/body sem
  // fazer chamada real de rede — assim validamos que o Instagram agora vai
  // para graph.instagram.com em vez de graph.facebook.com (o bug corrigido).
  const originalFetch = globalThis.fetch;
  let lastCall: { url: string; body: any } | null = null;
  globalThis.fetch = (async (input: any, init?: any) => {
    lastCall = { url: String(input), body: init?.body ? JSON.parse(init.body) : null };
    return new Response("{}", { status: 200 }) as any;
  }) as any;

  // Cria organização e canal Instagram
  const orgIg = `org_ig_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
    .run(randomUUID(), orgIg, "Loja IG");
  const chIg = `ch_ig_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, token_encrypted, status) VALUES (?, ?, 'instagram', 'Instagram Direct', '17841400000000000', 'ig-user-token-xyz', 'connected')`).run(chIg, orgIg);

  await MessageProviderService.sendMessage(chIg, "1234567890", "Olá!");
  check("1.1 Instagram send usa graph.instagram.com", !!lastCall && lastCall.url.startsWith("https://graph.instagram.com/"));
  check("1.2 Endpoint é /v21.0/me/messages", !!lastCall && lastCall.url.includes("/v21.0/me/messages"));
  check("1.3 Body traz recipient.id e message.text", !!lastCall && lastCall.body?.recipient?.id === "1234567890" && lastCall.body?.message?.text === "Olá!");
  check("1.4 NÃO usa graph.facebook.com (bug antigo)", !!lastCall && !lastCall.url.includes("graph.facebook.com"));

  // Regressão: WhatsApp Cloud continua indo para graph.facebook.com
  const chWa = `ch_wa_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, token_encrypted, status) VALUES (?, ?, 'whatsapp_cloud', 'WA', '999888', 'wa-token', 'connected')`).run(chWa, orgIg);
  await MessageProviderService.sendMessage(chWa, "5511900000000", "Oi!");
  check("1.5 WhatsApp continua em graph.facebook.com (não regrediu)", !!lastCall && lastCall.url.startsWith("https://graph.facebook.com/"));

  globalThis.fetch = originalFetch;

  // ==== PART 2: Colunas delivery_status/delivery_error em messages ====
  console.log("\n=== PART 2: delivery_status em messages ===");
  const msgCols = db.prepare(`PRAGMA table_info(messages)`).all() as any[];
  const has = (col: string) => msgCols.some((c: any) => c.name === col);
  check("2.1 messages.delivery_status existe", has("delivery_status"));
  check("2.2 messages.delivery_error existe", has("delivery_error"));

  // Simula uma mensagem enviada com sucesso e outra falhada
  const ticketId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, 'X', '5511100000000')`).run(randomUUID(), orgIg, chIg);
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage) VALUES (?, ?, ?, 'open', 'novo_lead')`).run(ticketId, orgIg, randomUUID());
  const okMsg = randomUUID();
  const badMsg = randomUUID();
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, delivery_status) VALUES (?, ?, ?, 'bot', 'ok', 'sent')`).run(okMsg, orgIg, ticketId);
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, delivery_status, delivery_error) VALUES (?, ?, ?, 'bot', 'fail', 'failed', 'token expired')`).run(badMsg, orgIg, ticketId);
  const bad = db.prepare(`SELECT delivery_status, delivery_error FROM messages WHERE id = ?`).get(badMsg) as any;
  check("2.3 Persiste 'failed' + motivo", bad.delivery_status === "failed" && bad.delivery_error === "token expired");

  // ==== PART 3: Vision storage calculator §16.2 ====
  console.log("\n=== PART 3: Vision storage calculator ===");
  const { calculateStorage } = await import("../apps/vision-cloud/storageCalc.js");

  // 4 câmeras 1080p H.264 15fps 24h/dia por 30 dias
  // bitrate = 3 Mbps → 3 * 0.125 = 0.375 MB/s → * 86400s = 32400 MB/dia
  // por câmera = 31.64 GB/dia; total 30d 4 câmeras = ~3796 GB = ~3.71 TB
  const r1 = calculateStorage({ cameras: 4, resolution: "1080p", codec: "h264", retentionDays: 30 });
  check("3.1 1080p H.264 4 câmeras 30d ≈ 3800 GB (±100)", Math.abs(r1.totalGb - 3800) < 100, `total=${r1.totalGb}`);
  check("3.2 bitrate ≈ 3 Mbps", Math.abs(r1.bitrateMbpsPerCamera - 3) < 0.1);

  // H.265 economiza ~50%
  const r2 = calculateStorage({ cameras: 4, resolution: "1080p", codec: "h265", retentionDays: 30 });
  check("3.3 H.265 usa ~metade do H.264", Math.abs(r2.totalGb / r1.totalGb - 0.5) < 0.05);

  // MJPEG gasta ~5x mais
  const r3 = calculateStorage({ cameras: 1, resolution: "720p", codec: "mjpeg", retentionDays: 1 });
  const r3Base = calculateStorage({ cameras: 1, resolution: "720p", codec: "h264", retentionDays: 1 });
  check("3.4 MJPEG usa ~5x do H.264", Math.abs(r3.totalGb / r3Base.totalGb - 5) < 0.2);

  // Motion-only 30% reduz para 30%
  const rMotion = calculateStorage({ cameras: 4, resolution: "1080p", codec: "h264", retentionDays: 30, motionOnlyFactor: 0.3 });
  check("3.5 motionOnlyFactor 0.3 → ~30% do contínuo", Math.abs(rMotion.totalGb / r1.totalGb - 0.3) < 0.05);

  // Sanidade: input inválido cai para defaults
  const rBad = calculateStorage({ cameras: 0, resolution: "bogus" as any, codec: "xyz" as any, fps: 999, hoursPerDay: -5, retentionDays: 0 });
  check("3.6 Input inválido usa defaults, retenção mínima 1 dia", rBad.assumptions.retentionDays === 1 && rBad.assumptions.codec === "h264");

  // ==== PART 4: Vision access logs §19.1 ====
  console.log("\n=== PART 4: Vision access logs ===");
  const { default: visionDb, initVisionDb } = await import("../apps/vision-cloud/db.js");
  initVisionDb();
  const { recordAccess, listAccess } = await import("../apps/vision-cloud/accessLogs.js");

  const visionOrg = `org_v_${randomUUID().slice(0, 6)}`;
  const cam1 = randomUUID();
  const user1 = randomUUID();
  const id1 = recordAccess({ organizationId: visionOrg, userId: user1, cameraId: cam1, action: "live_view", userAgent: "chrome/x", ipAddress: "10.0.0.1" });
  const id2 = recordAccess({ organizationId: visionOrg, userId: user1, cameraId: cam1, action: "playback", windowStart: "2026-07-01T12:00:00Z", windowEnd: "2026-07-01T13:00:00Z" });
  const id3 = recordAccess({ organizationId: visionOrg, userId: user1, cameraId: cam1, action: "export", targetRef: "incident-42" });
  check("4.1 3 acessos registrados", !!id1 && !!id2 && !!id3);

  // action inválida vira null
  const idBad = recordAccess({ organizationId: visionOrg, userId: user1, cameraId: cam1, action: "spy" as any });
  check("4.2 Action inválida rejeitada", idBad === null);

  const logs = listAccess(visionOrg);
  check("4.3 Listagem por org retorna 3", logs.length === 3);
  check("4.4 Ordenado por created_at DESC (export mais recente)", logs[0].action === "export");

  const filtered = listAccess(visionOrg, { action: "playback" });
  check("4.5 Filtro por action=playback funciona", filtered.length === 1 && filtered[0].action === "playback");

  // Isolamento: outra org não vê
  const otherOrg = `org_x_${randomUUID().slice(0, 6)}`;
  check("4.6 Outra org não vê os logs", listAccess(otherOrg).length === 0);

  // ==== PART 5: Vision webhook event.reviewed ====
  console.log("\n=== PART 5: vision.event.reviewed topic ====");
  const { EVENT_TOPICS, isValidWebhookTopic, enqueueWebhookDeliveries } = await import("../apps/vision-cloud/webhooks.js");
  check("5.1 vision.event.reviewed é topic válido", isValidWebhookTopic("vision.event.reviewed"));
  check("5.2 vision.event.detected continua válido (regressão)", isValidWebhookTopic("vision.event.detected"));
  check("5.3 topic inválido rejeitado", !isValidWebhookTopic("vision.event.hacked"));

  // Cria webhook ativo e enfileira uma entrega no novo tópico
  const { encryptSecret } = await import("../apps/vision-cloud/crypto.js");
  const whId = randomUUID();
  visionDb.prepare(`INSERT INTO vision_webhooks (id, organization_id, url, secret_enc, event_types, is_active, created_by) VALUES (?, ?, ?, ?, ?, 1, ?)`)
    .run(whId, visionOrg, "https://example.com/hook", encryptSecret("secret-x"), JSON.stringify(["vision.event.reviewed"]), user1);
  enqueueWebhookDeliveries(visionOrg, "vision.event.reviewed" as any, { event_id: "evt-1", status: "resolved" });
  const dCount = (visionDb.prepare(`SELECT COUNT(*) c FROM vision_webhook_deliveries WHERE webhook_id = ? AND event_type = 'vision.event.reviewed'`).get(whId) as any).c;
  check("5.4 Entrega enfileirada p/ webhook subscrito no novo topic", dCount === 1);

  // ---- Summary ----
  console.log("\n──── Resultados ────");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` [${r.detail}]` : ""}`);
  }
  console.log(`\n${results.length} verificações, ${failures} falha(s).`);
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
