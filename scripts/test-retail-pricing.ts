/**
 * TESTE — Tela "Precificar" no varejo (Fatia 3 de "fechar precificação" —
 * ADR-083 E7).
 * ---------------------------------------------------------------------------
 * Fecha o ciclo: nota de compra populou `inventory_items.avg_cost` → a tela
 * mostra custo × preço atual × preço sugerido pelo motor (`suggestSalePrice`)
 * + venda do mês, com semáforo de risco (loss/thin/ok); e aplica em lote via
 * `RetailPricingService.applyBulk`. Prova:
 *
 *   - listProducts junta preço/custo/vendas e ordena por receita DESC;
 *   - semáforo: negativo = loss; margem < 10% = thin; >= 10% = ok;
 *   - markup do parâmetro sobrescreve default_markup_percent da org;
 *   - produto sem custo cadastrado (avg_cost = 0): suggestedPrice = 0,
 *     marginPercent = null, hasCost = false (não vai forçar preço);
 *   - applyBulk atualiza preço, registra ProductEditHistory, rejeita linhas
 *     inválidas (preço <= 0, produto de outra org, "unchanged") sem abortar
 *     o batch inteiro;
 *   - isolamento multi-tenant (org B não vê nem altera produto da org A).
 *
 * Determinístico e offline (zero-token).
 *
 * Uso:  npm run test:retail-pricing
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-pricing-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-retail-pricing-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) < eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailPricingService } = await import("../src/server/RetailPricingService.js");
  const { suggestSalePrice } = await import("../src/server/pricing.js");

  const period = new Date().toISOString().slice(0, 7);
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`
  ).run(randomUUID(), A);
  db.prepare(
    `INSERT INTO storefront_settings (organization_id, default_markup_percent) VALUES (?, ?)`
  ).run(A, 50);

  // Catálogo: 4 produtos.
  const p1 = randomUUID(); // Bermuda: custo 40, preço 100 → margem 60% (ok)
  const p2 = randomUUID(); // Camiseta: custo 20, preço 22 → margem 9,09% (thin)
  const p3 = randomUUID(); // Chaveiro: custo 15, preço 12 → LOSS
  const p4 = randomUUID(); // Sem Custo: avg_cost = 0, preço 30
  const mkProd = (id: string, name: string, price: number, ext: string) =>
    db.prepare(
      `INSERT INTO products_services (id, organization_id, name, price, type, active, external_ref) VALUES (?, ?, ?, ?, 'product', 1, ?)`
    ).run(id, A, name, price, ext);
  mkProd(p1, "Bermuda", 100, "BERM01");
  mkProd(p2, "Camiseta", 22, "CAMI01");
  mkProd(p3, "Chaveiro", 12, "CHAV01");
  mkProd(p4, "Sem Custo", 30, "SEM01");

  const mkInv = (id: string, qty: number, cost: number) =>
    db.prepare(
      `INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, ?, ?)`
    ).run(randomUUID(), A, id, qty, cost);
  mkInv(p1, 20, 40);
  mkInv(p2, 30, 20);
  mkInv(p3, 5, 15);
  mkInv(p4, 10, 0);

  // Venda do mês (só bermuda e camiseta pra validar ordenação por revenue).
  db.prepare(
    `INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Loja', '10', 1)`
  ).run(randomUUID(), A);
  const insItem = (produto: string, qty: number, valor: number) =>
    db.prepare(
      `INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor)
         VALUES (?, ?, '10', ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), A, `B${Math.random().toString(36).slice(2, 7)}`, `${period}-05`, 1, produto, qty, valor);
  insItem("BERM01", 3, 300); // Bermuda: 3 uni, R$ 300 no mês
  insItem("CAMI01", 2, 44);  // Camiseta: 2 uni, R$ 44 no mês

  // ── listProducts sem markup → usa default (50) ─────────────────────────
  const list1 = RetailPricingService.listProducts(A, { period });
  check("defaultMarkup vem do storefront_settings (50)", list1.defaultMarkup === 50, String(list1.defaultMarkup));
  check("targetMarkup = defaultMarkup quando não passado (50)", list1.targetMarkup === 50);
  check("retorna todos os produtos ativos (4)", list1.items.length === 4, String(list1.items.length));

  const berm = list1.items.find((i) => i.productId === p1)!;
  const cam = list1.items.find((i) => i.productId === p2)!;
  const chav = list1.items.find((i) => i.productId === p3)!;
  const sem = list1.items.find((i) => i.productId === p4)!;

  check("Bermuda: custo=40, preço=100, marginPercent=60", near(berm.marginPercent!, 60), String(berm.marginPercent));
  check("Bermuda: marginAmount = 60 (100−40)", near(berm.marginAmount!, 60));
  check("Bermuda: suggestedPrice = suggestSalePrice(40, 50)",
    near(berm.suggestedPrice, suggestSalePrice(40, 50)), String(berm.suggestedPrice));
  check("Bermuda: riskLevel = ok", berm.riskLevel === "ok");
  check("Bermuda: unitsSoldMonth = 3", berm.unitsSoldMonth === 3);
  check("Bermuda: revenueMonth = 300", near(berm.revenueMonth, 300));

  // Camiseta: (22-20)/22 = 9,0909%
  check("Camiseta: marginPercent ≈ 9,09", near(cam.marginPercent!, 9.09, 0.02), String(cam.marginPercent));
  check("Camiseta: riskLevel = thin", cam.riskLevel === "thin");

  check("Chaveiro: preço 12 < custo 15 → riskLevel = loss", chav.riskLevel === "loss");
  check("Chaveiro: marginAmount = -3", near(chav.marginAmount!, -3));

  check("Sem Custo: hasCost = false", sem.hasCost === false);
  check("Sem Custo: suggestedPrice = 0", sem.suggestedPrice === 0);
  check("Sem Custo: marginPercent = null (sem base pra calcular)", sem.marginPercent === null);

  // Ordenação por revenue DESC: Bermuda (300) > Camiseta (44) > outros (0)
  check("Ordenação: Bermuda antes de Camiseta",
    list1.items.findIndex((i) => i.productId === p1) < list1.items.findIndex((i) => i.productId === p2));
  check("Ordenação: Camiseta antes dos sem venda",
    list1.items.findIndex((i) => i.productId === p2) < list1.items.findIndex((i) => i.productId === p3));

  // ── Markup do parâmetro sobrescreve o default ──────────────────────────
  const list2 = RetailPricingService.listProducts(A, { markup: 100, period });
  check("targetMarkup do parâmetro (100)", list2.targetMarkup === 100);
  const bermCem = list2.items.find((i) => i.productId === p1)!;
  check("Bermuda com markup 100%: sugestão = suggestSalePrice(40, 100)",
    near(bermCem.suggestedPrice, suggestSalePrice(40, 100)));

  // Clamp: markup > 500 vira 500
  const list3 = RetailPricingService.listProducts(A, { markup: 9999 });
  check("markup > 500 clampeado", list3.targetMarkup === 500);

  // Markup negativo vira 0
  const list4 = RetailPricingService.listProducts(A, { markup: -10 });
  check("markup < 0 clampeado a 0", list4.targetMarkup === 0);

  // ── applyBulk: mix (válido, inválido, inexistente, unchanged) ──────────
  const userId = "u-owner-A";
  const out = RetailPricingService.applyBulk(A, userId, [
    { productId: p1, newPrice: 89.99 },
    { productId: p2, newPrice: 0 },                    // preço inválido
    { productId: p2, newPrice: -5 },                   // preço negativo
    { productId: "produto-fantasma", newPrice: 50 },   // não existe
    { productId: p3, newPrice: 12 },                   // unchanged
    { productId: p4, newPrice: 35 },
    { productId: "", newPrice: 10 },                   // missing_id
  ]);
  check("applyBulk: appliedCount = 2 (p1 e p4)", out.appliedCount === 2, String(out.appliedCount));
  check("applyBulk: skippedCount = 5", out.skippedCount === 5, String(out.skippedCount));
  const reasons = new Set(out.skipped.map((s) => s.reason));
  check("skipped: invalid_price presente", reasons.has("invalid_price"));
  check("skipped: not_found presente", reasons.has("not_found"));
  check("skipped: unchanged presente", reasons.has("unchanged"));
  check("skipped: missing_id presente", reasons.has("missing_id"));
  // PERF-008: resultado detalhado por item + sucesso PARCIAL (uma linha ruim não
  // aborta as boas) + rejeição determinística NÃO é falha transitória.
  check("applyBulk: failedCount = 0 (rejeições determinísticas ≠ falha)", out.failedCount === 0 && Array.isArray(out.failed) && out.failed.length === 0, String(out.failedCount));
  check("applyBulk: sucesso parcial — p1 e p4 aplicados apesar das linhas ruins", out.applied.some((a) => a.productId === p1) && out.applied.some((a) => a.productId === p4));

  // Confere no BD.
  const bermPrice = (db.prepare("SELECT price FROM products_services WHERE id = ?").get(p1) as any)?.price;
  const semPrice = (db.prepare("SELECT price FROM products_services WHERE id = ?").get(p4) as any)?.price;
  const chavPrice = (db.prepare("SELECT price FROM products_services WHERE id = ?").get(p3) as any)?.price;
  check("BD: Bermuda virou 89,99", near(Number(bermPrice), 89.99));
  check("BD: Sem Custo virou 35", near(Number(semPrice), 35));
  check("BD: Chaveiro intacto (unchanged)", near(Number(chavPrice), 12));

  // Histórico versionado (ADR-033) — só o applied vira registro.
  const hist = db.prepare("SELECT COUNT(*) AS c FROM product_edit_history WHERE product_id = ?").get(p1) as any;
  check("ProductEditHistory: Bermuda tem entrada", (Number(hist?.c) || 0) >= 1);
  const histSem = db.prepare("SELECT COUNT(*) AS c FROM product_edit_history WHERE product_id = ?").get(p4) as any;
  check("ProductEditHistory: Sem Custo tem entrada", (Number(histSem?.c) || 0) >= 1);

  // Batch vazio: no-op, sem erro
  const outEmpty = RetailPricingService.applyBulk(A, userId, []);
  check("applyBulk vazio: appliedCount = 0", outEmpty.appliedCount === 0);
  check("applyBulk vazio: skippedCount = 0", outEmpty.skippedCount === 0);

  // ── Isolamento multi-tenant ─────────────────────────────────────────────
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`
  ).run(randomUUID(), B);
  const listB = RetailPricingService.listProducts(B);
  check("org B: lista vazia (não vê produtos da org A)", listB.items.length === 0);

  // Org B tenta alterar produto da A → cai em not_found
  const outB = RetailPricingService.applyBulk(B, "u-owner-B", [{ productId: p1, newPrice: 1 }]);
  check("org B: applied = 0 (não altera produto da A)", outB.appliedCount === 0);
  check("org B: skipped razão = not_found", outB.skipped[0]?.reason === "not_found");
  const bermStill = (db.prepare("SELECT price FROM products_services WHERE id = ?").get(p1) as any)?.price;
  check("Bermuda da org A intocada por tentativa da org B (89,99)", near(Number(bermStill), 89.99));

  // ── Limite de 500 é responsabilidade do caller (rota) — o service não corta.
  // Aqui só confirmamos que o service não estoura com um batch grande.
  const many: any[] = [];
  for (let i = 0; i < 200; i++) many.push({ productId: p1, newPrice: 89.99 }); // todos "unchanged"
  const outMany = RetailPricingService.applyBulk(A, userId, many);
  check("applyBulk 200 linhas duplicadas: só a 1ª conta como unchanged (as demais também)",
    outMany.appliedCount === 0 && outMany.skippedCount === 200);

  console.log("\n=== Tela Precificar no varejo (ADR-083 E7) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
