/**
 * TESTE — ADR-204 F3.6a: FalaTu MULTI-AÇÃO — "uma frase → N ações → UMA confirmação".
 * ----------------------------------------------------------------------------
 * Prova, nos serviços REAIS:
 *   A) a DIVISÃO reusa o classificador existente: só vira ação o pedaço que o FalaTu já reconhece como registro; pedaço que não é
 *      ação ("leite") é colado no anterior; vírgula de valor (R$ 1,50) nunca corta; pergunta/mistura/1 ação → NÃO é multi (0-regressão);
 *   B) a PRÉ-VISUALIZAÇÃO não escreve nada; item de dinheiro aparece bloqueado p/ quem não vê dinheiro; >6 pedidos → pede pra mandar menos;
 *   C) CONFIRMAR prepara cada item mantido pelo MESMO caminho de sempre (proposta governada / Inbox) — NADA é aprovado ou executado;
 *      item que o motor não consegue preparar volta com o motivo; removido não é criado; resumo honesto;
 *   D) idempotente (confirmar 2× não duplica), isolado (outro usuário/empresa não confirma), plano expira, ids inválidos recusados;
 *   E) auditoria sem o texto do dono; rotas (200/400); UI (lista com checkbox + 1 botão).
 *
 * Uso:  npm run test:falatu-multi-action
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-multi-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-multi-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuAskService: A } = await import("../src/server/FalaTuAskService.js");
  const { FalaTuMultiActionService: M, MULTI_MAX_ACTIONS, MULTI_PLAN_TTL_MS } = await import("../src/server/FalaTuMultiActionService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const O = mkOrg(), P = mkOrg();
  const profile = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id;
  const mkUser = (org: string, role: string, key: string, name: string) => { const id = randomUUID(); const email = `${id}@t.local`; db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')`).run(id, org, name, email, role); return { userId: id, id, role, role_profile_id: profile(org, key), name, email }; };
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  // Mock da extração por IA (mesmo padrão de test-falatu.ts): o resto do fluxo — Inbox, propostas governadas — é real.
  (FalaTuService as any).interpret = async (input: any) => {
    const text = input.text || "";
    return { transcription: text, confidence: 0.9, suggestedAction: "sugestão", summary: text.slice(0, 60), intent: "TASK", entities: { people: [], projects: [], actions: ["ligar"], listItems: [], eventDate: null, eventTime: null } };
  };
  FalaTuService.setOrgEnabled(O, true);                       // a rota /ask exige o módulo FalaTu ligado na empresa
  const dono = mkUser(O, "owner", "owner", "Dona"), vend = mkUser(O, "agent", "vendedor", "Vendedor"), outra = mkUser(P, "owner", "owner", "Outra");
  const TODAY = "2026-10-06";
  const now = (d = new Date("2026-10-06T15:00:00Z")) => d;
  const count = (t: string, org = O) => (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE organization_id = ?`).get(org) as any).c;
  const snapshot = () => JSON.stringify([count("decision_actions"), count("falatu_inbox_items"), count("contacts"), count("appointments"), count("tasks")]);

  // ── A) divisão ──
  const sp = (t: string) => M.split(t, TODAY);
  const tres = sp("cadastra o cliente João Silva e marca reunião com João Silva amanhã às 10h; anota ligar pro contador");
  check("3 pedidos (cliente + compromisso + anotação) → 3 ações, na ordem, com o texto original", tres.length === 3 && tres[0] === "cadastra o cliente João Silva" && /^marca reunião com João Silva amanhã às 10h$/.test(tres[1]) && tres[2] === "anota ligar pro contador", JSON.stringify(tres));
  check("1 ação só → NÃO é multi", sp("cadastra o cliente João").length === 0 && sp("anota ligar pro contador").length === 0);
  check("'e' que liga itens da MESMA ação (pão e leite) não divide", sp("anota comprar pão e leite").length === 0);
  const cola = sp("anota comprar pão e leite e cadastra o cliente Maria");
  check("a cola vale quando há uma 2ª ação de verdade: 'anota comprar pão e leite' + 'cadastra o cliente Maria'", cola.length === 2 && cola[0] === "anota comprar pão e leite", JSON.stringify(cola));
  const val = sp("paguei R$ 1,50 de café e lança a despesa de R$ 200 com fornecedor Acme");
  check("vírgula de VALOR (R$ 1,50) nunca corta e o valor sai intacto", val.length === 2 && /R\$ 1,50/.test(val[0]) && /R\$ 200/.test(val[1]), JSON.stringify(val));
  check("pergunta misturada com ação NÃO é multi (segue o caminho de antes)", sp("anota ligar pro contador e quanto vendi hoje").length === 0 && sp("quanto vendi hoje e anota ligar pro contador").length === 0);
  check("2 ações de dinheiro (venda + recebível) → 2", sp("registra a venda de R$500 e lança o recebível de R$200 do cliente João").length === 2);
  check("texto curto/vazio nunca é multi", sp("").length === 0 && sp("oi e tchau").length === 0);

  // ── B) pré-visualização ──
  const before = snapshot();
  const pv: any = await A.converse(O, dono, "cadastra o cliente João Silva e anota ligar pro contador amanhã", { now: now() });
  check("a frase com 2 ações vira 'multi_action' com a LISTA", pv.kind === "multi_action" && pv.data.multiPlan.items.length === 2 && /Entendi 2 pedidos/.test(pv.answer) && /UMA vez/.test(pv.answer));
  check("a pré-visualização NÃO escreve nada (ações, Inbox, clientes, agenda, tarefas)", snapshot() === before);
  check("cada item diz pra onde vai (Aprovações × Inbox)", pv.data.multiPlan.items[0].label.includes("Aprovações") && pv.data.multiPlan.items[1].label.includes("Inbox"));
  const pvMoney: any = await A.converse(O, vend, "lança a despesa de R$200 com fornecedor Acme e anota ligar pro contador", { now: now() });
  const itM = pvMoney.data.multiPlan.items;
  check("quem não vê dinheiro: o item de DINHEIRO aparece bloqueado (🔒) e o outro não", !!itM[0].blocked && itM[1].blocked === null && /🔒/.test(pvMoney.answer));
  const tooMany: any = await A.converse(O, dono, Array.from({ length: MULTI_MAX_ACTIONS + 1 }, (_, i) => `cadastra o cliente Pessoa${i}`).join("; "), { now: now() });
  check(`mais de ${MULTI_MAX_ACTIONS} pedidos → pede pra mandar menos e NÃO guarda plano`, tooMany.kind === "multi_action" && tooMany.data.multiPlan === null && /até 6/.test(tooMany.answer));
  const single: any = await A.converse(O, dono, "cadastra o cliente Solitário, telefone 11 99999-0000", { now: now() });
  check("0-regressão: 1 ação segue o caminho de sempre (record_contact, proposta aguardando aprovação)", single.kind === "record_contact" && single.data?.awaitingApproval === true);
  const noMulti: any = await A.converse(O, dono, "cadastra o cliente Aaa e cadastra o cliente Bbb", { now: now(), noMulti: true } as any);
  check("`noMulti` desliga a divisão (usado pelo próprio confirm — não recursa)", noMulti.kind !== "multi_action");

  // ── C) confirmar ──
  const mk = async (text: string, user = dono) => ((await A.converse(O, user, text, { now: now() })) as any).data.multiPlan;
  const plan = await mk("cadastra o cliente Beatriz Lima, telefone 11 98888-7777 e lança a despesa de R$ 350 com fornecedor Acme e anota ligar pro contador amanhã");
  check("plano com 3 itens (cliente, despesa, anotação)", plan.items.length === 3 && plan.items.map((i: any) => i.kind).join() === "record_contact,record_expense,record");
  const sBefore = snapshot();
  const aBefore = count("decision_actions");
  const c1: any = await M.confirm(O, dono, plan.planId, [plan.items[0].id, plan.items[1].id, plan.items[2].id], { now: now() });
  check("confirmar UMA vez prepara os 3", c1.ok && c1.results.length === 3 && c1.results.every((r: any) => ["awaiting_approval", "inbox"].includes(r.outcome)), JSON.stringify(c1.results?.map((r: any) => r.outcome)));
  check("cliente e despesa viram PROPOSTAS aguardando aprovação; a anotação vai pro Inbox", c1.results[0].outcome === "awaiting_approval" && c1.results[1].outcome === "awaiting_approval" && c1.results[2].outcome === "inbox" && count("decision_actions") === aBefore + 2 && !!c1.results[2].pendingId);
  const acts = db.prepare(`SELECT status, approval_policy FROM decision_actions WHERE organization_id = ? ORDER BY created_at DESC LIMIT 2`).all(O) as any[];
  check("NADA foi aprovado nem executado: as propostas continuam aguardando uma pessoa", acts.every((a) => a.status === "awaiting_approval") && count("action_execution_log") === 0 && count("contacts") === 0, JSON.stringify(acts));
  check("o resumo diz quantas ficaram em Aprovações e quantas no Inbox", /2 preparada\(s\)/.test(c1.summary) && /1 anotada\(s\) no Inbox/.test(c1.summary), c1.summary);
  void sBefore;
  const c1b: any = await M.confirm(O, dono, plan.planId, null, { now: now() });
  check("idempotente: confirmar de novo devolve o MESMO resultado e não duplica nada", c1b.ok && c1b.alreadyConfirmed === true && count("decision_actions") === aBefore + 2 && c1b.summary === c1.summary);

  const plan2 = await mk("cadastra o cliente Caio Prado e anota ligar pro contador");
  const a2 = count("decision_actions");
  const c2: any = await M.confirm(O, dono, plan2.planId, [plan2.items[1].id], { now: now() });
  check("remover um item: só o mantido é preparado; o removido NÃO cria nada e é reportado", c2.ok && c2.results[0].outcome === "removed" && c2.results[1].outcome === "inbox" && count("decision_actions") === a2 && /1 removida/.test(c2.summary));
  const plan3 = await mk("marca reunião com Fulano Inexistente amanhã às 10h e anota ligar pro contador");
  const c3: any = await M.confirm(O, dono, plan3.planId, null, { now: now() });
  check("item que o motor NÃO consegue preparar (cliente não encontrado) volta com o MOTIVO — nunca finge que fez", c3.ok && c3.results[0].outcome === "not_prepared" && /Não achei o cliente/.test(c3.results[0].message) && c3.results[1].outcome === "inbox" && /NÃO preparada/.test(c3.summary), JSON.stringify(c3.results));
  const plan4 = await mk("lança a despesa de R$200 com fornecedor Acme e anota ligar pro contador", vend);
  const a4 = count("decision_actions");
  const c4: any = await M.confirm(O, vend, plan4.planId, [plan4.items[0].id, plan4.items[1].id], { now: now() });
  check("quem não vê dinheiro: mesmo marcando o item de dinheiro ele é barrado (nada criado) e o outro prossegue", c4.results[0].outcome === "blocked" && c4.results[1].outcome === "inbox" && count("decision_actions") === a4);

  // ── D) idempotência/isolamento/validação ──
  const plan5 = await mk("cadastra o cliente Dora Melo e anota ligar pro contador");
  check("outro USUÁRIO da mesma empresa não confirma o plano de alguém", (await M.confirm(O, vend, plan5.planId, null, { now: now() })).ok === false);
  check("outra EMPRESA não confirma", (await M.confirm(P, outra, plan5.planId, null, { now: now() })).ok === false);
  check("id fora do plano → recusado; lista vazia → recusada; nada criado", (await M.confirm(O, dono, plan5.planId, ["a99"], { now: now() })).ok === false && (await M.confirm(O, dono, plan5.planId, [], { now: now() })).ok === false && count("decision_actions") === a4);
  check("plano inexistente → recusado", (await M.confirm(O, dono, "nao-existe", null, { now: now() })).ok === false);
  const plan6 = await mk("cadastra o cliente Eli Rosa e anota ligar pro contador");
  const late = new Date(Date.now() + MULTI_PLAN_TTL_MS + 60_000);
  check("plano expirado (15 min) → recusado, pede pra repetir", (await M.confirm(O, dono, plan6.planId, null, { now: late })).ok === false);
  const plan7 = await mk("cadastra o cliente Gil Neves e anota ligar pro contador");
  check("cancelar descarta (nada foi escrito) e depois não dá mais pra confirmar", M.cancel(O, dono, plan7.planId) === true && (await M.confirm(O, dono, plan7.planId, null, { now: now() })).ok === false && M.cancel(O, vend, plan5.planId) === false);

  // ── E) auditoria, rotas, UI ──
  const aud = db.prepare(`SELECT metadata_json FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'FALATU_MULTI_CONFIRMED' ORDER BY created_at DESC`).all(O) as any[];
  check("auditoria registra quantidade e tipos — SEM o texto do dono", aud.length >= 3 && aud.every((a) => !/Beatriz|Acme|contador|350/.test(String(a.metadata_json))) && aud.some((a) => /cliente/.test(String(a.metadata_json))));

  const express = (await import("express")).default;
  const router = (await import("../src/server/routes/falatu.js")).default;
  const who: Record<string, any> = { dono, vend, outra };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-org"] || undefined; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/falatu", router);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (method: string, url: string, user: string, org: string, body?: any) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/falatu${url}`, { method, headers: { "Content-Type": "application/json", "x-user": user, "x-org": org }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const ask = await call("POST", "/ask", "dono", O, { question: "cadastra o cliente Hugo Alves e anota ligar pro contador" });
  check("rota /ask devolve a lista (kind multi_action, planId)", ask.status === 200 && ask.body.kind === "multi_action" && !!ask.body.data.multiPlan.planId);
  const pid = ask.body.data.multiPlan.planId;
  check("rota: keep inválido → 400", (await call("POST", `/multi/${pid}/confirm`, "dono", O, { keep: "a1" })).status === 400 && (await call("POST", `/multi/${pid}/confirm`, "dono", O, { keep: [1] })).status === 400);
  check("rota: outro usuário → 400 (não é dele)", (await call("POST", `/multi/${pid}/confirm`, "vend", O, {})).status === 400);
  const ok = await call("POST", `/multi/${pid}/confirm`, "dono", O, { keep: ["a1", "a2"] });
  check("rota: confirma (200) com resumo e resultados", ok.status === 200 && ok.body.ok && ok.body.results.length === 2 && /Pronto/.test(ok.body.summary));
  const ask2 = await call("POST", "/ask", "dono", O, { question: "cadastra o cliente Ivo Reis e anota ligar pro contador" });
  check("rota: cancelar", (await call("POST", `/multi/${ask2.body.data.multiPlan.planId}/cancel`, "dono", O, {})).body.ok === true);
  server.close();

  const ui = fs.readFileSync(path.join(process.cwd(), "src/features/FalaTuView.tsx"), "utf8");
  check("UI: lista com checkbox por ação + UM botão de preparar + cancelar", /falatu-multi-plan/.test(ui) && /type="checkbox"/.test(ui) && /Preparar \$\{t\.multi\.keep\.length\} ação\(ões\)/.test(ui) && /\/multi\/\$\{t\.multi\.planId\}\/confirm/.test(ui) && /\/cancel/.test(ui));
  check("UI: item bloqueado fica desabilitado e a telemetria só conta QUANTAS (nunca o texto)", /disabled=\{!!it\.blocked/.test(ui) && /trackAction\('falatu_multi_confirmar', String\(t\.multi\.keep\.length\)\)/.test(ui));

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
