/**
 * TEST — PaymentService.chargeForReceivable (ADR-183 F1). DB-backed, determinístico (fetch
 * stubado — SEM rede). Prova: roteia pelo gateway POR-ORG (nunca a chave de plataforma);
 * reference `rcv:<id>` + idem `rcv-<id>`; idempotente (reusa pending); degrada honesto sem
 * gateway (never falls to ASAAS); pix_manual sem paymentId; NENHUMA chamada ao ASAAS.
 *
 * Uso: npm run test:charge-for-receivable
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-chgrcv-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-chgrcv-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Captura das chamadas fetch (pra provar destino/headers/body sem rede).
const calls: { url: string; init: any }[] = [];
(globalThis as any).fetch = async (url: string, init: any) => {
  calls.push({ url: String(url), init });
  // Resposta fake do Mercado Pago (PIX criado).
  return {
    ok: true, status: 201,
    json: async () => ({ id: "MP-PAY-1", status: "pending", point_of_interaction: { transaction_data: { qr_code: "QR-COPIA-COLA", qr_code_base64: "AAAA", ticket_url: "https://mp/ticket" } } }),
    text: async () => "",
  } as any;
};

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PaymentService: PAY } = await import("../src/server/PaymentService.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");

  const mkOrg = (provider: string, opts: { token?: string; pixKey?: string; enabled?: boolean } = {}) => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, pay_enabled, pay_provider) VALUES (?, ?, 'O', 'active', ?, ?)`)
      .run(randomUUID(), o, opts.enabled === false ? 0 : 1, provider);
    if (opts.token) db.prepare(`UPDATE organization_settings SET pay_gateway_token = ? WHERE organization_id = ?`).run(EncryptionService.encrypt(opts.token), o);
    if (opts.pixKey) db.prepare(`UPDATE organization_settings SET pay_pix_key = ?, pay_pix_name = 'Loja' WHERE organization_id = ?`).run(opts.pixKey, o);
    return o;
  };

  // 1. Mercado Pago (token por-org): cobra pelo gateway do LOJISTA, reference rcv:, idem rcv-.
  const A = mkOrg("mercadopago", { token: "MP-TOKEN-ORG-A" });
  const rid = "recv123";
  calls.length = 0;
  const r1 = await PAY.chargeForReceivable(A, { receivableId: rid, amount: 150 });
  check("1.1 ok + paymentId do gateway por-org", r1.ok === true && r1.paymentId === "MP-PAY-1" && r1.provider === "mercadopago");
  check("1.2 mensagem pronta pro WhatsApp com QR", !!r1.message && r1.message.includes("QR-COPIA-COLA"));
  const call = calls[0];
  check("1.3 chamou o Mercado Pago (não ASAAS)", call.url.includes("api.mercadopago.com") && !call.url.includes("asaas"));
  check("1.4 Authorization com o token do LOJISTA", call.init.headers.Authorization === "Bearer MP-TOKEN-ORG-A");
  check("1.5 X-Idempotency-Key = rcv-<id>", call.init.headers["X-Idempotency-Key"] === `rcv-${rid}`);
  const body = JSON.parse(call.init.body);
  check("1.6 external_reference = rcv:<id>", body.external_reference === `rcv:${rid}`);
  check("1.7 payment_charges persistido com order_id rcv:<id>", !!db.prepare(`SELECT 1 FROM payment_charges WHERE organization_id=? AND order_id=?`).get(A, `rcv:${rid}`));

  // 2. Idempotência: 2ª chamada reusa a cobrança pending (NÃO chama fetch de novo).
  calls.length = 0;
  const r2 = await PAY.chargeForReceivable(A, { receivableId: rid, amount: 150 });
  check("2.1 reusa pending (mesmo paymentId)", r2.ok === true && r2.paymentId === "MP-PAY-1");
  check("2.2 não chamou o gateway de novo", calls.length === 0);

  // 3. RN-COB-1/2: provider mercadopago SEM token → gateway_error, NUNCA cai na plataforma.
  const B = mkOrg("mercadopago", {}); // sem token
  calls.length = 0;
  const r3 = await PAY.chargeForReceivable(B, { receivableId: "r2", amount: 50 });
  check("3.1 sem token → ok false / gateway_error", r3.ok === false && r3.reason === "gateway_error");
  check("3.2 NUNCA chamou ASAAS nem nada", calls.length === 0);

  // 4. pay_enabled = 0 → not_enabled.
  const C = mkOrg("mercadopago", { token: "T", enabled: false });
  const r4 = await PAY.chargeForReceivable(C, { receivableId: "r3", amount: 50 });
  check("4.1 desabilitado → not_enabled", r4.ok === false && r4.reason === "not_enabled");

  // 5. pix_manual com chave → mensagem, SEM paymentId (sem auto-baixa, honesto).
  const D = mkOrg("pix_manual", { pixKey: "loja@pix.com" });
  const r5 = await PAY.chargeForReceivable(D, { receivableId: "r4", amount: 80 });
  check("5.1 pix_manual → ok + message, sem paymentId", r5.ok === true && !!r5.message && !r5.paymentId && r5.provider === "pix_manual");

  // 6. pix_manual SEM chave → manual_required (honesto).
  const E = mkOrg("pix_manual", {});
  const r6 = await PAY.chargeForReceivable(E, { receivableId: "r5", amount: 80 });
  check("6.1 pix_manual sem chave → manual_required", r6.ok === false && r6.reason === "manual_required");

  // 7. Valor inválido → not_enabled.
  const r7 = await PAY.chargeForReceivable(A, { receivableId: "r6", amount: 0 });
  check("7.1 amount 0 → not_enabled", r7.ok === false && r7.reason === "not_enabled");

  // 8. GLOBAL: em NENHUM momento houve chamada ao ASAAS (a chave de plataforma nunca é usada).
  const A2 = mkOrg("mercadopago", { token: "TK" });
  calls.length = 0;
  await PAY.chargeForReceivable(A2, { receivableId: "r7", amount: 10 });
  check("8.1 nenhuma chamada ao ASAAS em todo o fluxo", !calls.some((c) => c.url.includes("asaas")));

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} charge-for-receivable: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
