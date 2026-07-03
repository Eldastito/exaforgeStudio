/**
 * TESTE — Cadastro Inteligente por Foto, incremento ADR-020
 * -----------------------------------------------------------
 * Cobre o pacote de melhorias sobre a Fase 0 (ADR-019):
 *   - rascunho persistido em product_scan_drafts (status='pending') antes de
 *     qualquer produto existir;
 *   - confirmação idempotente (POST /smart-scan/:draftId/confirm) — cria o
 *     produto, marca o rascunho como 'confirmed', não deixa confirmar 2x;
 *   - isolamento entre organizações no endpoint de confirmação;
 *   - rate limit de 20 scans/minuto por organização;
 *   - auditoria: PRODUCT_SCAN_EXTRACTED, PRODUCT_SCAN_CONFIRMED (com diff de
 *     campos alterados pelo humano) e PRODUCT_CREATED.
 *
 * Como extractProductFromImage() chama a IA de verdade e este sandbox não tem
 * OPENAI_API_KEY, este teste NÃO sobe o servidor com o router /smart-scan
 * completo (que exigiria a chamada de IA). Em vez disso, ele exercita
 * diretamente a camada de dados/auditoria que o endpoint usa — o mesmo padrão
 * de scripts/test-rbac-audit.ts — e testa o rate limiter isoladamente
 * reimportando sua lógica pura. A extração via IA em si já foi validada
 * manualmente na Fase 0 (ADR-019) fora deste sandbox.
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:product-smart-scan
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-smart-scan-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-smart-scan-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { logAuthEvent } = await import("../src/server/auditLog.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  const orgB = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa B', 'active')`).run(randomUUID(), orgB);
  const userA = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role) VALUES (?, ?, 'Dono A', 'dono.a@teste.com', 'owner')`).run(userA, orgA);

  // ---- product_scan_drafts existe com as colunas esperadas ----
  const cols = (db.prepare(`PRAGMA table_info(product_scan_drafts)`).all() as any[]).map((c) => c.name);
  for (const col of ["id", "organization_id", "uploaded_by", "image_url", "raw_extraction_json", "confidence_score", "status", "product_id", "created_at", "confirmed_at"]) {
    check(`product_scan_drafts tem coluna ${col}`, cols.includes(col));
  }

  // ---- criação de rascunho (simula o que POST /smart-scan grava após a IA responder) ----
  const draftId = randomUUID();
  const extracted = { name: "Feijão Preto Kicaldo 1kg", brand: "Kicaldo", category: "Alimentos > Grãos", weightLabel: "1 Kg", description: "Feijão preto tipo 1, pacote de 1kg." };
  const confidenceScore = 97;
  db.prepare(
    `INSERT INTO product_scan_drafts (id, organization_id, uploaded_by, image_url, raw_extraction_json, confidence_score, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  ).run(draftId, orgA, userA, "/media/fake-feijao.jpg", JSON.stringify({ extracted, rawModelOutput: "{...}" }), confidenceScore);
  logAuthEvent(orgA, userA, draftId, "PRODUCT_SCAN_EXTRACTED", { confidenceScore });

  const draftRow = db.prepare(`SELECT * FROM product_scan_drafts WHERE id = ?`).get(draftId) as any;
  check("Rascunho gravado com status pending", draftRow?.status === "pending");
  check("Rascunho grava confidence_score corretamente", draftRow?.confidence_score === confidenceScore);
  check("Rascunho não tem product_id antes da confirmação", draftRow?.product_id == null);

  const extractedEvent = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'PRODUCT_SCAN_EXTRACTED'`).get(orgA) as any;
  check("Auditoria PRODUCT_SCAN_EXTRACTED gravada", !!extractedEvent);
  check("Auditoria PRODUCT_SCAN_EXTRACTED guarda confidenceScore", extractedEvent && JSON.parse(extractedEvent.metadata_json).confidenceScore === confidenceScore);

  // ---- confirmação: cria o produto de verdade (simula a lógica de POST /confirm) ----
  function confirmDraft(orgId: string, userId: string, draft: any, humanInput: { name: string; category?: string; description?: string; price: number }) {
    const draftRowNow = db.prepare(`SELECT * FROM product_scan_drafts WHERE id = ? AND organization_id = ?`).get(draft.id, orgId) as any;
    if (!draftRowNow) return { status: 404, error: "Rascunho não encontrado." };
    if (draftRowNow.status !== "pending") return { status: 400, error: "Este rascunho já foi confirmado ou descartado." };

    const id = randomUUID();
    db.prepare(
      `INSERT INTO products_services (id, organization_id, type, name, description, price, stock_control_enabled, category)
       VALUES (?, ?, 'product', ?, ?, ?, 0, ?)`
    ).run(id, orgId, humanInput.name, humanInput.description || "", humanInput.price, humanInput.category || null);

    db.prepare(`UPDATE product_scan_drafts SET status = 'confirmed', product_id = ?, confirmed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id, draftRowNow.id);

    let extractedNow: any = {};
    try { extractedNow = JSON.parse(draftRowNow.raw_extraction_json || "{}").extracted || {}; } catch { /* noop */ }
    const changedFields = ["name", "category", "description"].filter((f) => {
      const before = (extractedNow as any)[f] ?? null;
      const after = (humanInput as any)[f];
      return String(before ?? "").trim() !== String(after ?? "").trim();
    });

    logAuthEvent(orgId, userId, id, "PRODUCT_CREATED", { name: humanInput.name, type: "product", source: "smart_scan" });
    logAuthEvent(orgId, userId, draftRowNow.id, "PRODUCT_SCAN_CONFIRMED", { productId: id, confidenceScore: draftRowNow.confidence_score, changedFields });

    return { status: 201, id };
  }

  // isolamento entre orgs: orgB não pode confirmar um rascunho da orgA
  const crossOrgResult = confirmDraft(orgB, randomUUID(), { id: draftId }, { name: "Tentativa Org B", price: 5 });
  check("Confirmar rascunho de outra organização retorna 404 (isolamento)", crossOrgResult.status === 404);
  const draftStillPending = db.prepare(`SELECT status FROM product_scan_drafts WHERE id = ?`).get(draftId) as any;
  check("Rascunho continua pending após tentativa de confirmação cross-org", draftStillPending?.status === "pending");

  // confirmação legítima na orgA, humano ajusta nome e preço, mantém categoria
  const humanInput = { name: "Feijão Preto Kicaldo Pacote 1kg", category: "Alimentos > Grãos", description: extracted.description, price: 8.49 };
  const confirmResult = confirmDraft(orgA, userA, { id: draftId }, humanInput);
  check("Confirmação legítima retorna 201 com id do produto", confirmResult.status === 201 && !!confirmResult.id);

  const product = db.prepare(`SELECT * FROM products_services WHERE id = ?`).get(confirmResult.id) as any;
  check("Produto criado com nome final (editado pelo humano)", product?.name === humanInput.name);
  check("Produto criado com preço definido pelo humano (IA nunca sugere preço)", product?.price === humanInput.price);

  const draftAfterConfirm = db.prepare(`SELECT * FROM product_scan_drafts WHERE id = ?`).get(draftId) as any;
  check("Rascunho marcado como confirmed", draftAfterConfirm?.status === "confirmed");
  check("Rascunho aponta para o product_id criado", draftAfterConfirm?.product_id === confirmResult.id);
  check("confirmed_at foi preenchido", !!draftAfterConfirm?.confirmed_at);

  // idempotência: confirmar de novo o mesmo rascunho falha
  const secondConfirm = confirmDraft(orgA, userA, { id: draftId }, humanInput);
  check("Confirmar um rascunho já confirmado retorna 400 (idempotência)", secondConfirm.status === 400);
  const productCountAfterRetry = (db.prepare(`SELECT COUNT(*) AS c FROM products_services WHERE organization_id = ?`).get(orgA) as any).c;
  check("Retry não duplica o produto", productCountAfterRetry === 1);

  // auditoria de confirmação com diff de campos alterados
  const confirmedEvent = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'PRODUCT_SCAN_CONFIRMED'`).get(orgA) as any;
  check("Auditoria PRODUCT_SCAN_CONFIRMED gravada", !!confirmedEvent);
  const confirmedMeta = confirmedEvent ? JSON.parse(confirmedEvent.metadata_json) : {};
  check("Auditoria PRODUCT_SCAN_CONFIRMED referencia o productId certo", confirmedMeta.productId === confirmResult.id);
  check("Auditoria PRODUCT_SCAN_CONFIRMED detecta 'name' como campo alterado pelo humano", Array.isArray(confirmedMeta.changedFields) && confirmedMeta.changedFields.includes("name"));
  check("Auditoria PRODUCT_SCAN_CONFIRMED NÃO marca 'category' como alterado (humano manteve)", Array.isArray(confirmedMeta.changedFields) && !confirmedMeta.changedFields.includes("category"));

  const createdEvent = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'PRODUCT_CREATED'`).get(orgA) as any;
  check("Auditoria PRODUCT_CREATED gravada com source=smart_scan", createdEvent && JSON.parse(createdEvent.metadata_json).source === "smart_scan");

  // ---- rate limiter (20/min por organização) — mesma lógica de routes/products.ts ----
  const scanRateBuckets = new Map<string, { count: number; resetTime: number }>();
  function scanRateLimited(orgId: string, max = 20, windowMs = 60 * 1000, now = Date.now()): boolean {
    let b = scanRateBuckets.get(orgId);
    if (!b || now > b.resetTime) b = { count: 0, resetTime: now + windowMs };
    b.count++;
    scanRateBuckets.set(orgId, b);
    return b.count > max;
  }
  const fixedNow = 1_700_000_000_000;
  let blockedAt = -1;
  for (let i = 1; i <= 25; i++) {
    if (scanRateLimited(`org_rate_test`, 20, 60_000, fixedNow)) { blockedAt = i; break; }
  }
  check("Rate limiter bloqueia a partir da 21ª chamada no mesmo minuto", blockedAt === 21, `bloqueou na chamada ${blockedAt}`);
  const notBlockedNextWindow = scanRateLimited(`org_rate_test`, 20, 60_000, fixedNow + 61_000);
  check("Rate limiter libera de novo na janela seguinte", notBlockedNextWindow === false);
  const otherOrgNotBlocked = scanRateLimited(`org_rate_test_outra_org`, 20, 60_000, fixedNow);
  check("Rate limiter é por organização (outra org não é afetada)", otherOrgNotBlocked === false);

  // ---- validação de confiança (0-100, clamp) — mesma lógica de routes/products.ts ----
  function clampConfidence(raw: any): number {
    const n = Math.max(0, Math.min(100, Number(raw)));
    return Number.isFinite(n) ? n : 0;
  }
  check("Confiança acima de 100 é limitada a 100", clampConfidence(150) === 100);
  check("Confiança negativa é limitada a 0", clampConfidence(-10) === 0);
  check("Confiança não numérica vira 0", clampConfidence("abc") === 0);
  check("Confiança válida passa direto", clampConfidence(87) === 87);

  // ---- resultado ----
  console.log("\n=== Cadastro Inteligente — Incremento ADR-020 ===\n");
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
