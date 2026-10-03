/**
 * TESTE — Fase 2 / F2.8 (ADR-203): FalaTu com CONTEXTO, ESCOPO por papel e CONTINUIDADE (FalaTuConversationService + /ask + grupos de 1º nível).
 * Prova: (1) contexto corrente — a loja escolhida vira o padrão ("Quanto falta para bater a meta hoje?" → daquela loja); loja citada na frase
 * VENCE o contexto; "rede/todas as lojas" ignora o contexto; sem contexto = fluxo de sempre; (2) continuidade — "Por quê?" (Entender da F2.5: fato ×
 * hipótese, sem culpa), "E a Bangu?" (mesma ferramenta, outra loja), "E hoje?" (outro período); sem resposta anterior / passou 20 min / mudou de
 * assunto → NÃO continua (nunca inventa o que faltou); (3) role-aware — gerente preso à Bangu: só a Bangu (loja citada fora do escopo = recusa;
 * comparativo entre lojas = recusa; contexto de loja alheia = recusa; "E a Grande Rio?" = recusa), tudo no SERVIDOR; (4) dinheiro role-gated no
 * "Por quê?"; (5) isolamento por org+usuário; (6) /ask valida a loja do contexto; (7) 4 grupos de 1º nível cobrem as 9 abas do FalaTu (1 grupo
 * cada), flag desligada = abas planas. Determinístico, sem LLM.
 * Uso:  npm run test:falatu-conversation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-f28-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-conversation-1234567890";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

const NOW = new Date("2026-10-01T15:00:00Z");

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const F = (await import("../src/server/FalaTuAskService.js")).FalaTuAskService;
  const C = (await import("../src/server/FalaTuConversationService.js")).FalaTuConversationService;
  const R = (await import("../src/server/ExecutiveQueryRouterService.js")).ExecutiveQueryRouterService;
  const { PermissionService: P } = await import("../src/server/PermissionService.js");
  const { RetailMonthlyGoalService: G } = await import("../src/server/RetailMonthlyGoalService.js");
  R.llmFn = async () => "";
  const { FALATU_GROUPS, falatuGroupOf } = await import("../src/lib/falatuGroups.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?,?,?,?)`).run(randomUUID(), id, id, "active"); P.seedSystemProfiles(id); return id; };
  const A = mkOrg(), B = mkOrg();
  const userFor = (org: string, key: string) => ({ userId: randomUUID(), id: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id, role: key });
  const owner = userFor(A, "owner"), vendedor = userFor(A, "vendedor"), gerente = userFor(A, "gerente");
  const mkStore = (org: string, name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?,?,?,?)`).run(id, org, name, code); return id; };
  const grande = mkStore(A, "Grande Rio", "2001"), carioca = mkStore(A, "Carioca", "2002"), bangu = mkStore(A, "Bangu", "2003");
  const otherStore = mkStore(B, "Loja Alheia", "9001");
  G.set(A, { storeId: grande, month: "2026-10", goalAmount: 100000 }); G.set(A, { storeId: carioca, month: "2026-10", goalAmount: 60000 }); G.set(A, { storeId: bangu, month: "2026-10", goalAmount: 80000 });
  const ask = (u: any, q: string, ctx?: string | null) => F.converse(A, u, q, { now: NOW, contextStoreId: ctx ?? null });

  // ── (1) contexto corrente ──
  C.reset();
  let r = await ask(owner, "Quanto falta para bater a meta hoje?", bangu);
  check("com a loja escolhida (Bangu): 'quanto falta' vira a pergunta DA BANGU", /Bangu/.test(r.answer) && !/Carioca/.test(r.answer), r.answer.slice(0, 160));
  r = await ask(owner, "Quanto falta para a Carioca bater a meta hoje?", bangu);
  check("loja citada na frase VENCE o contexto (Carioca, não Bangu)", /Carioca/.test(r.answer) && !/Bangu/.test(r.answer), r.answer.slice(0, 160));
  r = await ask(owner, "Quanto falta para a rede bater a meta hoje?", bangu);
  check("'rede' ignora o contexto da loja (fluxo normal da rede)", !/^.{0,40}Bangu/.test(r.answer) || /Grande Rio|Carioca/.test(r.answer), r.answer.slice(0, 200));
  C.reset();
  r = await ask(owner, "Quanto falta para bater a meta hoje?", null);
  check("sem contexto: fluxo de sempre (rede, não fica presa a uma loja)", r.kind === "open_question" && (/Grande Rio|Carioca|Bangu|meta/i.test(r.answer)), r.answer.slice(0, 120));
  r = await ask(owner, "Quanto vendi em dinheiro hoje?", null);
  check("0-regressão: pergunta que o FalaTu já respondia (dinheiro de hoje) segue igual", r.kind === "cash_on_day", r.kind);

  // ── (2) continuidade ──
  C.reset();
  await ask(owner, "Quanto falta para a Carioca bater a meta hoje?");
  r = await ask(owner, "Por quê?");
  check("'Por quê?' explica a loja da última resposta com o Entender (períodos) e separa fato de hipótese", /Carioca/.test(r.answer) && /dia:.*mês:/.test(r.answer) && /Fato é número do sistema; hipótese é leitura possível dele, não causa comprovada/.test(r.answer) && !/culpa/i.test(r.answer), r.answer.slice(0, 260));
  r = await ask(owner, "E a Bangu?");
  check("'E a Bangu?' roda a MESMA ferramenta (meta do dia) em outra loja", /Bangu/.test(r.answer) && !/Carioca/.test(r.answer), r.answer.slice(0, 160));
  r = await ask(owner, "Por quê?");
  check("depois do 'E a Bangu?', o 'Por quê?' passa a ser da Bangu (o contexto acompanha)", /Bangu/.test(r.answer) && /Fato é número do sistema/.test(r.answer));
  C.reset();
  await ask(owner, "Quanto a Carioca vendeu ontem?");
  r = await ask(owner, "E hoje?");
  check("'E hoje?' troca só o período (vendas da Carioca, hoje)", /Carioca/.test(r.answer) && /hoje/i.test(r.answer), r.answer.slice(0, 160));
  check("o continuable vale enquanto há o que continuar (20 min)", !!C.last(A, owner, NOW.getTime()));

  C.reset();
  check("sem resposta anterior: 'Por quê?' NÃO é continuação (nunca inventa)", C.followUp(A, owner, "Por quê?", { now: NOW.getTime() }) === null && C.followUp(A, owner, "E a Bangu?", { now: NOW.getTime() }) === null);
  C.remember(A, owner, { tool: "meta_do_dia", args: { store: "Carioca" }, storeId: carioca }, NOW.getTime());
  check("passou 20 min: esquece (volta a tratar como pergunta nova)", C.followUp(A, owner, "Por quê?", { now: NOW.getTime() + 21 * 60_000 }) === null && C.last(A, owner, NOW.getTime() + 21 * 60_000) === null);
  C.remember(A, owner, { tool: "meta_do_dia", args: { store: "Carioca" }, storeId: carioca }, Date.now());
  await ask(owner, "Qual loja está com pior desempenho?");
  check("mudou de assunto (comparativo da rede): a conversa anterior é esquecida", C.last(A, owner) === null);
  C.remember(A, owner, { tool: "meta_do_dia", args: { }, storeId: null }, Date.now());
  r = await ask(owner, "Por quê?");
  check("última resposta SEM loja: 'Por quê?' PERGUNTA de qual loja (não chuta)", /De qual loja/.test(r.answer), r.answer);

  // ── (3) role-aware: gerente preso à Bangu ──
  db.prepare(`INSERT INTO user_stores (organization_id, user_id, store_id) VALUES (?,?,?)`).run(A, gerente.userId, bangu);
  C.reset();
  r = await ask(gerente, "Quanto falta para bater a meta hoje?");
  check("gerente preso à Bangu: a pergunta sem loja é da BANGU (escopo no servidor)", /Bangu/.test(r.answer) && !/Carioca|Grande Rio/.test(r.answer), r.answer.slice(0, 160));
  r = await ask(gerente, "Quanto falta para a Carioca bater a meta hoje?");
  check("loja citada fora do escopo: recusa clara, sem dado da Carioca", /acesso só a Bangu/.test(r.answer) && /Não posso falar da Carioca/.test(r.answer), r.answer);
  r = await ask(gerente, "Qual loja está com pior desempenho?");
  check("comparativo entre lojas é do dono/gestor da rede: recusa", /do dono ou do gestor da rede/.test(r.answer) && !/Carioca|Grande Rio/.test(r.answer.replace(/Eu posso responder.*/, "")), r.answer);
  r = await ask(gerente, "Quanto falta para bater a meta hoje?", carioca);
  check("contexto de loja alheia no /ask: 'Você não tem acesso a essa loja.'", /não tem acesso a essa loja/.test(r.answer), r.answer);
  C.remember(A, gerente, { tool: "meta_do_dia", args: { store: "Bangu" }, storeId: bangu }, NOW.getTime());
  r = await ask(gerente, "E a Grande Rio?");
  check("continuidade respeita o escopo: 'E a Grande Rio?' é recusado", /não tem acesso à Grande Rio/.test(r.answer), r.answer);
  const sem = await ask(owner, "Quanto falta para a Carioca bater a meta hoje?");
  check("o dono segue sem trava (a Carioca responde normalmente)", /Carioca/.test(sem.answer));

  // ── (4) dinheiro role-gated no Por quê ──
  C.remember(A, vendedor, { tool: "meta_do_dia", args: { store: "Carioca" }, storeId: carioca }, NOW.getTime());
  const sv = C.followUp(A, vendedor, "Por quê?", { now: NOW.getTime(), canSeeMoney: false });
  check("vendedor no 'Por quê?': número é do gestor (moneyRestricted), sem valores", !!sv && sv.moneyRestricted === true && !/R\$/.test(sv.text), sv?.text);

  // ── (5) isolamento ──
  C.remember(A, owner, { tool: "meta_do_dia", args: { store: "Carioca" }, storeId: carioca }, NOW.getTime());
  const sameUserOtherOrg = { ...owner };
  check("isolamento: a conversa de uma org/usuário não vaza para outra org", C.followUp(B, sameUserOtherOrg, "Por quê?", { now: NOW.getTime() }) === null && C.followUp(A, userFor(A, "owner"), "Por quê?", { now: NOW.getTime() }) === null);
  check("loja de outra org não vale como contexto (storeById)", C.storeById(A, otherStore) === null && C.storeById(B, otherStore)?.name === "Loja Alheia");

  // ── (6) rota ──
  const route = fs.readFileSync("src/server/routes/falatu.ts", "utf8");
  check("/ask valida o contexto (loja da org + escopo) e devolve 'continuable'", /context\.storeId/.test(route) && /Loja inválida para esta conta/.test(route) && /canAccessStore/.test(route) && /continuable:/.test(route));

  // ── (7) grupos de 1º nível ──
  const view = fs.readFileSync("src/features/FalaTuView.tsx", "utf8");
  const tabsBlock = view.slice(view.indexOf("const TABS = ["), view.indexOf("] as const;", view.indexOf("const TABS = [")));
  const realTabs = [...tabsBlock.matchAll(/\{ id: '([a-z]+)', label: '([^']+)'/g)].map(m => m[1]);
  const all = FALATU_GROUPS.flatMap(g => g.tabs);
  check("o FalaTu tem 9 abas reais e os 4 grupos (Conversar·Para mim·Organizar·Mais) cobrem TODAS, cada uma em 1 só grupo", realTabs.length === 9 && FALATU_GROUPS.length === 4 && realTabs.every(t => all.filter(a => a === t).length === 1) && all.length === 9, `${realTabs.length}/${all.length}`);
  check("grupos: 'ask'→Conversar, 'inbox'→Para mim, 'tasks'→Organizar, 'protocols'→Mais; aba desconhecida = null", falatuGroupOf("ask")?.label === "Conversar" && falatuGroupOf("inbox")?.label === "Para mim" && falatuGroupOf("tasks")?.label === "Organizar" && falatuGroupOf("protocols")?.label === "Mais" && falatuGroupOf("x") === null);
  check("flag desligada: as 9 abas planas de sempre; flag ligada: grupos", /\{simplified \? \(/.test(view) && /\{TABS\.map\(\(t\) => \(\s*<button key=\{t\.id\} onClick=\{\(\) => setTab\(t\.id\)\}/.test(view) && /FALATU_GROUPS\.map/.test(view));
  check("seletor 'Sobre:' só com 2+ lojas visíveis; manda context.storeId", /ctxStores\.length >= 2/.test(view) && /context: \{ storeId: ctxStoreId \}/.test(view) && /\/api\/retailops\/stores/.test(view));

  console.log(failures === 0 ? "\nTODOS OS CHECKS PASSARAM" : `\n${failures} FALHA(S)`);
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
