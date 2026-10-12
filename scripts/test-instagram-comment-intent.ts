/**
 * TESTE — Comentário do Instagram → intenção comercial (ADR-207 F9, parte A: entende e avisa; NÃO envia).
 *
 * Prova, com o serviço e as rotas do dono REAIS:
 *  - classificação determinística (preço/disponibilidade/compra/reclamação/elogio/spam/outro), sem confundir "tem tudo a ver";
 *  - texto de terceiro é higienizado e NUNCA entra no rascunho; reclamação não gera resposta automática (needsHuman);
 *  - produto só com prova (post ligado pelo dono, ou nome ÚNICO no texto); ambíguo/sem prova → pergunta qual peça;
 *  - preço do rascunho = preço do catálogo; sem promessa de estoque; produto inativo/oculto não aparece;
 *  - entrada do webhook: desligado (padrão) → NÃO trata (devolve false, fluxo antigo intacto); ligado → trata, dedupe por comentário,
 *    ignora a própria conta, canal desconhecido → false; sinal em business_signals só p/ comercial/reclamação, sem dinheiro;
 *  - não cria contato; retenção de 90 dias; isolamento entre empresas; rotas só dono/administrador.
 *
 * Uso: npm run test:instagram-comment-intent
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ig-comment-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ig-comment-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const social = (await import("../src/server/routes/social.js")).default;
  const { InstagramCommentIntentService: S } = await import("../src/server/InstagramCommentIntentService.js");

  const orgId = randomUUID(), other = randomUUID();
  for (const [id, slug, ig] of [[orgId, "toulon", "ig-111"], [other, "outra", "ig-222"]] as const) {
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(id, slug);
    db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, title) VALUES (?, ?, 1, ?)`).run(id, slug, slug);
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'instagram', 'IG', ?, 'connected')`).run(randomUUID(), id, ig);
  }
  const mkProduct = (org: string, name: string, price: number, extra: { active?: number; visible?: number } = {}) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, active, storefront_visible) VALUES (?, ?, ?, 'product', ?, ?, ?)`).run(id, org, name, price, extra.active ?? 1, extra.visible ?? 1);
    return id;
  };
  const vestido = mkProduct(orgId, "Vestido Aurora", 289.9), camisa = mkProduct(orgId, "Camisa Linho", 159);
  const inativo = mkProduct(orgId, "Casaco Antigo", 500, { active: 0 }), oculto = mkProduct(orgId, "Saia Secreta", 200, { visible: 0 });
  const produtoOutra = mkProduct(other, "Vestido Aurora", 1);

  // ── 1. classificação
  const c = (t: string) => S.classify(t);
  check("1.1 preço: 'quanto custa?'", c("Quanto custa?") === "price");
  check("1.2 preço: 'valor?' / 'preço' / 'R$'", c("valor?") === "price" && c("qual o preço") === "price");
  check("1.3 compra: 'como compro' / 'link' / 'quero'", c("Como compro?") === "buy" && c("manda o link") === "buy" && c("eu quero!") === "buy");
  check("1.4 disponibilidade: tamanho / 'tem no M'", c("Qual tamanho tem?") === "availability" && c("tem no M?") === "availability" && c("tem em 38?") === "availability");
  check("1.5 'tem tudo a ver' NÃO é disponibilidade", c("tem tudo a ver com você") !== "availability");
  check("1.6 reclamação vence preço", c("Golpe! paguei e não recebi, quanto vão devolver?") === "complaint");
  check("1.7 spam: link externo / seguidores", c("ganhe seguidores http://x.com") === "spam" && c("segue de volta?") === "spam");
  check("1.7b link sozinho (sem outra palavra de spam) é spam", c("olha isso http://x.com/promo") === "spam" && c("veja www.site.com") === "spam");
  check("1.8 elogio: 'amei' / emoji", c("Amei!!") === "praise" && c("😍😍") === "praise");
  check("1.9 vazio / sem pista → other", c("") === "other" && c("kkkk") === "other");
  check("1.10 acento e caixa: 'PREÇO'/'Preço'", c("PREÇO?") === "price" && c("Preço") === "price");
  check("1.11 palavra dentro de outra não conta ('quero' ≠ 'quer')", c("quer saber a história") !== "buy");

  // ── 2. higiene do texto de terceiro
  const sn = S.snippet("oi\n\n\t  tudo \u0007bem " + "x".repeat(300));
  check("2.1 snippet sem controles, espaço normalizado, ≤140", !/[\u0000-\u001f]/.test(sn) && sn.length <= 140 && sn.startsWith("oi tudo bem"));

  // ── 3. produto
  S.linkMedia(orgId, "media-1", vestido);
  check("3.1 post ligado ao produto vence", S.productFor(orgId, "media-1", "quanto?")?.id === vestido && S.productFor(orgId, "media-1", "quanto?")?.via === "media");
  check("3.2 nome único no texto", S.productFor(orgId, null, "quanto custa a camisa linho?")?.id === camisa);
  check("3.3 sem prova → null", S.productFor(orgId, null, "quanto custa?") === null && S.productFor(orgId, "media-x", "quanto?") === null);
  check("3.4 ambíguo (2 produtos citados) → null", S.productFor(orgId, null, "vestido aurora ou camisa linho? quanto?") === null);
  check("3.5 produto inativo/oculto nunca vira contexto", S.productFor(orgId, null, "casaco antigo quanto") === null && S.productFor(orgId, null, "saia secreta quanto") === null);
  let threw = false; try { S.linkMedia(orgId, "media-2", produtoOutra); } catch { threw = true; }
  check("3.6 não liga produto de OUTRA empresa", threw);
  threw = false; try { S.linkMedia(orgId, "media-2", inativo); } catch { threw = true; }
  check("3.7 não liga produto inativo", threw);
  check("3.8 desligar a ligação", S.linkMedia(orgId, "media-1", null).linked === false && S.productFor(orgId, "media-1", "quanto?") === null);
  S.linkMedia(orgId, "media-1", vestido);

  // ── 4. rascunho
  const dV = S.draft(orgId, "price", { id: vestido, name: "Vestido Aurora", price: 289.9 });
  check("4.1 preço: usa o do catálogo e o link da vitrine com origem", !!dV.text && dV.text.includes("R$ 289,90") && dV.text.includes("/loja/toulon/produto/") && dV.text.includes("zf_source=instagram"), String(dV.text));
  const dA = S.draft(orgId, "availability", { id: vestido, name: "Vestido Aurora", price: 289.9 });
  check("4.2 disponibilidade: manda ver na vitrine, SEM afirmar estoque nem preço", !!dA.text && !/R\$/.test(dA.text) && /disponibilidade/.test(dA.text) && !/tem sim|em estoque/i.test(dA.text));
  check("4.3 sem produto: pergunta qual peça", S.draft(orgId, "buy", null).text!.includes("Qual peça"));
  check("4.4 reclamação: sem resposta automática, needsHuman", S.draft(orgId, "complaint", null).text === null && S.draft(orgId, "complaint", null).needsHuman === true);
  check("4.5 spam/other: sem rascunho", S.draft(orgId, "spam", null).text === null && S.draft(orgId, "other", null).text === null);
  check("4.6 produto sem preço: não inventa valor", !/R\$/.test(S.draft(orgId, "price", { id: vestido, name: "X", price: null }).text || ""));

  // ── 5. entrada do webhook
  const ev = (id: string, text: string, extra: any = {}) => ({ field: "comments", value: { id, text, from: { id: "u-9", username: "maria" }, media: { id: "media-1" }, ...extra } });
  check("5.1 DESLIGADO (padrão): não trata → fluxo antigo segue", S.ingestChange("ig-111", ev("c1", "quanto custa?")) === false && S.list(orgId).comments.length === 0);
  S.setEnabled(orgId, true);
  check("5.2 ligado: trata e grava", S.ingestChange("ig-111", ev("c1", "quanto custa?")) === true && S.list(orgId).comments.length === 1);
  const first = S.list(orgId).comments[0];
  check("5.3 intenção, produto (post) e rascunho", first.intent === "price" && first.productName === "Vestido Aurora" && first.productVia === "media" && /R\$ 289,90/.test(first.draftReply));
  check("5.4 o texto do comentário NÃO entra no rascunho", !/quanto custa/i.test(first.draftReply));
  check("5.5 reentrega da Meta: dedupe por comentário (e segue 'tratado', não cai no fluxo de DM)", S.ingestChange("ig-111", ev("c1", "quanto custa?")) === true && S.list(orgId).comments.length === 1);
  check("5.6 comentário da própria conta é ignorado (tratado, sem gravar)", S.ingestChange("ig-111", ev("c2", "obrigado!", { from: { id: "ig-111", username: "toulon" } })) === true && S.list(orgId).comments.length === 1);
  check("5.7 canal desconhecido → false (cai no fluxo antigo)", S.ingestChange("ig-999", ev("c3", "quanto?")) === false);
  check("5.8 evento que não é comentário → false", S.ingestChange("ig-111", { field: "mentions", value: {} }) === false && S.ingestChange("ig-111", null) === false);
  check("5.9 comentário sem id → tratado e não grava", S.ingestChange("ig-111", { field: "comments", value: { text: "oi", from: { id: "u" } } }) === true && S.list(orgId).comments.length === 1);
  S.ingestChange("ig-111", ev("c4", "Golpe! não recebi nada", { from: { id: "u-3", username: "joao" }, media: { id: "m-z" } }));
  S.ingestChange("ig-111", ev("c5", "Amei!", { media: { id: "m-z" } }));
  S.ingestChange("ig-111", ev("c6", "ganhe seguidores http://spam.com"));
  S.ingestChange("ig-111", ev("c7", "tem no M?", { media: { id: "media-1" } }));
  const sig = (type: string) => (db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND signal_type = ?").all(orgId, type) as any[]);
  check("5.10 sinal só p/ comercial (preço + disponibilidade) e reclamação", sig("instagram_comment_commercial").length === 2 && sig("instagram_comment_complaint").length === 1);
  check("5.11 elogio e spam não geram sinal", (db.prepare("SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type LIKE 'instagram_comment_%'").get(orgId) as any).n === 3);
  const s0 = sig("instagram_comment_commercial")[0];
  check("5.12 sinal sem dinheiro, hipótese, trecho curto", s0.impact_amount === null && s0.basis === "hypothesis" && JSON.parse(s0.evidence_json).snippet.length <= 100);
  check("5.13 reclamação: severidade risk e sem rascunho", sig("instagram_comment_complaint")[0].severity === "risk" && S.list(orgId).comments.find((x: any) => x.intent === "complaint").draftReply === null && S.list(orgId).comments.find((x: any) => x.intent === "complaint").needsHuman === true);
  check("5.14 spam gravado como 'other/spam' sem produto", S.list(orgId, { intent: "spam" }).comments.length === 1 && S.list(orgId, { intent: "spam" }).comments[0].productId === null);
  check("5.15 NÃO cria contato a partir de comentário", (db.prepare("SELECT COUNT(*) n FROM contacts WHERE organization_id = ?").get(orgId) as any).n === 0);

  // ── 6. dispensar
  const toDismiss = S.list(orgId, { intent: "price" }).comments[0];
  check("6.1 dispensar resolve o sinal", S.dismiss(orgId, toDismiss.id) === true && S.list(orgId, { status: "dismissed" }).comments.length === 1 && sig("instagram_comment_commercial").filter((x) => x.status === "open").length === 1);
  check("6.2 dispensar de novo / id alheio → false", S.dismiss(orgId, toDismiss.id) === false);
  const aberto = S.list(orgId, { status: "new", intent: "complaint" }).comments[0];
  check("6.3 id de OUTRA empresa não dispensa (e o comentário segue aberto)", S.dismiss(other, aberto.id) === false && S.list(orgId, { status: "new", intent: "complaint" }).comments.length === 1);

  // ── 7. retenção + isolamento
  db.prepare("UPDATE instagram_comment_intents SET created_at = datetime('now','-100 days') WHERE organization_id = ? AND comment_id = 'c5'").run(orgId);
  S.ingestChange("ig-111", ev("c8", "link?"));
  check("7.1 comentário com mais de 90 dias é apagado", !S.list(orgId, { limit: 200 }).comments.some((x: any) => x.commentId === "c5"));
  S.setEnabled(other, true);
  S.ingestChange("ig-222", ev("c1", "quanto custa o vestido aurora?"));
  check("7.2 mesmo comment_id em outra empresa não colide e não vaza", S.list(other).comments.length === 1 && S.list(other).comments[0].productId === produtoOutra && !S.list(orgId, { limit: 200 }).comments.some((x: any) => x.productId === produtoOutra));

  // ── 8. rotas
  const mkUser = (org: string, name: string, role: string) => { const id = randomUUID(); db.prepare("INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')").run(id, org, name, `${name}@${org.slice(0, 4)}.com`, role); return id; };
  const dono = mkUser(orgId, "Bruno", "owner"), atendente = mkUser(orgId, "Ana", "agent"), donoOutra = mkUser(other, "Ze", "owner");
  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    const uid = String(req.headers["x-uid"] || "");
    const row = uid ? (db.prepare("SELECT id, organization_id, role FROM users WHERE id = ?").get(uid) as any) : null;
    if (row) { req.organizationId = row.organization_id; req.user = { userId: row.id, role: row.role, organizationId: row.organization_id }; }
    next();
  });
  app.use("/api/social", social);
  const server = http.createServer(app);
  const port: number = await new Promise((r) => server.listen(0, () => r((server.address() as any).port)));
  const call = async (uid: string, method: string, p: string, body?: any) => { const r = await fetch(`http://127.0.0.1:${port}/api/social${p}`, { method, headers: { "Content-Type": "application/json", "x-uid": uid }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const ord = S.list(orgId, { limit: 200 }).comments.map((x: any) => x.commentId);
  check("8.0 mais recente primeiro", ord.indexOf("c8") < ord.indexOf("c1"), ord.join(","));
  check("8.1 dono lista", (await call(dono, "GET", "/instagram/comments")).status === 200);
  check("8.2 atendente barrado em tudo", (await call(atendente, "GET", "/instagram/comments")).status === 403 && (await call(atendente, "PUT", "/instagram/comments/settings", { enabled: true })).status === 403 && (await call(atendente, "POST", "/instagram/comments/x/dismiss")).status === 403 && (await call(atendente, "PUT", "/instagram/media-product", { mediaId: "m", productId: vestido })).status === 403);
  const off = await call(dono, "PUT", "/instagram/comments/settings", { enabled: false });
  check("8.3 dono desliga e religa", off.body.enabled === false && (await call(dono, "PUT", "/instagram/comments/settings", { enabled: true })).body.enabled === true);
  check("8.4 só aceita enabled === true (string 'true' não liga)", (await call(dono, "PUT", "/instagram/comments/settings", { enabled: "true" })).body.enabled === false);
  await call(dono, "PUT", "/instagram/comments/settings", { enabled: true });
  check("8.5 ligar post→produto: ok; produto de outra empresa → 400", (await call(dono, "PUT", "/instagram/media-product", { mediaId: "m-77", productId: camisa })).status === 200 && (await call(dono, "PUT", "/instagram/media-product", { mediaId: "m-77", productId: produtoOutra })).status === 400);
  check("8.6 outra empresa não dispensa comentário alheio", (await call(donoOutra, "POST", `/instagram/comments/${first.id}/dismiss`)).status === 404);
  check("8.7 filtro por intenção na rota", (await call(dono, "GET", "/instagram/comments?intent=complaint")).body.comments.every((x: any) => x.intent === "complaint"));
  server.close();

  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
