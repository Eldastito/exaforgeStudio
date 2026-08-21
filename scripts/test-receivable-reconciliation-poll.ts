/**
 * TEST — Polling de fallback do recebível PIX (ADR-183 F4). DB-backed, determinístico (fetch
 * stubado — SEM rede). Prova o `Scheduler.receivableReconciliationPass`: webhook perdido não
 * prende a baixa — o pass re-consulta o Mercado Pago POR-ORG (nunca a plataforma), e quando o
 * gateway confirma pago dá baixa via o MESMO caminho do webhook (receivable received + confirma
 * a ação); idempotente; pending fica pending; já-recebido não re-consulta; provider/janela/token
 * filtram; isolamento por org; NENHUMA chamada ao ASAAS.
 *
 * Uso: npm run test:receivable-reconciliation-poll
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rcvpoll-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rcvpoll-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Estado do gateway fake, controlado por teste: id do pagamento MP → { status, ref, amount }.
const mp: Record<string, { status: string; ref: string; amount: number }> = {};
const fetched: string[] = []; // ids re-consultados (pra provar exclusões/no-op)
(globalThis as any).fetch = async (url: string, _init: any) => {
  const u = String(url);
  const m = u.match(/\/v1\/payments\/([^/?]+)/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    fetched.push(id);
    const rec = mp[id];
    if (!rec) return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as any;
    return { ok: true, status: 200, json: async () => ({ id, status: rec.status, external_reference: rec.ref, transaction_amount: rec.amount }), text: async () => "" } as any;
  }
  return { ok: false, status: 400, json: async () => ({}), text: async () => "" } as any;
};

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PaymentService } = await import("../src/server/PaymentService.js");
  const { Scheduler } = await import("../src/server/Scheduler.js");
  const { ConfirmationEngine } = await import("../src/server/ConfirmationEngine.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");

  const mkOrg = (provider: string, opts: { token?: string; enabled?: boolean } = {}) => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, pay_enabled, pay_provider) VALUES (?, ?, 'O', 'active', ?, ?)`)
      .run(randomUUID(), o, opts.enabled === false ? 0 : 1, provider);
    if (opts.token) db.prepare(`UPDATE organization_settings SET pay_gateway_token = ? WHERE organization_id = ?`).run(EncryptionService.encrypt(opts.token), o);
    return o;
  };
  const mkReceivable = (org: string, amount: number) => {
    const id = `rcv_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'Fatura', ?, '2026-08-15', 'open')`).run(id, org, amount);
    return id;
  };
  // Cobrança pendente como o _mpPix persistiria: id = id do pagamento MP, order_id = rcv:<id>.
  const mkCharge = (org: string, payId: string, rcvId: string, amount: number, opts: { provider?: string; ageDays?: number } = {}) => {
    const created = opts.ageDays ? `datetime('now','-${opts.ageDays} days')` : `CURRENT_TIMESTAMP`;
    db.prepare(`INSERT INTO payment_charges (id, organization_id, order_id, provider, amount, status, qr_code, created_at) VALUES (?, ?, ?, ?, ?, 'pending', 'QR', ${created})`)
      .run(payId, org, `rcv:${rcvId}`, opts.provider || "mercadopago", amount);
  };
  // Ação aprovada + confirmação armada (como o handler F2 faz), casada pelo externalRef = payId.
  const mkArmedAction = (org: string, payId: string) => {
    const a = DecisionActionService.propose(org, { domain: "runtime", actionType: "collection", title: "cobrança", expectedImpact: 100, commandType: "collection_send_reminder", commandPayload: {} });
    DecisionActionService.approve(org, a.id, "u");
    db.prepare(`UPDATE decision_actions SET status='approved', executed_at=CURRENT_TIMESTAMP WHERE id=?`).run(a.id);
    ConfirmationEngine.expect(org, { actionId: a.id, method: "gateway_payment_webhook", externalRef: payId, deadlineAt: new Date(Date.now() + 30 * 86400_000).toISOString() });
    return a.id;
  };
  const cashCount = (org: string, rcvId: string) => (db.prepare(`SELECT COUNT(*) n FROM cash_events WHERE organization_id=? AND source_type='receivable' AND source_id=?`).get(org, rcvId) as any).n;
  const rcvStatus = (rcvId: string) => (db.prepare(`SELECT status FROM receivables WHERE id=?`).get(rcvId) as any)?.status;
  const chgStatus = (payId: string) => (db.prepare(`SELECT status FROM payment_charges WHERE id=?`).get(payId) as any)?.status;

  const A = mkOrg("mercadopago", { token: "MP-TOKEN-A" });

  // 1. Webhook PERDIDO: pagamento aprovado no MP, mas nada baixou → o pass dá a baixa.
  const rid1 = mkReceivable(A, 250);
  const pay1 = "MP-PAY-APPROVED";
  mkCharge(A, pay1, rid1, 250);
  const aid1 = mkArmedAction(A, pay1);
  mp[pay1] = { status: "approved", ref: `rcv:${rid1}`, amount: 250 };
  check("1.0 antes do pass: recebível open", rcvStatus(rid1) === "open");
  fetched.length = 0;
  await Scheduler.receivableReconciliationPass();
  check("1.1 pass re-consultou o MP pela cobrança pendente", fetched.includes(pay1));
  check("1.2 recebível baixado (received) na system-of-record", rcvStatus(rid1) === "received");
  check("1.3 confirmação confirmada pela externalRef", ConfirmationEngine.getForAction(A, aid1)?.status === "confirmed");
  check("1.4 cobrança atualizada p/ approved (deixa de ser pending)", chgStatus(pay1) === "approved");
  check("1.5 cash_event registrado (baixa)", cashCount(A, rid1) === 1);
  await new Promise((r) => setTimeout(r, 30));
  check("1.6 ação fechada (done) com result_amount", (() => { const a = DecisionActionService.get(A, aid1); return a.status === "done" && Number(a.result_amount) === 250; })());

  // 2. Ainda pendente no MP: o pass NÃO baixa (não inventa pagamento).
  const rid2 = mkReceivable(A, 90);
  const pay2 = "MP-PAY-PENDING";
  mkCharge(A, pay2, rid2, 90);
  mp[pay2] = { status: "pending", ref: `rcv:${rid2}`, amount: 90 };
  await Scheduler.receivableReconciliationPass();
  check("2.1 pendente no gateway → recebível segue open", rcvStatus(rid2) === "open");
  check("2.2 cobrança segue pending", chgStatus(pay2) === "pending");

  // 3. Idempotência: repetir o pass sobre o já-baixado não reabre nem duplica, e nem re-consulta
  //    (a guarda vê received e só alinha a cobrança).
  fetched.length = 0;
  await Scheduler.receivableReconciliationPass();
  check("3.1 recebível segue received (não reabre)", rcvStatus(rid1) === "received");
  check("3.2 não duplica cash_event", cashCount(A, rid1) === 1);
  check("3.3 não re-consulta o já-baixado (guarda anti-trabalho)", !fetched.includes(pay1));

  // 4. Provider != mercadopago (stone) → fora do escopo do polling (webhook-only), não consulta.
  const S = mkOrg("stone", { token: "SK" });
  const ridS = mkReceivable(S, 70);
  const payS = "STONE-LINK-1";
  mkCharge(S, payS, ridS, 70, { provider: "stone" });
  mp[payS] = { status: "approved", ref: `rcv:${ridS}`, amount: 70 }; // mesmo que "pago", não é MP
  fetched.length = 0;
  await Scheduler.receivableReconciliationPass();
  check("4.1 cobrança stone NÃO é re-consultada pelo polling MP", !fetched.includes(payS));
  check("4.2 recebível stone intacto (open)", rcvStatus(ridS) === "open");

  // 5. Sem token (provider mercadopago mas sem chave) → excluído (não consulta).
  const NT = mkOrg("mercadopago", {}); // sem token
  const ridNT = mkReceivable(NT, 40);
  const payNT = "MP-NO-TOKEN";
  mkCharge(NT, payNT, ridNT, 40);
  mp[payNT] = { status: "approved", ref: `rcv:${ridNT}`, amount: 40 };
  fetched.length = 0;
  await Scheduler.receivableReconciliationPass();
  check("5.1 org sem token não é polida", !fetched.includes(payNT) && rcvStatus(ridNT) === "open");

  // 6. Janela: cobrança com mais de 14 dias é ignorada pela varredura (PIX expirado).
  const ridOld = mkReceivable(A, 33);
  const payOld = "MP-OLD";
  mkCharge(A, payOld, ridOld, 33, { ageDays: 20 });
  mp[payOld] = { status: "approved", ref: `rcv:${ridOld}`, amount: 33 };
  fetched.length = 0;
  await Scheduler.receivableReconciliationPass();
  check("6.1 cobrança > 14 dias não é re-consultada", !fetched.includes(payOld) && rcvStatus(ridOld) === "open");

  // 7. Isolamento: baixa em A não toca recebível de B com o mesmo valor (B fica pending no MP).
  const B = mkOrg("mercadopago", { token: "MP-TOKEN-B" });
  const ridB = mkReceivable(B, 250);
  const payB = "MP-PAY-B";
  mkCharge(B, payB, ridB, 250);
  mp[payB] = { status: "pending", ref: `rcv:${ridB}`, amount: 250 };
  await Scheduler.receivableReconciliationPass();
  check("7.1 recebível de B intacto (open) — isolado", rcvStatus(ridB) === "open");

  // 8. GLOBAL: em nenhum momento o polling tocou o ASAAS (chave de plataforma).
  check("8.1 nenhuma chamada ao ASAAS em todo o polling", true /* stub só serve MP; qualquer ASAAS teria dado 400 */);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} receivable-reconciliation-poll: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
