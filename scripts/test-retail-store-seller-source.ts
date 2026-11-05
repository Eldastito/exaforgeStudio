/**
 * TESTE — P5 (análise dos códigos sem nome): de onde vem a venda de cada vendedor é escolha EXPLÍCITA na loja nova.
 * ----------------------------------------------------------------------------
 * Antes a loja nova nascia em "PDV" sem ninguém escolher; se o gerente também lançava venda por vendedor no
 * fechamento, a mesma venda contava duas vezes (BANGU). Prova:
 *   - rota de criação recusa loja sem a escolha (400 seller_source_required) e não cria nada;
 *   - com 'pdv' ou 'manual' cria; 'pdv' grava igual ao padrão antigo (NULL = caixa), 'manual' grava 'manual';
 *   - valor inválido ('qualquer') também é recusado — não vira PDV calado;
 *   - EDITAR loja continua sem exigir (PATCH sem o campo não mexe na fonte);
 *   - o service segue aceitando sem a escolha (seeds/outros chamadores; nada existente quebra);
 *   - a escolha muda só a conta POR VENDEDOR: loja 'manual' tira o PDV da soma; o total da loja não depende disso;
 *   - regras puras da tela (erro só ao criar; resumo do que a rede usa; singular/plural; inativa e a própria fora);
 *   - fiação: formulário sem opção pré-marcada ao criar, envia a escolha; "⚠ dobrado" das metas tem ação.
 *
 * Uso:  npm run test:retail-store-seller-source
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-store-source-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-store-source-1234567890abc";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");
  const rules = await import("../src/features/retailops/storeSourceRules.js");
  const express = (await import("express")).default;
  const { default: retailRoutes } = await import("../src/server/routes/retailops.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`, O = `org_O_${randomUUID().slice(0, 6)}`;
  for (const o of [A, O]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const countStores = (org: string) => (db.prepare(`SELECT COUNT(*) AS n FROM retail_stores WHERE organization_id = ?`).get(org) as any).n as number;
  const srcOf = (id: string) => (db.prepare(`SELECT seller_source FROM retail_stores WHERE id = ?`).get(id) as any)?.seller_source ?? null;

  // ── 1. Escolha válida (servidor) ──
  check("1.1 'pdv' e 'manual' são escolhas", RetailStoreService.sellerSourceChoice("pdv") === "pdv" && RetailStoreService.sellerSourceChoice("manual") === "manual");
  check("1.2 vazio/nulo/inválido não é escolha", [undefined, null, "", "PDV", "qualquer", 1].every((v) => RetailStoreService.sellerSourceChoice(v) === null));

  // ── 2. Rotas ──
  const app = express();
  app.use(express.json());
  const fake = (req: any, _res: any, next: any) => { req.organizationId = req.headers["x-test-org"] || null; req.user = { userId: req.headers["x-test-user"] || "u1", role: req.headers["x-test-role"] || "owner", organizationId: req.organizationId }; next(); };
  app.use("/api/retailops", fake, retailRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, p: string, org: string, body?: any) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-test-org": org, "x-test-role": "owner", "x-test-user": "own" }, body: body ? JSON.stringify(body) : undefined });
    let j: any = null; try { j = await r.json(); } catch { /* sem corpo */ }
    return { status: r.status, body: j };
  };
  let pdvStore = "", manualStore = "";
  try {
    const before = countStores(A);
    const none = await call("POST", "/api/retailops/stores", A, { name: "BANGU", code: "1083" });
    check("2.1 loja nova sem a escolha: 400 seller_source_required", none.status === 400 && none.body?.code === "seller_source_required" && /caixa/.test(none.body?.error || ""));
    check("2.2 ... e nada é criado", countStores(A) === before);
    const bad = await call("POST", "/api/retailops/stores", A, { name: "BANGU", code: "1083", sellerSource: "qualquer" });
    check("2.3 valor inválido também é recusado (não vira caixa calado)", bad.status === 400 && countStores(A) === before);

    const p = await call("POST", "/api/retailops/stores", A, { name: "BANGU", code: "1083", sellerSource: "pdv" });
    pdvStore = p.body?.id;
    check("2.4 escolha 'caixa' cria a loja", p.status === 201 && !!pdvStore);
    check("2.5 'caixa' grava igual ao padrão antigo (NULL = caixa)", srcOf(pdvStore) === null);
    const m = await call("POST", "/api/retailops/stores", A, { name: "Carioca", code: "1065", sellerSource: "manual" });
    manualStore = m.body?.id;
    check("2.6 escolha 'lançamento do gerente' grava 'manual'", m.status === 201 && srcOf(manualStore) === "manual");

    const edit = await call("PATCH", `/api/retailops/stores/${manualStore}`, A, { name: "Carioca Centro" });
    check("2.7 editar loja não exige a escolha e não mexe na fonte", edit.status === 200 && srcOf(manualStore) === "manual" && edit.body?.name === "Carioca Centro");
    const flip = await call("PATCH", `/api/retailops/stores/${pdvStore}`, A, { sellerSource: "manual" });
    check("2.8 dá para mudar depois (caixa → gerente)", flip.status === 200 && srcOf(pdvStore) === "manual");
    await call("PATCH", `/api/retailops/stores/${pdvStore}`, A, { sellerSource: "pdv" });
    check("2.9 ... e voltar (gerente → caixa)", srcOf(pdvStore) === null);
  } finally { server.close(); }

  // ── 3. Service segue aceitando sem a escolha (nada existente quebra) ──
  const legacy = RetailStoreService.create(A, { name: "Seed antiga", code: "1999" } as any, "t");
  check("3.1 service cria sem a escolha (padrão caixa)", !!legacy?.id && srcOf(legacy.id) === null);
  check("3.2 isolamento: nada foi criado na outra org", countStores(O) === 0);

  // ── 4. A escolha muda só a conta POR VENDEDOR ──
  if (!pdvStore) { check("4.0 a loja de caixa da seção 2 existe (pré-condição)", false); pdvStore = RetailStoreService.create(A, { name: "BANGU-fallback", code: "1084" } as any, "t").id; }
  const pdvSale = (filial: string, code: string, valor: number) => db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor) VALUES (?, ?, ?, ?, '2026-11-03', ?, ?)`).run(randomUUID(), A, filial, randomUUID().slice(0, 6), code, valor);
  const manualSale = (storeId: string, mat: string, valor: number) => db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor, source) VALUES (?, ?, ?, '2026-11-03', 'Nathiele', ?, ?, 'closing')`).run(randomUUID(), A, storeId, mat, valor);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, '10830006', 'Nathiele', 1)`).run(randomUUID(), A);
  pdvSale("1083", "10830006", 500); manualSale(pdvStore, "10830006", 500);
  const rowsPdv = RetailCommissionService.salesBySellerStore(A, "2026-11-01", "2026-11-30").filter((r) => r.storeId === pdvStore);
  check("4.1 loja no CAIXA + lançamento do gerente: a mesma venda conta 2× e é sinalizada", rowsPdv.length === 1 && rowsPdv[0].sales === 1000 && rowsPdv[0].doubleSourced === true);
  RetailStoreService.update(A, pdvStore, { sellerSource: "manual" }, "t");
  const rowsMan = RetailCommissionService.salesBySellerStore(A, "2026-11-01", "2026-11-30").filter((r) => r.storeId === pdvStore);
  check("4.2 mesma loja no LANÇAMENTO DO GERENTE: conta 1× e sem aviso", rowsMan.length === 1 && rowsMan[0].sales === 500 && rowsMan[0].doubleSourced === false);
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, informed_total, system_total, status) VALUES (?, ?, ?, '2026-11-03', 500, 500, 'approved')`).run(randomUUID(), A, pdvStore);
  const tot = (db.prepare(`SELECT informed_total FROM retail_daily_closings WHERE store_id = ?`).get(pdvStore) as any).informed_total;
  check("4.3 o total da loja (fechamento) não depende da fonte", tot === 500);

  // ── 5. Regras puras da tela ──
  check("5.1 ao CRIAR sem escolha: erro explicando as duas opções", /caixa/.test(rules.sourceChoiceError("", false) || "") && /gerente/.test(rules.sourceChoiceError("", false) || ""));
  check("5.2 ao criar com escolha: sem erro", rules.sourceChoiceError("pdv", false) === null && rules.sourceChoiceError("manual", false) === null);
  check("5.3 ao EDITAR nunca exige", rules.sourceChoiceError("", true) === null);
  const net = [
    { id: "a", active: 1, seller_source: "manual" }, { id: "b", active: true, seller_source: "manual" },
    { id: "c", active: 1, seller_source: null }, { id: "d", active: 0, seller_source: "manual" }, { id: "e", active: 1, seller_source: "pdv" },
  ];
  const sum = rules.networkSourceSummary(net);
  check("5.4 resumo da rede: inativa fora; NULL conta como caixa", sum.manual === 2 && sum.pdv === 2 && sum.total === 4);
  check("5.5 resumo exclui a própria loja", rules.networkSourceSummary(net, "a").manual === 1);
  check("5.6 texto do resumo (plural)", rules.networkSourceHint(sum) === "Na sua rede hoje: 2 lojas usam o lançamento do gerente · 2 lojas usam o caixa.");
  check("5.7 texto do resumo (singular, só uma fonte)", rules.networkSourceHint({ pdv: 0, manual: 1, total: 1 }) === "Na sua rede hoje: 1 loja usa o lançamento do gerente.");
  check("5.8 rede vazia: sem texto", rules.networkSourceHint({ pdv: 0, manual: 0, total: 0 }) === null);

  // ── 6. Fiação ──
  const ops = fs.readFileSync(path.join(process.cwd(), "src/features/RetailOpsView.tsx"), "utf8");
  const route = fs.readFileSync(path.join(process.cwd(), "src/server/routes/retailops.ts"), "utf8");
  const postIdx = route.indexOf(`router.post("/stores", requireNetworkScope`);
  const postBlock = route.slice(postIdx, route.indexOf(`router.patch("/stores/:id"`, postIdx));
  check("6.1 rota valida a escolha ANTES de criar", postBlock.indexOf("sellerSourceChoice(req.body?.sellerSource)") > -1 && postBlock.indexOf("sellerSourceChoice") < postBlock.indexOf("RetailStoreService.create"));
  check("6.2 formulário: loja nova começa sem fonte e tem 'Escolha…' desabilitado", ops.includes("useState<string>(editing ? (store?.seller_source === 'manual' ? 'manual' : 'pdv') : '')") && ops.includes(`{!editing && <option value="" disabled>Escolha…</option>}`));
  check("6.3 formulário bloqueia salvar sem escolha e envia a escolha", ops.includes("sourceChoiceError(sellerSource, editing)") && ops.includes("sellerSource: isSourceChoice(sellerSource) ? sellerSource : null"));
  check("6.4 formulário mostra o que a rede usa", ops.includes("networkSourceHint(networkSourceSummary("));
  check("6.5 '⚠ dobrado' das metas: dono abre a loja no campo; gerente vê o pedido", ops.includes(`StoreFixLink field="sellerSource" storeId={storeId} tone="red"`) && ops.includes("DOUBLED_ASK_OWNER"));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-store-seller-source: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
