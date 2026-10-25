/**
 * TESTE — Aviso "pronto para retirar" ao cliente (ADR-207 F14).
 *
 * Sobe a vitrine pública + as rotas de Retail Ops REAIS (e, nos casos de bloqueio, o sink REAL de mensagens com os portões de
 * consentimento e de horário da empresa) e prova:
 *  - desligado (padrão) não manda nada nem grava nada; ligado manda UMA mensagem só na transição para "pronto";
 *  - a mensagem não leva dinheiro nem telefone e higieniza o texto vindo do cliente;
 *  - repetir clique/reprocessar nunca manda a 2ª; falha no envio nunca derruba o avanço da etapa;
 *  - sem telefone / telefone inválido / cliente que pediu para não receber / sem canal → NÃO manda e a fila diz "avise por outro meio";
 *  - consentimento (sink real) é bloqueio FINAL; horário silencioso (sink real) é re-tentado pelo passe e sai uma vez só depois;
 *  - tentativas limitadas (3), validade de 24 h, pedido retirado/cancelado no meio encerra o aviso;
 *  - cura só da transição recente (queda do processo) e NUNCA retroativa; isolamento entre empresas; rótulos da tela.
 * Uso: npm run test:pickup-ready-notice
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http"; import { fileURLToPath } from "url"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pickup-notice-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pickup-notice-1234567890";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const storefrontPublic = (await import("../src/server/routes/storefrontPublic.js")).default;
  const retailRoutes = (await import("../src/server/routes/retailops.js")).default;
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailOnlineReserveService: R } = await import("../src/server/RetailOnlineReserveService.js");
  const { StorePickupService: P } = await import("../src/server/StorePickupService.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");
  const { StorePickupQueueService: Q } = await import("../src/server/StorePickupQueueService.js");
  const { PickupReadyNoticeService: N, cleanText, toWhatsappDigits } = await import("../src/server/PickupReadyNoticeService.js");
  const L = await import("../src/features/pickup/noticeLabels.js");

  const orgId = randomUUID(), orgB = randomUUID();
  for (const [id, slug] of [[orgId, "toulon"], [orgB, "outra"]] as const) {
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(id, slug.toUpperCase());
    db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, title) VALUES (?, ?, 1, ?)`).run(id, slug, `Loja ${slug}`);
  }
  const camisa = randomUUID(), calca = randomUUID();
  for (const [id, name] of [[camisa, "Camisa Polo"], [calca, "Calça Jeans"]] as const) {
    db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, active, stock_control_enabled) VALUES (?, ?, ?, 'product', 100, 1, 1)`).run(id, orgId, name);
    db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available, quantity_reserved) VALUES (?, ?, ?, NULL, 200, 0)`).run(randomUUID(), orgId, id);
  }
  const s1 = RetailStoreService.create(orgId, { name: "Toulon 1079", code: "10", address: "Rua das Flores, 100", city: "Recife" });
  R.setEnabled(orgId, true); P.setSettings(orgId, { enabled: true }); P.setStore(orgId, s1.id, true);
  for (const p of [camisa, calca]) R.setReserve(orgId, s1.id, p, null, 150);
  const channelId = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', 'WhatsApp', 'wa1', 'connected')`).run(channelId, orgId);

  const dono = randomUUID();
  db.prepare("INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Bruno', ?, 'owner', 'active')").run(dono, orgId, "bruno@toulon.com");
  const app = express(); app.use(express.json());
  app.use("/api/public", storefrontPublic);
  app.use((req: any, _res: any, next: any) => {
    const uid = String(req.headers["x-uid"] || "");
    const row = uid ? (db.prepare("SELECT id, organization_id, role, role_profile_id FROM users WHERE id = ?").get(uid) as any) : null;
    if (row) { req.organizationId = row.organization_id; req.user = { userId: row.id, role: row.role, role_profile_id: row.role_profile_id, organizationId: row.organization_id }; }
    next();
  });
  app.use("/api/retailops", retailRoutes);
  const server = http.createServer(app);
  const port: number = await new Promise((r) => server.listen(0, () => r((server.address() as any).port)));
  const url = `http://127.0.0.1:${port}/api`;
  const order = async (body: any) => { const r = await fetch(`${url}/public/store/toulon/order`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) as any }; };
  const call = async (method: string, p: string, body?: any) => { const r = await fetch(`${url}/retailops${p}`, { method, headers: { "Content-Type": "application/json", "x-uid": dono }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) as any }; };

  // ── infraestrutura de teste ──
  const sent: { to: string; text: string; channelId: string }[] = [];
  const okSender = async (chId: string, to: string, text: string) => { sent.push({ to, text, channelId: chId }); return "ok"; };
  N.sendOverride = okSender;
  const paid = async (customer: any = { name: "Maria Souza", phone: "11988887777" }, product = camisa) => {
    const o = await order({ items: [{ productId: product, quantity: 1 }], fulfillment: "pickup", pickupStoreId: s1.id, customer });
    if (o.status !== 200) throw new Error("pedido não criado: " + JSON.stringify(o.json));
    OrdersService.updateStatus(orgId, o.json.orderId, "pago"); return o.json.orderId as string;
  };
  const toReady = async (id: string) => { const r = await call("POST", `/pickup/orders/${id}/advance`, { to: "pronto" }); await Q.settleHooks(); await N.idle(); return r; };
  const notice = (id: string) => db.prepare("SELECT * FROM pickup_ready_notices WHERE organization_id = ? AND order_id = ?").get(orgId, id) as any;
  const backdate = (id: string, minutes: number) => db.prepare("UPDATE pickup_ready_notices SET updated_at = datetime('now', ?), created_at = CASE WHEN ? >= 1440 THEN datetime('now', ?) ELSE created_at END WHERE order_id = ?").run(`-${minutes} minutes`, minutes, `-${minutes} minutes`, id);
  const clearSent = () => { sent.length = 0; };

  // ── 1. Desligado (padrão): nada acontece ──────────────────────────────────
  check("1.1 padrão: aviso DESLIGADO", P.settings(orgId).readyNotice === false && N.isEnabled(orgId) === false);
  const a0 = await paid();
  const r0 = await toReady(a0);
  db.prepare("UPDATE orders SET pickup_status_at = datetime('now','-5 minutes') WHERE id = ?").run(a0);   // ficou pronto 5 min ANTES de o dono ligar o aviso (o relógio do SQLite é de 1 s)
  check("1.2 desligado: avançar para 'pronto' funciona e NÃO manda nada", r0.status === 200 && r0.json.stage === "pronto" && sent.length === 0);
  check("1.3 desligado: nem registro é criado", !notice(a0));
  check("1.4 a fila não mostra aviso quando desligado", (await call("GET", "/pickup/queue")).json.noticeEnabled === false && L.noticeBadge(null, "pronto", false) === null);

  // ── 2. Configuração ───────────────────────────────────────────────────────
  const cfg = await call("PUT", "/pickup/settings", { readyNotice: true });
  check("2.1 PUT /pickup/settings liga o aviso", cfg.status === 200 && cfg.json.settings.readyNotice === true && N.isEnabled(orgId));
  check("2.2 ligar/desligar fica no audit", (db.prepare("SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'PICKUP_READY_NOTICE_ENABLED'").get(orgId) as any).c >= 1);
  check("2.3 não ligou nada retroativo: o pedido que já estava 'pronto' NÃO foi avisado", sent.length === 0 && !notice(a0));

  // ── 3. Ligado: UMA mensagem, na transição para 'pronto' ───────────────────
  const a = await paid({ name: "Maria Souza", phone: "(11) 98888-7777" });
  await call("POST", `/pickup/orders/${a}/advance`, { to: "separado" }); await Q.settleHooks(); await N.idle();
  check("3.1 'separado' NÃO manda aviso", sent.length === 0 && !notice(a));
  const ra = await toReady(a);
  check("3.2 'pronto' manda exatamente UM aviso e o avanço responde ok", ra.status === 200 && ra.json.changed === true && sent.length === 1);
  const m = sent[0];
  check("3.3 vai para o telefone normalizado com DDI 55 e pelo canal da empresa", m.to === "5511988887777" && m.channelId === channelId);
  const short = a.slice(0, 8);
  check("3.4 texto traz nº do pedido, loja, endereço, peças e o nome (só o primeiro)", m.text.includes(`#${short}`) && m.text.includes("Toulon 1079") && m.text.includes("Rua das Flores, 100") && m.text.includes("1× Camisa Polo") && /Olá, Maria!/.test(m.text) && !m.text.includes("Souza"));
  check("3.5 texto SEM dinheiro e SEM telefone", !/R\$|\d+[,.]\d{2}|total|preço|valor/i.test(m.text) && !/9?8888[- ]?7777/.test(m.text));
  const n1 = notice(a);
  check("3.6 registro: sent, 1 tentativa, telefone NÃO gravado (só os 2 últimos dígitos)", n1.status === "sent" && n1.attempts === 1 && !!n1.sent_at && !JSON.stringify(n1).includes("98888") && /…77/.test(n1.detail));
  const aud = db.prepare("SELECT metadata_json FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'PICKUP_READY_NOTICE_SENT' AND target_user_id = ?").all(orgId, a) as any[];
  check("3.7 audit do envio existe e não leva o telefone inteiro", aud.length === 1 && !JSON.stringify(aud).includes("98888"));

  // ── 4. Idempotência ───────────────────────────────────────────────────────
  const rep = await call("POST", `/pickup/orders/${a}/advance`, { to: "pronto" }); await Q.settleHooks(); await N.idle();
  check("4.1 repetir 'pronto' é no-op e não manda de novo", rep.json.changed === false && sent.length === 1);
  check("4.2 reprocessar à força devolve already_final e não manda", (await N.onReady(orgId, a)).status === "already_final" && sent.length === 1);
  await N.pass(); check("4.3 o passe não reenvia o que já foi avisado — nem avisa retroativamente o pedido que ficou pronto ANTES de ligar (mesmo dentro de 30 min)", sent.length === 1 && !notice(a0));
  const dup = db.prepare("SELECT COUNT(*) c FROM pickup_ready_notices WHERE order_id = ?").get(a) as any;
  check("4.4 um único registro por pedido", dup.c === 1);

  // ── 5. Fila mostra o estado ───────────────────────────────────────────────
  const q = (await call("GET", "/pickup/queue")).json;
  const qa = q.queue.find((x: any) => x.orderId === a);
  check("5.1 fila: noticeEnabled + notice.status=sent no pedido", q.noticeEnabled === true && qa.notice.status === "sent");
  check("5.2 fila continua SEM dinheiro nem telefone no aviso", !/total|price|amount/i.test(JSON.stringify(q)) );
  check("5.3 selo da tela: avisado ✓ (verde)", L.noticeBadge(qa.notice, qa.stage, true)!.tone === "ok" && /avisado/i.test(L.noticeBadge(qa.notice, qa.stage, true)!.text));

  // ── 6. Pedido que não está pronto/pago ────────────────────────────────────
  const np = await paid();
  check("6.1 pedido pago mas NÃO pronto → not_ready, sem envio", (await N.onReady(orgId, np)).status === "not_ready" && !notice(np));
  check("6.2 pedido inexistente / de outra empresa → not_ready", (await N.onReady(orgId, randomUUID())).status === "not_ready" && (await N.onReady(orgB, np)).status === "disabled");
  const unpaid = await order({ items: [{ productId: camisa, quantity: 1 }], fulfillment: "pickup", pickupStoreId: s1.id, customer: { name: "X", phone: "11977776666" } });
  check("6.3 pedido NÃO pago nunca é avisado", (await N.onReady(orgId, unpaid.json.orderId)).status === "not_ready");

  // ── 7. Quem não deve receber ──────────────────────────────────────────────
  clearSent();
  const nophone = await paid({ name: "Ana" }); await toReady(nophone);
  check("7.1 sem telefone → no_phone, nada enviado", notice(nophone)?.status === "no_phone" && sent.length === 0);
  const badphone = await paid({ name: "Beto", phone: "123" }); await toReady(badphone);
  check("7.2 telefone fora do padrão → no_phone (não chuta)", notice(badphone)?.status === "no_phone" && sent.length === 0);
  check("7.3 formatos aceitos viram 55+DDD+número; o resto é recusado", toWhatsappDigits("(11) 98888-7777") === "5511988887777" && toWhatsappDigits("+55 11 98888-7777") === "5511988887777" && toWhatsappDigits("5511988887777") === "5511988887777" && toWhatsappDigits("1133334444") === "551133334444" && toWhatsappDigits("123") === null && toWhatsappDigits("") === null && toWhatsappDigits(null) === null && toWhatsappDigits("12345678901234567") === null);
  const optId = randomUUID();
  db.prepare("INSERT INTO contacts (id, organization_id, channel_id, name, identifier, marketing_opt_out) VALUES (?, ?, ?, 'Carla', '5511955554444', 1)").run(optId, orgId, channelId);
  const optOrder = await paid({ name: "Carla", phone: "11955554444" }); await toReady(optOrder);
  check("7.4 cliente que pediu para NÃO receber mensagens → opted_out, nada enviado", notice(optOrder)?.status === "opted_out" && sent.length === 0);
  check("7.5 a fila diz o que fazer ('avise por outro meio')", /outro meio/.test(L.noticeBadge({ status: "opted_out" }, "pronto", true)!.text) && L.noticeBadge({ status: "opted_out" }, "pronto", true)!.tone === "warn");

  // ── 8. Texto de terceiro é higienizado ────────────────────────────────────
  check("8.1 cleanText tira quebra de linha, markdown e controle, e limita o tamanho", cleanText("Mar\nia *GRÁTIS*\u0007 `x` <b>", 40) === "Mar ia GRÁTIS x b" && cleanText("a".repeat(200), 10).length === 10 && cleanText(null, 5) === "" && cleanText("  ", 5) === "");
  clearSent();
  const evil = await paid({ name: "João\n*PROMOÇÃO* clique http://golpe.exemplo", phone: "11944443333" }); await toReady(evil);
  check("8.2 nome malicioso: sai só o 1º nome, numa linha só, sem markdown", sent.length === 1 && /^Olá, João!/.test(sent[0].text) && !sent[0].text.includes("golpe") && !sent[0].text.includes("PROMOÇÃO") && sent[0].text.split("\n")[0].startsWith("Olá, João!"));

  // ── 9. Falha no envio nunca derruba o avanço; tentativas e validade ──────
  clearSent();
  const boom = async () => { throw new Error("provedor fora do ar"); };
  N.sendOverride = boom as any;
  const f = await paid({ name: "Duda", phone: "11933332222" });
  const rf = await toReady(f);
  check("9.1 envio que explode NÃO derruba o avanço (200, etapa 'pronto')", rf.status === 200 && rf.json.stage === "pronto" && notice(f)?.status === "failed" && notice(f).attempts === 1);
  check("9.2 a falha mostra aviso 'tente de novo / outro meio' na tela", L.noticeBadge({ status: "failed" }, "pronto", true)!.tone === "warn");
  let calls = 0; N.sendOverride = (async () => { calls++; throw new Error("ainda fora"); }) as any;
  for (let i = 0; i < 4; i++) { backdate(f, 11); await N.pass(); }
  check("9.3 o passe re-tenta no máx. 3 tentativas no total e depois expira (sem 4º envio)", calls === 2 && notice(f).status === "expired" && notice(f).attempts === 3, JSON.stringify({ calls, n: notice(f) }));
  N.sendOverride = okSender; clearSent();
  const recent = await paid({ name: "Eva", phone: "11922221111" });
  N.sendOverride = boom as any; await toReady(recent); N.sendOverride = okSender;
  await N.pass();
  check("9.4 não re-tenta antes de 10 minutos", sent.length === 0 && notice(recent).status === "failed");
  backdate(recent, 11); await N.pass();
  check("9.5 passados 10 min o passe re-tenta e AVISA uma vez", sent.length === 1 && notice(recent).status === "sent" && notice(recent).attempts === 2);
  const old = await paid({ name: "Fabi", phone: "11911110000" });
  N.sendOverride = boom as any; await toReady(old); N.sendOverride = okSender; clearSent();
  backdate(old, 1500); await N.pass();
  check("9.6 passou de 24 h → expira sem enviar", notice(old).status === "expired" && sent.length === 0);

  // ── 10. Pedido segue em frente enquanto o aviso está pendente ─────────────
  const gone = await paid({ name: "Gil", phone: "11900009999" });
  N.sendOverride = boom as any; await toReady(gone); N.sendOverride = okSender; clearSent();
  await call("POST", `/pickup/orders/${gone}/advance`, { to: "retirado" }); await Q.settleHooks(); await N.idle();
  backdate(gone, 11); await N.pass();
  check("10.1 cliente já retirou: o aviso pendente é ENCERRADO sem mandar", sent.length === 0 && notice(gone).status === "obsolete");
  const canc = await paid({ name: "Hugo", phone: "11988880000" });
  N.sendOverride = boom as any; await toReady(canc); N.sendOverride = okSender; clearSent();
  OrdersService.updateStatus(orgId, canc, "cancelado"); backdate(canc, 11); await N.pass();
  check("10.2 pedido cancelado: aviso pendente encerrado sem mandar", sent.length === 0 && notice(canc).status === "obsolete");

  // ── 11. Sem canal conectado ───────────────────────────────────────────────
  db.prepare("UPDATE channels SET status = 'disabled' WHERE id = ?").run(channelId);
  const nc = await paid({ name: "Iara", phone: "11977771111" }); clearSent(); await toReady(nc);
  check("11.1 sem canal de WhatsApp → no_channel, nada enviado, mensagem de reconectar", notice(nc)?.status === "no_channel" && sent.length === 0 && /reconecte/i.test(L.noticeBadge({ status: "no_channel" }, "pronto", true)!.text));
  db.prepare("UPDATE channels SET status = 'connected' WHERE id = ?").run(channelId);
  backdate(nc, 11); await N.pass();
  check("11.2 canal volta → o passe avisa uma vez", sent.length === 1 && notice(nc).status === "sent");

  // ── 12. Sink REAL: horário silencioso (re-tenta) ──────────────────────────
  N.sendOverride = null; clearSent();
  db.prepare("UPDATE organization_settings SET client_quiet_hours_enforced = 1, client_quiet_hours_start_hour = 5, client_quiet_hours_end_hour = 5 WHERE organization_id = ?").run(orgId);   // start==end = 24 h de silêncio
  const qh = await paid({ name: "Jo", phone: "11966662222" }); await toReady(qh);
  check("12.1 sink real em horário silencioso → blocked_quiet_hours (nada saiu)", notice(qh)?.status === "blocked_quiet_hours" && /fora do horário/i.test(L.noticeBadge({ status: "blocked_quiet_hours" }, "pronto", true)!.text) && L.noticeBadge({ status: "blocked_quiet_hours" }, "pronto", true)!.tone === "wait");
  db.prepare("UPDATE organization_settings SET client_quiet_hours_enforced = 0 WHERE organization_id = ?").run(orgId);
  N.sendOverride = okSender; backdate(qh, 11); await N.pass();
  check("12.2 saiu da janela → o passe manda UMA vez", sent.length === 1 && notice(qh).status === "sent");
  backdate(qh, 11); await N.pass();
  check("12.3 e não repete", sent.length === 1);

  // ── 13. Sink REAL: consentimento (bloqueio FINAL) ─────────────────────────
  N.sendOverride = null; clearSent();
  db.prepare("UPDATE organization_settings SET outbound_consent_required = 1 WHERE organization_id = ?").run(orgId);
  db.prepare("INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, 'Kátia', '5511955556666')").run(randomUUID(), orgId, channelId);
  const cs = await paid({ name: "Kátia", phone: "11955556666" }); await toReady(cs);
  check("13.1 sink real, contato conhecido SEM consentimento → blocked_consent (nada saiu)", notice(cs)?.status === "blocked_consent" && L.noticeBadge({ status: "blocked_consent" }, "pronto", true)!.tone === "warn");
  N.sendOverride = okSender; backdate(cs, 11); await N.pass();
  check("13.2 consentimento é bloqueio FINAL: o passe não insiste", sent.length === 0 && notice(cs).status === "blocked_consent");
  db.prepare("UPDATE organization_settings SET outbound_consent_required = 0 WHERE organization_id = ?").run(orgId);

  // ── 14. Limite de frequência (código tipado) ──────────────────────────────
  clearSent();
  const cap = Object.assign(new Error("limite"), { code: "outbound_blocked:frequency_cap" });
  N.sendOverride = (async () => { throw cap; }) as any;
  const fc = await paid({ name: "Léo", phone: "11944442222" }); await toReady(fc);
  check("14.1 limite de frequência → blocked_frequency_cap (re-tentável)", notice(fc)?.status === "blocked_frequency_cap");
  N.sendOverride = okSender; backdate(fc, 11); await N.pass();
  check("14.2 passa no limite depois → sai uma vez", sent.length === 1 && notice(fc).status === "sent");

  // ── 15. Cura da transição recente, nunca retroativa ───────────────────────
  clearSent();
  const heal = await paid({ name: "Mara", phone: "11933330000" });
  N.sendOverride = null; N.sendOverride = okSender;
  db.prepare("UPDATE orders SET pickup_status = 'pronto', pickup_status_at = CURRENT_TIMESTAMP WHERE id = ?").run(heal);   // simula: virou pronto e o processo caiu antes do aviso
  const h1 = await N.pass();
  check("15.1 'pronto' recente sem registro (queda no meio) é curado: avisa uma vez", h1.healed === 1 && sent.length === 1 && notice(heal).status === "sent");
  const ancient = await paid({ name: "Nina", phone: "11922220000" });
  db.prepare("UPDATE orders SET pickup_status = 'pronto', pickup_status_at = datetime('now','-2 days') WHERE id = ?").run(ancient);
  clearSent(); await N.pass();
  check("15.2 'pronto' antigo NUNCA é avisado retroativamente", sent.length === 0 && !notice(ancient));
  check("15.0 o momento em que o aviso foi ligado fica guardado", !!(db.prepare("SELECT pickup_ready_notice_enabled_at v FROM organization_settings WHERE organization_id = ?").get(orgId) as any).v);
  const justBefore = await paid({ name: "Olga", phone: "11911119999" });
  db.prepare("UPDATE orders SET pickup_status = 'pronto', pickup_status_at = datetime('now','-31 minutes') WHERE id = ?").run(justBefore);
  await N.pass(); check("15.3 a janela de cura é de 30 min (31 min fica de fora)", sent.length === 0 && !notice(justBefore));

  // ── 16. Desligar para tudo e isolamento entre empresas ────────────────────
  const off = await paid({ name: "Pedro", phone: "11900001111" });
  await call("PUT", "/pickup/settings", { readyNotice: false }); clearSent();
  await toReady(off);
  check("16.1 desligar volta a não mandar e não registrar", sent.length === 0 && !notice(off));
  const stuck = await paid({ name: "Rita", phone: "11999991111" });
  await call("PUT", "/pickup/settings", { readyNotice: true }); N.sendOverride = boom as any; await toReady(stuck); N.sendOverride = okSender;
  await call("PUT", "/pickup/settings", { readyNotice: false }); backdate(stuck, 11); clearSent(); await N.pass();
  check("16.2 desligado, o passe não re-tenta nada", sent.length === 0 && notice(stuck).status === "failed");
  check("16.3 empresa B (flag própria) não é afetada pela A", N.isEnabled(orgB) === false && (await N.onReady(orgB, off)).status === "disabled");
  db.prepare("UPDATE organization_settings SET pickup_ready_notice_enabled = 1 WHERE organization_id = ?").run(orgB);
  check("16.4 mesmo com B ligada, um pedido da A não é visível para a B", (await N.onReady(orgB, off)).status === "not_ready" && !db.prepare("SELECT 1 FROM pickup_ready_notices WHERE organization_id = ?").get(orgB));

  // ── 17. Fiação ────────────────────────────────────────────────────────────
  const sched = read("src/server/Scheduler.ts"), q2 = read("src/server/StorePickupQueueService.ts"), ui = read("src/features/RetailOpsView.tsx"), sink = read("src/server/MessageProviderService.ts");
  check("17.1 o passe está no Scheduler (best-effort, dentro de try/catch)", /PickupReadyNoticeService\.pass\(\)/.test(sched) && /aviso de retirada pronta falhou/.test(sched));
  check("17.2 o gancho é só na transição para 'pronto' e dispara-e-esquece (sem await no avanço)", /to === "pronto"/.test(q2) && /fireOnReady/.test(q2) && !/await[^;\n]*fireOnReady/.test(q2));
  check("17.3 a tela usa o selo e o interruptor; o texto de ajuda diz o que acontece", /noticeBadge\(o\.notice/.test(ui) && /readyNotice/.test(ui) && /UMA mensagem/.test(L.NOTICE_SETTING_HELP) && /consentimento/.test(L.NOTICE_SETTING_HELP) && /outro meio/.test(L.NOTICE_SETTING_HELP));
  check("17.4 o aviso passa pelo sink canônico (feature 'vendas') e NÃO contorna os portões", /sendMessage\(channelId, to, text, \{ feature: "vendas" \}\)/.test(read("src/server/PickupReadyNoticeService.ts")) && !/fetch\(/.test(read("src/server/PickupReadyNoticeService.ts")) && /OutboundConsentGuardService\.evaluate/.test(sink));
  check("17.5 todo estado que NÃO é 'enviado' tem selo com instrução (nunca cala)", ["blocked_consent", "opted_out", "no_phone", "no_channel", "failed", "expired"].every((s) => /outro meio|tento de novo/.test(L.noticeBadge({ status: s }, "pronto", true)!.text)) && L.noticeBadge({ status: "xpto" }, "pronto", true)!.tone === "warn");
  check("17.6 pronto sem registro e aviso ligado → 'em preparo'; retirado sem registro → nada", L.noticeBadge(null, "pronto", true)!.tone === "wait" && L.noticeBadge(null, "retirado", true) === null && L.noticeBadge(null, "separado", true) === null);

  server.close();
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
