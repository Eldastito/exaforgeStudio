/**
 * TEST — Comigo/Menu Suggest LLM+RAG (Gap B do levantamento autônomos, ADR-088 D5 nível 2).
 *
 * Prova, offline e em banco temporário (SEM bater na OpenAI real):
 *   - desejo < 3 chars → source='empty', sem chamada
 *   - menu vazio → source='empty', sem chamada
 *   - sem AI configurado (aiConfiguredFn=false) → literal (LIKE em nome/descrição)
 *   - LLM devolve JSON válido com ids do menu → source='llm', até 3 itens
 *   - LLM devolve id FORA do menu → descarta id fantasma; se sobrar 0, cai pra literal
 *   - LLM devolve JSON malformado → literal
 *   - LLM lança → literal, sem consumir cap
 *   - Teto por org/dia estourado → literal + capReached=true; LLM NÃO é chamado
 *   - Isolamento entre orgs: cap de A não vaza pra B; menu de A não aparece em B
 *
 * Uso: npm run test:comigo-menu-suggest
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-menu-sug-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-menu-sug-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoMenuSuggestService, _internals } = await import("../src/server/ComigoMenuSuggestService.js");

  // ── Setup: 2 orgs (isolamento) ────────────────────────────────────────────
  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  // orgA cap=10 (folgado pros passos 4-8); orgB cap=50 (isolamento).
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_menu_suggest_daily_cap) VALUES (?, ?, 'Loja A', 'active', 10)`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_menu_suggest_daily_cap) VALUES (?, ?, 'Loja B', 'active', 50)`).run(randomUUID(), orgB);

  // Catálogo da orgA: 3 itens sellable + 1 inativo. orgB tem 1 item diferente.
  const salada = randomUUID();
  const feijoada = randomUUID();
  const suco = randomUUID();
  const otherA = randomUUID();  // inativo — não deve aparecer no snapshot
  const pizzaB = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, description, active) VALUES (?, ?, 'product', 'Salada Verde', 12, 'Folhas leves com molho de limão', 1)`).run(salada, orgA);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, description, active) VALUES (?, ?, 'product', 'Feijoada Completa', 45, 'Prato pesado tradicional', 1)`).run(feijoada, orgA);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, description, active) VALUES (?, ?, 'product', 'Suco Detox', 8, 'Bebida leve verde', 1)`).run(suco, orgA);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, description, active) VALUES (?, ?, 'product', 'Item Inativo', 5, null, 0)`).run(otherA, orgA);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, description, active) VALUES (?, ?, 'product', 'Pizza Peperoni', 60, null, 1)`).run(pizzaB, orgB);

  // ── 1. Guardas de entrada ────────────────────────────────────────────────
  _internals.setAIConfiguredFn(() => true);
  let chatCalls = 0;
  _internals.setChatFn(async () => { chatCalls++; return '{"items":[]}'; });

  const emptyDesire = await ComigoMenuSuggestService.interpret(orgA, "  ");
  check("desejo vazio → source=empty, 0 items", emptyDesire.source === "empty" && emptyDesire.items.length === 0);
  const shortDesire = await ComigoMenuSuggestService.interpret(orgA, "ok");
  check("desejo < 3 chars → source=empty", shortDesire.source === "empty");
  check("guarda de entrada não chama o LLM", chatCalls === 0);

  // ── 2. Menu vazio → empty (sem chamada) ──────────────────────────────────
  const orgVazia = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Vazia', 'active')`).run(randomUUID(), orgVazia);
  const noMenu = await ComigoMenuSuggestService.interpret(orgVazia, "qualquer coisa leve");
  check("menu vazio → source=empty", noMenu.source === "empty");
  check("menu vazio não chama o LLM", chatCalls === 0);

  // ── 3. Sem AI configurado → literal ──────────────────────────────────────
  _internals.setAIConfiguredFn(() => false);
  const lit = await ComigoMenuSuggestService.interpret(orgA, "leve verde");
  check("sem AI → source=literal", lit.source === "literal");
  check("literal casa Salada + Suco (contêm 'leve verde')", lit.items.length >= 1 && lit.items.every((i) => i.id === salada || i.id === suco));
  check("literal não chama o LLM", chatCalls === 0);

  // ── 4. LLM devolve JSON válido → source=llm ──────────────────────────────
  _internals.setAIConfiguredFn(() => true);
  chatCalls = 0;
  _internals.setChatFn(async (_prompt, opts) => {
    chatCalls++;
    check("chatFn recebe json:true", opts?.json === true);
    check("chatFn recebe temperature:0", opts?.temperature === 0);
    return JSON.stringify({ items: [
      { id: salada, reason: "leve, folhas cruas" },
      { id: suco, reason: "bebida leve e refrescante" },
    ]});
  });
  const okLlm = await ComigoMenuSuggestService.interpret(orgA, "algo leve");
  check("LLM OK → source=llm", okLlm.source === "llm");
  check("LLM OK → 2 items", okLlm.items.length === 2);
  check("LLM OK → primeiro é Salada com nome canônico", okLlm.items[0].id === salada && okLlm.items[0].name === "Salada Verde");
  check("LLM OK → preço vem do snapshot, não do LLM", okLlm.items[0].price === 12);
  check("LLM OK → reason preservado", okLlm.items[0].reason.includes("leve"));
  check("chatFn foi chamado 1 vez", chatCalls === 1);

  // ── 5. LLM devolve id FORA do menu → descarta ────────────────────────────
  chatCalls = 0;
  _internals.setChatFn(async () => JSON.stringify({ items: [
    { id: "id-fantasma-que-nao-existe", reason: "inventado" },
    { id: salada, reason: "leve" },
  ]}));
  const mixed = await ComigoMenuSuggestService.interpret(orgA, "algo leve");
  check("id fantasma descartado", mixed.items.length === 1);
  check("id válido sobrevive", mixed.items[0].id === salada);
  check("source=llm quando ao menos 1 id sobreviveu", mixed.source === "llm");

  // ── 6. LLM devolve SÓ ids inválidos → literal ────────────────────────────
  chatCalls = 0;
  _internals.setChatFn(async () => JSON.stringify({ items: [
    { id: "ghost-1", reason: "" },
    { id: "ghost-2", reason: "" },
  ]}));
  const allGhost = await ComigoMenuSuggestService.interpret(orgA, "leve verde");
  check("todos ids inválidos → cai pra literal", allGhost.source === "literal");
  check("literal fallback preserva itens do menu real", allGhost.items.every((i) => i.id === salada || i.id === suco));

  // ── 7. LLM devolve JSON malformado → literal ─────────────────────────────
  chatCalls = 0;
  _internals.setChatFn(async () => "isso não é json {{{");
  const bad = await ComigoMenuSuggestService.interpret(orgA, "leve verde");
  check("JSON malformado → source=literal", bad.source === "literal");

  // ── 8. LLM lança (rede/rate-limit) → literal ─────────────────────────────
  chatCalls = 0;
  _internals.setChatFn(async () => { throw new Error("rate_limit"); });
  const thrown = await ComigoMenuSuggestService.interpret(orgA, "leve verde");
  check("LLM lança → source=literal (não propaga)", thrown.source === "literal");
  // não pode gravar cap-meter quando falhou
  const meterAfterThrow = (db.prepare(`SELECT COUNT(*) c FROM ai_usage_log WHERE organization_id=? AND kind='comigo_menu_suggest'`).get(orgA) as any).c;
  // Passos 4,5,6,7 gravaram 1 meter cada (chatFn retornou sem lançar mesmo quando
  // o parse falhou ou os ids eram inválidos). Passo 8 lançou → NÃO grava.
  check("chamada que lança não grava cap-meter", meterAfterThrow === 4);

  // ── 9. Cap por org/dia estourado → literal + capReached ──────────────────
  // orgA tem cap=10. Preenche o restante pra estourar o teto sem depender do
  // caminho de sucesso do LLM (que já foi testado acima).
  for (let i = meterAfterThrow; i < 10; i++) {
    db.prepare(`INSERT INTO ai_usage_log (id, organization_id, model, kind) VALUES (?, ?, 'meter', 'comigo_menu_suggest')`).run(randomUUID(), orgA);
  }
  chatCalls = 0;
  _internals.setChatFn(async () => { chatCalls++; return JSON.stringify({ items: [{ id: salada, reason: "x" }] }); });
  const capped = await ComigoMenuSuggestService.interpret(orgA, "leve verde");
  check("cap estourado → source=literal", capped.source === "literal");
  check("cap estourado → capReached=true", capped.capReached === true);
  check("cap estourado → LLM NÃO é chamado", chatCalls === 0);

  // ── 10. Isolamento: orgB (cap 50) chama normalmente ──────────────────────
  chatCalls = 0;
  _internals.setChatFn(async () => { chatCalls++; return JSON.stringify({ items: [] }); });
  const bOk = await ComigoMenuSuggestService.interpret(orgB, "algo qualquer");
  check("orgB não é afetada pelo cap da orgA", chatCalls === 1);
  check("orgB LLM devolveu [] → source=empty", bOk.source === "empty" && bOk.items.length === 0);
  // e o cap de B começa do zero
  const statusB = ComigoMenuSuggestService.status(orgB);
  check("orgB status cap=50", statusB.cap === 50);
  check("orgB status used=1", statusB.used === 1);
  check("orgB status remaining=49", statusB.remaining === 49);

  // ── 11. Isolamento de menu: orgB não vê itens da orgA ────────────────────
  _internals.setChatFn(async () => JSON.stringify({ items: [
    { id: salada, reason: "id da orgA" },   // id existe mas em outra org
  ]}));
  const crossTenant = await ComigoMenuSuggestService.interpret(orgB, "algo leve");
  check("orgB descarta id que existe só na orgA", crossTenant.items.every((i) => i.id !== salada));

  // ── 12. Item INATIVO não aparece no menu ─────────────────────────────────
  _internals.setChatFn(async () => JSON.stringify({ items: [
    { id: otherA, reason: "tenta pegar inativo" },
  ]}));
  const inactive = await ComigoMenuSuggestService.interpret(orgB, "leve");
  check("item inativo (active=0) descartado do snapshot", !inactive.items.some((i) => i.id === otherA));

  // Reseta pra não vazar entre testes se rodar em conjunto.
  _internals.setChatFn(null);
  _internals.setAIConfiguredFn(null);

  // ── Relatório ────────────────────────────────────────────────────────────
  console.log("\n=== TEST: Comigo — Menu Suggest LLM+RAG (Gap B, ADR-088 D5 nível 2) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Menu Suggest LLM+RAG OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
