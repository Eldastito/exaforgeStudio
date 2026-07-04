/**
 * TESTE — Fase B do cadastro por WhatsApp: margem obrigatória, recusa,
 * reposição por reconhecimento de catálogo e foto de estúdio (ADR-032)
 * -------------------------------------------------------------------------
 * Sem OPENAI_API_KEY neste sandbox (mesma limitação da ADR-030/031), então
 * este teste cobre a camada determinística (DB/regras de negócio) e a
 * degradação graciosa dos pontos que dependem de IA (classificação/edição de
 * imagem) — não a qualidade da extração/edição em si.
 *
 * Uso: npm run test:whatsapp-inventory-fase-b
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-wa-inventory-b-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-wa-inventory-b-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { InventoryIntakeService } = await import("../src/server/InventoryIntakeService.js");
  const { StudioCatalogPhotoService } = await import("../src/server/StudioCatalogPhotoService.js");
  const { WhatsAppInventoryIntake, DECLINE_PATTERN } = await import("../src/server/WhatsAppInventoryIntake.js");
  const { findBestProductMatch } = await import("../src/server/productMatcher.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug) VALUES (?, 'empresa-a')`).run(orgA);

  // ---- schema ----
  const productCols = (db.prepare(`PRAGMA table_info(products_services)`).all() as any[]).map((c) => c.name);
  for (const col of ["margin_percent", "pricing_declined_at", "studio_image_url"]) {
    check(`products_services tem coluna ${col}`, productCols.includes(col));
  }
  const storefrontCols = (db.prepare(`PRAGMA table_info(storefront_settings)`).all() as any[]).map((c) => c.name);
  check("storefront_settings tem coluna ai_catalog_photos_enabled", storefrontCols.includes("ai_catalog_photos_enabled"));
  const orgCols = (db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[]).map((c) => c.name);
  check("organization_settings tem coluna pending_pricing_nudge_at", orgCols.includes("pending_pricing_nudge_at"));

  // ---- margem persistida ----
  const pricedId = InventoryIntakeService.commitProductFromScan(orgA, {
    name: "Feijão Preto 1kg", category: "Grãos", description: "", salePrice: 8.99, marginPercent: 40, quantity: 20, imageUrl: "/media/a.jpg",
  });
  const priced = db.prepare(`SELECT * FROM products_services WHERE id = ?`).get(pricedId) as any;
  check("Produto com margem: margin_percent gravado", priced?.margin_percent === 40);
  check("Produto com margem: publicado na vitrine", priced?.storefront_visible === 1);

  // ---- preço direto (sem custo/margem) ainda publica — decisão confirmada com o usuário ----
  const directId = InventoryIntakeService.commitProductFromScan(orgA, {
    name: "Arroz Branco 5kg", category: "Grãos", description: "", salePrice: 24.9, marginPercent: null, quantity: 10, imageUrl: "/media/b.jpg",
  });
  const direct = db.prepare(`SELECT * FROM products_services WHERE id = ?`).get(directId) as any;
  check("Preço direto sem margem: ainda assim publicado (regra confirmada)", direct?.storefront_visible === 1 && direct?.margin_percent === null);

  // ---- recusa: produto sem preço nunca é publicado ----
  const declinedId = InventoryIntakeService.commitProductWithoutPrice(orgA, {
    name: "Açúcar Cristal 1kg", category: "Mercearia", description: "", quantity: 15, imageUrl: "/media/c.jpg",
  });
  const declined = db.prepare(`SELECT * FROM products_services WHERE id = ?`).get(declinedId) as any;
  check("Recusa: produto NUNCA publicado na vitrine (storefront_visible=0)", declined?.storefront_visible === 0);
  check("Recusa: price fica nulo", declined?.price == null);
  check("Recusa: pricing_declined_at foi marcado", !!declined?.pricing_declined_at);
  const declinedInv = db.prepare(`SELECT * FROM inventory_items WHERE product_service_id = ?`).get(declinedId) as any;
  check("Recusa: quantidade AINDA entra no controle de estoque", declinedInv?.quantity_available === 15);

  // ---- recusa no fluxo de nota fiscal: custo/quantidade reais da nota, preço pendente ----
  const invoiceDeclinedId = InventoryIntakeService.commitInvoiceItemWithoutPrice(orgA, {
    name: "Óleo de Soja 900ml", quantity: 12, unitCost: 6.5, supplierName: "Atacadão",
  });
  const invoiceDeclined = db.prepare(`SELECT * FROM products_services WHERE id = ?`).get(invoiceDeclinedId) as any;
  check("Nota fiscal + recusa: nunca publicado", invoiceDeclined?.storefront_visible === 0);
  const invoiceDeclinedInv = db.prepare(`SELECT * FROM inventory_items WHERE product_service_id = ?`).get(invoiceDeclinedId) as any;
  check("Nota fiscal + recusa: quantidade real da nota entra no estoque mesmo sem preço", invoiceDeclinedInv?.quantity_available === 12);
  check("Nota fiscal + recusa: custo médio gravado (dado real da nota)", Math.abs((invoiceDeclinedInv?.avg_cost || 0) - 6.5) < 0.01);

  // ---- reposição por reconhecimento de catálogo (Fluxo 1) reaproveita preço, nunca pede de novo ----
  InventoryIntakeService.restockProductFromScan(orgA, { productId: pricedId, quantity: 30 });
  const restocked = db.prepare(`SELECT * FROM inventory_items WHERE product_service_id = ?`).get(pricedId) as any;
  check("Reposição por foto: soma ao estoque (20 + 30)", restocked?.quantity_available === 50);
  const priceAfterRestock = db.prepare(`SELECT price, margin_percent FROM products_services WHERE id = ?`).get(pricedId) as any;
  check("Reposição por foto: preço/margem NÃO mudam (reaproveitados)", priceAfterRestock?.price === 8.99 && priceAfterRestock?.margin_percent === 40);

  // ---- auditoria de produtos incompletos ----
  const incomplete = InventoryIntakeService.incompletePricingProducts(orgA);
  const incompleteNames = incomplete.map((p) => p.name).sort();
  check("Auditoria lista SÓ os produtos sem preço", incompleteNames.join(",") === ["Açúcar Cristal 1kg", "Óleo de Soja 900ml"].sort().join(","), `encontrados=${incompleteNames.join(",")}`);
  check("Auditoria NÃO lista produtos já precificados", !incompleteNames.includes("Feijão Preto 1kg") && !incompleteNames.includes("Arroz Branco 5kg"));

  // ---- DECLINE_PATTERN: só recusa explícita, nunca texto com dado real ----
  check("'não quero informar' é recusa", DECLINE_PATTERN.test("não quero informar"));
  check("'não sei o preço ainda' é recusa", DECLINE_PATTERN.test("não sei o preço ainda"));
  check("'pula esse' é recusa", DECLINE_PATTERN.test("pula esse"));
  check("'paguei 5 reais' NÃO é recusa (tem dado real)", !DECLINE_PATTERN.test("paguei 5 reais"));
  check("'quero 40% de margem' NÃO é recusa", !DECLINE_PATTERN.test("quero 40% de margem"));
  check("'20 unidades' NÃO é recusa", !DECLINE_PATTERN.test("20 unidades"));

  // ---- resolveProductFields: preço direto conta como pronto mesmo sem margin_percent numérico ----
  const direct2 = WhatsAppInventoryIntake.resolveProductFields({ salePrice: 15, quantity: 5 });
  check("resolveProductFields: preço direto sem custo/margem fica pronto (regra confirmada)", direct2.ready);

  // ---- StudioCatalogPhotoService: desligado por padrão ----
  check("Foto de estúdio desligada por padrão (opt-in)", !StudioCatalogPhotoService.isEnabled(orgA));
  const disabledResult = await StudioCatalogPhotoService.generateForNewProduct(orgA, "ZmFrZQ==", "image/jpeg");
  check("Desligada: generateForNewProduct retorna null sem tentar IA", disabledResult === null);
  const disabledExisting = await StudioCatalogPhotoService.ensureForExistingProduct(orgA, pricedId, "ZmFrZQ==", "image/jpeg");
  check("Desligada: ensureForExistingProduct retorna null/reused=false", disabledExisting.url === null && disabledExisting.reused === false);

  // ---- ligando o toggle: reaproveita foto já persistida sem chamar IA de novo ----
  db.prepare(`UPDATE storefront_settings SET ai_catalog_photos_enabled = 1 WHERE organization_id = ?`).run(orgA);
  check("Toggle ligado: isEnabled reflete a configuração", StudioCatalogPhotoService.isEnabled(orgA));
  StudioCatalogPhotoService.persistForProduct(orgA, pricedId, "/media/estudio-feijao.png");
  const withStudio = db.prepare(`SELECT studio_image_url FROM products_services WHERE id = ?`).get(pricedId) as any;
  check("persistForProduct grava studio_image_url", withStudio?.studio_image_url === "/media/estudio-feijao.png");
  const coverAfter = db.prepare(`SELECT url FROM product_images WHERE product_service_id = ? ORDER BY position ASC LIMIT 1`).get(pricedId) as any;
  check("persistForProduct troca a capa em product_images", coverAfter?.url === "/media/estudio-feijao.png");
  const reused = await StudioCatalogPhotoService.ensureForExistingProduct(orgA, pricedId, "ZmFrZQ==", "image/jpeg");
  check("Já tem foto de estúdio: reaproveita SEM chamar IA (reused=true)", reused.url === "/media/estudio-feijao.png" && reused.reused === true);

  // ---- ligado mas SEM foto ainda: tenta gerar, falha graciosamente sem chave de IA ----
  const newProductNoStudio = InventoryIntakeService.commitProductFromScan(orgA, {
    name: "Café Torrado 500g", category: "Mercearia", description: "", salePrice: 12.9, marginPercent: null, quantity: 8, imageUrl: "/media/cafe.jpg",
  });
  const genResult = await StudioCatalogPhotoService.ensureForExistingProduct(orgA, newProductNoStudio, "ZmFrZQ==", "image/jpeg");
  check("Ligado sem chave de IA: falha graciosamente (url=null), nunca lança exceção", genResult.url === null && genResult.reused === false);

  // ---- match de catálogo: mesmo limiar (0.75) usado no Fluxo 1 para virar reposição ----
  const catalog = [{ id: "p1", name: "Feijão Preto 1kg" }];
  const strong = findBestProductMatch("FEIJAO PRETO 1KG", catalog, 0.75);
  check("Fluxo 1 reconhece produto já cadastrado (match forte)", !!strong);

  // ---- maybeNudge: some quando não há org, aparece quando há produto incompleto, respeita rate-limit ----
  const orgSemProdutos = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa Vazia', 'active')`).run(randomUUID(), orgSemProdutos);
  check("Sem produtos incompletos: nudge vazio", WhatsAppInventoryIntake.maybeNudge(orgSemProdutos) === "");

  const nudge1 = WhatsAppInventoryIntake.maybeNudge(orgA);
  check("Com produtos incompletos: nudge menciona os produtos", nudge1.includes("Açúcar Cristal") || nudge1.includes("Óleo de Soja"));
  const nudge2 = WhatsAppInventoryIntake.maybeNudge(orgA);
  check("Rate-limit: segunda chamada no mesmo dia NÃO repete o aviso", nudge2 === "");

  // simula 25h atrás: rate-limit libera de novo
  db.prepare(`UPDATE organization_settings SET pending_pricing_nudge_at = datetime('now', '-25 hours') WHERE organization_id = ?`).run(orgA);
  const nudge3 = WhatsAppInventoryIntake.maybeNudge(orgA);
  check("Rate-limit: libera de novo depois de 24h", nudge3 !== "");

  // ---- resultado ----
  console.log("\n=== Fase B — margem obrigatória, recusa, reposição por match, foto de estúdio (ADR-032) ===\n");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Erro fatal no teste:", e);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
