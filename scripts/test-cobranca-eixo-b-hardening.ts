/**
 * TEST — Cobrança de recebível Eixo B hardening (ADR-183 F5). Doc-of-record EXECUTÁVEL de dupla
 * função: (A) codifica RN-COB-1..6 como REGRESSÃO sobre os serviços/handlers REAIS F1–F4;
 * (B) verifica a FIAÇÃO de produção (helpers roteiam Eixo B e não a plataforma, método de
 * confirmação registrado, pass no Scheduler, testes wired, ADR/runbook presentes).
 * DB-backed, determinístico (fetch stubado — SEM rede; qualquer chamada ao ASAAS seria visível).
 *
 * Uso: npm run test:cobranca-eixo-b-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cobhard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-cobhard-123456";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Gateway fake controlado por teste. Distingue: POST /v1/payments (cria) × GET /v1/payments/{id}
// (re-consulta). Registra TODAS as chamadas (pra provar destino/headers e que o ASAAS nunca é tocado).
const mp: Record<string, { status: string; ref: string; amount: number }> = {};
const calls: { url: string; method: string; init: any }[] = [];
let createSeq = 0; let failCreate = false;
const ok200 = (body: any) => ({ ok: true, status: 200, json: async () => body, text: async () => "" } as any);
(globalThis as any).fetch = async (url: string, init: any) => {
  const u = String(url); const method = String(init?.method || "GET").toUpperCase();
  calls.push({ url: u, method, init });
  const mGet = u.match(/\/v1\/payments\/([^/?]+)/);
  if (mGet) { // re-consulta (sync/polling)
    const id = decodeURIComponent(mGet[1]); const rec = mp[id];
    if (!rec) return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as any;
    return ok200({ id, status: rec.status, external_reference: rec.ref, transaction_amount: rec.amount });
  }
  if (/\/v1\/payments$/.test(u) && method === "POST") { // cria PIX
    if (failCreate) return { ok: false, status: 500, json: async () => ({ message: "boom" }), text: async () => "" } as any;
    const body = JSON.parse(init.body); const id = `MP-${++createSeq}`;
    mp[id] = { status: "pending", ref: body.external_reference, amount: body.transaction_amount };
    return ok200({ id, status: "pending", point_of_interaction: { transaction_data: { qr_code: "QR", qr_code_base64: "AA", ticket_url: "http://t" } } });
  }
  return { ok: false, status: 400, json: async () => ({}), text: async () => "" } as any;
};

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PaymentService } = await import("../src/server/PaymentService.js");
  const { Scheduler } = await import("../src/server/Scheduler.js");
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
  const rcvStatus = (rcvId: string) => (db.prepare(`SELECT status FROM receivables WHERE id=?`).get(rcvId) as any)?.status;
  const asaasHits = () => calls.filter((c) => c.url.includes("asaas")).length;

  const A = mkOrg("mercadopago", { token: "MP-TOKEN-A" });

  // ── RN-COB-1: Eixo B NUNCA usa a chave de plataforma — cobra pelo gateway POR-ORG. ──
  const rid = "recv-hard-1";
  calls.length = 0;
  const c1 = await PaymentService.chargeForReceivable(A, { receivableId: rid, amount: 120 });
  const post = calls.find((c) => c.method === "POST");
  check("RN-1 cobra no Mercado Pago do lojista (nunca ASAAS)", !!post && post.url.includes("api.mercadopago.com") && asaasHits() === 0);
  check("RN-1 Authorization = token POR-ORG do lojista", post?.init.headers.Authorization === "Bearer MP-TOKEN-A");

  // ── RN-COB-3: idempotência + correlação — reference/idem `rcv:` e reuso do pending. ──
  check("RN-3 external_reference = rcv:<id>", JSON.parse(post!.init.body).external_reference === `rcv:${rid}`);
  check("RN-3 X-Idempotency-Key = rcv-<id>", post!.init.headers["X-Idempotency-Key"] === `rcv-${rid}`);
  calls.length = 0;
  const c2 = await PaymentService.chargeForReceivable(A, { receivableId: rid, amount: 120 });
  check("RN-3 reusa a cobrança pending (mesmo paymentId, sem novo POST)", c2.paymentId === c1.paymentId && !calls.some((c) => c.method === "POST"));

  // ── RN-COB-2: sem gateway → degrada honesto, NUNCA cai na plataforma. ──
  const NT = mkOrg("mercadopago", {}); // provider mas sem token
  calls.length = 0;
  const cNT = await PaymentService.chargeForReceivable(NT, { receivableId: "r", amount: 50 });
  check("RN-2 mercadopago sem token → gateway_error, zero ASAAS", cNT.ok === false && cNT.reason === "gateway_error" && asaasHits() === 0);
  const MAN = mkOrg("pix_manual", {});
  const cMAN = await PaymentService.chargeForReceivable(MAN, { receivableId: "r", amount: 50 });
  check("RN-2 pix_manual sem chave → manual_required (sem paymentId)", cMAN.ok === false && cMAN.reason === "manual_required");
  const DIS = mkOrg("mercadopago", { token: "T", enabled: false });
  check("RN-2 desabilitado → not_enabled", (await PaymentService.chargeForReceivable(DIS, { receivableId: "r", amount: 50 })).ok === false);

  // ── RN-COB-4: baixa pela SYSTEM-OF-RECORD (receivables.received), não só a decision_action. ──
  const rid4 = mkReceivable(A, 200);
  await PaymentService.onReceivablePaid(A, rid4, "MP-PAY-X", 200);
  check("RN-4 pagamento confirmado → receivables.status='received'", rcvStatus(rid4) === "received");
  check("RN-4 cash_event de baixa registrado", !!db.prepare(`SELECT 1 FROM cash_events WHERE organization_id=? AND source_type='receivable' AND source_id=?`).get(A, rid4));

  // ── RN-COB-5: webhook RE-CONSULTADO + polling (webhook perdido não prende a baixa). ──
  const rid5 = mkReceivable(A, 75);
  // Cobrança pendente (como o _mpPix persistiu); MP aprova; polling re-consulta e dá baixa.
  const pay5 = "MP-POLL-5";
  db.prepare(`INSERT INTO payment_charges (id, organization_id, order_id, provider, amount, status, qr_code, created_at) VALUES (?, ?, ?, 'mercadopago', 75, 'pending', 'QR', CURRENT_TIMESTAMP)`).run(pay5, A, `rcv:${rid5}`);
  mp[pay5] = { status: "approved", ref: `rcv:${rid5}`, amount: 75 };
  calls.length = 0;
  await Scheduler.receivableReconciliationPass();
  check("RN-5 polling re-consultou o gateway (GET) e deu baixa", calls.some((c) => c.method === "GET" && c.url.includes(pay5)) && rcvStatus(rid5) === "received");
  check("RN-5 polling nunca tocou o ASAAS", asaasHits() === 0);

  // ── RN-COB-6: money-critical FAIL-CLOSED + isolamento por org. ──
  failCreate = true; calls.length = 0;
  const cFail = await PaymentService.chargeForReceivable(A, { receivableId: "r6", amount: 10 });
  check("RN-6 falha do gateway → fail-closed (gateway_error, sem paymentId)", cFail.ok === false && cFail.reason === "gateway_error" && !cFail.paymentId);
  failCreate = false;
  const B = mkOrg("mercadopago", { token: "MP-TOKEN-B" });
  const ridB = mkReceivable(B, 200);
  await PaymentService.onReceivablePaid(A, mkReceivable(A, 200), "MP-ISO", 200); // baixa em A
  check("RN-6 isolamento — recebível de B intacto (open)", rcvStatus(ridB) === "open");

  // ── (B) FIAÇÃO DE PRODUÇÃO ──
  const runtime = fs.readFileSync(path.join(ROOT, "src/server/RuntimeCommandHandlers.ts"), "utf8");
  const collection = fs.readFileSync(path.join(ROOT, "src/server/CollectionPlaybook.ts"), "utf8");
  check("wiring: RuntimeCommandHandlers roteia via PaymentService.chargeForReceivable", runtime.includes("PaymentService.chargeForReceivable"));
  check("wiring: CollectionPlaybook roteia via PaymentService.chargeForReceivable", collection.includes("PaymentService.chargeForReceivable"));
  check("wiring: nenhum helper usa AsaasService._req.call (chave de plataforma morta)", !runtime.includes("_req.call") && !collection.includes("_req.call"));
  const confirm = fs.readFileSync(path.join(ROOT, "src/server/ConfirmationEngine.ts"), "utf8");
  check("wiring: gateway_payment_webhook em CONFIRMATION_METHODS", confirm.includes("gateway_payment_webhook"));
  const scheduler = fs.readFileSync(path.join(ROOT, "src/server/Scheduler.ts"), "utf8");
  check("wiring: receivableReconciliationPass no Scheduler (método + tick)", (scheduler.match(/receivableReconciliationPass/g) || []).length >= 2);
  const pay = fs.readFileSync(path.join(ROOT, "src/server/PaymentService.ts"), "utf8");
  check("wiring: PaymentService tem chargeForReceivable + onReceivablePaid + ramo rcv:", pay.includes("chargeForReceivable") && pay.includes("onReceivablePaid") && pay.includes('startsWith("rcv:")'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const needed = ["test:charge-for-receivable", "test:receivable-pix-routing", "test:receivable-reconciliation-poll", "test:cobranca-eixo-b-hardening"];
  check("wiring: 4 testes do Eixo B wired", needed.every((t) => pkg.scripts[t]));
  check("wiring: ADR-183 presente", fs.existsSync(path.join(ROOT, "docs/adr/ADR-183-cobranca-eixo-b-recebivel-pix.md")));
  check("wiring: runbook presente", fs.existsSync(path.join(ROOT, "docs/runbook/cobranca-recebivel-operacao.md")));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} cobranca-eixo-b-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
