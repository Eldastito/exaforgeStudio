/**
 * TESTE — Responder comentário / Direct do Instagram, GOVERNADO (ADR-207 F9b).
 *
 * Prova, com o serviço, o executor, o handler registrado e as rotas REAIS (só a chamada à Meta é simulada, por transporte injetado):
 *  - propor NÃO envia nada: nasce `awaiting_approval`; executar sem aprovação é recusado; só depois de aprovada por uma pessoa envia;
 *  - o texto parte do rascunho da F9a, o dono pode editar; reclamação não tem rascunho → exige texto; sanitização; limites (2000 chars / 1000 bytes);
 *  - resposta PRIVADA só até 7 dias e 1 por comentário; pública sem janela; comentário já respondido / dispensado / de outra empresa recusam;
 *  - formato certo da chamada à Meta (público: /{comentário}/replies; privado: /{ig-id}/messages com recipient.comment_id) e envio ÚNICO;
 *  - permissão da Meta ausente → falha "Aguardando permissão da Meta (escopo)", NADA marcado como respondido, e reenvio funciona depois;
 *  - Instagram desconectado recusa; idempotente (2º execute barrado); respondeu → sai da fila (status answered, aviso resolvido);
 *  - proposta repetida não duplica; rotas só dono/administrador; isolamento entre empresas.
 *
 * Uso: npm run test:instagram-comment-reply
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ig-reply-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ig-reply-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const social = (await import("../src/server/routes/social.js")).default;
  const { InstagramCommentReplyService: R } = await import("../src/server/InstagramCommentReplyService.js");
  const { InstagramCommentIntentService: I } = await import("../src/server/InstagramCommentIntentService.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");

  const orgId = randomUUID(), other = randomUUID(), semIg = randomUUID();
  for (const [id, ig] of [[orgId, "ig-111"], [other, "ig-222"], [semIg, null]] as const) {
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
    if (ig) db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'instagram', 'Instagram @t', ?, 'connected', ?)`).run(randomUUID(), id, ig, EncryptionService.encrypt("tok-" + id.slice(0, 4)));
  }
  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, active, storefront_visible) VALUES (?, ?, 'Vestido Aurora', 'product', 289.9, 1, 1)`).run(prod, orgId);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, title) VALUES (?, 'toulon', 1, 'T')`).run(orgId);
  I.setEnabled(orgId, true); I.setEnabled(other, true); I.setEnabled(semIg, true);
  const ingest = (biz: string, id: string, text: string, user = "maria", media = "m1") => I.ingestChange(biz, { field: "comments", value: { id, text, from: { id: "u-" + id, username: user }, media: { id: media } } });
  I.linkMedia(orgId, "m1", prod);
  ingest("ig-111", "c-price", "quanto custa?");
  ingest("ig-111", "c-compl", "Golpe! não recebi nada", "joao");
  ingest("ig-111", "c-old", "quero comprar", "ana");
  ingest("ig-111", "c-dism", "tem no M?", "bia");
  ingest("ig-222", "c-other", "quanto custa?");
  const intent = (org: string, cid: string) => db.prepare("SELECT * FROM instagram_comment_intents WHERE organization_id = ? AND comment_id = ?").get(org, cid) as any;
  db.prepare("UPDATE instagram_comment_intents SET created_at = datetime('now','-10 days') WHERE id = ?").run(intent(orgId, "c-old").id);
  I.dismiss(orgId, intent(orgId, "c-dism").id);
  const thrown = (fn: () => any) => { try { fn(); return ""; } catch (e: any) { return String(e.message); } };
  const athrown = async (fn: () => Promise<any>) => { try { await fn(); return ""; } catch (e: any) { return String(e.message); } };

  // transporte simulado da Meta
  const calls: Array<{ url: string; method: string; body: any; ct: string | null }> = [];
  let mode: "ok" | "perm" | "other" = "ok";
  R.transport = (async (url: any, init: any) => {
    const body = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body.entries()) : (init?.body ? JSON.parse(init.body) : null);
    calls.push({ url: String(url), method: init?.method, body, ct: init?.headers?.["Content-Type"] ?? null });
    if (mode === "perm") return new Response(JSON.stringify({ error: { message: "(#10) Application does not have permission for this action", code: 10 } }), { status: 403 });
    if (mode === "other") return new Response(JSON.stringify({ error: { message: "Comentário removido", code: 100 } }), { status: 400 });
    return new Response(JSON.stringify(String(url).includes("/messages") ? { recipient_id: "r1", message_id: "mid-1" } : { id: "reply-1" }), { status: 200 });
  }) as any;

  // ── 1. propor NÃO envia
  const price = intent(orgId, "c-price");
  const p1 = R.propose(orgId, "u1", { intentId: price.id, kind: "public" });
  check("1.1 propor devolve ação AGUARDANDO APROVAÇÃO e não chama a Meta", p1.deduped === false && p1.action.status === "awaiting_approval" && calls.length === 0, String(p1.action.status));
  const payload = JSON.parse(p1.action.command_payload_json);
  check("1.2 o texto é o rascunho da F9a (preço do catálogo) e o comentário vai no comando", /R\$ 289,90/.test(payload.text) && payload.commentId === "c-price" && payload.kind === "public" && payload.intentId === price.id);
  check("1.3 o texto do cliente NUNCA entra na resposta", !/quanto custa/i.test(payload.text));
  check("1.4 repetir a proposta não duplica (devolve a mesma, deduped)", (() => { const again = R.propose(orgId, "u1", { intentId: price.id, kind: "public" }); return again.deduped === true && again.action.id === p1.action.id && (db.prepare("SELECT COUNT(*) n FROM decision_actions WHERE organization_id = ? AND action_type = 'instagram_comment_reply'").get(orgId) as any).n === 1; })());
  check("1.5 tipos diferentes (público × privado) são ações separadas", (() => { const pv = R.propose(orgId, "u1", { intentId: price.id, kind: "private" }); return pv.deduped === false && pv.action.id !== p1.action.id; })());

  // ── 2. governança
  check("2.1 executar SEM aprovação é recusado e não chama a Meta", /não aprovada/i.test(await athrown(() => R.execute(orgId, p1.action.id))) && calls.length === 0);
  DecisionActionService.approve(orgId, p1.action.id, "u1");
  const ex = await R.execute(orgId, p1.action.id);
  check("2.2 aprovada por uma pessoa → envia UMA chamada à Meta", calls.length === 1 && /resposta publicada/i.test(ex.result?.summary || ""), JSON.stringify(ex));
  check("2.3 formato público: POST /{comentário}/replies com message e token", calls[0].url.includes("/c-price/replies") && calls[0].method === "POST" && calls[0].body.message === payload.text && !!calls[0].body.access_token);
  check("2.4 respondeu → comentário marcado, sai da fila e o aviso é resolvido", (() => { const r = intent(orgId, "c-price"); const sg = db.prepare("SELECT status FROM business_signals WHERE organization_id = ? AND dedupe_key = ?").get(orgId, `ig.comment|${r.id}`) as any; return !!r.replied_public_at && r.status === "answered" && sg.status === "resolved"; })());
  check("2.5 2º execute da mesma ação é barrado (sem 2ª chamada)", /finalizada|já|terminal|duplic/i.test(await athrown(() => R.execute(orgId, p1.action.id))) && calls.length === 1);
  check("2.6 comentário já respondido não aceita nova proposta pública", /já recebeu a resposta pública/.test(thrown(() => R.propose(orgId, "u1", { intentId: price.id, kind: "public" }))));
  check("2.7 a lista mostra o respondido (status answered) e some de 'new'", I.list(orgId, { status: "new" }).comments.every((c: any) => c.commentId !== "c-price") && I.list(orgId, { status: "answered" }).comments.some((c: any) => c.commentId === "c-price" && c.repliedPublicAt));

  // ── 3. resposta privada
  const pv = R.propose(orgId, "u1", { intentId: price.id, kind: "private", text: "Oi! Te mando os detalhes por aqui. 😊" });
  check("3.1 com ação privada aberta, a proposta com outro texto devolve a existente (não cria 2ª)", pv.deduped === true);
  const pvAction = (db.prepare("SELECT * FROM decision_actions WHERE organization_id = ? AND command_payload_json LIKE '%\"kind\":\"private\"%'").get(orgId) as any);
  DecisionActionService.approve(orgId, pvAction.id, "u1");
  calls.length = 0;
  await R.execute(orgId, pvAction.id);
  check("3.2 formato privado: POST /{ig-id}/messages em JSON com recipient.comment_id", calls.length === 1 && calls[0].url.includes("/ig-111/messages") && calls[0].ct === "application/json" && calls[0].body.recipient.comment_id === "c-price" && !!calls[0].body.message.text);
  check("3.3 marcou a resposta privada (1 por comentário)", !!intent(orgId, "c-price").replied_private_at && /única resposta privada/.test(thrown(() => R.propose(orgId, "u1", { intentId: price.id, kind: "private" }))));

  // ── 4. janela de 7 dias
  const old = intent(orgId, "c-old");
  check("4.1 privada com comentário de 10 dias: recusa (prazo da Meta)", /7 dias/.test(thrown(() => R.propose(orgId, "u1", { intentId: old.id, kind: "private", text: "Oi!" }))));
  check("4.2 pública não tem janela: aceita comentário de 10 dias", R.propose(orgId, "u1", { intentId: old.id, kind: "public", text: "Oi! Veja na vitrine." }).deduped === false);

  // ── 5. texto
  const compl = intent(orgId, "c-compl");
  check("5.1 reclamação sem texto do dono: recusa (não há rascunho automático)", /Escreva o texto/.test(thrown(() => R.propose(orgId, "u1", { intentId: compl.id, kind: "public" }))));
  const cp = R.propose(orgId, "u1", { intentId: compl.id, kind: "public", text: "  Sentimos muito!\u0007 Vamos resolver.  Chama no Direct.  " });
  check("5.2 com texto do dono: aceita e sanitiza (sem caracteres de controle, espaços limpos)", JSON.parse(cp.action.command_payload_json).text === "Sentimos muito! Vamos resolver. Chama no Direct.");
  check("5.3 pública > 2000 caracteres recusa", /2000 caracteres/.test(thrown(() => R.propose(orgId, "u1", { intentId: intent(orgId, "c-old").id, kind: "public", text: "x".repeat(2001) }))));
  const ana2 = (ingest("ig-111", "c-acc", "quero", "carol"), intent(orgId, "c-acc"));
  check("5.4 privada > 1000 BYTES recusa (acentos/emoji contam mais que caracteres)", /1000 bytes/.test(thrown(() => R.propose(orgId, "u1", { intentId: ana2.id, kind: "private", text: "é".repeat(600) }))) && R.propose(orgId, "u1", { intentId: ana2.id, kind: "private", text: "e".repeat(900) }).deduped === false);

  // ── 6. recusas
  check("6.1 comentário dispensado recusa", /dispensado/.test(thrown(() => R.propose(orgId, "u1", { intentId: intent(orgId, "c-dism").id, kind: "public", text: "Oi" }))));
  check("6.2 comentário de OUTRA empresa → não encontrado", /não encontrado/.test(thrown(() => R.propose(orgId, "u1", { intentId: intent(other, "c-other").id, kind: "public", text: "Oi" }))));
  check("6.3 tipo inválido recusa", /Tipo inválido/.test(thrown(() => R.propose(orgId, "u1", { intentId: price.id, kind: "dm" as any, text: "Oi" }))));

  // ── 7. falha da Meta
  const old2 = intent(orgId, "c-old");
  const oldAct = (db.prepare("SELECT * FROM decision_actions WHERE organization_id = ? AND command_payload_json LIKE ?").get(orgId, `%${old2.id}%`) as any);
  DecisionActionService.approve(orgId, oldAct.id, "u1");
  calls.length = 0; mode = "perm";
  const permErr = await athrown(() => R.execute(orgId, oldAct.id));
  check("7.1 permissão da Meta ausente → falha honesta 'Aguardando permissão da Meta (escopo)'", /Aguardando permissão da Meta \(instagram_business_manage_comments\)/.test(permErr), permErr);
  check("7.2 nada foi marcado como respondido e o aviso segue", intent(orgId, "c-old").replied_public_at === null && intent(orgId, "c-old").status === "new");
  check("7.3 a falha fica no registro de execução (auditável)", (db.prepare("SELECT COUNT(*) n FROM action_execution_log WHERE action_id = ? AND status = 'failed'").get(oldAct.id) as any).n === 1);
  mode = "ok"; calls.length = 0;
  await R.execute(orgId, oldAct.id);
  check("7.4 depois que a permissão sai, o REENVIO da mesma ação funciona e marca respondido", calls.length === 1 && !!intent(orgId, "c-old").replied_public_at);
  mode = "other"; R.propose(orgId, "u1", { intentId: ana2.id, kind: "public", text: "Oi, veja na vitrine." });
  const a2 = (db.prepare("SELECT * FROM decision_actions WHERE organization_id = ? AND command_payload_json LIKE ? AND command_payload_json LIKE '%\"public\"%'").get(orgId, `%${ana2.id}%`) as any);
  DecisionActionService.approve(orgId, a2.id, "u1");
  const e75 = await athrown(() => R.execute(orgId, a2.id));
  check("7.5 outro erro da Meta (ex.: comentário removido) aparece como está, sem 'permissão'", /Comentário removido/.test(e75) && !/Aguardando permissão/.test(e75) && !intent(orgId, "c-acc").replied_public_at);
  mode = "ok";

  // ── 8. Instagram desconectado
  ingest("ig-222", "c-x2", "quanto custa?", "zed");
  db.prepare("UPDATE channels SET status = 'disabled' WHERE organization_id = ?").run(other);
  const x2 = intent(other, "c-x2");
  const ax = R.propose(other, "u9", { intentId: x2.id, kind: "public", text: "Oi" });
  DecisionActionService.approve(other, ax.action.id, "u9");
  check("8.1 Instagram desconectado: recusa na execução, sem chamar a Meta", /não conectado/.test(await athrown(() => R.execute(other, ax.action.id))) && !!x2 && !intent(other, "c-x2").replied_public_at);

  // ── 9. isolamento da execução
  const bx = R.propose(other, "u9", { intentId: intent(other, "c-other").id, kind: "public", text: "Oi" });
  DecisionActionService.approve(other, bx.action.id, "u9");
  check("9.1 outra empresa não executa a ação alheia", /não encontrada/i.test(await athrown(() => R.execute(orgId, bx.action.id))));

  // ── 10. rotas
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
  const call = async (uid: string, method: string, p2: string, body?: any) => { const rr = await fetch(`http://127.0.0.1:${port}/api/social${p2}`, { method, headers: { "Content-Type": "application/json", "x-uid": uid }, body: body ? JSON.stringify(body) : undefined }); return { status: rr.status, body: await rr.json().catch(() => ({})) as any }; };
  ingest("ig-111", "c-rota", "quanto custa?", "rita");
  const rota = intent(orgId, "c-rota");
  calls.length = 0;
  const pr = await call(dono, "POST", `/instagram/comments/${rota.id}/reply`, { kind: "public" });
  check("10.1 dono propõe pela rota: aguardando aprovação, nada enviado", pr.status === 200 && pr.body.status === "awaiting_approval" && calls.length === 0);
  check("10.2 atendente barrado nas duas rotas", (await call(atendente, "POST", `/instagram/comments/${rota.id}/reply`, { kind: "public" })).status === 403 && (await call(atendente, "POST", `/instagram/comment-replies/${pr.body.actionId}/execute`)).status === 403);
  check("10.3 executar pela rota sem aprovar → 409 e nada enviado", (await call(dono, "POST", `/instagram/comment-replies/${pr.body.actionId}/execute`)).status === 409 && calls.length === 0);
  DecisionActionService.approve(orgId, pr.body.actionId, dono);
  const er = await call(dono, "POST", `/instagram/comment-replies/${pr.body.actionId}/execute`);
  check("10.4 aprovada: executa pela rota e envia 1 vez", er.status === 200 && er.body.ok === true && calls.length === 1);
  check("10.5 erro de regra vira 400 com a mensagem", (await call(dono, "POST", `/instagram/comments/${rota.id}/reply`, { kind: "dm" })).status === 400);
  check("10.6 propor e executar ficam no registro de auditoria", (db.prepare("SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND event_type IN ('IG_COMMENT_REPLY_PROPOSED','IG_COMMENT_REPLY_EXECUTED')").get(orgId) as any).n >= 2);
  const listed = await call(dono, "GET", "/instagram/comments?status=new");
  check("10.7 a lista mostra a resposta aguardando/aprovada de cada comentário (não propõe de novo)", Array.isArray(listed.body.comments) && listed.body.comments.every((c: any) => Array.isArray(c.pendingReplies)));
  server.close();

  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
