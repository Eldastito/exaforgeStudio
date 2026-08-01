/**
 * TEST — Comigo/Pix dinâmico com PSP real (Mercado Pago, Gap G, ADR-149).
 *
 * Prova, offline e com fetch mockado (SEM bater na API real do MP):
 *   - provider=mock (default) mantém comportamento antigo (test-comigo-pix cobre).
 *   - provider=mercadopago sem pay_gateway_token → provider_failed.
 *   - provider=mercadopago OK: chama /v1/payments com Bearer + Idempotency-Key,
 *     salva external_id, qr_code_base64, txid = paymentId, provider=mercadopago.
 *   - external_reference sempre "cmg:<orderId>".
 *   - Idempotente por pedido: 2ª chamada reusa (não chama fetch de novo).
 *   - MP responde !ok → provider_failed (NÃO cai pro mock silenciosamente).
 *   - MP responde sem qr_code → provider_failed.
 *   - fetch lança → provider_failed.
 *   - confirmByReference fecha o pedido como pix_dyn (rota do webhook geral).
 *   - Idempotência do webhook: 2ª entrega não paga duas vezes.
 *   - Isolamento entre orgs: cobrança da orgA não é confirmada com orgB.
 *
 * Uso: npm run test:comigo-pix-mp
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-pix-mp-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-pix-mp-1234567890";
process.env.COMIGO_PIX_PROVIDER = "mercadopago";
process.env.APP_URL = "https://app.exaforge.test";
// Precisa ENCRYPTION_KEY dedicada pra armazenar o token cifrado da org.
process.env.ENCRYPTION_KEY = "0".repeat(64);

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoPixService, _internals } = await import("../src/server/ComigoPixService.js");
  const { BalcaoService } = await import("../src/server/BalcaoService.js");

  // Duas orgs; orgA com token MP; orgB sem token.
  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, pay_gateway_token) VALUES (?, ?, 'A', 'active', 'APP_USR-fake-token-A')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), orgB);

  // Pedido aberto R$25 na orgA.
  const o1 = BalcaoService.openOrder(orgA, { sessionAlias: "Zé" });
  BalcaoService.addItem(orgA, o1, { name: "Pizza", unitPrice: 25 });

  // ── 1. Sem token → provider_failed ────────────────────────────────────────
  const oB = BalcaoService.openOrder(orgB, {});
  BalcaoService.addItem(orgB, oB, { name: "Coca", unitPrice: 8 });
  _internals.setFetchFn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  const noToken = await ComigoPixService.createCharge(orgB, oB) as any;
  check("sem token → provider_failed", noToken.ok === false && noToken.error === "provider_failed");

  // ── 2. MP OK: chama URL/headers/body corretos ─────────────────────────────
  let calls: any[] = [];
  const fakePaymentId = "9876543210";
  const fakeQrCode = "00020126...MP-FAKE-PIX";
  const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAA==";
  _internals.setFetchFn(async (url: any, init: any) => {
    calls.push({ url, init });
    return {
      ok: true, status: 201,
      json: async () => ({
        id: fakePaymentId,
        status: "pending",
        point_of_interaction: { transaction_data: { qr_code: fakeQrCode, qr_code_base64: fakeBase64, ticket_url: "https://mp.test/ticket" } },
      }),
    };
  });
  const c1 = await ComigoPixService.createCharge(orgA, o1) as any;
  check("MP OK → ok=true", c1.ok === true);
  check("MP OK → provider=mercadopago", c1.provider === "mercadopago");
  check("MP OK → txid = payment id", c1.txid === fakePaymentId);
  check("MP OK → qrPayload é o qr_code do MP (não mock)", c1.qrPayload === fakeQrCode);
  check("MP OK → qrCodeBase64 preservado", c1.qrCodeBase64 === fakeBase64);
  check("MP OK → ticketUrl preservado", c1.ticketUrl === "https://mp.test/ticket");
  check("fetch chamado 1 vez", calls.length === 1);
  const call = calls[0];
  check("URL correta (/v1/payments)", String(call.url).endsWith("/v1/payments"));
  check("Authorization Bearer com token da org", call.init.headers.Authorization === "Bearer APP_USR-fake-token-A");
  check("X-Idempotency-Key = cmg-<orderId>", call.init.headers["X-Idempotency-Key"] === `cmg-${o1}`);
  const body = JSON.parse(call.init.body);
  check("body.external_reference = cmg:<orderId>", body.external_reference === `cmg:${o1}`);
  check("body.payment_method_id = pix", body.payment_method_id === "pix");
  check("body.transaction_amount = 25", body.transaction_amount === 25);
  check("body.notification_url aponta pra /api/webhooks/payment", String(body.notification_url).includes("/api/webhooks/payment?secret="));

  // ── 3. Idempotente por pedido: 2ª chamada reusa (sem chamar fetch) ───────
  calls = [];
  const c2 = await ComigoPixService.createCharge(orgA, o1) as any;
  check("2ª chamada reusa cobrança pendente", c2.reused === true && c2.txid === c1.txid);
  check("2ª chamada NÃO chama fetch (reuso)", calls.length === 0);

  // ── 4. MP responde !ok → provider_failed (não cai pro mock) ──────────────
  const o2 = BalcaoService.openOrder(orgA, {});
  BalcaoService.addItem(orgA, o2, { name: "Salgado", unitPrice: 5 });
  _internals.setFetchFn(async () => ({ ok: false, status: 400, json: async () => ({ message: "invalid" }) }));
  const failed = await ComigoPixService.createCharge(orgA, o2) as any;
  check("MP 400 → provider_failed", failed.ok === false && failed.error === "provider_failed");
  const chargedAny = db.prepare("SELECT COUNT(*) c FROM comigo_pix_charges WHERE order_id = ?").get(o2) as any;
  check("MP 400 → não grava cobrança falhada", chargedAny.c === 0);

  // ── 5. MP responde sem qr_code → provider_failed ──────────────────────────
  const o3 = BalcaoService.openOrder(orgA, {});
  BalcaoService.addItem(orgA, o3, { name: "Item X", unitPrice: 10 });
  _internals.setFetchFn(async () => ({ ok: true, status: 200, json: async () => ({ id: "1", status: "pending", point_of_interaction: { transaction_data: {} } }) }));
  const noQr = await ComigoPixService.createCharge(orgA, o3) as any;
  check("MP sem qr_code → provider_failed", noQr.ok === false && noQr.error === "provider_failed");

  // ── 6. fetch lança → provider_failed ─────────────────────────────────────
  const o4 = BalcaoService.openOrder(orgA, {});
  BalcaoService.addItem(orgA, o4, { name: "Item Y", unitPrice: 12 });
  _internals.setFetchFn(async () => { throw new Error("network_down"); });
  const thrown = await ComigoPixService.createCharge(orgA, o4) as any;
  check("fetch lança → provider_failed", thrown.ok === false && thrown.error === "provider_failed");

  // ── 7. confirmByReference fecha o pedido como pix_dyn ────────────────────
  const confirmed = ComigoPixService.confirmByReference(orgA, o1, fakePaymentId) as any;
  check("confirmByReference → ok", confirmed.ok === true);
  check("confirmByReference → orderClosed", confirmed.orderClosed === true);
  const ord = db.prepare("SELECT status, paid_via FROM comigo_orders WHERE id=?").get(o1) as any;
  check("pedido paid via pix_dyn", ord.status === "paid" && ord.paid_via === "pix_dyn");
  const chg = db.prepare("SELECT status, external_id FROM comigo_pix_charges WHERE order_id=?").get(o1) as any;
  check("cobrança marcada paid", chg.status === "paid");
  check("external_id preservado do MP", chg.external_id === fakePaymentId);

  // ── 8. Idempotência do webhook: 2ª entrega = alreadyPaid ─────────────────
  const again = ComigoPixService.confirmByReference(orgA, o1, fakePaymentId) as any;
  check("2ª confirmação = alreadyPaid", again.ok === true && again.alreadyPaid === true);

  // ── 9. Isolamento entre orgs: orgB não confirma pedido da orgA ───────────
  const leak = ComigoPixService.confirmByReference(orgB, o1) as any;
  check("isolamento cross-org", leak.ok === false && leak.error === "charge_not_found");

  // Reseta pra suites em conjunto.
  _internals.setFetchFn(null);
  delete process.env.COMIGO_PIX_PROVIDER;

  // ── Relatório ────────────────────────────────────────────────────────────
  console.log("\n=== TEST: Comigo — Pix PSP real (Mercado Pago, Gap G, ADR-149) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Pix Mercado Pago OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
