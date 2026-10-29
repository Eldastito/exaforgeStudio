/**
 * TESTE — links de "acerto" (aviso → lugar e campo certos). Piloto: margem bruta da loja.
 * Uso: npm run test:action-links
 */
import fs from "fs";
import { pickStoreForFix, storeFieldId } from "../src/lib/actionLinks.ts";
let failures = 0;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) failures++; };

const stores = [
  { id: "a", name: "Av. brasil", active: 1, gross_margin_percent: 55 },
  { id: "b", name: "BANGU", active: 1, gross_margin_percent: null },
  { id: "c", name: "Carioca", active: 1, gross_margin_percent: 0 },
  { id: "d", name: "FR MADUREIRA", active: 0, gross_margin_percent: null },
  { id: "e", name: "Grande Rio", active: true, gross_margin_percent: "" },
];
check("sem loja pedida: a primeira ATIVA sem margem", pickStoreForFix(stores, null, "margin")?.id === "b");
check("margem 0 e vazia contam como sem margem", pickStoreForFix(stores.filter((s) => s.id !== "b"), null, "margin")?.id === "c");
check("loja inativa nunca é escolhida", pickStoreForFix(stores.filter((s) => ["d"].includes(s.id)), null, "margin") === null);
check("loja pedida existe: abre ela (mesmo já tendo margem)", pickStoreForFix(stores, "a", "margin")?.id === "a");
check("loja pedida inexistente ou inativa: null (não abre outra)", pickStoreForFix(stores, "zzz", "margin") === null && pickStoreForFix(stores, "d", "margin") === null);
check("todas com margem: null", pickStoreForFix([stores[0]], null, "margin") === null);
check("lista vazia: null", pickStoreForFix([], null, "margin") === null);
check("id do campo", storeFieldId("margin") === "store-field-margin");

const v = fs.readFileSync("src/features/RetailOpsView.tsx", "utf8");
const st = fs.readFileSync("src/store/useStore.ts", "utf8");
check("o input da margem tem o id que o link procura", /<input id=\{storeFieldId\('margin'\)\}/.test(v));
check("aviso: 'Editar loja' e cada loja sem margem são links", /<ActionLink tone="amber" onClick=\{\(\) => fixMargin\(null\)\}[^>]*>Editar loja<\/ActionLink>/.test(v) && /fixMargin\(s\.storeId\)/.test(v));
check("link troca para a aba Fechamento e guarda o destino", /setPendingStoreFix\(\{ storeId, field: 'margin' \}\); setPendingRetailTab\('fechamento'\)/.test(v));
check("destino: só dono/admin da rede abre; consome o pedido", /if \(!isNetwork\) \{ toast\.error\('Só o dono ou administrador da rede edita a loja\.'\)/.test(v) && /setPendingStoreFix\(null\);\s*\n\s*if \(!isNetwork\)/.test(v));
check("o modal recebe o campo e foca", /focusField=\{storeModal\.focusField\}/.test(v) && /scrollIntoView/.test(v));
check("store: pedido pendente declarado e iniciado nulo", /pendingStoreFix: \{ storeId: string \| null; field: StoreFixField \} \| null;/.test(st) && /pendingStoreFix: null,/.test(st));

// ── demais avisos da Operação da Rede ──
check("fonte dos vendedores: sem loja pedida NUNCA adivinha", pickStoreForFix(stores, null, "sellerSource") === null);
check("fonte dos vendedores: loja pedida ativa abre; inativa não", pickStoreForFix(stores, "a", "sellerSource")?.id === "a" && pickStoreForFix(stores, "d", "sellerSource") === null);
check("loja nova: não escolhe loja existente", pickStoreForFix(stores, null, "new") === null);
check("id do campo da fonte dos vendedores", storeFieldId("sellerSource") === "store-field-sellerSource");
check("select da fonte tem o id que o link procura", /<select id=\{storeFieldId\('sellerSource'\)\}/.test(v));
check("loja nova: o destino abre o formulário vazio (só rede)", /pendingStoreFix\.field === 'new'\) \{ setStoreModal\(\{ store: null \}\); return; \}/.test(v));
const links = (re: RegExp) => (v.match(re) || []).length;
check("Vendedores da loja vira link nos avisos (lotação, matrícula, apuração, não identificado)", links(/<TabLink tab="vendedores"/g) >= 4);
check("Escala & cotas vira link (aviso de sem vendedor e rótulo 'sem cota')", links(/<TabLink tab="escala"/g) >= 2);
check("Fechamento diário e Comissão viram links", /<TabLink tab="fechamento"/.test(v) && /<TabLink tab="comissao"/.test(v));
check("cadastrar lojas (retirada e escala) abre loja nova", links(/<StoreFixLink field="new"/g) >= 2);
check("loja com venda em duas fontes: o nome abre a loja no campo da fonte (só rede)", /st\.storeId && !manager \? <StoreFixLink field="sellerSource" storeId=\{st\.storeId\}/.test(v));
check("'falta' da margem vira link da loja certa", /<StoreFixLink field="margin" storeId=\{s\.storeId\}/.test(v));
check("os links usam só pontes que existem (aba e pedido de loja)", /setTab\(tab\)/.test(fs.readFileSync("src/components/ui/ActionLink.tsx", "utf8")) && /setFix\(\{ storeId, field \}\)/.test(fs.readFileSync("src/components/ui/ActionLink.tsx", "utf8")));
check("as abas apontadas existem em TABS", ["fechamento", "comissao", "escala", "vendedores"].every((k) => new RegExp(`key: '${k}'`).test(v)));
process.exit(failures ? 1 : 0);
