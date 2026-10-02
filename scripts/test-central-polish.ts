/**
 * TESTE — S7: acabamento da Central de Saúde (achados dos prints da produção TOULON, 02/10/2026).
 * Prova: (1) os 4 padrões recorrentes da loja (antes "Ponto de atenção em Varejo · Ver detalhes e decidir") têm texto de gestor, com a
 * loja no título e sem id técnico; (2) o gatilho já dito na síntese não se repete embaixo; (3) "items" → "itens"/"item";
 * (4) assuntos além dos 5 mostrados viram "+ N outros" (o resumo dizia 13 e a tela mostrava 6); (5) o zero de "Entradas registradas hoje"
 * numa org sem saída lançada explica o que mede — mas segue sendo número (zero é fato) e org com caixa real não ganha a nota.
 * Uso:  npm run test:central-polish
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-central-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-central-polish-1234567890abcd";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { presentSignal } = await import("../src/server/SignalLanguage.js");
  const { visibleTriggers, hiddenAttention } = await import("../src/lib/healthTriggers.js");
  const { BusinessTutorService: T } = await import("../src/server/BusinessTutorService.js");
  const { BusinessHealthService: H } = await import("../src/server/BusinessHealthService.js");
  const { FinancialLedgerService: L } = await import("../src/server/FinancialLedgerService.js");

  // ── (1) padrões recorrentes ──
  const TYPES: Array<[string, RegExp]> = [
    ["caixa_divergente_recorrente", /O caixa diverge do sistema com frequência — Grande Rio/],
    ["estoque_negativo_recorrente", /O saldo de estoque fica negativo com frequência — Grande Rio/],
    ["meta_nao_batida_recorrente", /A loja não bate a meta com frequência — Grande Rio/],
    ["fechamento_atrasado_recorrente", /O fechamento da loja chega atrasado com frequência — Grande Rio/],
  ];
  for (const [type, re] of TYPES) {
    const p = presentSignal({ signalType: type, domain: "retail_ops", evidence: { store: "Grande Rio" } });
    check(`${type}: texto de gestor com a loja no título (não 'Ponto de atenção em Varejo')`, p.known && re.test(p.title) && !/Ponto de atenção/.test(p.title), p.title);
    check(`${type}: ação específica (não 'Ver detalhes e decidir') e sem id técnico`, p.actionLabel !== "Ver detalhes e decidir" && !/recorrente|_/.test(p.title + p.meaning + p.actionLabel + p.actionWillDo), JSON.stringify(p));
  }
  check("sem loja na evidência: título segue legível (sem 'undefined')", !/undefined|null/.test(presentSignal({ signalType: "meta_nao_batida_recorrente", domain: "retail_ops", evidence: {} }).title));

  // ── (2)(4) helpers da tela ──
  const trig = [{ label: "R$ 13.428,60 parados em estoque sem giro (7 itens)." }, { label: "Outro gatilho." }];
  const vis = visibleTriggers(trig, "R$ 13.428,60 parados em estoque sem giro (7 itens). Hoje já tem 3 assuntos.");
  check("gatilho já dito na síntese não se repete; o que não foi dito continua", vis.length === 1 && vis[0].label === "Outro gatilho.");
  check("síntese vazia/null: todos os gatilhos aparecem (0-regressão)", visibleTriggers(trig, null).length === 2 && visibleTriggers(undefined, "x").length === 0);
  check("assuntos além dos mostrados: 13 com 5 na tela → '+ 8'; todos visíveis → 0; sem dado → 0", hiddenAttention(13, 5) === 8 && hiddenAttention(5, 5) === 0 && hiddenAttention(undefined, 0) === 0 && hiddenAttention(3, 5) === 0);

  // ── (3) "itens" ──
  const mkOrg = (tag: string) => { const id = `org_${tag}_${randomUUID().slice(0, 6)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/BusinessHealthService.ts"), "utf8");
  check("rótulo de estoque parado em português (itens/item), sem 'items'", /"itens" : "item"/.test(src) && !/"s" : ""\}\)\$\{?[^]{0,10}items/.test(src) && !/ items\)/.test(src));
  void H;

  // ── (5) entradas registradas hoje ──
  const night = (o: string) => T.eveningBrief(o).text;
  const E = mkOrg("E");   // só entrada, de outro dia: base "entradas" (sem saída lançada), nada hoje
  L.recordEvent(E, { direction: "in", amount: 70, eventDate: "2026-01-10", sourceType: "manual", sourceId: randomUUID() } as any);
  const nE = night(E);
  check("sem saída lançada e nada hoje: continua 'R$ 0,00' (zero é fato) E explica que não é a venda da loja", /Entradas registradas hoje: R\$ 0,00 \(só o que foi lançado no financeiro hoje — não é a venda da loja\)/.test(nE), nE);
  const F = mkOrg("F");   // tem entrada e saída: caixa real
  L.recordEvent(F, { direction: "in", amount: 500, eventDate: "2026-01-10", sourceType: "manual", sourceId: randomUUID() } as any);
  L.recordEvent(F, { direction: "out", amount: 100, eventDate: "2026-01-11", sourceType: "manual", sourceId: randomUUID() } as any);
  const nF = night(F);
  check("org com caixa real (entradas e saídas lançadas): não ganha a nota (0-regressão)", /Entrou no caixa: R\$ 0,00/.test(nF) && !/não é a venda da loja/.test(nF), nF);
  const G = mkOrg("G");
  L.recordEvent(G, { direction: "in", amount: 250, sourceType: "manual", sourceId: randomUUID() } as any);
  check("entrou dinheiro hoje: mostra o valor, sem a nota", /Entradas registradas hoje: R\$ 250,00(?! \()/.test(night(G)) , night(G));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} FALHA(S)`); process.exit(1); }
  console.log("\nTODOS OS CHECKS PASSARAM");
}
main().catch((e) => { console.error(e); process.exit(1); });
