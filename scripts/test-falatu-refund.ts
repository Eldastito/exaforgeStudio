/**
 * TEST — ADR-154 F2.2 (Fatia E): reembolso automático da garantia de 7 dias.
 *
 * Cobre o mecanismo money-critical:
 *  - elegibilidade pela JANELA (guarantee_days, ancorada em falatu_terms_accepted_at);
 *  - requestRefund: estorna os pagamentos PAGOS no ASAAS, cancela a assinatura,
 *    marca 'cancelled' e audita FALATU_REFUND_ISSUED;
 *  - idempotência (RN-E3): 2ª chamada → already_refunded;
 *  - guardrails: fora da janela (guarantee_expired), plano B2B (not_falatu_plan),
 *    sem gateway (billing_not_configured), sem pagamento pago (cancela mesmo assim);
 *  - AsaasService.refundPayment bate no endpoint certo (POST /payments/{id}/refund);
 *  - reconciliação do webhook PAYMENT_REFUNDED: org já 'cancelled' NÃO vira 'suspended';
 *  - rota autenticada GET /refund/eligibility + POST /refund.
 *
 * ASAAS via `fetch` STUBADO; a lógica de janela usa clock INJETADO (nowMs).
 * Uso: npm run test:falatu-refund
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import express from "express";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-refund-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-refund-123456";
process.env.ASAAS_API_KEY = "asaas-test-key"; // isConfigured() = true
delete process.env.ASAAS_WEBHOOK_TOKEN;        // webhook passa sem token (dev)
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// ---- Stub do fetch: só o que a rota real / webhook / refundPayment tocam ----
const calls: Array<{ method: string; url: string }> = [];
(global as any).fetch = async (url: any, init: any) => {
  const method = String(init?.method || "GET").toUpperCase();
  const u = String(url);
  calls.push({ method, url: u });
  const json = (data: any) => ({ ok: true, status: 200, json: async () => data });
  if (method === "GET" && /\/subscriptions\/sub_route\/payments$/.test(u))
    return json({ data: [{ id: "pay_route", status: "CONFIRMED", value: 19, dueDate: "2026-08-08", invoiceUrl: "https://asaas.test/i/pay_route" }] });
  if (method === "POST" && /\/payments\/[^/]+\/refund$/.test(u)) { const id = u.match(/\/payments\/([^/]+)\/refund/)![1]; return json({ id, status: "REFUNDED" }); }
  if (method === "DELETE" && /\/subscriptions\/sub_route$/.test(u)) return json({ deleted: true });
  if (method === "GET" && /\/payments\/[^/]+$/.test(u)) { const id = u.match(/\/payments\/([^/]+)$/)![1]; return json({ id, status: "REFUNDED" }); }
  return { ok: false, status: 404, json: async () => ({ errors: [{ description: "not stubbed" }] }) };
};

const WITHIN = Date.parse("2026-08-09T00:00:00Z");  // 1 dia após o aceite
const EXPIRED = Date.parse("2026-08-20T00:00:00Z"); // 12 dias após o aceite
const ACCEPTED = "2026-08-08 00:00:00";             // formato do SQLite CURRENT_TIMESTAMP (UTC)

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalatuRefundService, FalatuRefundError } = await import("../src/server/FalatuRefundService.js");
  const { AsaasService } = await import("../src/server/AsaasService.js");
  const { PlanService } = await import("../src/server/PlanService.js");
  const falatuRoutes = (await import("../src/server/routes/falatu.js")).default;

  function seedOrg(orgId: string, opts: { planId?: string; billing?: string; acceptedAt?: string | null; subId?: string | null } = {}) {
    const { planId = "falatu_solo", billing = "active", acceptedAt = ACCEPTED, subId = null } = opts;
    db.prepare(`
      INSERT INTO organization_settings
        (id, organization_id, business_name, vertical, status, onboarding_status, plan_id, billing_status, default_landing_view, payment_provider, external_customer_id, external_subscription_id, falatu_enabled, falatu_terms_version, falatu_terms_accepted_at)
      VALUES (?, ?, ?, 'servicos', 'active', 'completed', ?, ?, 'falatu', ?, ?, ?, 1, '2026-08-08', ?)
    `).run(randomUUID(), orgId, "Org " + orgId, planId, billing, subId ? "asaas" : null, subId ? "cus_" + orgId : null, subId, acceptedAt);
  }
  const billingOf = (orgId: string) => (db.prepare(`SELECT billing_status FROM organization_settings WHERE organization_id = ?`).get(orgId) as any)?.billing_status;
  const auditCount = (orgId: string) => (db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'FALATU_REFUND_ISSUED'`).get(orgId) as any).c;

  const tryRefund = async (orgId: string, actor: any, deps: any) => { try { await FalatuRefundService.requestRefund(orgId, actor, deps); return ""; } catch (e: any) { return e.code || "throw"; } };
  const okDeps = (nowMs: number, refundedSink: string[], invoices?: any[]) => ({
    nowMs, asaasConfigured: () => true,
    listInvoices: async () => invoices || [{ id: "pay_a", status: "CONFIRMED", value: 19, dueDate: "2026-08-08", invoiceUrl: "" }],
    refundPayment: async (id: string) => { refundedSink.push(id); return { id, status: "REFUNDED" }; },
    cancelSubscription: async (o: string) => { PlanService.setBillingStatus(o, "cancelled"); return true; },
  });

  // ===== 1. Elegibilidade dentro da janela =====
  seedOrg("org_a");
  const e1 = FalatuRefundService.checkEligibility("org_a", { nowMs: WITHIN });
  check("elegível dentro da janela", e1.eligible === true && e1.reason === "ok");
  check("janela = 7 dias e daysLeft coerente", e1.windowDays === 7 && e1.daysLeft === 6);

  // ===== 2. Reembolso happy path =====
  const refundedA: string[] = [];
  const r = await FalatuRefundService.requestRefund("org_a", "user_a", okDeps(WITHIN, refundedA));
  check("estorna o pagamento pago", refundedA.includes("pay_a") && r.refundedPaymentIds.join() === "pay_a");
  check("total estornado correto", r.refundedTotal === 19);
  check("billing vira 'cancelled'", r.billingStatus === "cancelled" && billingOf("org_a") === "cancelled");
  check("audita FALATU_REFUND_ISSUED", auditCount("org_a") === 1);

  // ===== 3. Idempotência: 2ª chamada barra =====
  check("2ª chamada → already_refunded", (await tryRefund("org_a", "user_a", okDeps(WITHIN, []))) === "already_refunded");
  check("não estorna de novo (audit continua 1)", auditCount("org_a") === 1);

  // ===== 4. Fora da janela =====
  seedOrg("org_exp");
  const eExp = FalatuRefundService.checkEligibility("org_exp", { nowMs: EXPIRED });
  check("fora da janela → não elegível", eExp.eligible === false && eExp.reason === "guarantee_expired");
  check("requestRefund fora da janela → guarantee_expired", (await tryRefund("org_exp", "u", okDeps(EXPIRED, []))) === "guarantee_expired");
  check("org fora da janela NÃO foi cancelada", billingOf("org_exp") === "active");

  // ===== 5. Plano B2B rejeitado =====
  seedOrg("org_b2b", { planId: "growth" });
  check("plano não-FalaTu → not_falatu_plan", (await tryRefund("org_b2b", "u", okDeps(WITHIN, []))) === "not_falatu_plan");

  // ===== 6. Sem gateway configurado =====
  seedOrg("org_ng");
  check("sem gateway → billing_not_configured", (await tryRefund("org_ng", "u", { nowMs: WITHIN, asaasConfigured: () => false })) === "billing_not_configured");
  check("org sem gateway NÃO foi cancelada", billingOf("org_ng") === "active");

  // ===== 7. Sem pagamento pago (boleto pendente) → cancela mesmo assim, total 0 =====
  seedOrg("org_np");
  const refundedNp: string[] = [];
  const rNp = await FalatuRefundService.requestRefund("org_np", "u", okDeps(WITHIN, refundedNp, [{ id: "pay_pend", status: "PENDING", value: 19 }]));
  check("sem pago: não estorna nada", refundedNp.length === 0 && rNp.refundedPaymentIds.length === 0 && rNp.refundedTotal === 0);
  check("sem pago: ainda cancela a assinatura", rNp.billingStatus === "cancelled" && billingOf("org_np") === "cancelled");

  // ===== 8. AsaasService.refundPayment bate no endpoint certo =====
  const rp = await AsaasService.refundPayment("pay_x", { description: "teste" });
  check("refundPayment devolve status REFUNDED", rp?.status === "REFUNDED");
  check("refundPayment chama POST /payments/pay_x/refund", calls.some((c) => c.method === "POST" && /\/payments\/pay_x\/refund$/.test(c.url)));

  // ===== 9. Webhook PAYMENT_REFUNDED preserva 'cancelled' (não vira 'suspended') =====
  seedOrg("org_wh", { subId: "sub_wh" });
  await FalatuRefundService.requestRefund("org_wh", "u", okDeps(WITHIN, []));
  check("org_wh cancelada pelo refund", billingOf("org_wh") === "cancelled");
  const wh = await AsaasService.handleWebhook({}, { event: "PAYMENT_REFUNDED", payment: { id: "pay_wh", subscription: "sub_wh", status: "REFUNDED" } });
  check("webhook PAYMENT_REFUNDED mantém 'cancelled'", wh.billing === "cancelled" && billingOf("org_wh") === "cancelled");

  // ===== 10. Rota autenticada GET /refund/eligibility + POST /refund =====
  seedOrg("org_route", { subId: "sub_route", acceptedAt: null }); // acceptedAt setado abaixo pra CURRENT_TIMESTAMP (real now)
  db.prepare(`UPDATE organization_settings SET falatu_terms_accepted_at = CURRENT_TIMESTAMP WHERE organization_id = ?`).run("org_route");

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { userId: "user_route", email: "route@teste.com" }; req.organizationId = "org_route"; next(); });
  app.use("/api/falatu", falatuRoutes);
  const server = http.createServer(app);
  await new Promise<void>((res) => server.listen(0, res));
  const port = (server.address() as any).port;
  const call = (method: string, p: string): Promise<any> => new Promise((resolve, reject) => {
    const req = http.request({ port, path: p, method, headers: { "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || "{}") }); } catch (err) { reject(err); } });
    });
    req.on("error", reject); req.end();
  });

  const elig = await call("GET", "/api/falatu/refund/eligibility");
  check("GET eligibility → 200 elegível", elig.status === 200 && elig.json.eligible === true);
  const post = await call("POST", "/api/falatu/refund");
  check("POST refund → 200 cancelado", post.status === 200 && post.json.billingStatus === "cancelled" && post.json.refundedPaymentIds.join() === "pay_route");
  check("rota chamou o ASAAS (refund + cancel)", calls.some((c) => /\/payments\/pay_route\/refund$/.test(c.url)) && calls.some((c) => c.method === "DELETE" && /\/subscriptions\/sub_route$/.test(c.url)));
  check("org_route cancelada + auditada", billingOf("org_route") === "cancelled" && auditCount("org_route") === 1);
  await new Promise<void>((res) => server.close(() => res()));

  console.log("");
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"} — ${x.name}`);
  console.log(failures === 0 ? "\nOK — 100% PASS" : `\nFALHOU — ${failures} checagem(ns)`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
});
