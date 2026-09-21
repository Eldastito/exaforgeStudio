/**
 * FiscalDocumentService — persistência idempotente do documento fiscal de
 * entrada (ADR-200, Fase 1, PR 2).
 *
 * Recebe a saída determinística de `parseNFeDocument` e grava/enriquece UM
 * registro por (organization_id, access_key). Invariantes:
 *   - dedupe multiorigem: upload manual, provedor e consulta por chave caem no
 *     MESMO registro; reprocessar o mesmo XML é no-op (idempotente);
 *   - só ENRIQUECE quando chega uma versão mais completa (resumo → XML
 *     completo); nunca rebaixa um documento já completo por um resumo posterior;
 *   - NÃO movimenta estoque (isso é do recebimento, ADR-086) e NÃO resolve loja
 *     (Fase 2). Isolado por organization_id.
 *
 * Eventos (procEventoNFe) e schema inválido são ignorados aqui — a ingestão de
 * cancelamento vem na Fase 3.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import type { ParsedNFeDocument, NFeContentLevel } from "./nfeParser.js";
import { FiscalStoreResolverService } from "./FiscalStoreResolverService.js";

// Quanto MAIOR o rank, mais completo o documento. Só sobe, nunca desce.
const CONTENT_RANK: Record<NFeContentLevel, number> = {
  invalid: 0,
  event_only: 0,
  summary_only: 1,
  signed_only: 2,
  authorized_process: 3,
};

// Níveis que geram/atualizam um documento persistido nesta fase.
const PERSISTABLE: NFeContentLevel[] = ["summary_only", "signed_only", "authorized_process"];

/**
 * Loja + estado de processamento a partir do parse (ADR-200 Fase 2).
 * Só `authorized_process` tenta resolver loja: sem loja determinística o
 * documento fica `store_assignment_required` (nenhum estoque sai sem loja).
 * `summary_only` (resNFe) não tem destinatário → aguarda o XML completo.
 */
function storeContext(orgId: string, p: ParsedNFeDocument): { storeId: string | null; processingState: string } {
  if (p.contentLevel === "summary_only") return { storeId: null, processingState: "awaiting_full_xml" };
  if (p.contentLevel === "signed_only") return { storeId: null, processingState: "parsing" };
  // authorized_process
  const res = FiscalStoreResolverService.resolve(orgId, p.recipientCnpj);
  if (res.status === "resolved") return { storeId: res.storeId, processingState: "ready_for_receipt" };
  return { storeId: null, processingState: "store_assignment_required" };
}

export interface PersistOptions {
  source: "manual_upload" | "provider";
  connectionId?: string | null;
  invoiceScanDraftId?: string | null;
}

export interface PersistResult {
  status: "created" | "enriched" | "unchanged" | "skipped";
  documentId: string | null;
  reason?: string;
}

export class FiscalDocumentService {
  /**
   * Grava ou enriquece o documento fiscal a partir do parse. Idempotente por
   * (org, access_key). Retorna o efeito para auditoria/UX.
   */
  static persist(orgId: string, parsed: ParsedNFeDocument, opts: PersistOptions): PersistResult {
    if (!PERSISTABLE.includes(parsed.contentLevel)) {
      return { status: "skipped", documentId: null, reason: `content_level ${parsed.contentLevel}` };
    }
    if (!parsed.accessKey) {
      // Sem chave não há como deduplicar — não persiste documento fiscal nesta fase.
      return { status: "skipped", documentId: null, reason: "sem access_key" };
    }

    const existing = db.prepare(
      `SELECT id, content_level FROM fiscal_documents WHERE organization_id = ? AND access_key = ?`
    ).get(orgId, parsed.accessKey) as any;

    if (existing) {
      const oldRank = CONTENT_RANK[existing.content_level as NFeContentLevel] ?? 0;
      const newRank = CONTENT_RANK[parsed.contentLevel];
      if (newRank <= oldRank) {
        return { status: "unchanged", documentId: existing.id, reason: "versão não é mais completa" };
      }
      this.writeDocument(orgId, existing.id, parsed, opts, storeContext(orgId, parsed));
      this.replaceItems(orgId, existing.id, parsed);
      return { status: "enriched", documentId: existing.id };
    }

    const id = randomUUID();
    this.insertDocument(orgId, id, parsed, opts, storeContext(orgId, parsed));
    this.replaceItems(orgId, id, parsed);
    return { status: "created", documentId: id };
  }

