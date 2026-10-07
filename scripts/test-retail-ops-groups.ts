/**
 * TESTE — Fase 2 / F2.7 (ADR-203): "Operação da Rede" — as 20 abas reagrupadas em 5 grupos por propósito (src/lib/retailOpsGroups.ts +
 * RetailOpsView). Prova: (1) PARIDADE — toda aba do RetailOpsView está em EXATAMENTE 1 grupo e todo item de grupo é uma aba real
 * (nada some, nada duplica, nada inventado); (2) 20 abas → 5 grupos, nenhum grupo vazio nem com mais de 5 abas (a razão de existir:
 * menos de 6 escolhas por vez); (3) a aba padrão ('insights') cai num grupo (o grupo ativo sempre existe); (4) `groupOfTab` acha o
 * grupo certo e devolve null para aba desconhecida; (5) flag DESLIGADA = a lista plana de sempre (TABS.map) — 0-regressão; flag
 * LIGADA = grupos → abas do grupo; (6) conteúdo das abas intacto (cada `tab === 'x'` continua renderizando o mesmo componente);
 * (7) a tela segue no catálogo do menu (Explorar). Puro, sem DB/rede/LLM.
 * Uso:  npm run test:retail-ops-groups
 */
import fs from "fs";
import { RETAIL_TAB_GROUPS, groupOfTab } from "../src/lib/retailOpsGroups.js";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

const src = fs.readFileSync("src/features/RetailOpsView.tsx", "utf8");
const tabsBlock = src.slice(src.indexOf("const TABS: { key: RetailTab"), src.indexOf("const PATTERN_STATUS"));
const realTabs = [...tabsBlock.matchAll(/\{ key: '([a-z]+)', label: '([^']+)'/g)].map((m) => m[1]);
const all = RETAIL_TAB_GROUPS.flatMap((g) => g.tabs);

check("a tela tem 20 abas reais (a base do reagrupamento)", realTabs.length === 20, String(realTabs.length));
const missing = realTabs.filter((t) => !all.includes(t)), invented = all.filter((t) => !realTabs.includes(t));
check("toda aba real está em algum grupo (nada some)", missing.length === 0, missing.join(","));
check("nenhum grupo cita aba que não existe (nada inventado)", invented.length === 0, invented.join(","));
const dup = all.filter((t, i) => all.indexOf(t) !== i);
check("nenhuma aba em 2 grupos (nada duplica)", dup.length === 0, dup.join(","));
check("20 abas distribuídas: total dos grupos = 20", all.length === 20);
check("5 grupos, nenhum vazio e nenhum com mais de 5 abas (menos de 6 escolhas por vez)", RETAIL_TAB_GROUPS.length === 5 && RETAIL_TAB_GROUPS.every((g) => g.tabs.length >= 1 && g.tabs.length <= 5), RETAIL_TAB_GROUPS.map((g) => g.tabs.length).join(","));
check("todo grupo tem rótulo e dica em linguagem de dono", RETAIL_TAB_GROUPS.every((g) => g.label.length > 3 && g.hint.length > 10 && new Set(RETAIL_TAB_GROUPS.map((x) => x.key)).size === 5));

check("a aba padrão ('insights') pertence a um grupo (o grupo ativo sempre existe)", groupOfTab("insights")?.key === "inteligencia");
check("groupOfTab acha o grupo certo (fechamento → 'Fechar o dia'; estoque → 'Estoque e reposição') e null p/ desconhecida", groupOfTab("fechamento")?.label === "Fechar o dia" && groupOfTab("estoque")?.label === "Estoque e reposição" && groupOfTab("nao-existe") === null);

// ── fiação: flag off = plana; flag on = grupos ──
const comp = src.slice(src.indexOf("export function RetailOpsView()"), src.indexOf("{tab === 'insights' && <InsightsTab />}"));
check("flag desligada: a lista plana de sempre (TABS.map)", /\) : \(\s*<div className="mb-5 flex flex-wrap gap-2">\s*\{TABS\.map\(tabBtn\)\}/.test(comp));
check("flag ligada (simplifiedNavEnabled): grupos → abas do grupo", /simplifiedNavEnabled/.test(comp) && /RETAIL_TAB_GROUPS\.map/.test(comp) && /activeGroup\.tabs/.test(comp));
check("o botão da aba mantém o visual de sempre (indigo ativo / borda zinc)", /bg-indigo-600 text-white' : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'/.test(comp));

// ── conteúdo intacto ──
const body = src.slice(src.indexOf("{tab === 'insights' && <InsightsTab />}"), src.indexOf("{tab === 'precificar' && <PricingTab />}") + 60);
const rendered = [...body.matchAll(/tab === '([a-z]+)' &&/g)].map((m) => m[1]);
check("cada aba continua renderizando o seu componente (20 de 20)", realTabs.every((t) => rendered.includes(t)), realTabs.filter((t) => !rendered.includes(t)).join(","));

const nav = fs.readFileSync("src/lib/navCatalog.ts", "utf8");
check("a tela 'Operação da Rede' segue no menu (Explorar)", /viewMode: 'retailops', label: 'Operação da Rede'/.test(nav));

console.log(failures === 0 ? "\nTODOS OS CHECKS PASSARAM" : `\n${failures} FALHA(S)`);
process.exit(failures ? 1 : 0);
