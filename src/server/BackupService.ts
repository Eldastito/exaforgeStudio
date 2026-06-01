import db from "./db.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * Backup real do banco — gera um JSON com snapshot dos dados da organização
 * e salva no disco (volume persistente do Coolify em /data/backups por padrão).
 *
 * Multi-tenant: cada backup contém apenas os dados da organização que solicitou.
 * Download é autorizado pela rota — o arquivo não é exposto publicamente.
 */

const BACKUPS_DIR = process.env.BACKUPS_DIR ||
  path.join(process.env.DATA_DIR || process.cwd(), 'backups');

// Tabelas que pertencem a uma organização (com coluna organization_id).
// Não inclui `plans` (global) nem `users` (que mantemos fora para evitar vazar hashes).
const TENANT_TABLES = [
  'organization_settings',
  'channels',
  'contacts',
  'tickets',
  'ticket_summaries',
  'ticket_closures',
  'ticket_stage_logs',
  'messages',
  'knowledge_documents',
  'knowledge_chunks',
  'ai_interactions_log',
  'authorized_managers',
  'products_services',
  'inventory_items',
  'product_variants',
  'stock_movements',
  'appointments',
  'deliveries',
  'integrations',
  'oauth_connections',
  'webhook_endpoints',
  'orders',
  'order_items',
  'campaigns',
  'campaign_recipients',
  'notifications',
  'cadences',
  'cadence_steps',
];

export class BackupService {
  private static ensureDir() {
    try { fs.mkdirSync(BACKUPS_DIR, { recursive: true }); } catch (e) { /* noop */ }
  }

  /** Gera um snapshot JSON da organização e salva no disco. */
  static run(orgId: string, jobId: string, type: string = 'manual'): { fileName: string; sizeBytes: number; recordCount: number } {
    this.ensureDir();
    const snapshot: Record<string, any> = {
      version: 1,
      organization_id: orgId,
      type,
      generated_at: new Date().toISOString(),
      tables: {} as Record<string, any[]>,
    };

    let total = 0;
    for (const table of TENANT_TABLES) {
      try {
        const rows = db.prepare(`SELECT * FROM ${table} WHERE organization_id = ?`).all(orgId);
        snapshot.tables[table] = rows;
        total += (rows as any[]).length;
      } catch (e) {
        // Tabela inexistente nesta DB → ignora.
        snapshot.tables[table] = [];
      }
    }

    const safeOrg = String(orgId).replace(/[^a-zA-Z0-9_-]/g, '');
    const fileName = `${safeOrg}-${jobId}.json`;
    const filePath = path.join(BACKUPS_DIR, fileName);
    const content = JSON.stringify(snapshot, null, 2);
    fs.writeFileSync(filePath, content, 'utf-8');
    const stat = fs.statSync(filePath);
    return { fileName, sizeBytes: stat.size, recordCount: total };
  }

  /** Caminho absoluto + validação de pertinência da org (anti path-traversal). */
  static resolveFile(orgId: string, fileName: string): string | null {
    if (!fileName || /[\\/]/.test(fileName) || fileName.includes('..')) return null;
    const safeOrg = String(orgId).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!fileName.startsWith(safeOrg + '-')) return null;
    const fullPath = path.join(BACKUPS_DIR, fileName);
    if (!fs.existsSync(fullPath)) return null;
    return fullPath;
  }

  /** Remove um backup do disco (idempotente). */
  static deleteFile(orgId: string, fileName: string): boolean {
    const fullPath = this.resolveFile(orgId, fileName);
    if (!fullPath) return false;
    try { fs.unlinkSync(fullPath); return true; } catch (e) { return false; }
  }

  /** SHA-256 do arquivo (útil para verificação de integridade). */
  static checksum(fullPath: string): string {
    const buf = fs.readFileSync(fullPath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  }
}
