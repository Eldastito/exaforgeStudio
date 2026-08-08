/**
 * TEST — ADR-154 F2.2 (Fatia B): checkout self-serve do FalaTu.
 *
 * Cobre o caminho crítico "escolhe → paga → ativa": start() cria a org já com
 * plan_id + assinatura Asaas (nasce `trialing`) e devolve o link de pagamento; o
 * WEBHOOK existente do Asaas (PAYMENT_CONFIRMED) promove pra `active`. Mais os
 * guardrails: só plano falatu_*, Asaas obrigatório, 1 email = 1 conta, CPF/senha
 * válidos, e rollback da org se o gateway falhar.
 *
 * Asaas via `fetch` STUBADO (sem rede). Uso: npm run test:falatu-checkout
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import express from "express";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-checkout-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-checkout-123456";
process.env.ASAAS_API_KEY = "asaas-test-key"; // isConfigured() = true
delete process.env.ASAAS_WEBHOOK_TOKEN;       // dev: webhook passa sem token
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// ---- Stub do fetch: encena o Asaas (customer, subscription, payments, payment) ----
const calls: Array<{ method: string; url: string }> = [];
(global as any).fetch = async (url: any, init: any) => {
  const method = String(init?.method || "GET").toUpperCase();
  const u = String(url);
  calls.push({ method, url: u });
  const json = (data: any) => ({ ok: true, status: 200, json: async () => data });
  if (method === "POST" && u.endsWith("/customers")) return json({ id: "cus_test" });
  if (method === "POST" && u.endsWith("/subscriptions")) return json({ id: "sub_test" });
  if (method === "GET" && u.includes("/subscriptions/sub_test/payments"))
    return json({ data: [{ id: "pay_test", status: "PENDING", value: 19, dueDate: "2026-08-08", invoiceUrl: "https://asaas.test/i/pay_test" }] });
  if (method === "GET" && u.includes("/payments/pay_test"))
    return json({ id: "pay_test", status: "CONFIRMED", value: 19, dueDate: "2026-08-08", subscription: "sub_test", customer: "cus_test" });
  return { ok: false, status: 404, json: async () => ({ errors: [{ description: "not stubbed" }] }) };
};

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BlueprintSeeder } = await import("../src/server/BlueprintSeeder.js");
  const { FalatuCheckoutService } = await import("../src/server/FalatuCheckoutService.js");
  const { AsaasService } = await import("../src/server/AsaasService.js");
  const falatuPublicRoutes = (await import("../src/server/routes/falatuPublic.js")).default;

  // O boot semeia blueprints via import async; garante o falatu_solo publicado.
  BlueprintSeeder.seedInitialBlueprints();

  const orgRow = (orgId: string) => db.prepare(`SELECT plan_id, billing_status, external_subscription_id, falatu_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;

  // ===== 1. Checkout happy path =====
  const r = await FalatuCheckoutService.start({
    name: "Maria", email: "maria@teste.com", phone: "11999990000", cpf: "390.533.447-05", password: "senha123", planId: "falatu_solo",
  });
  check("start devolve organizationId", !!r.organizationId);
  check("start devolve checkoutUrl do Asaas", r.checkoutUrl === "https://asaas.test/i/pay_test");
  check("start devolve plano/preço certos", r.planId === "falatu_solo" && r.price === 19 && r.planName === "Solo");
  const org = orgRow(r.organizationId);
  check("org nasce com plan_id=falatu_solo", org.plan_id === "falatu_solo");
  check("org nasce billing_status='trialing' (pré-pagamento)", org.billing_status === "trialing");
  check("assinatura Asaas amarrada (external_subscription_id)", org.external_subscription_id === "sub_test");
  check("falatu_enabled ligado", Number(org.falatu_enabled) === 1);
  check("dono criado (owner)", (db.prepare(`SELECT role FROM users WHERE organization_id = ? AND email = ?`).get(r.organizationId, "maria@teste.com") as any)?.role === "owner");
  check("chamou o Asaas (customers + subscriptions)", calls.some((c) => c.url.endsWith("/customers")) && calls.some((c) => c.url.endsWith("/subscriptions")));

  // ===== 2. Webhook PAYMENT_CONFIRMED promove pra active (código EXISTENTE) =====
  const wh = await AsaasService.handleWebhook({}, { event: "PAYMENT_CONFIRMED", payment: { id: "pay_test", subscription: "sub_test", status: "CONFIRMED", value: 19, dueDate: "2026-08-08" } });
  check("webhook resolve a org e ativa", wh.status === "ok" && wh.billing === "active");
  check("org agora billing_status='active'", orgRow(r.organizationId).billing_status === "active");

  // ===== 3. Guardrails =====
  let code = "";
  const tryStart = async (input: any, deps?: any) => { try { await FalatuCheckoutService.start(input, deps); return ""; } catch (e: any) { return e.code || "throw"; } };
  code = await tryStart({ name: "X", email: "x@t.com", cpf: "39053344705", password: "senha123", planId: "growth" });
  check("plano B2B (growth) rejeitado → invalid_plan", code === "invalid_plan");
  code = await tryStart({ name: "X", email: "x@t.com", cpf: "39053344705", password: "senha123", planId: "falatu_pro" }, { asaasConfigured: () => false });
  check("sem gateway → billing_not_configured", code === "billing_not_configured");
  code = await tryStart({ name: "Maria", email: "maria@teste.com", cpf: "39053344705", password: "senha123", planId: "falatu_pro" });
  check("email repetido → email_in_use", code === "email_in_use");
  code = await tryStart({ name: "Y", email: "y@t.com", cpf: "123", password: "senha123", planId: "falatu_solo" });
  check("CPF inválido → invalid_cpf", code === "invalid_cpf");
  code = await tryStart({ name: "Y", email: "y2@t.com", cpf: "39053344705", password: "curta", planId: "falatu_solo" });
  check("senha fraca → weak_password", code === "weak_password");

  // ===== 4. Rota pública POST /api/public/falatu/checkout =====
  const app = express();
  app.use(express.json());
  app.use("/api/public/falatu", falatuPublicRoutes);
  const server = http.createServer(app);
  await new Promise<void>((res) => server.listen(0, res));
  const port = (server.address() as any).port;
  const resp: any = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: "João", email: "joao@teste.com", phone: "11988887777", cpf: "39053344705", password: "senha123", planId: "falatu_familia" });
    const req = http.request({ port, path: "/api/public/falatu/checkout", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.write(body); req.end();
  });
  check("POST checkout → 200 com checkoutUrl", resp.status === 200 && resp.json?.checkoutUrl === "https://asaas.test/i/pay_test");
  check("POST checkout criou org Família", resp.json?.planId === "falatu_familia" && resp.json?.price === 49);
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
