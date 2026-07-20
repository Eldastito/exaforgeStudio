/**
 * TEST — Cobrança ZappFlow → lojista via ASAAS (ADR-091 Bloco B, PR B1).
 *
 * Trava o núcleo money-critical: assinatura (cliente+subscription), webhook
 * idempotente com re-consulta do pagamento (não confia no payload), transição
 * de billing_status, autenticação do webhook e cancelamento. fetch mockado.
 *
 * Uso: npm run test:asaas-billing
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-asaas-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-asaas-1234567890";
process.env.ASAAS_API_KEY = "test_key";
process.env.ASAAS_WEBHOOK_TOKEN = "whtoken";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AsaasService } = await import("../src/server/AsaasService.js");
  const { PlanService } = await import("../src/server/PlanService.js");

  // --- Mock fetch (roteia por URL) ---
  let paymentStatus = "CONFIRMED"; // controlado por cenário (re-consulta)
  const calls: string[] = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    const u = String(url); const m = init?.method || "GET"; calls.push(`${m} ${u}`);
    let body: any = {};
    if (/\/customers$/.test(u) && m === "POST") body = { id: "cus_1" };
    else if (/\/subscriptions$/.test(u) && m === "POST") body = { id: "sub_1" };
    else if (/\/payments\//.test(u) && m === "GET") body = { id: "pay_1", status: paymentStatus, value: 597, dueDate: "2026-08-20" };
    else if (/\/subscriptions\/sub_1\/payments$/.test(u)) body = { data: [{ id: "pay_1", status: paymentStatus, value: 597, dueDate: "2026-08-20", invoiceUrl: "https://asaas/i/pay_1" }] };
    else if (/\/subscriptions\/sub_1$/.test(u) && m === "DELETE") body = { deleted: true };
    return { ok: true, status: 200, json: async () => body, text: async () => "" } as any;
  };

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'TOULON', 'active', 'growth', 'trialing')`).run(randomUUID(), orgId);
  const billingOf = () => (db.prepare(`SELECT billing_status, current_period_end, external_customer_id, external_subscription_id, payment_provider, billing_dunning_stage FROM organization_settings WHERE organization_id = ?`).get(orgId) as any);

  // ===== 1. Assinatura: cria cliente + subscription e persiste os ids =====
  const sub = await AsaasService.subscribe(orgId, { customer: { name: "TOULON", email: "dono@toulon.com", cpfCnpj: "12345678000190" }, value: 597, description: "ZappFlow Growth", nextDueDate: "2026-08-20" });
  check("subscribe retornou subscriptionId", sub?.subscriptionId === "sub_1");
  const s1 = billingOf();
  check("external_customer_id persistido", s1.external_customer_id === "cus_1");
  check("external_subscription_id persistido", s1.external_subscription_id === "sub_1");
  check("payment_provider = asaas", s1.payment_provider === "asaas");

  // ===== 2. Webhook PAYMENT_CONFIRMED (token válido) → active + período =====
  const evConfirmed = { id: "evt_1", event: "PAYMENT_CONFIRMED", payment: { id: "pay_1", subscription: "sub_1", customer: "cus_1", status: "CONFIRMED", dueDate: "2026-08-20" } };
  const r2 = await AsaasService.handleWebhook({ "asaas-access-token": "whtoken" }, evConfirmed);
  check("webhook confirmado processou (ok)", r2.status === "ok" && r2.billing === "active");
  check("billing_status = active", billingOf().billing_status === "active");
  check("period_end setado do vencimento", billingOf().current_period_end === "2026-08-20");

  // ===== 3. Idempotência: mesmo evt_1 não re-processa =====
  PlanService.setBillingStatus(orgId, "past_due"); // simula estado posterior
  const r3 = await AsaasService.handleWebhook({ "asaas-access-token": "whtoken" }, evConfirmed);
  check("evento repetido é 'duplicate'", r3.status === "duplicate");
  check("billing NÃO voltou pra active (dedupe)", billingOf().billing_status === "past_due");

  // ===== 4. PAYMENT_OVERDUE (novo evento) → past_due =====
  paymentStatus = "OVERDUE";
  const r4 = await AsaasService.handleWebhook({ "asaas-access-token": "whtoken" }, { id: "evt_2", event: "PAYMENT_OVERDUE", payment: { id: "pay_1", subscription: "sub_1", status: "OVERDUE" } });
  check("overdue → past_due", r4.billing === "past_due" && billingOf().billing_status === "past_due");

  // ===== 5. Re-consulta protege: evento diz CONFIRMED mas ASAAS diz PENDING =====
  paymentStatus = "PENDING";
  const r5 = await AsaasService.handleWebhook({ "asaas-access-token": "whtoken" }, { id: "evt_3", event: "PAYMENT_CONFIRMED", payment: { id: "pay_1", subscription: "sub_1", status: "CONFIRMED" } });
  check("payload CONFIRMED mas re-consulta PENDING → NÃO ativa", r5.billing === "unchanged" && billingOf().billing_status === "past_due");

  // ===== 6. Token inválido → unauthorized (não processa) =====
  const r6 = await AsaasService.handleWebhook({ "asaas-access-token": "errado" }, { id: "evt_4", event: "PAYMENT_CONFIRMED", payment: { id: "pay_1", subscription: "sub_1" } });
  check("token inválido → unauthorized", r6.status === "unauthorized");
  check("evento com token inválido NÃO foi gravado", !db.prepare(`SELECT 1 FROM asaas_webhook_events WHERE id = 'evt_4'`).get());

  // ===== 7. Voltar a pagar zera a régua de inadimplência =====
  db.prepare(`UPDATE organization_settings SET billing_dunning_stage = 'D+7' WHERE organization_id = ?`).run(orgId);
  paymentStatus = "CONFIRMED";
  await AsaasService.handleWebhook({ "asaas-access-token": "whtoken" }, { id: "evt_5", event: "PAYMENT_RECEIVED", payment: { id: "pay_1", subscription: "sub_1", status: "RECEIVED", dueDate: "2026-09-20" } });
  check("pagamento em dia → active + régua zerada", billingOf().billing_status === "active" && billingOf().billing_dunning_stage == null);

  // ===== 8. Cancelamento =====
  const cancelled = await AsaasService.cancelSubscription(orgId);
  check("cancelSubscription ok", cancelled && billingOf().billing_status === "cancelled");

  // ===== 9. listInvoices normaliza =====
  const invs = await AsaasService.listInvoices(orgId);
  check("listInvoices retorna fatura com invoiceUrl", invs.length === 1 && invs[0].invoiceUrl === "https://asaas/i/pay_1");

  // --- Relatório ---
  console.log("\n=== TEST: Cobrança ASAAS (ADR-091 Bloco B) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Cobrança ASAAS OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
