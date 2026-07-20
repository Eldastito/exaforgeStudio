/**
 * TEST — Pagamento Stone via Pagar.me (ADR-100, Fase 1: link de pagamento).
 *
 * A TOULON usa a maquininha Stone e quer receber na loja virtual por cartão,
 * Pix e boleto. O provider `stone` do PaymentService cria um Link de Pagamento
 * Pagar.me (core/v5/paymentlinks) a cada pedido e confirma sozinho pelo webhook
 * order.paid/charge.paid — reusando payment_charges + markPaid, exatamente como
 * o Mercado Pago.
 *
 * Como não há credenciais reais da Pagar.me no CI, este teste MOCKA o fetch
 * global e trava o contrato da requisição (host api.pagar.me, Basic auth com a
 * secret key, valor em centavos, code = id do pedido) + a persistência em
 * payment_charges + o mapeamento do webhook para markPaid. Se alguém quebrar o
 * host, a auth ou o casamento por `code`, o CI quebra.
 *
 * Uso: npm run test:stone-payment-link
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-stone-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-stone-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PaymentService } = await import("../src/server/PaymentService.js");

  // --- Org com provider stone + secret key + pedido aguardando pagamento ---
  const orgId = randomUUID();
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'TOULON', 'active')`).run(orgId);
  PaymentService.updateSettings(orgId, { enabled: true, provider: "stone", gatewayToken: "sk_test_TOULON_123" });

  const orderId = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'aguardando_pagamento', ?)`)
    .run(orderId, orgId, 149.9);

  // --- Mock do fetch global (não bate na Pagar.me) ---
  let calls = 0;
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedBody: any = null;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: any, init: any) => {
    calls++;
    capturedUrl = String(url);
    capturedAuth = init?.headers?.Authorization || init?.headers?.authorization || "";
    try { capturedBody = JSON.parse(init?.body || "{}"); } catch { capturedBody = null; }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "pl_STONE_ABC", url: "https://pagar.me/link/STONE_ABC" }),
      text: async () => "",
    } as any;
  };

  let msg: string | null = null;
  try {
    // ===== 1. chargeForOrder(stone) cria o link e monta a mensagem =====
    msg = await PaymentService.chargeForOrder(orgId, { orderId, amount: 149.9, contactName: "Cliente" });

    check("chargeForOrder retornou mensagem", !!msg);
    check("mensagem cita cartão/Pix/boleto", !!msg && /cart[ãa]o.*Pix.*boleto/i.test(msg));
    check("mensagem contém o link do pagamento", !!msg && msg.includes("https://pagar.me/link/STONE_ABC"));

    // ===== 2. Contrato da requisição à Pagar.me =====
    check("host correto (api.pagar.me core/v5/paymentlinks)", capturedUrl === "https://api.pagar.me/core/v5/paymentlinks");
    const expectedAuth = "Basic " + Buffer.from("sk_test_TOULON_123:").toString("base64");
    check("Basic auth = base64(secretKey:)", capturedAuth === expectedAuth);
    check("code = id do pedido (casa o webhook)", capturedBody?.code === orderId);
    check("metadata.reference = id do pedido", capturedBody?.metadata?.reference === orderId);
    check("aceita credit_card + pix + boleto", JSON.stringify(capturedBody?.payment_settings?.accepted_payment_methods) === JSON.stringify(["credit_card", "pix", "boleto"]));
    check("valor em centavos (14990)", capturedBody?.cart_settings?.items?.[0]?.amount === 14990);
    check("is_building = false (link já usável)", capturedBody?.is_building === false);

    // ===== 3. Persistência em payment_charges =====
    const charge = db.prepare(`SELECT * FROM payment_charges WHERE order_id = ? AND organization_id = ?`).get(orderId, orgId) as any;
    check("payment_charges criado", !!charge);
    check("provider = stone", charge?.provider === "stone");
    check("status = pending", charge?.status === "pending");
    check("ticket_url = link Pagar.me", charge?.ticket_url === "https://pagar.me/link/STONE_ABC");
    check("amount gravado em reais (149.9)", Math.abs(Number(charge?.amount) - 149.9) < 0.01);

    // orders reflete o gateway
    const ord1 = db.prepare(`SELECT payment_method, payment_link, payment_external_id FROM orders WHERE id = ?`).get(orderId) as any;
    check("orders.payment_method = stone", ord1?.payment_method === "stone");
    check("orders.payment_link salvo", ord1?.payment_link === "https://pagar.me/link/STONE_ABC");

    // ===== 4. Idempotência: 2ª cobrança reaproveita o link (sem novo fetch) =====
    const callsBefore = calls;
    const msg2 = await PaymentService.chargeForOrder(orgId, { orderId, amount: 149.9 });
    check("2ª cobrança reusa o link (não chama a Pagar.me de novo)", calls === callsBefore);
    check("2ª mensagem repete o mesmo link", !!msg2 && msg2.includes("https://pagar.me/link/STONE_ABC"));

    // ===== 5. Webhook order.paid → markPaid =====
    const before = db.prepare(`SELECT payment_status FROM orders WHERE id = ?`).get(orderId) as any;
    check("pedido ainda não pago antes do webhook", before?.payment_status !== "paid");

    const status = await PaymentService.syncStonePayment(orgId, {
      type: "order.paid",
      data: { id: "or_XYZ", code: orderId, status: "paid" },
    });
    check("syncStonePayment retornou 'paid'", status === "paid");

    const after = db.prepare(`SELECT payment_status, payment_method, status FROM orders WHERE id = ?`).get(orderId) as any;
    check("pedido marcado como pago", after?.payment_status === "paid");
    check("método registrado = stone", after?.payment_method === "stone");
    check("status avançou de aguardando_pagamento", after?.status !== "aguardando_pagamento");
    const chargePaid = db.prepare(`SELECT status FROM payment_charges WHERE order_id = ? AND organization_id = ?`).get(orderId, orgId) as any;
    check("payment_charges marcado paid", chargePaid?.status === "paid");

    // ===== 6. Eventos não-pagos são ignorados =====
    const ignored = await PaymentService.syncStonePayment(orgId, { type: "order.created", data: { code: orderId, status: "pending" } });
    check("evento não-pago é ignorado (retorna null)", ignored === null);

    // ===== 7. Isolamento: webhook sem ref conhecido não afeta nada =====
    const noRef = await PaymentService.syncStonePayment(orgId, { type: "order.paid", data: { id: "or_NADA", status: "paid" } });
    check("webhook sem code/reference retorna null", noRef === null);
  } finally {
    (globalThis as any).fetch = realFetch;
  }

  // --- Relatório ---
  console.log("\n=== TEST: Pagamento Stone (ADR-100) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Stone (link de pagamento) OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
