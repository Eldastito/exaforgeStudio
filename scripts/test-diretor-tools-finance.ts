/**
 * TESTE — F4 do Diretor IA com ferramentas: finanças, comissão e catálogo
 * (docs/prd/PLANO-DIRETOR-IA-FERRAMENTAS.md).
 * -----------------------------------------------------------------------------
 * Prova, offline: as 4 ferramentas novas (todas money — §73) + a detecção
 * determinística delas no roteador.
 *  - caixa_resumo: caixa/a receber/a pagar do FinancialLedgerService;
 *  - a_receber: total + detalhe fiado×contas + vencido;
 *  - comissao_estimada: RetailCommissionService por período;
 *  - catalogo_produto: preço + estoque geral (controlado); sem match → honesto;
 *  - §73: as 4 somem do cardápio de papel restrito e run() barra com
 *    forbidden_money;
 *  - roteador detecta "a receber", "caixa", "comissão", "preço do X" sem LLM;
 *  - isolamento multi-tenant.
 *
 * Uso: npm run test:diretor-tools-finance
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dirfin-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-dirfin-1234567890";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ExecutiveQueryToolsService: T } = await import("../src/server/ExecutiveQueryToolsService.js");
  const { ExecutiveQueryRouterService: R } = await import("../src/server/ExecutiveQueryRouterService.js");

  const orgId = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Rede A', 'active')`).run(randomUUID(), orgId);
  // Caixa: uma conta com saldo.
  db.prepare(`INSERT INTO cash_accounts (id, organization_id, name, current_balance, active) VALUES (?, ?, 'Caixa', 1500, 1)`).run(randomUUID(), orgId);
  // A pagar / a receber (manual).
  db.prepare(`INSERT INTO payables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'Fornecedor X', 800, '2026-09-30', 'open')`).run(randomUUID(), orgId);
  db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status, source_type) VALUES (?, ?, 'Cliente Y', 500, '2026-09-25', 'open', 'manual')`).run(randomUUID(), orgId);

  // ── 1) caixa_resumo ──
  const c1 = T.run(orgId, "caixa_resumo", {}, { canSeeMoney: true });
  check("1.1 caixa_resumo traz caixa/a receber/a pagar", c1.ok && !!c1.summary?.includes("Caixa atual: R$ 1500.00") && !!c1.summary?.includes("A pagar (em aberto): R$ 800.00"), c1.summary || "");
  check("1.2 caixa_resumo enxerga o a receber (>= manual)", Number(c1.data?.aReceber) >= 500, JSON.stringify(c1.data));

  // ── 2) a_receber ──
  const c2 = T.run(orgId, "a_receber", {}, { canSeeMoney: true });
  check("2.1 a_receber detalha contas manuais", c2.ok && !!c2.summary?.includes("Contas: R$ 500.00"), c2.summary || "");

  // ── 3) comissao_estimada ──
  const c3 = T.run(orgId, "comissao_estimada", {}, { canSeeMoney: true });
  check("3.1 comissao_estimada roda pro mês e devolve valor", c3.ok && typeof c3.data?.total === "number" && !!c3.summary?.includes("Comissão estimada"), c3.summary || "");

  // ── 4) catalogo_produto ──
  const pid = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, currency, active, storefront_visible, stock_control_enabled) VALUES (?, ?, 'product', 'Camisa Polo Azul', 129.9, 'R$', 1, 1, 1)`).run(pid, orgId);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, quantity_reserved) VALUES (?, ?, ?, 10, 3)`).run(randomUUID(), orgId, pid);
  const c4 = T.run(orgId, "catalogo_produto", { product: "polo" }, { canSeeMoney: true });
  check("4.1 catalogo_produto traz preço + estoque geral (10-3=7)", c4.ok && !!c4.summary?.includes("R$ 129.90") && !!c4.summary?.includes("estoque geral 7"), c4.summary || "");
  check("4.2 produto sem match → honesto (não inventa)", !!T.run(orgId, "catalogo_produto", { product: "tenis xyz" }, { canSeeMoney: true }).summary?.includes("não invente"));
  check("4.3 sem produto → missing_arg", T.run(orgId, "catalogo_produto", {}, { canSeeMoney: true }).error === "missing_arg");

  // ── 5) §73 — cardápio e execução ──
  const restrito = T.list({ canSeeMoney: false }).map((t) => t.name);
  check("5.1 as 4 ferramentas de dinheiro somem do cardápio restrito", !["caixa_resumo", "a_receber", "comissao_estimada", "catalogo_produto"].some((n) => restrito.includes(n)), restrito.join(","));
  check("5.2 run barra caixa_resumo sem dinheiro", T.run(orgId, "caixa_resumo", {}, { canSeeMoney: false }).error === "forbidden_money");
  check("5.3 run barra catalogo_produto sem dinheiro", T.run(orgId, "catalogo_produto", { product: "polo" }, { canSeeMoney: false }).error === "forbidden_money");

  // ── 6) Roteador detecta as novas por palavra-chave (sem LLM) ──
  R.llmFn = async () => { throw new Error("nao deveria chamar LLM"); };
  check("6.1 detect a_receber", R.detect(orgId, "quanto tenho a receber?")?.tool === "a_receber");
  check("6.2 detect caixa_resumo (saldo/caixa)", R.detect(orgId, "qual o saldo em caixa?")?.tool === "caixa_resumo");
  check("6.3 detect comissao_estimada", R.detect(orgId, "qual a comissão da equipe esse mes?")?.tool === "comissao_estimada");
  const dcat = R.detect(orgId, "qual o preço da camisa polo azul?");
  check("6.4 detect catalogo_produto com termo do produto", dcat?.tool === "catalogo_produto" && String(dcat?.args?.product).includes("camisa polo"), JSON.stringify(dcat));
  const a1 = await R.answer(orgId, "quanto tenho a receber?", { canSeeMoney: true });
  check("6.5 answer a_receber devolve o número do sistema (LLM off → fatos crus)", !!a1?.includes("R$ 500.00"), a1 || "");
  const a2 = await R.answer(orgId, "quanto tenho a receber?", { canSeeMoney: false });
  check("6.6 §73: papel restrito perguntando a receber → null (panorama)", a2 === null, a2 || "null");

  // ── 7) Isolamento ──
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Rede B', 'active')`).run(randomUUID(), B);
  check("7.1 caixa de B não vê a receber de A", Number(T.run(B, "a_receber", {}, { canSeeMoney: true }).data?.aReceber || 0) === 0);
  check("7.2 catálogo de B não vê produto de A", !!T.run(B, "catalogo_produto", { product: "polo" }, { canSeeMoney: true }).summary?.includes("não invente"));

  console.log("\n=== TEST: F4 — ferramentas de finanças/comissão/catálogo ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
