/**
 * TESTE — Conteúdo → WhatsApp / e-mail (ADR-207 F13a). PREPARA, nunca envia.
 *
 * Prova, com o serviço, o motor de Campanhas e a rota do dono REAIS:
 *  - WhatsApp: vira RASCUNHO de campanha (status draft, ninguém recebe nada); texto limpo (sem hashtags), com {nome}, link da loja com a
 *    origem (zf_source/campaign/content), e a instrução real de descadastro ("responda SAIR");
 *  - público = segmento ∩ sem opt-out ∩ COM consentimento de comunicação registrado (sem prova, fica de fora, e diz quantos);
 *  - e-mail: assunto + texto + HTML prontos, sem envio (sendable=false), só quem tem e-mail cadastrado e consentimento;
 *  - termo proibido pela marca recusa; conteúdo cancelado/vazio/de outra empresa recusa; produto de outra empresa recusa; sem loja = sem link;
 *  - idempotente (não duplica rascunho aberto); dryRun não cria nada; cap de destinatários; isolamento; só dono/administrador;
 *  - nada é enviado: nenhuma mensagem sai do sistema.
 *
 * Uso: npm run test:content-broadcast
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-content-broadcast-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-content-broadcast-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const social = (await import("../src/server/routes/social.js")).default;
  const { ContentBroadcastService: B } = await import("../src/server/ContentBroadcastService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");
  const { BrandDnaService } = await import("../src/server/BrandDnaService.js");
  const { OPT_OUT_RE } = await import("../src/server/webhookProcessor.js");

  const orgId = randomUUID(), other = randomUUID();
  for (const [id, slug] of [[orgId, "toulon"], [other, "outra"]] as const) {
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(id, slug);
  }
  const mkContact = (org: string, name: string, phone: string, o: { consent?: boolean; optOut?: number; email?: string | null } = {}) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, marketing_opt_out, email) VALUES (?, ?, 'ch-test', ?, ?, ?, ?)`).run(id, org, name, phone, o.optOut ?? 0, o.email ?? null);
    if (o.consent) LgpdService.grantConsent(org, id, "comunicacoes", { channel: "test" });
    return id;
  };
  const ana = mkContact(orgId, "Ana", "5511900000001", { consent: true, email: "ana@x.com" });
  const bia = mkContact(orgId, "Bia", "5511900000002", { consent: true });                       // sem e-mail
  const carla = mkContact(orgId, "Carla", "5511900000003", { consent: false, email: "c@x.com" }); // sem consentimento
  const dora = mkContact(orgId, "Dora", "5511900000004", { consent: true, optOut: 1, email: "d@x.com" }); // optou por sair
  const outra = mkContact(other, "Outra", "5511900000009", { consent: true, email: "o@x.com" });

  const entry = (org: string, caption: string | null, status = "scheduled") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO scheduled_posts (id, organization_id, caption, status, channel) VALUES (?, ?, ?, ?, 'instagram')`).run(id, org, caption, status);
    return id;
  };
  const CAP = "Linho é a cara do outono. Nova coleção chegou com cortes leves e cores terrosas. #moda #linho #outono";
  const e1 = entry(orgId, CAP);
  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, active, slug) VALUES (?, ?, 'Camisa Linho', 'product', 100, 1, 'camisa-linho')`).run(prod, orgId);
  const prodOutra = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, active) VALUES (?, ?, 'X', 'product', 1, 1)`).run(prodOutra, other);
  const thrown = async (fn: () => Promise<any>) => { try { await fn(); return ""; } catch (e: any) { return String(e.message); } };
  const campaigns = () => db.prepare("SELECT * FROM campaigns WHERE organization_id = ?").all(orgId) as any[];

  // ── 1. texto
  check("1.1 cleanText tira hashtags e limpa espaços", B.cleanText("Oi   mundo #moda #linho_2 fim", 100) === "Oi mundo fim");
  check("1.2 cleanText corta em frase quando passa do limite", (() => { const t = B.cleanText("Primeira frase completa. Segunda frase bem longa que ultrapassa o limite de tamanho definido.", 40); return t.endsWith(".") && t.length <= 40; })());
  check("1.3 cleanText corta em palavra com reticências quando não há frase", (() => { const t = B.cleanText("palavra ".repeat(30), 30); return t.endsWith("…") && t.length <= 31; })());

  // ── 2. sem loja publicada
  const noStore = await B.draft(orgId, "u1", { entryId: e1, channel: "whatsapp", dryRun: true }) as any;
  check("2.1 sem loja publicada: mensagem sem link e avisa", noStore.link === null && noStore.caveats.some((c: string) => /Sem loja publicada/.test(c)) && !/http|\/loja\//.test(noStore.message));

  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, title) VALUES (?, 'toulon', 1, 'T')`).run(orgId);

  // ── 3. WhatsApp dryRun
  const dry = await B.draft(orgId, "u1", { entryId: e1, channel: "whatsapp", productId: prod, campaign: "Outono Linho", dryRun: true }) as any;
  check("3.1 dryRun não cria campanha nenhuma", dry.dryRun === true && dry.created === false && campaigns().length === 0);
  check("3.2 mensagem: saudação com {nome}, texto sem hashtags, link do produto com origem", /^Oi \{nome\}! Linho é a cara do outono/.test(dry.message) && !/#/.test(dry.message) && dry.link.includes("/loja/toulon/produto/camisa-linho") && dry.link.includes("zf_source=whatsapp") && dry.link.includes("zf_campaign=outono-linho") && /zf_content=[a-f0-9]{8}/.test(dry.link), dry.link);
  check("3.3 termina com a instrução REAL de descadastro (a palavra que o webhook trata)", /responda SAIR\.$/.test(dry.message) && OPT_OUT_RE.test("sair"));
  check("3.4 público: 4 no segmento · Dora (opt-out) já fora do motor · Carla sem consentimento fica de fora · Ana e Bia entram", dry.audience.inSegment === 3 && dry.audience.withoutConsent === 1 && dry.audience.included === 2 && dry.audience.requireConsent === true, JSON.stringify(dry.audience));
  check("3.5 avisa quantos ficaram de fora por falta de consentimento", dry.caveats.some((c: string) => /1 contato\(s\) ficaram de fora/.test(c)));
  check("3.6 sem productId: link vai para a vitrine", ((await B.draft(orgId, "u1", { entryId: e1, channel: "whatsapp", dryRun: true })) as any).link.includes("/loja/toulon?zf_source=whatsapp"));

  // ── 4. cria o rascunho
  const made = await B.draft(orgId, "u1", { entryId: e1, channel: "whatsapp", productId: prod, campaign: "Outono Linho" }) as any;
  const camp = campaigns()[0];
  check("4.1 cria UMA campanha em DRAFT (nada enviado)", made.created === true && campaigns().length === 1 && camp.status === "draft" && camp.sent_count === 0 && made.status === "draft");
  check("4.2 destinatários = só Ana e Bia (consentimento + sem opt-out)", (() => { const r = db.prepare("SELECT contact_id, status FROM campaign_recipients WHERE campaign_id = ?").all(camp.id) as any[]; return r.length === 2 && r.every((x) => x.status === "pending") && r.some((x) => x.contact_id === ana) && r.some((x) => x.contact_id === bia) && !r.some((x) => x.contact_id === carla || x.contact_id === dora); })());
  check("4.3 a mensagem da campanha é a prévia, com {nome} para o motor personalizar", camp.message === made.message && /\{nome\}/.test(camp.message));
  check("4.4 a campanha guarda de onde veio (conteúdo + canal), para não duplicar", JSON.parse(camp.segment).entryId === e1 && JSON.parse(camp.segment).source === "content");
  check("4.5 nome identifica o conteúdo na tela de Campanhas", /Conteúdo · outono-linho/.test(camp.name));
  const again = await B.draft(orgId, "u1", { entryId: e1, channel: "whatsapp", productId: prod, campaign: "Outono Linho" }) as any;
  check("4.6 idempotente: repetir não cria 2º rascunho e aponta o existente", again.created === false && again.existingCampaignId === camp.id && campaigns().length === 1);
  db.prepare("UPDATE campaigns SET status = 'completed' WHERE id = ?").run(camp.id);
  check("4.7 depois de concluída, um novo rascunho é permitido", ((await B.draft(orgId, "u1", { entryId: e1, channel: "whatsapp", campaign: "reenvio" })) as any).created === true);

  // ── 5. e-mail
  const mail = await B.draft(orgId, "u1", { entryId: e1, channel: "email", productId: prod, campaign: "news" }) as any;
  check("5.1 e-mail: pronto mas NÃO enviável pelo sistema, nada criado", mail.sendable === false && mail.created === false && campaigns().length === 2);
  check("5.2 assunto curto, texto sem hashtags, HTML escapado, link com origem email", mail.subject.length <= 70 && !/#/.test(mail.text) && mail.link.includes("zf_source=email") && /<a href="[^"]+zf_source=email/.test(mail.html) && !/<script/i.test(mail.html));
  check("5.3 inclui o pedido de descadastro", /descadastro/.test(mail.text) && /descadastro/.test(mail.html));
  check("5.4 público do e-mail: só quem tem e-mail E consentimento (Ana; Bia sem e-mail, Carla sem consentimento, Dora opt-out)", mail.audience.included === 1 && mail.audience.reachableByChannel === 2 && mail.audience.withoutConsent === 1, JSON.stringify(mail.audience));
  check("5.5 avisa que o ZapFlow não envia e-mail em massa", mail.caveats.some((c: string) => /não envia e-mail em massa/.test(c)));
  check("5.6 resposta não vaza e-mails/telefones de clientes", !/ana@x|c@x|5511900/.test(JSON.stringify(mail)) && !/5511900/.test(JSON.stringify(made)));
  const xss = entry(orgId, `Promoção <script>alert(1)</script> & "aspas" de outono`);
  check("5.7 HTML escapa conteúdo do dono", !/<script>/.test(((await B.draft(orgId, "u1", { entryId: xss, channel: "email" })) as any).html));

  // ── 6. recusas
  check("6.1 conteúdo de outra empresa → não encontrado", /não encontrado/.test(await thrown(() => B.draft(orgId, "u1", { entryId: entry(other, "x"), channel: "whatsapp" }))));
  check("6.2 conteúdo cancelado recusa", /cancelado/.test(await thrown(() => B.draft(orgId, "u1", { entryId: entry(orgId, "texto", "canceled"), channel: "whatsapp" }))));
  check("6.3 conteúdo sem legenda recusa", /não tem texto/.test(await thrown(() => B.draft(orgId, "u1", { entryId: entry(orgId, "   "), channel: "whatsapp" }))));
  check("6.4 canal inválido recusa", /Canal inválido/.test(await thrown(() => B.draft(orgId, "u1", { entryId: e1, channel: "sms" as any }))));
  check("6.5 produto de outra empresa recusa", /Produto não encontrado/.test(await thrown(() => B.draft(orgId, "u1", { entryId: e1, channel: "whatsapp", productId: prodOutra, dryRun: true }))));
  await BrandDnaService.save(orgId, "u1", { forbidden: ["barato"] } as any);
  check("6.6 termo proibido pela marca recusa (não reescreve)", /proíbe \("barato"\)|proíbe/.test(await thrown(() => B.draft(orgId, "u1", { entryId: entry(orgId, "Roupa barato demais!"), channel: "whatsapp" }))));
  db.prepare("UPDATE contact_consents SET granted = 0 WHERE organization_id = ?").run(orgId);
  const none = await B.draft(orgId, "u1", { entryId: entry(orgId, "Outro texto"), channel: "whatsapp" }) as any;
  check("6.7 sem consentimento de ninguém no segmento → created=false / no_reachable_recipients", none.created === false && none.reason === "no_reachable_recipients" && /consentimento/.test(none.caveats.join(" ")));
  db.prepare("UPDATE contact_consents SET granted = 1 WHERE organization_id = ?").run(orgId);

  // ── 7. cap + segmento
  const e2 = entry(orgId, "Texto para muitos");
  for (let i = 0; i < 510; i++) mkContact(orgId, `C${i}`, `55119100${String(i).padStart(5, "0")}`, { consent: true });
  const big = await B.draft(orgId, "u1", { entryId: e2, channel: "whatsapp", dryRun: true }) as any;
  check("7.1 limita a 500 por rascunho e avisa", big.audience.included === 500 && big.audience.truncated === true && big.caveats.some((c: string) => /limitado a 500/.test(c)));
  const tagged = mkContact(orgId, "Tag", "5511933333333", { consent: true });
  db.prepare("UPDATE contacts SET tags = 'vip' WHERE id = ?").run(tagged);
  const seg = await B.draft(orgId, "u1", { entryId: e2, channel: "whatsapp", segment: { tag: "vip" }, dryRun: true }) as any;
  check("7.2 segmento do CRM é respeitado (tag vip → 1)", seg.audience.inSegment === 1 && seg.audience.included === 1);

  // ── 8. isolamento
  check("8.1 contato de outra empresa nunca entra", ((await B.draft(orgId, "u1", { entryId: e2, channel: "whatsapp", segment: { tag: "vip" }, dryRun: true })) as any).audience.included === 1 && (db.prepare("SELECT COUNT(*) n FROM campaign_recipients WHERE contact_id = ?").get(outra) as any).n === 0);

  // ── 9. nada foi enviado
  check("9.1 nenhum destinatário saiu de 'pending' (zero envios)", (db.prepare("SELECT COUNT(*) n FROM campaign_recipients WHERE organization_id = ? AND status <> 'pending'").get(orgId) as any).n === 0 && (db.prepare("SELECT COALESCE(SUM(sent_count),0) n FROM campaigns WHERE organization_id = ?").get(orgId) as any).n === 0);

  // ── 10. rota
  const mkUser = (org: string, name: string, role: string) => { const id = randomUUID(); db.prepare("INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')").run(id, org, name, `${name}@${org.slice(0, 4)}.com`, role); return id; };
  const dono = mkUser(orgId, "Bruno", "owner"), atendente = mkUser(orgId, "Ana", "agent");
  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    const uid = String(req.headers["x-uid"] || "");
    const row = uid ? (db.prepare("SELECT id, organization_id, role FROM users WHERE id = ?").get(uid) as any) : null;
    if (row) { req.organizationId = row.organization_id; req.user = { userId: row.id, role: row.role, organizationId: row.organization_id }; }
    next();
  });
  app.use("/api/social", social);
  const server = http.createServer(app);
  const port: number = await new Promise((rs) => server.listen(0, () => rs((server.address() as any).port)));
  const post = async (uid: string, body: any) => { const r = await fetch(`http://127.0.0.1:${port}/api/social/content-broadcast`, { method: "POST", headers: { "Content-Type": "application/json", "x-uid": uid }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const e3 = entry(orgId, "Texto via rota");
  const before = campaigns().length;
  const rr = await post(dono, { entryId: e3, channel: "whatsapp", campaign: "rota" });
  check("10.1 dono cria o rascunho pela rota", rr.status === 200 && rr.body.created === true && campaigns().length === before + 1);
  check("10.2 a rota não aceita afrouxar o consentimento (requireConsent:false é ignorado)", (await post(dono, { entryId: entry(orgId, "Outro via rota"), channel: "whatsapp", requireConsent: false, dryRun: true })).body.audience.requireConsent === true);
  check("10.3 erro de regra vira 400 com a mensagem", (await post(dono, { entryId: "nada", channel: "whatsapp" })).status === 400);
  check("10.4 atendente barrado", (await post(atendente, { entryId: e3, channel: "whatsapp" })).status === 403);
  check("10.5 criar rascunho fica no registro de auditoria", (db.prepare("SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CONTENT_BROADCAST_DRAFTED'").get(orgId) as any).n >= 1);
  server.close();

  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
