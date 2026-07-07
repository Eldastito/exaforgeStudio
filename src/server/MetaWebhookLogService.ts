import { randomUUID } from "node:crypto";
import db from "./db.js";

/**
 * Console de diagnóstico: registra TODO hit que bate em /api/webhooks/meta
 * ANTES da validação/parse. Sem isto, um webhook que a Meta mandou mas foi
 * rejeitado silenciosamente (payload mal formado, header errado, etc.) some
 * — o lojista nunca sabe se a Meta enviou ou não.
 *
 * Best-effort: nunca lança para o chamador. Faz sanitize dos cabeçalhos (só
 * os que interessam) e limita o payload a 10KB para não estourar disco.
 * Faz auto-purga: mantém no máximo os últimos 500 hits ou 48h — o que vier
 * primeiro. Suficiente para diagnóstico ao vivo, não vira lixo eterno.
 */

const MAX_PAYLOAD_BYTES = 10 * 1024;
const MAX_ROWS = 500;
const RETENTION_HOURS = 48;

const KEEP_HEADERS = new Set([
  "content-type", "content-length", "user-agent",
  "x-forwarded-for", "x-real-ip",
  "x-hub-signature", "x-hub-signature-256",
]);

function sanitizeHeaders(raw: any): string {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(raw)) {
      if (KEEP_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = String(raw[k]).slice(0, 300);
    }
  }
  return JSON.stringify(out);
}

function truncatePayload(payload: any): string {
  try {
    const s = typeof payload === "string" ? payload : JSON.stringify(payload);
    return s.length > MAX_PAYLOAD_BYTES ? s.slice(0, MAX_PAYLOAD_BYTES) + "...[truncated]" : s;
  } catch { return "[unserializable payload]"; }
}

let lastPurgeAt = 0;

export const MetaWebhookLogService = {
  record(input: {
    method: string;
    sourceIp?: string | null;
    userAgent?: string | null;
    object?: string | null;
    payload: any;
    headers?: any;
    processed?: boolean;
    error?: string | null;
  }): string | null {
    try {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO meta_webhook_hits (id, method, source_ip, user_agent, object, payload_json, headers_json, processed, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, input.method,
        (input.sourceIp || "").slice(0, 80) || null,
        (input.userAgent || "").slice(0, 300) || null,
        input.object || null,
        truncatePayload(input.payload),
        sanitizeHeaders(input.headers || {}),
        input.processed ? 1 : 0,
        input.error ? String(input.error).slice(0, 500) : null,
      );
      // Auto-purge a cada ~5 min: retém 500 mais recentes / últimas 48h.
      const now = Date.now();
      if (now - lastPurgeAt > 5 * 60 * 1000) {
        lastPurgeAt = now;
        try {
          db.exec(`DELETE FROM meta_webhook_hits WHERE received_at < datetime('now', '-${RETENTION_HOURS} hours')`);
          db.exec(`
            DELETE FROM meta_webhook_hits WHERE id IN (
              SELECT id FROM meta_webhook_hits ORDER BY received_at DESC LIMIT -1 OFFSET ${MAX_ROWS}
            )
          `);
        } catch { /* noop */ }
      }
      return id;
    } catch (e) {
      console.error("[MetaWebhookLog] falha ao gravar hit:", e);
      return null;
    }
  },

  /** Marca um hit como processado com sucesso (chamado depois da lógica principal). */
  markProcessed(id: string) {
    try { db.prepare(`UPDATE meta_webhook_hits SET processed = 1 WHERE id = ?`).run(id); } catch { /* noop */ }
  },

  /** Marca um hit como falhado, com o erro. */
  markFailed(id: string, error: string) {
    try { db.prepare(`UPDATE meta_webhook_hits SET processed = 0, error = ? WHERE id = ?`).run(String(error).slice(0, 500), id); } catch { /* noop */ }
  },

  list(limit = 50): any[] {
    const n = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
    return db.prepare(
      `SELECT id, received_at, method, source_ip, user_agent, object, payload_json, headers_json, processed, error
       FROM meta_webhook_hits ORDER BY received_at DESC LIMIT ${n}`
    ).all() as any[];
  },

  /** Resumo agregado (últimas 24h) para o painel: quantos GET, POST, por object. */
  summary(): { last24h: number; byObject: Record<string, number>; byMethod: Record<string, number>; lastAt: string | null } {
    const rows = db.prepare(
      `SELECT method, object FROM meta_webhook_hits WHERE received_at >= datetime('now', '-24 hours')`
    ).all() as any[];
    const byObject: Record<string, number> = {};
    const byMethod: Record<string, number> = {};
    for (const r of rows) {
      byObject[r.object || "-"] = (byObject[r.object || "-"] || 0) + 1;
      byMethod[r.method || "-"] = (byMethod[r.method || "-"] || 0) + 1;
    }
    const last = db.prepare(`SELECT received_at FROM meta_webhook_hits ORDER BY received_at DESC LIMIT 1`).get() as any;
    return { last24h: rows.length, byObject, byMethod, lastAt: last?.received_at || null };
  },
};
