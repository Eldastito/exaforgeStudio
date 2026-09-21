/**
 * FISCAL INBOUND — API da Entrada Automática de NF-e (ADR-200). Montada em
 * /api/fiscal/inbound. Expõe o que a UI de conferência consome: listar/abrir
 * documentos fiscais, criar o recebimento esperado, conferir (received/mapear)
 * e confirmar. Tudo por trás do flag `fiscal_inbound_enabled` da org.
 *
 * Não implementa captura por provedor (Fase 3): os documentos chegam pelo
 * upload manual de XML, que já converge no pipeline fiscal quando o flag está
 * ligado (routes/products.ts).
 */
import { Router } from "express";
import db from "../db.js";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { FiscalInboundFlagService } from "../FiscalInboundFlagService.js";
import { FiscalDocumentService } from "../FiscalDocumentService.js";
import { FiscalReceivingService } from "../FiscalReceivingService.js";

const router = Router();
const actor = (req: any) => req.user?.userId || req.user?.id;
function fail(res: any, e: any) { res.status(400).json({ error: e?.message || "erro" }); }

// Gate por org: enquanto o flag estiver desligado, a feature responde 404
// (não existe pro tenant). Owner/admin/manager podem operar a conferência.
router.use((req: AuthRequest, res, next): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "unauthorized" });
  if (!FiscalInboundFlagService.isEnabled(orgId)) return res.status(404).json({ error: "fiscal_inbound_disabled" });
  next();
});

/** Lojas ativas da org (para o filtro da tela). */
router.get("/stores", requireRole("owner", "admin", "manager"), (req: AuthRequest, res): any => {
  try {
    const stores = db.prepare(
      `SELECT id, name, cnpj FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`
    ).all(req.organizationId!);
    res.json({ stores });
  } catch (e: any) { fail(res, e); }
});

/** Lista documentos fiscais de entrada da org (sem itens), com filtros opcionais. */
router.get("/documents", requireRole("owner", "admin", "manager"), (req: AuthRequest, res): any => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const storeId = typeof req.query.storeId === "string" ? req.query.storeId : null;
    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to = typeof req.query.to === "string" ? req.query.to : null;
    res.json({ documents: FiscalDocumentService.list(req.organizationId!, { storeId, from, to, limit }) });
  } catch (e: any) { fail(res, e); }
});

/** Documento fiscal + itens. */
router.get("/documents/:id", requireRole("owner", "admin", "manager"), (req: AuthRequest, res): any => {
  try {
    const doc = FiscalDocumentService.get(req.organizationId!, String(req.params.id));
    if (!doc) return res.status(404).json({ error: "not_found" });
    res.json({ document: doc });
  } catch (e: any) { fail(res, e); }
});

/** Cria o recebimento esperado a partir do documento (não movimenta estoque). */
router.post("/documents/:id/create-receipt", requireRole("owner", "admin", "manager"), (req: AuthRequest, res): any => {
  try {
    const r = FiscalReceivingService.createExpectedFromDocument(req.organizationId!, String(req.params.id), actor(req));
    if (r.status === "blocked") return res.status(409).json(r);
    res.json(r);
  } catch (e: any) { fail(res, e); }
});

/** Recebimento fiscal (cabeçalho + itens + divergência). */
router.get("/receipts/:id", requireRole("owner", "admin", "manager"), (req: AuthRequest, res): any => {
  try {
    const rec = FiscalReceivingService.getReceipt(req.organizationId!, String(req.params.id));
    if (!rec) return res.status(404).json({ error: "not_found" });
    res.json({ receipt: rec });
  } catch (e: any) { fail(res, e); }
});

/** Registra a quantidade conferida (decimal) + avaria de um item. */
router.post("/receipts/:id/items/:itemId/received", requireRole("owner", "admin", "manager"), (req: AuthRequest, res): any => {
  try {
    const { receivedQty, damageQty, divergenceReason } = req.body || {};
    const r = FiscalReceivingService.setReceived(req.organizationId!, String(req.params.id), String(req.params.itemId), Number(receivedQty), { damageQty: Number(damageQty) || 0, divergenceReason });
    if (!r.ok) return res.status(409).json(r);
    res.json({ ok: true, receipt: FiscalReceivingService.getReceipt(req.organizationId!, String(req.params.id)) });
  } catch (e: any) { fail(res, e); }
});

/** Associa manualmente um item a produto/variante (memoriza fornecedor+cProd). */
router.post("/receipts/:id/items/:itemId/map", requireRole("owner", "admin", "manager"), (req: AuthRequest, res): any => {
  try {
    const { productServiceId, variantId } = req.body || {};
    if (!productServiceId) return res.status(400).json({ error: "productServiceId obrigatório" });
    const r = FiscalReceivingService.mapReceiptItem(req.organizationId!, String(req.params.id), String(req.params.itemId), String(productServiceId), variantId || null, actor(req));
    if (!r.ok) return res.status(409).json(r);
    res.json({ ok: true, receipt: FiscalReceivingService.getReceipt(req.organizationId!, String(req.params.id)) });
  } catch (e: any) { fail(res, e); }
});

/** Confirma o recebimento: credita só o recebido no ledger autoritativo. */
router.post("/receipts/:id/confirm", requireRole("owner", "admin", "manager"), (req: AuthRequest, res): any => {
  try {
    const r = FiscalReceivingService.confirm(req.organizationId!, String(req.params.id), actor(req));
    if (r.status === "blocked") return res.status(409).json(r);
    res.json({ ...r, receipt: FiscalReceivingService.getReceipt(req.organizationId!, String(req.params.id)) });
  } catch (e: any) { fail(res, e); }
});

export default router;
