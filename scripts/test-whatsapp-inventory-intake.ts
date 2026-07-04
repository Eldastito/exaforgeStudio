/**
 * TESTE — Cadastro de estoque/vitrine direto no WhatsApp (canal do gestor)
 * -------------------------------------------------------------------------
 * Cobre a "IA do negócio" separada da IA de atendimento: um gestor autorizado
 * manda uma foto de produto/nota fiscal e a própria conversa pergunta o que
 * falta (custo/margem/quantidade, ou só o preço de venda no caso de nota) até
 * publicar na vitrine.
 *
 * Sem OPENAI_API_KEY neste sandbox (mesma limitação da ADR-030), então este
 * teste NÃO exercita a extração/classificação por visão de verdade — isso já
 * é validado em produção pelo script de validação da ADR-030. Aqui cobre-se:
 *   - a camada de dados/commit (InventoryIntakeService), 100% determinística;
 *   - a lógica pura de "o que ainda falta perguntar" (resolveProductFields);
 *   - o limiar de auto-reposição (0.75, mais rígido que o 0.6 da tela de
 *     revisão humana — aqui não há humano conferindo antes);
 *   - o CRUD de ação pendente (PendingManagerActions);
 *   - o ROTEAMENTO em AIOrchestratorService.processMessage: gestor+foto entra
 *     no fluxo novo (e falha com uma mensagem amigável, sem chave de IA);
 *     cliente comum+foto NÃO entra nesse fluxo (regressão); ação pendente de
 *     campanha continua intacta (regressão).
 *
 * Uso: npm run test:whatsapp-inventory-intake
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-wa-inventory-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-wa-inventory-1234567890";
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
  const { WhatsAppInventoryIntake } = await import("../src/server/WhatsAppInventoryIntake.js");
  const { getPendingAction, savePendingAction, clearPendingAction } = await import("../src/server/PendingManagerActions.js");
  const { findBestProductMatch } = await import("../src/server/productMatcher.js");
  const { AIOrchestratorService } = await import("../src/server/AIOrchestratorService.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa A', 'active')`).run(randomUUID(), orgA);
  const managerPhone = "5521999998888";
  db.prepare(`INSERT INTO authorized_managers (id, organization_id, identifier, name) VALUES (?, ?, ?, 'Dono da loja')`).run(randomUUID(), orgA, managerPhone);

  // ---- schema: product_price_history ----
  const cols = (db.prepare(`PRAGMA table_info(product_price_history)`).all() as any[]).map((c) => c.name);
  for (const col of ["id", "organization_id", "product_id", "product_name", "category", "cost_price", "margin_percent", "sale_price", "source", "created_at"]) {
    check(`product_price_history tem coluna ${col}`, cols.includes(col));
  }

  // ---- InventoryIntakeService.commitProductFromScan (fluxo 1) ----
  const productId = InventoryIntakeService.commitProductFromScan(orgA, {
    name: "Feijão Preto Kicaldo 1kg", category: "Alimentos > Grãos", description: "Feijão preto tipo 1.",
    salePrice: 8.99, quantity: 25, imageUrl: "/media/fake-feijao.jpg",
  });
  const product = db.prepare(`SELECT * FROM products_services WHERE id = ?`).get(productId) as any;
  check("Produto criado com o preço definido na conversa", product?.price === 8.99);
  check("Produto criado já publicado na vitrine (storefront_visible=1)", product?.storefront_visible === 1);
  check("Produto criado com estoque controlado", product?.stock_control_enabled === 1);
  const inv = db.prepare(`SELECT * FROM inventory_items WHERE product_service_id = ?`).get(productId) as any;
  check("Estoque inicial gravado com a quantidade informada", inv?.quantity_available === 25);
  const img = db.prepare(`SELECT * FROM product_images WHERE product_service_id = ?`).get(productId) as any;
  check("Foto do WhatsApp virou a imagem do produto", img?.url === "/media/fake-feijao.jpg");
  const createdEvent = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'PRODUCT_CREATED'`).get(orgA) as any;
  check("Auditoria PRODUCT_CREATED gravada com source=whatsapp_manager", createdEvent && JSON.parse(createdEvent.metadata_json).source === "whatsapp_manager");

  // ---- InventoryIntakeService.recordPriceHistory ("aprender" = dado estruturado, não ML) ----
  InventoryIntakeService.recordPriceHistory(orgA, {
    productId, productName: "Feijão Preto Kicaldo 1kg", category: "Alimentos > Grãos",
    costPrice: 5, marginPercent: 40, salePrice: 8.99, source: "whatsapp_manager",
  });
  const history = db.prepare(`SELECT * FROM product_price_history WHERE organization_id = ?`).get(orgA) as any;
  check("Histórico de preço gravado com custo/margem/preço", history?.cost_price === 5 && history?.margin_percent === 40 && history?.sale_price === 8.99);

  // ---- InventoryIntakeService.commitInvoiceItemCreate (fluxo 2, item novo) ----
  const newItemId = InventoryIntakeService.commitInvoiceItemCreate(orgA, {
    name: "Arroz Branco Tipo 1 5kg", salePrice: 24.9, quantity: 10, unitCost: 17, supplierName: "Atacadão Central",
  });
  const newItemProduct = db.prepare(`SELECT * FROM products_services WHERE id = ?`).get(newItemId) as any;
  check("Item novo da nota criado com preço de venda informado", newItemProduct?.price === 24.9);
  const newItemInv = db.prepare(`SELECT * FROM inventory_items WHERE product_service_id = ?`).get(newItemId) as any;
  check("Item novo da nota entra no estoque com a quantidade da nota", newItemInv?.quantity_available === 10);
  check("Custo médio gravado a partir do custo real da nota", Math.abs((newItemInv?.avg_cost || 0) - 17) < 0.01);

  // ---- InventoryIntakeService.commitInvoiceItemRestock (fluxo 2, item já existe — repõe sem perguntar) ----
  InventoryIntakeService.commitInvoiceItemRestock(orgA, { productId, quantity: 15, unitCost: 5.2, supplierName: "Atacadão Central" });
  const restocked = db.prepare(`SELECT * FROM inventory_items WHERE product_service_id = ?`).get(productId) as any;
  check("Reposição automática soma ao estoque existente (25 + 15)", restocked?.quantity_available === 40);
  const movement = db.prepare(`SELECT * FROM stock_movements WHERE product_service_id = ? ORDER BY created_at DESC LIMIT 1`).get(productId) as any;
  check("Movimentação de reposição registrada com origin=invoice_scan", movement?.origin === "invoice_scan");

  // ---- resolveProductFields (lógica pura: o que falta perguntar) ----
  const empty = WhatsAppInventoryIntake.resolveProductFields({});
  check("Sem nada informado: falta custo e quantidade", !empty.ready && empty.missing.includes("costPrice") && empty.missing.includes("quantity"));

  const onlyCost = WhatsAppInventoryIntake.resolveProductFields({ costPrice: 5 });
  check("Só custo informado: falta margem/preço e quantidade", !onlyCost.ready && onlyCost.missing.includes("priceOrMargin") && onlyCost.missing.includes("quantity"));

  const costAndMargin = WhatsAppInventoryIntake.resolveProductFields({ costPrice: 5, marginPercent: 40, quantity: 20 });
  check("Custo+margem+quantidade: pronto, preço calculado (5 * 1.4 = 7)", costAndMargin.ready && costAndMargin.salePrice === 7);

  const directPrice = WhatsAppInventoryIntake.resolveProductFields({ salePrice: 9.9, quantity: 3 });
  check("Preço de venda direto (sem custo/margem): pronto", directPrice.ready && directPrice.salePrice === 9.9);

  const zeroQty = WhatsAppInventoryIntake.resolveProductFields({ salePrice: 9.9, quantity: 0 });
  check("Quantidade 0 é um valor válido (não é 'faltando')", zeroQty.ready);

  // ---- limiar de auto-reposição (0.75) — mais rígido que a tela de revisão (0.6, ADR-024) ----
  const catalog = [{ id: "p1", name: "Feijão Preto Kicaldo 1kg" }];
  const strongMatch = findBestProductMatch("FEIJAO PRETO KICALDO 1KG", catalog, 0.75);
  check("Match forte (nome quase idêntico) passa no limiar de 0.75", !!strongMatch);
  // Sobreposição parcial real (3 de 4 tokens batem, sem um nome ser
  // subconjunto total do outro) — nameSimilarity dá ~0.67, que fica ENTRE os
  // dois limiares (diferente de testar com uma palavra só, que ganha bônus de
  // contenção total e sempre pontua alto demais para provar a diferença).
  const weakMatch = findBestProductMatch("FEIJAO PRETO KICALDO EXTRA GRANEL", catalog, 0.75);
  const weakMatchReview = findBestProductMatch("FEIJAO PRETO KICALDO EXTRA GRANEL", catalog, 0.6);
  check("Match fraco é REJEITADO no limiar de 0.75 (auto-reposição não arrisca)", weakMatch === null);
  check("O mesmo match fraco passaria no limiar de 0.6 da tela de revisão humana (comportamento diferente é intencional)", !!weakMatchReview);

  // ---- PendingManagerActions: CRUD + substituição ----
  savePendingAction(orgA, managerPhone, "product_registration", { foo: "bar" });
  const pending1 = getPendingAction(orgA, managerPhone);
  check("Ação pendente salva e recuperável", pending1?.action_type === "product_registration");
  savePendingAction(orgA, managerPhone, "invoice_registration", { baz: "qux" });
  const pending2 = getPendingAction(orgA, managerPhone);
  check("Nova ação pendente substitui a anterior do mesmo gestor", pending2?.action_type === "invoice_registration" && pending2?.id !== pending1?.id);
  clearPendingAction(pending2.id);
  check("Ação pendente removida após clear", !getPendingAction(orgA, managerPhone));

  // ---- Roteamento em AIOrchestratorService.processMessage ----
  const baseParams = { organizationId: orgA, channelId: "chan1" } as any;

  // Gestor + foto: entra no fluxo novo (e falha com mensagem amigável — sem OPENAI_API_KEY neste sandbox).
  const managerPhotoResult = await AIOrchestratorService.processMessage({
    ...baseParams, message: "", senderId: managerPhone, imageBase64: "ZmFrZQ==", imageMime: "image/jpeg",
  });
  check("Gestor+foto entra no cadastro de estoque (mensagem de erro amigável, sem IA configurada)", managerPhotoResult.reply.includes("Não consegui analisar essa foto"));
  check("Gestor+foto nunca marca needsHuman (não trava o atendimento)", managerPhotoResult.needsHuman === false);

  // Cliente comum (não gestor) + foto: NÃO deve cair no fluxo de cadastro de estoque (regressão).
  let customerThrew = false;
  let customerReply = "";
  try {
    const r = await AIOrchestratorService.processMessage({
      ...baseParams, message: "", senderId: "5521988887777", imageBase64: "ZmFrZQ==", imageMime: "image/jpeg",
    });
    customerReply = r.reply;
  } catch (e) { customerThrew = true; }
  check(
    "Cliente comum (não gestor) com foto NÃO entra no fluxo de cadastro de estoque",
    customerThrew || !customerReply.includes("Não consegui analisar essa foto")
  );

  // Ação pendente de campanha (regressão): resposta ambígua continua pedindo confirmação de campanha,
  // sem ser desviada para o handler novo (pending.action_type === 'create_campaign' é excluído do desvio).
  savePendingAction(orgA, managerPhone, "create_campaign", { name: "Campanha Teste", message: "Oi!", segment: {} });
  const campaignAmbiguous = await AIOrchestratorService.processMessage({ ...baseParams, message: "talvez", senderId: managerPhone });
  check("Ação pendente de campanha continua com o gate sim/não original (regressão)", campaignAmbiguous.reply.includes("campanha aguardando confirmação"));
  clearPendingAction((getPendingAction(orgA, managerPhone) || {}).id || "");

  // Continuação de um cadastro de produto pendente: roteia para o fluxo novo, não para o gate de campanha.
  savePendingAction(orgA, managerPhone, "product_registration", {
    imageUrl: "/media/fake.jpg", extracted: { name: "Feijão Preto", category: null, description: "" }, collected: {},
  });
  const continuation = await AIOrchestratorService.processMessage({ ...baseParams, message: "paguei 5, quero 40%, tenho 20 unidades", senderId: managerPhone });
  check("Continuação de cadastro pendente NÃO cai no gate de campanha", !continuation.reply.toLowerCase().includes("campanha"));

  // ---- resultado ----
  console.log("\n=== Cadastro de estoque por WhatsApp (IA do negócio) ===\n");
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
