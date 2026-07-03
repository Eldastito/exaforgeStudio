/**
 * TESTE — Cadastro por Nota Fiscal (Smart Inventory Fase 1, ADR-021)
 * -------------------------------------------------------------------
 * Cobre:
 *   - rascunho persistido em invoice_scan_drafts (status='pending') com a
 *     lista bruta de itens extraídos antes de qualquer produto ser criado;
 *   - confirmação (POST /invoice-scan/:draftId/confirm) processa item por
 *     item conforme a ação escolhida pelo humano: 'create' (produto novo,
 *     com estoque e custo médio via InventoryService.recordMovement),
 *     'restock' (soma estoque/atualiza custo médio de um produto EXISTENTE,
 *     sem duplicar cadastro) e 'skip' (ignora a linha);
 *   - confirmação é idempotente (rascunho já confirmado não processa de novo);
 *   - isolamento entre organizações (org B não confirma rascunho de org A, nem
 *     reabastece produto de org A);
 *   - custo médio ponderado (avg_cost) é atualizado corretamente em restock;
 *   - auditoria: INVOICE_SCAN_EXTRACTED, INVOICE_SCAN_CONFIRMED, PRODUCT_CREATED.
 *
 * Mesma ressalva de scripts/test-product-smart-scan.ts: a chamada de visão em
 * si (extractInvoiceItems contra a OpenAI) não é exercitada aqui — este teste
 * roda a lógica de dados/estoque diretamente, do mesmo jeito que o endpoint
 * de confirmação faz internamente (reaproveitando InventoryService de verdade,
 * não uma cópia).
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:invoice-scan
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-invoice-scan-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-invoice-scan-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { logAuthEvent } = await import("../src/server/auditLog.js");
  const { InventoryService } = await import("../src/server/InventoryService.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  const orgB = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa B', 'active')`).run(randomUUID(), orgB);
  const userA = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role) VALUES (?, ?, 'Dono A', 'dono.a@teste.com', 'owner')`).run(userA, orgA);

  // ---- schema ----
  const cols = (db.prepare(`PRAGMA table_info(invoice_scan_drafts)`).all() as any[]).map((c) => c.name);
  for (const col of ["id", "organization_id", "uploaded_by", "image_url", "raw_extraction_json", "confidence_score", "status", "created_at", "confirmed_at"]) {
    check(`invoice_scan_drafts tem coluna ${col}`, cols.includes(col));
  }

  // Produto já existente na orgA (pra testar reposição sem duplicar)
  const existingProductId = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, description, price, stock_control_enabled) VALUES (?, ?, 'product', 'Arroz Branco 5kg', '', 25.9, 1)`).run(existingProductId, orgA);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 10, 15.0)`).run(randomUUID(), orgA, existingProductId);

  // ---- extração: rascunho gravado com 3 itens (1 vai virar produto novo, 1 vai repor o Arroz, 1 vai ser ignorado) ----
  const draftId = randomUUID();
  const extractedItems = [
    { name: "Feijão Preto Kicaldo 1kg", quantity: 20, unit: "un", unitCost: 6.5, confidence: 96 },
    { name: "Arroz Branco 5kg", quantity: 10, unit: "un", unitCost: 17.0, confidence: 91 },
    { name: "Sacola Plástica (uso interno)", quantity: 500, unit: "un", unitCost: 0.05, confidence: 70 },
  ];
  const confidenceScore = 92;
  db.prepare(
    `INSERT INTO invoice_scan_drafts (id, organization_id, uploaded_by, image_url, raw_extraction_json, confidence_score, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  ).run(draftId, orgA, userA, "/media/fake-nota.jpg", JSON.stringify({ supplierName: "Atacadão Central", items: extractedItems, rawModelOutput: "{...}" }), confidenceScore);
  logAuthEvent(orgA, userA, draftId, "INVOICE_SCAN_EXTRACTED", { confidenceScore, itemCount: extractedItems.length });

  const draftRow = db.prepare(`SELECT * FROM invoice_scan_drafts WHERE id = ?`).get(draftId) as any;
  check("Rascunho de nota gravado com status pending", draftRow?.status === "pending");
  check("Rascunho grava confidence_score corretamente", draftRow?.confidence_score === confidenceScore);
  const extractedEvent = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'INVOICE_SCAN_EXTRACTED'`).get(orgA) as any;
  check("Auditoria INVOICE_SCAN_EXTRACTED gravada com itemCount", extractedEvent && JSON.parse(extractedEvent.metadata_json).itemCount === 3);

  // ---- lógica de confirmação (replica o loop do endpoint, reaproveitando InventoryService de verdade) ----
  function confirmInvoiceDraft(orgId: string, userId: string, draft: any, items: any[]) {
    const draftRowNow = db.prepare(`SELECT * FROM invoice_scan_drafts WHERE id = ? AND organization_id = ?`).get(draft.id, orgId) as any;
    if (!draftRowNow) return { status: 404, error: "Rascunho não encontrado." };
    if (draftRowNow.status !== "pending") return { status: 400, error: "Este rascunho já foi confirmado ou descartado." };

    let supplierName: string | null = null;
    try { supplierName = JSON.parse(draftRowNow.raw_extraction_json || "{}").supplierName || null; } catch { /* noop */ }

    const created: string[] = [];
    const restocked: string[] = [];
    const skipped: number[] = [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      if (it.action === "skip" || !it.action) { skipped.push(i); continue; }
      const quantity = Math.max(0, parseInt(String(it.quantity), 10) || 0);
      const unitCost = Math.max(0, Number(it.unitCost) || 0);
      if (quantity <= 0) return { status: 400, error: `Item "${it.name || i + 1}": quantidade inválida.` };

      if (it.action === "create") {
        if (!it.name || !String(it.name).trim()) return { status: 400, error: `Item ${i + 1}: nome obrigatório.` };
        if (!(Number(it.salePrice) > 0)) return { status: 400, error: `Item "${it.name}": preço de venda obrigatório.` };
        const productId = randomUUID();
        db.prepare(`INSERT INTO products_services (id, organization_id, type, name, description, price, stock_control_enabled) VALUES (?, ?, 'product', ?, '', ?, 1)`)
          .run(productId, orgId, String(it.name).trim(), Number(it.salePrice));
        InventoryService.recordMovement(orgId, { productId, type: "entrada", quantity, unitCost, origin: "invoice_scan", note: supplierName || undefined, createdBy: userId });
        logAuthEvent(orgId, userId, productId, "PRODUCT_CREATED", { name: it.name, type: "product", source: "invoice_scan" });
        created.push(productId);
      } else if (it.action === "restock") {
        const product = db.prepare(`SELECT id FROM products_services WHERE id = ? AND organization_id = ?`).get(String(it.matchedProductId || ""), orgId) as any;
        if (!product) return { status: 400, error: `Item ${i + 1}: produto existente não encontrado.` };
        InventoryService.recordMovement(orgId, { productId: it.matchedProductId, type: "entrada", quantity, unitCost, origin: "invoice_scan", note: supplierName || undefined, createdBy: userId });
        restocked.push(it.matchedProductId);
      }
    }

    db.prepare(`UPDATE invoice_scan_drafts SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(draftRowNow.id);
    logAuthEvent(orgId, userId, draftRowNow.id, "INVOICE_SCAN_CONFIRMED", { confidenceScore: draftRowNow.confidence_score, created: created.length, restocked: restocked.length, skipped: skipped.length });
    return { status: 201, created, restocked, skipped: skipped.length };
  }

  // isolamento: orgB não confirma rascunho da orgA
  const crossOrgResult = confirmInvoiceDraft(orgB, randomUUID(), { id: draftId }, []);
  check("Confirmar rascunho de nota de outra organização retorna 404 (isolamento)", crossOrgResult.status === 404);

  // isolamento: mesmo com o draftId certo, orgB não consegue repor estoque do produto da orgA
  // (simulado diretamente: tentativa de restock com matchedProductId de outra org)
  const crossOrgRestock = (() => {
    const product = db.prepare(`SELECT id FROM products_services WHERE id = ? AND organization_id = ?`).get(existingProductId, orgB) as any;
    return !product; // não deve encontrar
  })();
  check("Produto da orgA não é visível/reponível a partir da orgB", crossOrgRestock);

  // confirmação legítima na orgA: item 1 novo produto, item 2 repõe Arroz existente, item 3 ignorado
  const confirmItems = [
    { action: "create", name: "Feijão Preto Kicaldo 1kg", quantity: 20, unitCost: 6.5, salePrice: 9.99 },
    { action: "restock", matchedProductId: existingProductId, quantity: 10, unitCost: 17.0 },
    { action: "skip" },
  ];
  const confirmResult = confirmInvoiceDraft(orgA, userA, { id: draftId }, confirmItems);
  check("Confirmação legítima retorna 201", confirmResult.status === 201);
  check("1 produto novo criado", (confirmResult as any).created?.length === 1);
  check("1 produto reposto (não duplicado)", (confirmResult as any).restocked?.length === 1);
  check("1 item ignorado (skip)", (confirmResult as any).skipped === 1);

  const productCount = (db.prepare(`SELECT COUNT(*) AS c FROM products_services WHERE organization_id = ?`).get(orgA) as any).c;
  check("Total de produtos na orgA é 2 (1 pré-existente + 1 novo do scan, nenhum duplicado)", productCount === 2);

  const newProductId = (confirmResult as any).created[0];
  const newProductStock = db.prepare(`SELECT quantity_available FROM inventory_items WHERE product_service_id = ?`).get(newProductId) as any;
  check("Produto novo entra com a quantidade da nota (20)", newProductStock?.quantity_available === 20);

  // custo médio ponderado do produto reposto: 10 unid a 15.0 + 10 unid a 17.0 = (150+170)/20 = 16.0
  const restockedInv = db.prepare(`SELECT quantity_available, avg_cost FROM inventory_items WHERE product_service_id = ?`).get(existingProductId) as any;
  check("Estoque do produto reposto soma corretamente (10 + 10 = 20)", restockedInv?.quantity_available === 20);
  check("Custo médio ponderado recalculado corretamente (15.0 e 17.0 -> 16.0)", Math.abs((restockedInv?.avg_cost || 0) - 16.0) < 0.001, `avg_cost=${restockedInv?.avg_cost}`);

  // movimentos de estoque registrados com origin correto
  const movements = db.prepare(`SELECT * FROM stock_movements WHERE organization_id = ? AND origin = 'invoice_scan'`).all(orgA) as any[];
  check("2 movimentações de estoque registradas com origin=invoice_scan (novo + reposição)", movements.length === 2);

  // idempotência: confirmar de novo o mesmo rascunho falha e não duplica nada
  const secondConfirm = confirmInvoiceDraft(orgA, userA, { id: draftId }, confirmItems);
  check("Confirmar um rascunho de nota já confirmado retorna 400 (idempotência)", secondConfirm.status === 400);
  const productCountAfterRetry = (db.prepare(`SELECT COUNT(*) AS c FROM products_services WHERE organization_id = ?`).get(orgA) as any).c;
  check("Retry não duplica produtos", productCountAfterRetry === 2);
  const stockAfterRetry = db.prepare(`SELECT quantity_available FROM inventory_items WHERE product_service_id = ?`).get(existingProductId) as any;
  check("Retry não duplica a reposição de estoque (continua 20, não 30)", stockAfterRetry?.quantity_available === 20);

  // auditoria de confirmação
  const confirmedEvent = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'INVOICE_SCAN_CONFIRMED'`).get(orgA) as any;
  check("Auditoria INVOICE_SCAN_CONFIRMED gravada", !!confirmedEvent);
  const confirmedMeta = confirmedEvent ? JSON.parse(confirmedEvent.metadata_json) : {};
  check("Auditoria INVOICE_SCAN_CONFIRMED conta created/restocked/skipped corretamente", confirmedMeta.created === 1 && confirmedMeta.restocked === 1 && confirmedMeta.skipped === 1);

  const productCreatedEvent = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'PRODUCT_CREATED' AND target_user_id = ?`).get(orgA, newProductId) as any;
  check("Auditoria PRODUCT_CREATED gravada com source=invoice_scan", productCreatedEvent && JSON.parse(productCreatedEvent.metadata_json).source === "invoice_scan");

  // ---- resultado ----
  console.log("\n=== Cadastro por Nota Fiscal — Smart Inventory Fase 1 (ADR-021) ===\n");
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
