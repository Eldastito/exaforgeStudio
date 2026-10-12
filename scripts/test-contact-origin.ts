/**
 * TESTE — Origem do contato no CRM (ADR-207 F2). Prova: first touch gravado UMA vez e IMUTÁVEL · contato novo por mensagem recebida
 * ganha o canal de chegada (webhook REAL) · contato antigo mostra origem INFERIDA e rotulada (nada é gravado) · conversão derivada do
 * pedido · resumo por origem com recorte de loja e dinheiro só dono/admin · isolamento · rotas REAIS · rótulos da tela.
 * Uso: npm run test:contact-origin
 */
import os from "os"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-origin-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-origin-1234567890";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const { ContactOriginService: SVC } = await import("../src/server/ContactOriginService.js");
  const contactsRouter = (await import("../src/server/routes/contacts.js")).default;
  const L = await import("../src/lib/contactOrigin.js");
  const { processIncomingMessage } = await import("../src/server/webhookProcessor.js");

  const mkOrg = () => {
    const orgId = randomUUID();
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'x', 'active')`).run(orgId);
    return orgId;
  };
  const mkChan = (orgId: string, provider: string, identifier = randomUUID().slice(0, 8)) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, name, provider, identifier, status) VALUES (?, ?, 'C', ?, ?, 'active')`).run(id, orgId, provider, identifier);
    return { id, identifier };
  };
  const mkContact = (orgId: string, chan: string, name = "Maria") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(id, orgId, chan, name, "55" + Math.floor(Math.random() * 1e9));
    return id;
  };
  const ft = (id: string) => db.prepare(`SELECT first_touch_channel c, first_touch_campaign cp, first_touch_at at FROM contacts WHERE id = ?`).get(id) as any;

  // ── canais ──
  check("canal: provider vira canal de negócio", SVC.normalizeChannel("whatsapp_cloud") === "whatsapp" && SVC.normalizeChannel("evolution_go") === "whatsapp" && SVC.normalizeChannel("instagram") === "instagram" && SVC.normalizeChannel("facebook") === "facebook" && SVC.normalizeChannel("xyz") === "other" && SVC.normalizeChannel("") === null && SVC.normalizeChannel(null) === null);

  // ── first touch imutável ──
  const A = mkOrg(), B = mkOrg();
  const chA = mkChan(A, "instagram"), chW = mkChan(A, "evolution_go"), chB = mkChan(B, "instagram");
  const c1 = mkContact(A, chA.id);
  check("grava a origem uma vez (com campanha)", SVC.recordFirstTouch(A, c1, { channel: "instagram", campaign: "linen_out26", content: "reel_143" }).set && ft(c1).c === "instagram" && ft(c1).cp === "linen_out26" && !!ft(c1).at);
  check("IMUTÁVEL: outro canal depois NÃO troca a origem", !SVC.recordFirstTouch(A, c1, { channel: "whatsapp", campaign: "outra" }).set && ft(c1).c === "instagram" && ft(c1).cp === "linen_out26");
  check("contato de OUTRA empresa não é gravado", !SVC.recordFirstTouch(B, c1, { channel: "tiktok" }).set && ft(c1).c === "instagram");
  const c2 = mkContact(A, chW.id);
  check("sem canal não há origem (campanha sozinha não basta)", !SVC.recordFirstTouch(A, c2, { campaign: "x" }).set && ft(c2).c === null);
  check("entrada inválida é descartada, canal desconhecido vira 'other'", SVC.recordFirstTouch(A, c2, { channel: "meu-canal", campaign: "<script>" }).set && ft(c2).c === "other" && ft(c2).cp === null);

  // ── contato novo por mensagem recebida (webhook REAL) ──
  const chI = mkChan(A, "instagram", "ig_biz_1");
  try { await processIncomingMessage({ channelId: chI.id, organizationId: A, identifier: chI.identifier, provider: "instagram", senderId: "ig_user_77", contactName: "Joana", text: "Tem tamanho G?" }, null); } catch { /* o resto do atendimento (IA etc.) pode falhar sem rede; a origem já foi gravada antes */ }
  const novo = db.prepare(`SELECT id, first_touch_channel c FROM contacts WHERE organization_id = ? AND channel_id = ? AND identifier = 'ig_user_77'`).get(A, chI.id) as any;
  check("webhook: contato NOVO nasce com a origem = canal por onde chegou", !!novo && novo.c === "instagram");
  const chWa = mkChan(A, "whatsapp_cloud", "wa_biz_1");
  try { await processIncomingMessage({ channelId: chWa.id, organizationId: A, identifier: chWa.identifier, provider: "whatsapp_cloud", senderId: "5521999990000", contactName: "Pedro", text: "oi" }, null); } catch { /* idem */ }
  const wa = db.prepare(`SELECT id, first_touch_channel c FROM contacts WHERE organization_id = ? AND channel_id = ? AND identifier = '5521999990000'`).get(A, chWa.id) as any;
  check("webhook: WhatsApp → origem whatsapp", wa?.c === "whatsapp");
  try { await processIncomingMessage({ channelId: chI.id, organizationId: A, identifier: chI.identifier, provider: "instagram", senderId: "ig_user_77", contactName: "Joana", text: "obrigada" }, null); } catch { /* idem */ }
  check("webhook: nova mensagem do mesmo contato não duplica nem muda a origem", (db.prepare(`SELECT COUNT(*) n FROM contacts WHERE organization_id = ? AND identifier = 'ig_user_77'`).get(A) as any).n === 1 && ft(novo.id).c === "instagram");

  // ── contato ANTIGO: inferido, rotulado, nada gravado ──
  const old = mkContact(A, chW.id, "Antigo");
  const oo = SVC.originOf(A, old)!;
  check("antigo sem registro: origem inferida do canal e ROTULADA", oo.origin.channel === "whatsapp" && oo.origin.basis === "inferred_channel" && oo.origin.campaign === null);
  check("inferir NÃO grava nada no contato", ft(old).c === null);
  check("registrado: basis = recorded", SVC.originOf(A, c1)!.origin.basis === "recorded");
  const orphan = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'canal-sumiu', 'Órfão', '1')`).run(orphan, A);
  check("sem canal conhecido: desconhecida (nunca chuta)", SVC.originOf(A, orphan)!.origin.basis === "unknown" && SVC.originOf(A, orphan)!.origin.channel === null);
  check("contato de outra empresa → null (isolamento)", SVC.originOf(B, c1) === null);

  // ── conversão e toques (derivados do pedido) ──
  const ord = (contact: string, by: string, status: string, pay: string | null, attr: any = {}) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, payment_status, total_amount, created_by, attr_source, attr_campaign) VALUES (?, ?, ?, ?, ?, 100, ?, ?, ?)`).run(id, A, contact, status, pay, by, attr.s ?? null, attr.c ?? null);
    return id;
  };
  check("sem compra paga: conversão null", SVC.originOf(A, c1)!.conversionChannel === null);
  ord(c1, "storefront", "aguardando_pagamento", null, { s: "instagram", c: "linen_out26" });
  check("pedido só aguardando: ainda não é conversão", SVC.originOf(A, c1)!.conversionChannel === null);
  ord(c1, "storefront", "pago", "paid", { s: "instagram", c: "linen_out26" });
  const h = SVC.originOf(A, c1)!;
  check("compra paga na loja virtual → conversão zapflow_store", h.conversionChannel === "zapflow_store");
  check("os toques de campanha vêm dos pedidos (2) e a ORIGEM continua a registrada", h.touches.length === 2 && h.touches.some((t) => t.paid) && h.origin.channel === "instagram");
  const c3 = mkContact(A, chW.id); ord(c3, "ai", "pago", null);
  check("venda fechada no atendimento → ai_chat", SVC.originOf(A, c3)!.conversionChannel === "ai_chat");
  const c4 = mkContact(A, chW.id); const oc = ord(c4, "storefront", "cancelado", "paid", { s: "instagram", c: "cancelada" });
  check("pedido cancelado não conta", SVC.originOf(A, c4)!.conversionChannel === null && SVC.originOf(A, c4)!.touches.length === 0 && !!oc);

  // ── resumo ──
  db.prepare(`UPDATE contacts SET purchase_count = 2, total_spent = 300 WHERE id = ?`).run(c1);
  db.prepare(`UPDATE contacts SET purchase_count = 1, total_spent = 90 WHERE id = ?`).run(old);
  const s1 = SVC.summary(A, { includeMoney: false });
  const ig = s1.byChannel.find((e) => e.channel === "instagram")!, wp = s1.byChannel.find((e) => e.channel === "whatsapp")!;
  check("resumo: contatos por origem (registrada + inferida somadas, separadas em recorded/inferred)", ig.contacts >= 2 && ig.recorded >= 2 && wp.inferred >= 1 && s1.total === s1.byChannel.reduce((x, e) => x + e.contacts, 0));
  check("resumo: quem já comprou por origem", ig.buyers === 1 && wp.buyers >= 1 && ig.buyerRatePct !== null);
  check("resumo SEM dinheiro por padrão", !("revenue" in ig) && !("revenue" in wp));
  check("resumo com dinheiro: receita por origem", (SVC.summary(A, { includeMoney: true }).byChannel.find((e) => e.channel === "instagram") as any).revenue === 300);
  check("resumo: empresa B isolada e vazia", SVC.summary(B).total === 0 && SVC.summary(B).byChannel.length === 0);
  check("resumo: origem desconhecida aparece à parte, não escondida", s1.byChannel.some((e) => e.channel === null));
  const sc = SVC.summary(A, { scope: { clause: " AND contacts.id = ?", args: [c1] } });
  check("resumo respeita o recorte de loja do CRM (scope)", sc.total === 1 && sc.byChannel[0].channel === "instagram");

  // ── rotas REAIS ──
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-test-org"]; req.user = { userId: "u1", role: String(req.headers["x-test-role"] || "owner") }; next(); });
  app.use("/api/contacts", contactsRouter);
  const server = await new Promise<any>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/contacts`;
  const get = async (p: string, org: string, role = "owner") => { const r = await fetch(base + p, { headers: { "x-test-org": org, "x-test-role": role } }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
  const list = await get("/", A);
  const li = (list.body as any[]).find((c) => c.id === c1);
  check("lista de contatos: campos antigos intactos + origin", list.status === 200 && li.name === "Maria" && li.lead_score !== undefined && li.origin.channel === "instagram" && li.origin.basis === "recorded" && !("channel_provider" in li));
  check("lista: contato antigo traz origin inferida", (list.body as any[]).find((c) => c.id === old).origin.basis === "inferred_channel");
  const oneRoute = await get(`/${c1}/origin`, A);
  check("GET /:id/origin devolve a história", oneRoute.status === 200 && oneRoute.body.origin.channel === "instagram" && oneRoute.body.conversionChannel === "zapflow_store");
  check("GET /:id/origin de outra empresa → 404", (await get(`/${c1}/origin`, B)).status === 404 && (await get(`/nao-existe/origin`, A)).status === 404);
  const sOwner = await get("/origin-summary", A, "owner"), sAgent = await get("/origin-summary", A, "agent");
  check("resumo na rota: dono vê receita; atendente não", sOwner.body.byChannel.some((e: any) => "revenue" in e) && !sAgent.body.byChannel.some((e: any) => "revenue" in e) && sAgent.status === 200);
  check("PATCH de contato segue funcionando", (await fetch(`${base}/${c1}`, { method: "PATCH", headers: { "Content-Type": "application/json", "x-test-org": A, "x-test-role": "owner" }, body: JSON.stringify({ tags: "vip" }) })).status < 500);
  server.close();

  // ── rótulos da tela ──
  check("tela: registrada com campanha", L.originLine({ channel: "instagram", campaign: "linen_out26", content: null, basis: "recorded" }) === "Instagram · linen_out26");
  check("tela: inferida NUNCA parece registrada", L.originLine({ channel: "whatsapp", campaign: null, content: null, basis: "inferred_channel" }) === "WhatsApp (pelo canal da 1ª conversa)");
  check("tela: desconhecida não mostra nada; canal sem rótulo vira genérico", L.originLine({ channel: null, campaign: null, content: null, basis: "unknown" }) === null && L.originLine(null) === null && L.originChannelLabel("zzz") === "Outro canal" && L.originChannelLabel(null) === "Origem desconhecida");
  check("tela: conversão", L.conversionLabel("zapflow_store") === "Loja virtual ZapFlow" && L.conversionLabel("ai_chat") === "Atendimento (IA)" && L.conversionLabel(null) === null);

  // ── fiação ──
  const wp2 = read("src/server/webhookProcessor.ts"), cv = read("src/features/ContactsView.tsx"), dbs = read("src/server/db.ts");
  check("webhook: o gancho é best-effort e fica logo depois do INSERT do contato novo", /\.run\(contactId, orgId, channel\.id[\s\S]{0,400}ContactOriginService\.recordFromNewContact\(orgId, contactId, channel\.provider\)/.test(wp2));
  check("tela mostra a origem no cartão e o resumo no topo", /Origem: \{originLine\(c\.origin\)\}/.test(cv) && /De onde vêm seus contatos/.test(cv));
  check("migração aditiva (só ADD COLUMN / CREATE INDEX IF NOT EXISTS)", /ADR-207 F2[\s\S]*first_touch_at DATETIME/.test(dbs) && !/DROP TABLE/.test(dbs.slice(dbs.indexOf("ADR-207 F2"))));
  check("a mutação de first touch só acontece com IS NULL", /WHERE id = \? AND organization_id = \? AND first_touch_channel IS NULL/.test(read("src/server/ContactOriginService.ts")));

  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - results.filter((r) => !r.ok).length}/${results.length} checks`);
  if (failures) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
