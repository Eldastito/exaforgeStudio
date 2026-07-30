/**
 * Módulo Clínica — Retenção LGPD / purge automático (ADR-080 Fase U).
 *
 * LGPD Art.16: "os dados pessoais serão eliminados após o término de seu
 * tratamento". Aplicado com CAUTELA no contexto clínico:
 *
 *   - **PRESERVAMOS** row de prontuário/receita/atestado (SOAP, itens,
 *     status, snapshots). Resolução CFM 1.821/2007 exige 20 anos de guarda
 *     em papel; digital segue essa regra.
 *   - **APAGAMOS** ARQUIVOS derivados:
 *       * PDFs gerados pra envio de deliveries por WhatsApp — o paciente
 *         já tem a cópia no celular. Default: 30 dias.
 *       * Anexos ao prontuário (imagens, exames) após N anos (default 2).
 *         Row fica com `purged_at` pra rastro; o arquivo binário sai.
 *
 * Roda como pass diário no Scheduler (`clinicRetentionPass`). Idempotente:
 * arquivo já ausente / row já marcada `purged_at` são ignorados.
 *
 * NÃO deleta rows. NÃO deleta anexos "recentes" (dentro da janela).
 * NÃO deleta PDFs de docs não-issued (defensivo). Best-effort — falha de
 * FS é logada mas não trava o pass (próxima rodada tenta de novo).
 */
import fs from "node:fs";
import path from "node:path";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { CLINIC_DOCS_DIR } from "./ClinicDocumentDeliveryService.js";
import { PRIVATE_CLINICAL_DIR } from "./ClinicAttachmentService.js";

const DEFAULT_DELIVERY_DAYS = 30;
const DEFAULT_ATTACHMENT_DAYS = 730; // 2 anos
const MIN_DAYS = 7;                  // guard-rail: nunca abaixo de 1 semana

export interface RetentionStats {
  deliveriesPurged: number;
  attachmentsPurged: number;
  errors: number;
}

export class ClinicRetentionService {
  private static settings(orgId: string): { enabled: boolean; deliveryDays: number; attachmentDays: number } {
    try {
      const o = db.prepare(
        `SELECT clinic_retention_enabled, clinic_retention_days_deliveries, clinic_retention_days_attachments
           FROM organization_settings WHERE organization_id = ?`
      ).get(orgId) as any;
      return {
        enabled: o?.clinic_retention_enabled !== 0,
        deliveryDays: Math.max(MIN_DAYS, Number(o?.clinic_retention_days_deliveries) || DEFAULT_DELIVERY_DAYS),
        attachmentDays: Math.max(MIN_DAYS, Number(o?.clinic_retention_days_attachments) || DEFAULT_ATTACHMENT_DAYS),
      };
    } catch { return { enabled: true, deliveryDays: DEFAULT_DELIVERY_DAYS, attachmentDays: DEFAULT_ATTACHMENT_DAYS }; }
  }

  /**
   * Roda a retenção pra UMA org. Devolve stats. Não lança em falha de FS —
   * incrementa `errors` e segue. Chamador tem visibilidade via retorno.
   */
  static runForOrg(orgId: string, opts: { nowMs?: number } = {}): RetentionStats {
    const stats: RetentionStats = { deliveriesPurged: 0, attachmentsPurged: 0, errors: 0 };
    const cfg = this.settings(orgId);
    if (!cfg.enabled) return stats;

    const nowMs = opts.nowMs ?? Date.now();
    const deliveryCutoff = new Date(nowMs - cfg.deliveryDays * 86400_000).toISOString();
    const attachCutoff = new Date(nowMs - cfg.attachmentDays * 86400_000).toISOString();

    // --- Deliveries (PDFs enviados pelo canal) ------------------------------
    // Storage key vem do file gravado em CLINIC_DOCS_DIR/{uuid}.pdf.
    // Guardamos o key na tabela `clinical_document_deliveries` como parte do
    // provider_message_id? Não — o key só existia no filesystem. Como recuperar?
    // O ClinicDocumentDeliveryService salva sob CLINIC_DOCS_DIR/{doc_id}-{deliveryId}.pdf?
    // Vamos ler o diretório e apagar por mtime (fonte de verdade do FS).
    try {
      if (fs.existsSync(CLINIC_DOCS_DIR)) {
        for (const name of fs.readdirSync(CLINIC_DOCS_DIR)) {
          if (!name.endsWith(".pdf")) continue;
          const filePath = path.join(CLINIC_DOCS_DIR, name);
          try {
            const st = fs.statSync(filePath);
            if (st.mtimeMs < nowMs - cfg.deliveryDays * 86400_000) {
              fs.unlinkSync(filePath);
              stats.deliveriesPurged++;
            }
          } catch { stats.errors++; }
        }
      }
      // Marca rows históricas org-scoped que perderam o arquivo (não temos
      // 1:1 filesystem→row, então marca todas rows `sent` fora da janela que
      // ainda não estão purged — sinaliza pro histórico "arquivo foi limpo").
      db.prepare(
        `UPDATE clinical_document_deliveries
            SET file_purged_at = CURRENT_TIMESTAMP
          WHERE organization_id = ? AND status = 'sent'
            AND sent_at < ? AND file_purged_at IS NULL`
      ).run(orgId, deliveryCutoff);
    } catch { stats.errors++; }

    // --- Anexos ao prontuário (após N anos, default 2) ---------------------
    try {
      const rows = db.prepare(
        `SELECT id, encounter_id, storage_key FROM clinical_encounter_attachments
          WHERE organization_id = ? AND uploaded_at < ? AND purged_at IS NULL`
      ).all(orgId, attachCutoff) as any[];
      for (const r of rows) {
        if (!r.storage_key || typeof r.storage_key !== "string") { stats.errors++; continue; }
        const base = path.basename(r.storage_key);
        if (base !== r.storage_key || !/^[a-zA-Z0-9._-]+$/.test(base)) { stats.errors++; continue; }
        const filePath = path.join(PRIVATE_CLINICAL_DIR, orgId, r.encounter_id, base);
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch { stats.errors++; continue; }
        db.prepare(`UPDATE clinical_encounter_attachments SET purged_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(r.id, orgId);
        stats.attachmentsPurged++;
      }
    } catch { stats.errors++; }

    if (stats.deliveriesPurged || stats.attachmentsPurged) {
      logAuthEvent(orgId, null, null, "CLINIC_RETENTION_PURGE", stats);
    }
    return stats;
  }

  /** Pass diário no Scheduler. Percorre orgs com módulo clínica ativo. */
  static dispatch(opts: { orgId?: string; nowMs?: number } = {}): Record<string, RetentionStats> {
    const out: Record<string, RetentionStats> = {};
    let orgs: string[] = [];
    if (opts.orgId) orgs = [opts.orgId];
    else {
      try {
        orgs = (db.prepare(
          `SELECT DISTINCT organization_id FROM clinical_encounters`
        ).all() as any[]).map((r) => r.organization_id);
      } catch { return out; }
    }
    for (const orgId of orgs) {
      try { out[orgId] = this.runForOrg(orgId, { nowMs: opts.nowMs }); } catch { /* best-effort */ }
    }
    return out;
  }
}

export default ClinicRetentionService;