  private static insertDocument(orgId: string, id: string, p: ParsedNFeDocument, opts: PersistOptions, ctx: { storeId: string | null; processingState: string }): void {
    db.prepare(
      `INSERT INTO fiscal_documents (
         id, organization_id, connection_id, store_id, document_type, access_key, model, number, series, issue_at,
         issuer_cnpj, issuer_name, recipient_cnpj, recipient_name,
         total_products, total_invoice, freight, discount, other_expenses,
         fiscal_status, content_level, protocol_number, protocol_status, authorization_at,
         source, processing_state, invoice_scan_draft_id
       ) VALUES (?, ?, ?, ?, 'nfe', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, orgId, opts.connectionId || null, ctx.storeId, p.accessKey, p.model, p.number, p.series, p.issueAt,
      p.issuerCnpj, p.issuerName, p.recipientCnpj, p.recipientName,
      p.totalProducts, p.totalInvoice, p.freight, p.discount, p.otherExpenses,
      p.fiscalStatus, p.contentLevel, p.protocolNumber, p.protocolStatus, p.authorizationAt,
      opts.source, ctx.processingState, opts.invoiceScanDraftId || null
    );
  }

  private static writeDocument(orgId: string, id: string, p: ParsedNFeDocument, opts: PersistOptions, ctx: { storeId: string | null; processingState: string }): void {
    // store_id via COALESCE: uma loja já atribuída (auto ou manual) não é
    // apagada por uma reavaliação que não conseguiu resolver.
    db.prepare(
      `UPDATE fiscal_documents SET
         model = ?, number = ?, series = ?, issue_at = ?,
         issuer_cnpj = ?, issuer_name = ?, recipient_cnpj = ?, recipient_name = ?,
         total_products = ?, total_invoice = ?, freight = ?, discount = ?, other_expenses = ?,
         fiscal_status = ?, content_level = ?, protocol_number = ?, protocol_status = ?, authorization_at = ?,
         store_id = COALESCE(?, store_id), processing_state = ?, connection_id = COALESCE(?, connection_id),
         invoice_scan_draft_id = COALESCE(?, invoice_scan_draft_id),
         updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = ? AND id = ?`
    ).run(
      p.model, p.number, p.series, p.issueAt,
      p.issuerCnpj, p.issuerName, p.recipientCnpj, p.recipientName,
      p.totalProducts, p.totalInvoice, p.freight, p.discount, p.otherExpenses,
      p.fiscalStatus, p.contentLevel, p.protocolNumber, p.protocolStatus, p.authorizationAt,
      ctx.storeId, ctx.processingState, opts.connectionId || null,
      opts.invoiceScanDraftId || null, orgId, id
    );
  }

  private static replaceItems(orgId: string, documentId: string, p: ParsedNFeDocument): void {
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM fiscal_document_items WHERE fiscal_document_id = ?`).run(documentId);
      const stmt = db.prepare(
        `INSERT INTO fiscal_document_items (
           id, organization_id, fiscal_document_id, item_number, supplier_product_code, fiscal_description,
           ean, ean_tax, ncm, cfop, commercial_unit, commercial_qty, commercial_unit_value,
           tax_unit, tax_qty, tax_unit_value, gross_value, discount_value, freight_value, other_value,
           insurance_value, tax_json, traceability_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const it of p.items) {
        stmt.run(
          randomUUID(), orgId, documentId, it.itemNumber, it.supplierProductCode, it.fiscalDescription,
          it.ean, it.eanTax, it.ncm, it.cfop, it.commercialUnit, it.commercialQty, it.commercialUnitValue,
          it.taxUnit, it.taxQty, it.taxUnitValue, it.grossValue, it.discountValue, it.freightValue, it.otherValue,
          it.insuranceValue, it.taxJson, it.traceabilityJson
        );
      }
    });
    tx();
  }

  /** Documento (com itens) por chave de acesso, ou null. */
  static getByAccessKey(orgId: string, accessKey: string): any | null {
    const doc = db.prepare(`SELECT * FROM fiscal_documents WHERE organization_id = ? AND access_key = ?`).get(orgId, accessKey) as any;
    if (!doc) return null;
    doc.items = db.prepare(`SELECT * FROM fiscal_document_items WHERE fiscal_document_id = ? ORDER BY item_number`).all(doc.id);
    return doc;
  }

  /** Documento (com itens) por id, ou null. */
  static get(orgId: string, id: string): any | null {
    const doc = db.prepare(`SELECT * FROM fiscal_documents WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!doc) return null;
    doc.items = db.prepare(`SELECT * FROM fiscal_document_items WHERE fiscal_document_id = ? ORDER BY item_number`).all(doc.id);
    return doc;
  }

  /**
   * Lista documentos da org (sem itens), mais recentes primeiro, com filtros
   * opcionais de loja e período (por data de emissão). `from`/`to` são datas
   * `YYYY-MM-DD` comparadas contra a porção de data de `issue_at`, ambas inclusivas.
   */
  static list(orgId: string, opts: { storeId?: string | null; from?: string | null; to?: string | null; limit?: number } = {}): any[] {
    const where = ["organization_id = ?"];
    const params: any[] = [orgId];
    if (opts.storeId) { where.push("store_id = ?"); params.push(opts.storeId); }
    if (opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)) { where.push("substr(issue_at, 1, 10) >= ?"); params.push(opts.from); }
    if (opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)) { where.push("substr(issue_at, 1, 10) <= ?"); params.push(opts.to); } // dia inclusivo
    const limit = Math.max(1, Math.min(500, opts.limit || 100));
    params.push(limit);
    return db.prepare(
      `SELECT * FROM fiscal_documents WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`
    ).all(...params) as any[];
  }
}

export default FiscalDocumentService;
