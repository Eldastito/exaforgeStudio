/**
 * TESTE — barra "Pergunte ou procure qualquer coisa" (ADR-203 §35)
 * ----------------------------------------------------------------------------
 * Parte PURA (`lib/commandBar`) + fiação no código-fonte (o repo não tem teste de componente):
 *   - pergunta de verdade (?, 3+ palavras, verbo de pedido) → PERGUNTAR primeiro; nome de tela → ABRIR primeiro;
 *   - palavra solta sem tela nem contato → ainda oferece PERGUNTAR (melhor que "nada encontrado");
 *   - sem FalaTu disponível a opção Perguntar nunca aparece; texto curto (<2) não abre nada;
 *   - "comissão" → atalho pra aba Operação da Rede → Comissão (acento/plural), mínimo 3 letras, só abas que existem;
 *   - fiação: flag OFF = busca de contatos de sempre; Perguntar envia pelo FalaTu (pendingAsk), Abrir usa o MESMO catálogo/gate do menu,
 *     a aba é aberta por deep-link (pendingRetailTab) só se existir; telemetria registra QUE usou, nunca o texto.
 * Uso:  npm run test:command-bar
 */
import fs from "fs";
import path from "path";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`); if (!ok) failures++; };

async function main() {
  const { isQuestion, actionOrder, retailTabMatches } = await import("../src/lib/commandBar.js");

  // ── o que é pergunta ──
  const frases = ["Como estão minhas lojas?", "Quanto a Carioca precisa vender hoje?", "Quem está no segundo mês sem bater meta?", "Posso comprar R$180 mil de coleção?",
    "Crie uma campanha para quem não compra há 90 dias.", "Mostra os produtos parados", "tem problema no estoque", "como fechou ontem"];
  check("as frases do PRD são reconhecidas como PERGUNTA", frases.every(isQuestion), frases.filter((f) => !isQuestion(f)).join(" | "));
  check("nome de tela solto NÃO é pergunta ('comissão', 'estoque', 'hoje', 'Atendimento Digital' é 2 palavras)", !isQuestion("comissão") && !isQuestion("estoque") && !isQuestion("hoje") && !isQuestion("atendimento digital"));
  check("vazio/espaços não é pergunta", !isQuestion("") && !isQuestion("   "));

  // ── ordem dos caminhos ──
  check("pergunta com tela e contato: Perguntar → Abrir → Contatos", JSON.stringify(actionOrder("quanto vendi hoje?", { open: 1, contact: 2 }, true)) === '["ask","open","contact"]');
  check("nome de tela: Abrir vem ANTES (Enter abre a tela); Perguntar fica como alternativa no fim", JSON.stringify(actionOrder("comissão", { open: 1, contact: 0 }, true)) === '["open","ask"]');
  check("palavra solta sem tela nem contato: ainda oferece PERGUNTAR (nunca 'nada encontrado')", JSON.stringify(actionOrder("fornecedor", { open: 0, contact: 0 }, true)) === '["ask"]');
  check("sem FalaTu disponível: 'ask' nunca aparece (nem pra pergunta)", !actionOrder("como estão as lojas?", { open: 1, contact: 1 }, false).includes("ask") && JSON.stringify(actionOrder("como estão as lojas?", { open: 0, contact: 0 }, false)) === "[]");
  check("menos de 2 caracteres não abre nada", actionOrder("a", { open: 3, contact: 3 }, true).length === 0 && actionOrder("", { open: 3, contact: 3 }, true).length === 0);
  check("contato sem tela: Contatos antes do Perguntar (nome de pessoa não vira pergunta)", JSON.stringify(actionOrder("maria", { open: 0, contact: 1 }, true)) === '["contact","ask"]');

  // ── atalhos de aba ──
  const tabs = (q: string) => retailTabMatches(q).map((x) => x.tab);
  check("'comissão' / 'comissao' / 'comissões' → aba Comissão (acento e plural)", tabs("comissão").includes("comissao") && tabs("comissao").includes("comissao") && tabs("comissões").includes("comissao"));
  check("o atalho diz ONDE leva ('Operação da Rede → Comissão')", retailTabMatches("comissão")[0]?.label === "Operação da Rede → Comissão");
  check("'meta' → Metas do vendedor; 'escala' → Escala & cotas; 'estoque' → Estoque negativo", tabs("meta").includes("metas") && tabs("escala").includes("escala") && tabs("estoque").includes("estoque"));
  check("menos de 3 letras não dispara atalho; palavra sem aba não inventa ('xyz')", tabs("co").length === 0 && tabs("xyz").length === 0);
  const src = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
  const retail = src("src/features/RetailOpsView.tsx");
  const tabKeys = Array.from(retail.matchAll(/\{ key: '([a-z]+)', label: '[^']+', icon: \w+ \}/g)).map((m) => m[1]);
  const allAliasTabs = Array.from(src("src/lib/commandBar.ts").matchAll(/tab: '([a-z]+)'/g)).map((m) => m[1]);
  check("todo atalho aponta pra uma ABA QUE EXISTE em RetailOpsView", allAliasTabs.length >= 8 && allAliasTabs.every((t) => tabKeys.includes(t)), allAliasTabs.filter((t) => !tabKeys.includes(t)).join(","));

  // ── fiação ──
  const g = src("src/features/GlobalSearch.tsx"), f = src("src/features/FalaTuView.tsx"), st = src("src/store/useStore.ts");
  check("flag OFF = a busca de contatos de sempre (placeholder e lista)", /simplifiedNavEnabled \? 'Pergunte ou procure qualquer coisa…' : 'Buscar leads ou tags\.\.\.'/.test(g) && /if \(!simplifiedNavEnabled\) return contactRows;/.test(g));
  check("Abrir usa o MESMO catálogo/gate do menu (primaryNav + exploreGroups com o ctx do usuário)", /primaryNav\(navCtx\)/.test(g) && /exploreGroups\(navCtx, q\)/.test(g));
  check("Perguntar só aparece com FalaTu disponível pra este usuário (módulo ligado + RBAC)", /canAsk = simplifiedNavEnabled && \(isMasterAdmin \|\| \(falatuEnabled && canAccessModule\('falatu'\)\)\)/.test(g));
  check("o atalho de aba só é oferecido quando a Operação da Rede está disponível (6º item)", /primaryNav\(navCtx\)\.some\(p => p\.viewMode === 'retailops'\)\) for \(const m of retailTabMatches/.test(g));
  check("Perguntar: planta a pergunta e abre o FalaTu; Abrir: deep-link da aba antes de trocar a tela", /setPendingAsk\(r\.label \|\| q\.trim\(\)\); setViewMode\('falatu'\)/.test(g) && /if \(r\.tab\) setPendingRetailTab\(r\.tab\); setViewMode\(r\.viewMode as any\)/.test(g));
  check("FalaTu consome a pergunta UMA vez, abre 'Conversar' e espera se já há resposta em curso", /if \(!pendingAsk \|\| askBusy\) return;[\s\S]*setTab\('ask'\);[\s\S]*setPendingAsk\(null\);[\s\S]*void sendAsk\(pendingAsk\)/.test(f));
  check("RetailOpsView consome o deep-link só se a aba EXISTE e limpa", /TABS\.some\(t => t\.key === pendingRetailTab\)\) setTab\(pendingRetailTab as RetailTab\);\s*setPendingRetailTab\(null\)/.test(retail));
  check("store: pendingAsk e pendingRetailTab nascem null (0-regressão)", /pendingAsk: null,/.test(st) && /pendingRetailTab: null,/.test(st));
  check("telemetria: registra QUE usou (barra_perguntar/barra_abrir), nunca o texto digitado", /trackAction\('barra_perguntar', 'falatu'\)/.test(g) && /trackAction\('barra_abrir', r\.viewMode \|\| ''\)/.test(g) && !/trackAction\([^)]*\bq\b/.test(g));

  console.log(`\n${failures === 0 ? "✅" : "❌"} command-bar: ${failures === 0 ? "todos os checks" : failures + " falha(s)"}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
