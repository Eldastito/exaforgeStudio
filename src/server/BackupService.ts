import db from "./db.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { GoogleOAuthService } from "./GoogleOAuthService.js";
import { StorageService } from "./StorageService.js";

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

  /**
   * Gera um backup, registra em backup_jobs, envia ao Drive do dono (opcional) e
   * espelha no S3 (redundância). Usado pelo Scheduler — tanto para o backup
   * programado do cliente (type='auto', toDrive) quanto para a redundância da
   * plataforma (type='platform', só S3). ADR-097.
   */
  static async runAndDistribute(orgId: string, type: string, opts: { toDrive?: boolean } = {}): Promise<{ jobId: string; fileName: string } | null> {
    const jobId = uuidv4();
    try {
      db.prepare(`INSERT INTO backup_jobs (id, organization_id, type, status) VALUES (?, ?, ?, 'pending')`).run(jobId, orgId, type);
      const result = this.run(orgId, jobId, type);
      db.prepare(`UPDATE backup_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP, file_url = ? WHERE id = ?`).run(result.fileName, jobId);

      // Envio ao Drive do dono (opt-in) — guarda o id p/ a retenção expurgar depois.
      if (opts.toDrive) {
        try {
          if (GoogleOAuthService.getConnection(orgId)) {
            const full = this.resolveFile(orgId, result.fileName);
            if (full) {
              const up = await GoogleOAuthService.driveUpload(orgId, result.fileName, "application/json", fs.readFileSync(full));
              if (up && "id" in up) db.prepare(`UPDATE backup_jobs SET drive_file_id = ? WHERE id = ?`).run(up.id, jobId);
            }
          }
        } catch (e) { console.error("[Backup] envio ao Drive falhou", orgId, e); }
      }

      // Espelho no S3 (redundância na infra do operador). Best-effort.
      try {
        const full = this.resolveFile(orgId, result.fileName);
        if (full) await StorageService.mirrorToS3(full, `backups/${result.fileName}`);
      } catch (e) { /* noop */ }

      return { jobId, fileName: result.fileName };
    } catch (e) {
      console.error("[Backup] runAndDistribute falhou", orgId, e);
      try { db.prepare(`UPDATE backup_jobs SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(jobId); } catch { /* noop */ }
      return null;
    }
  }

  /**
   * Restaura um backup de volta ao banco (ADR-097). Multi-tenant seguro:
   *  - só aceita snapshot da PRÓPRIA org (valida organization_id);
   *  - mexe SÓ nas tabelas do tenant (nunca users/plans/outras orgs);
   *  - nunca grava uma linha cujo organization_id não seja o da org;
   *  - **backup-guard**: gera um backup de segurança do estado atual ANTES de
   *    sobrescrever (se o guard falhar, aborta sem tocar em nada);
   *  - tudo numa transação (atômico).
   */
  static restore(orgId: string, fileName: string): { ok: boolean; error?: string; guardFileName?: string; restored?: Record<string, number> } {
    const full = this.resolveFile(orgId, fileName);
    if (!full) return { ok: false, error: 'arquivo_nao_encontrado' };

    let snapshot: any;
    try { snapshot = JSON.parse(fs.readFileSync(full, 'utf-8')); }
    catch { return { ok: false, error: 'arquivo_invalido' }; }
    if (!snapshot || snapshot.organization_id !== orgId || typeof snapshot.tables !== 'object') {
      return { ok: false, error: 'snapshot_de_outra_org' };
    }

    // Backup-guard: salva o estado atual antes de sobrescrever. Sem rede de
    // segurança, não restaura.
    let guardFileName: string | undefined;
    try {
      const guardJobId = uuidv4();
      db.prepare(`INSERT INTO backup_jobs (id, organization_id, type, status) VALUES (?, ?, 'pre-restore', 'pending')`).run(guardJobId, orgId);
      const g = this.run(orgId, guardJobId, 'pre-restore');
      db.prepare(`UPDATE backup_jobs SET status='completed', completed_at=CURRENT_TIMESTAMP, file_url=? WHERE id=?`).run(g.fileName, guardJobId);
      guardFileName = g.fileName;
    } catch (e) {
      console.error('[Backup] backup-guard falhou; restauração abortada', orgId, e);
      return { ok: false, error: 'falha_no_backup_guard' };
    }

    const restored: Record<string, number> = {};
    const apply = db.transaction(() => {
      for (const table of TENANT_TABLES) {
        const rows = snapshot.tables[table];
        if (!Array.isArray(rows)) continue;
        // Colunas reais da tabela hoje — tolera drift de schema (ignora colunas
        // que sumiram; não exige colunas novas).
        let cols: Set<string>;
        try {
          const info = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
          cols = new Set(info.map((c: any) => c.name));
        } catch { continue; }
        if (!cols.has('organization_id')) continue;

        // Substitui o estado atual DESTA org (não mescla).
        db.prepare(`DELETE FROM ${table} WHERE organization_id = ?`).run(orgId);
        let n = 0;
        for (const row of rows) {
          if (!row || row.organization_id !== orgId) continue; // nunca escreve linha de outra org
          const keys = Object.keys(row).filter(k => cols.has(k));
          if (!keys.length) continue;
          db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
            .run(...keys.map(k => row[k]));
          n++;
        }
        restored[table] = n;
      }
    });

    try { apply(); }
    catch (e) {
      console.error('[Backup] restauração falhou (o backup-guard preserva o estado anterior)', orgId, e);
      return { ok: false, error: 'falha_na_restauracao', guardFileName };
    }
    return { ok: true, guardFileName, restored };
  }

  /**
   * Retenção: mantém os `keep` backups completos mais recentes (por org e tipo) e
   * expurga os antigos do DISCO, do DRIVE do dono (se enviado) e da tabela.
   * Retorna quantos foram removidos.
   */
  static async applyRetention(orgId: string, keep: number, type: string): Promise<number> {
    const k = Math.max(1, Math.floor(Number(keep)) || 1);
    const old = db.prepare(
      `SELECT id, file_url, drive_file_id FROM backup_jobs
        WHERE organization_id = ? AND type = ? AND status = 'completed'
        ORDER BY created_at DESC LIMIT -1 OFFSET ?`
    ).all(orgId, type, k) as any[];
    let removed = 0;
    for (const o of old) {
      try { if (o.file_url) this.deleteFile(orgId, o.file_url); } catch { /* noop */ }
      if (o.drive_file_id) { try { await GoogleOAuthService.driveDelete(orgId, o.drive_file_id); } catch { /* noop */ } }
      try { db.prepare(`DELETE FROM backup_jobs WHERE id = ?`).run(o.id); removed++; } catch { /* noop */ }
    }
    return removed;
  }
}
