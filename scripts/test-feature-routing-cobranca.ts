/**
 * TEST — F6.3a (RF-08 §F6.3 / CA-03): guarda de finalidade do domínio COBRANÇA.
 *
 * Prova, offline (tmp db, fetch/deps stubados — sem rede), que:
 *  A. o produtor real de cobrança (CollectionCadenceService) declara a finalidade
 *     "cobranca" no envio — antes não declarava, então o gate não se aplicava;
 *  B. no sink, desligar a finalidade "cobranca" BLOQUEIA a cobrança SEM afetar
 *     outra finalidade no mesmo canal (CA-03), e finalidade sem binding passa
 *     (0-regressão) — "interno" não vira finalidade privilegiada.
 *
 * Uso: npm run test:feature-routing-cobranca
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-feat-cobr-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-feat-cobr-1";
process.env.EVOLUTION_API_KEY = "k"; process.env.EVOLUTION_BASE_URL = "https://ev.test"; process.env.OPENAI_API_KEY = "sk-fake";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelBindingService, OutboundFeatureDisabledError } = await import("../src/server/ChannelBindingService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");

  // ══ PARTE B (primeiro, com o sink REAL): isolação da finalidade cobranca ══
  const bmkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const bmkChannel = (org: string) => { const id = randomUUID(); db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'evolution_go', 'n', 'n', 'connected', 'tok')`).run(id, org); return id; };
  const bind = (org: string, ch: string, feature: string, inbound: number, outbound: number) =>
    db.prepare(`INSERT INTO channel_feature_bindings (id, organization_id, channel_id, feature_key, inbound, outbound) VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, ch, feature, inbound, outbound);

  const B = `org_B_${randomUUID().slice(0, 6)}`; bmkOrg(B);
  const chB = bmkChannel(B);
  bind(B, chB, "cobranca", 1, 0);    // cobranca: só entrada → SAÍDA desligada
  bind(B, chB, "atendimento", 1, 1); // atendimento livre no mesmo canal

  let fetchCalls = 0;
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => { fetchCalls++; return { ok: true, status: 200, text: async () => "{}", json: async () => ({ key: { id: "mid" } }), headers: { get: () => "application/json" } }; };

  let blocked = false;
  try { await MessageProviderService.sendMessage(chB, "5521999", "cobrança", { feature: "cobranca" }); } catch (e) { blocked = e instanceof OutboundFeatureDisabledError; }
  check("B.1 cobranca desligada → bloqueia (nem chama o provedor)", blocked === true && fetchCalls === 0);
  fetchCalls = 0; await MessageProviderService.sendMessage(chB, "5521999", "oi", { feature: "atendimento" });
  check("B.2 CA-03: atendimento livre no MESMO canal (cobranca desligada não afeta)", fetchCalls > 0);
  fetchCalls = 0; await MessageProviderService.sendMessage(chB, "5521999", "oi", { feature: "agenda" });
  check("B.3 finalidade sem binding → passa (0-regressão)", fetchCalls > 0);
  (globalThis as any).fetch = origFetch;

  // ══ PARTE A: o produtor real de cobrança declara feature 'cobranca' ══
  const { CollectionCadenceService } = await import("../src/server/CollectionCadenceService.js");
  const { AsaasService } = await import("../src/server/AsaasService.js");
  const { __setClassifierChatForTests } = await import("../src/server/CollectionIntentClassifier.js");

  const captured: Array<{ feature: string | undefined }> = [];
  (MessageProviderService as any).sendMessage = async (_ch: string, _to: string, _text: string, opts?: any) => {
    captured.push({ feature: opts?.feature }); return `msg_${randomUUID().slice(0, 6)}`;
  };
  (AsaasService as any).getPayment = async (id: string) => ({ id, invoiceUrl: "https://asaas.com/i/" + id, value: 250, dueDate: "2026-08-30", status: "PENDING" });
  __setClassifierChatForTests(async () => '{"intent":"unknown","reason":"default"}');

  const dateOffset = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, collection_cadence_enabled, collection_reminder_2_days_after_due, collection_reminder_3_days_after_due, external_customer_id, external_subscription_id, billing_status) VALUES (?, ?, 'X', 'active', 1, 3, 7, ?, ?, 'active')`).run(randomUUID(), A, `cust_${A}`, `sub_${A}`);
  const chA = `ch-${A}`; db.prepare(`INSERT INTO channels (id, organization_id, name, provider, status, kind) VALUES (?, ?, 'Canal', 'whatsapp_cloud', 'active', 'client')`).run(chA, A);
  const contactA = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier) VALUES (?, ?, ?, '5511988887777')`).run(contactA, A, chA);
  const recA = randomUUID(); db.prepare(`INSERT INTO receivables (id, organization_id, contact_id, description, amount, due_date, status) VALUES (?, ?, ?, 'Fatura', 250, ?, 'open')`).run(recA, A, contactA, dateOffset(-4));
  const actionId = randomUUID(); const payload = { receivableId: recA, contactId: contactA, phone: "5511988887777", channelId: chA, customerId: `cust-${A}`, amount: 250, dueDate: dateOffset(-4) };
  db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, status, title, expected_impact, command_type, command_payload_json, basis, created_at) VALUES (?, ?, 'runtime', 'runtime_step_send_reminder', 'approved', 'cobrança', 250, 'collection_send_reminder', ?, 'fact', ?)`).run(actionId, A, JSON.stringify(payload), new Date().toISOString());
  db.prepare(`INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status, deadline_at, external_ref, created_at) VALUES (?, ?, ?, 'asaas_payment_webhook', 'pending', ?, ?, ?)`).run(randomUUID(), A, actionId, new Date(Date.now() + 30 * 86400_000).toISOString(), `pay_${randomUUID().slice(0, 6)}`, new Date().toISOString());

  const r = await CollectionCadenceService.runForOrg(A);
  check("A.1 produtor de cobrança enviou (cadência T2)", r.sent === 1 && captured.length === 1);
  check("A.2 o envio declara finalidade 'cobranca'", captured[0]?.feature === "cobranca");

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} feature-routing-cobranca: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
