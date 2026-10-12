/**
 * TESTE — Motor de Crescimento (ADR-207 F11): UMA tela que compõe Radar → Criar → Aprovar → Programados → Resultados → Aprendizados.
 *
 * Prova, com o serviço e a rota do dono REAIS:
 *  - ativação DERIVADA do que está configurado (canal conectado · marca preenchida · objetivo ativo · loja publicada) — sem flag nova,
 *    com o "próximo passo" certo; a loja é recomendada mas NÃO bloqueia;
 *  - empresa vazia: tudo vazio e honesto (nada inventado), 'Motor' ainda não ativo;
 *  - cada aba lê o que os serviços existentes já produzem (ideias, briefings, aprovações pendentes/aprovadas, rascunhos, programados,
 *    resultados medidos, aprendizados) e some só a seção que falhar (degradação por seção);
 *  - é READ-ONLY (nada é criado/aprovado/publicado ao abrir a tela); isolamento entre empresas; só dono/administrador.
 *
 * Uso: npm run test:growth-engine
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-growth-engine-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-growth-engine-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const social = (await import("../src/server/routes/social.js")).default;
  const { GrowthEngineService: G } = await import("../src/server/GrowthEngineService.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");
  const { BrandDnaService } = await import("../src/server/BrandDnaService.js");
  const { CampaignObjectiveContractService: Contracts } = await import("../src/server/CampaignObjectiveContractService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");
  const { EditorialCalendarService: Cal } = await import("../src/server/EditorialCalendarService.js");
  const { InstagramCommentIntentService: Comments } = await import("../src/server/InstagramCommentIntentService.js");

  const orgId = randomUUID(), empty = randomUUID(), other = randomUUID();
  for (const id of [orgId, empty, other]) db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);

  // ── 1. empresa VAZIA
  const e = await G.overview(empty) as any;
  check("1.1 vazia: Motor NÃO ativo, 3 passos obrigatórios faltando, loja é opcional", e.activation.ready === false && e.activation.steps.filter((s: any) => s.required && !s.done).length === 3 && e.activation.steps.find((s: any) => s.key === "store").required === false);
  check("1.2 vazia: próximo passo = conectar canal (com o lugar onde fazer)", e.activation.next.key === "channel" && e.activation.next.where === "channels");
  check("1.3 vazia: nada inventado em nenhuma aba", e.radar.whatToPost.length === 0 && e.create.briefs.length === 0 && e.approve.pending.length === 0 && e.approve.drafts.length === 0 && e.scheduled.entries.length === 0 && e.results.measured.length === 0 && e.learnings.learning.length === 0);
  check("1.4 vazia: manchete é a mensagem de ativação, não um número inventado", /Falta 3 passos/.test(e.headline));

  // ── 2. ativação passo a passo
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'instagram', 'Instagram @toulon', 'ig-1', 'connected', ?)`).run(randomUUID(), orgId, EncryptionService.encrypt("tok"));
  let a = (await G.overview(orgId) as any).activation;
  check("2.1 canal conectado conclui o passo 1 e o próximo vira 'marca'", a.steps[0].done === true && /Instagram/.test(a.steps[0].detail) && a.next.key === "brand");
  await BrandDnaService.save(orgId, "u1", { persona: "Mulher 30-45, trabalha fora", audience: "Moda feminina" } as any);
  a = (await G.overview(orgId) as any).activation;
  check("2.1b só 2 campos da marca ainda NÃO conclui o passo (e diz quantos faltam)", a.steps[1].done === false && /hoje 2 de 11/.test(a.steps[1].detail), a.steps[1].detail);
  await BrandDnaService.save(orgId, "u1", { positioning: "Alfaiataria acessível" } as any);
  a = (await G.overview(orgId) as any).activation;
  check("2.2 marca com 3 campos conclui o passo 2 · próximo = objetivo", a.steps[1].done === true && a.next.key === "objective", JSON.stringify(a.steps[1]));
  check("2.3 ainda NÃO ativo (falta o objetivo)", a.ready === false);
  Contracts.create(orgId, "u1", { objectiveId: "vendas" });
  a = (await G.overview(orgId) as any).activation;
  check("2.4 objetivo ativo → Motor ATIVADO, mesmo sem loja", a.ready === true && /ativado/i.test(a.message), JSON.stringify(a.steps.map((s: any) => [s.key, s.done])));
  check("2.5 sem loja: o próximo passo sugerido é publicar a loja (opcional)", a.next.key === "store" && a.steps[3].done === false);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, title) VALUES (?, 'toulon', 1, 'T')`).run(orgId);
  a = (await G.overview(orgId) as any).activation;
  check("2.6 loja publicada fecha o último passo; nada mais a fazer", a.steps[3].done === true && a.next === null);
  db.prepare(`UPDATE channels SET status = 'disabled' WHERE organization_id = ?`).run(orgId);
  const dis = (await G.overview(orgId) as any).activation;
  check("2.8 canal desabilitado não conta como conectado: passo volta a pendente", dis.steps[0].done === false && dis.ready === false);
  db.prepare(`UPDATE channels SET status = 'connected' WHERE organization_id = ?`).run(orgId);

  // ── 3. abas com dados
  BusinessSignalService.publish(orgId, {
    domain: "social", signalType: "content_opportunity", severity: "info", basis: "hypothesis", confidence: 0.6,
    sourceService: "OpportunityMatchingService", subjectType: "topic", subjectId: "linho",
    evidence: { vertical: "moda", topic: "linho no outono", channel: "instagram", evidenceMode: "model_knowledge" }, dedupeKey: "opp|moda|linho|instagram",
  } as any);
  const act1 = DecisionActionService.propose(orgId, { domain: "social", actionType: "social_publish", title: "Post de linho", commandType: "social_publish", commandPayload: { channel: "instagram" }, createdBy: "u1" });
  const act2 = DecisionActionService.propose(orgId, { domain: "social", actionType: "social_publish", title: "Reels", commandType: "social_publish", commandPayload: { channel: "instagram" }, createdBy: "u1" });
  const act3 = DecisionActionService.propose(orgId, { domain: "financeiro", actionType: "pagar", title: "Outra coisa (não social)", createdBy: "u1" });
  const act4 = DecisionActionService.propose(orgId, { domain: "social", actionType: "outra_coisa_social", title: "Ação social que não é publicação", createdBy: "u1" });
  Cal.draft(orgId, { channel: "instagram", caption: "rascunho", objective: "vendas" });
  const canc = Cal.draft(orgId, { channel: "instagram", caption: "cancelado", objective: "vendas" }); Cal.cancel(orgId, canc.id);
  const pub = Cal.draft(orgId, { channel: "instagram", caption: "já publicado", objective: "vendas" });
  db.prepare("UPDATE scheduled_posts SET status = 'published' WHERE id = ?").run(pub.id);
  const sch = Cal.draft(orgId, { channel: "instagram", caption: "programado", objective: "vendas" });
  Cal.approve(orgId, sch.id, { scheduledAt: new Date(Date.now() + 86400000).toISOString() });
  Comments.setEnabled(orgId, true);
  Comments.ingestChange("ig-1", { field: "comments", value: { id: "c1", text: "quanto custa?", from: { id: "u9", username: "maria" }, media: { id: "m1" } } });
  Comments.ingestChange("ig-1", { field: "comments", value: { id: "c2", text: "Amei!", from: { id: "u8", username: "ana" }, media: { id: "m1" } } });

  const before = JSON.stringify({
    act: db.prepare("SELECT id, status FROM decision_actions ORDER BY id").all(), sig: db.prepare("SELECT id, status FROM business_signals ORDER BY id").all(),
    posts: db.prepare("SELECT id, status FROM scheduled_posts ORDER BY id").all(), cmt: db.prepare("SELECT id, status FROM instagram_comment_intents ORDER BY id").all(),
  });
  const o = await G.overview(orgId) as any;
  const after = JSON.stringify({
    act: db.prepare("SELECT id, status FROM decision_actions ORDER BY id").all(), sig: db.prepare("SELECT id, status FROM business_signals ORDER BY id").all(),
    posts: db.prepare("SELECT id, status FROM scheduled_posts ORDER BY id").all(), cmt: db.prepare("SELECT id, status FROM instagram_comment_intents ORDER BY id").all(),
  });
  check("3.0 abrir a tela é READ-ONLY: ações, sinais, posts e comentários intactos", before === after);
  check("3.1 Radar: a ideia de conteúdo aparece, com o motivo", o.radar.available && o.radar.whatToPost.some((x: any) => x.label === "linho no outono" && x.kind === "content" && x.reason));
  check("3.2 Radar: só comentários COMERCIAIS contam (elogio não)", o.radar.commentsToAnswer === 1);
  check("3.3 Criar: briefing pronto para o Estúdio a partir da oportunidade", o.create.available && o.create.briefs.length === 1 && /linho no outono/.test(o.create.briefs[0].briefingText));
  check("3.4 Aprovar: só publicação SOCIAL aguardando aprovação", o.approve.available && o.approve.pending.length === 2 && o.approve.pending.every((p: any) => [act1.id, act2.id].includes(p.actionId)) && !o.approve.pending.some((p: any) => [act3.id, act4.id].includes(p.actionId)));
  check("3.5 Aprovar: rascunho do calendário aparece (e o programado não)", o.approve.drafts.length === 1 && o.approve.drafts[0].caption === "rascunho");
  check("3.6 Programados: só o agendado", o.scheduled.available && o.scheduled.entries.length === 1 && o.scheduled.entries[0].caption === "programado");
  check("3.7 Resultados: sem publicação medida, vazio (não inventa engajamento)", o.results.available && o.results.measured.length === 0);
  check("3.8 Aprendizados: sem desfecho assegurado, vazio", o.learnings.available && o.learnings.learning.length === 0 && o.learnings.champions.length === 0);
  check("3.9 manchete resume o que há para decidir", /1 ideia/.test(o.headline) && /pra aprovar/.test(o.headline) && /programado/.test(o.headline), o.headline);
  // aprovada, ainda não publicada
  DecisionActionService.approve(orgId, act1.id, "u1");
  DecisionActionService.approve(orgId, act4.id, "u1");
  const o2 = await G.overview(orgId) as any;
  check("3.10 aprovada vai para 'pronta para publicar' e sai das pendentes", o2.approve.approvedToPublish.some((x: any) => x.actionId === act1.id) && !o2.approve.approvedToPublish.some((x: any) => x.actionId === act4.id) && !o2.approve.pending.some((x: any) => x.actionId === act1.id));

  // resultado de campanha da loja (funil)
  const oid = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, status, payment_status, total_amount, created_by, attr_campaign, attr_source) VALUES (?, ?, 'pago', 'paid', 300, 'storefront', 'verao', 'instagram')`).run(oid, orgId);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total) VALUES (?, ?, ?, 'P', 300, 1, 300)`).run(randomUUID(), oid, orgId);
  const o3 = await G.overview(orgId) as any;
  check("3.11 Resultados: venda paga da campanha aparece (fato)", o3.results.campaigns.some((c: any) => c.campaign === "verao" && c.paidOrders === 1 && c.revenuePaid === 300));

  // ── 4. isolamento
  const ot = await G.overview(other) as any;
  check("4.1 outra empresa não vê nada da nossa", ot.radar.whatToPost.length === 0 && ot.approve.pending.length === 0 && ot.scheduled.entries.length === 0 && ot.results.campaigns.length === 0);

  // ── 5. degradação por seção
  const SC = (await import("../src/server/StudioBriefService.js")).StudioBriefService as any;
  const orig = SC.listOpportunities;
  SC.listOpportunities = () => { throw new Error("falha simulada"); };
  const d = await G.overview(orgId) as any;
  SC.listOpportunities = orig;
  check("5.1 uma fonte caída derruba só as seções que dependem dela (Criar e Radar), o resto segue", d.create.available === false && /falha simulada/.test(d.create.reason) && d.radar.available === false && d.approve.available === true && d.scheduled.available === true && d.activation.ready === true);

  // ── 6. rota
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
  const port: number = await new Promise((r) => server.listen(0, () => r((server.address() as any).port)));
  const get = async (uid: string) => { const r = await fetch(`http://127.0.0.1:${port}/api/social/growth-engine`, { headers: { "x-uid": uid } }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const r1 = await get(dono);
  check("6.1 dono recebe a tela inteira", r1.status === 200 && r1.body.activation.ready === true && Array.isArray(r1.body.approve.pending));
  check("6.2 atendente é barrado (tem dinheiro e aprovação)", (await get(atendente)).status === 403);
  check("6.3 sem login é barrado", [401, 403].includes((await get("")).status));
  server.close();

  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
