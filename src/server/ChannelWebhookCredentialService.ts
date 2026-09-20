/**
 * ChannelWebhookCredentialService — credencial de webhook POR CANAL + saúde
 * POR CANAL (F6 do PRD Conexão WhatsApp, 20/09/2026).
 *
 * Antes o segredo do webhook era GLOBAL (`webhook_secret` no app_config): um
 * segredo vazado abria TODOS os canais, e o "último hit" global fazia um canal
 * saudável mascarar outro quebrado. Aqui cada canal Evolution ganha uma
 * credencial OPACA própria (`whc_<hex>`):
 *
 *  - `webhook_secret_enc` (AES-GCM): o CLARO é necessário pra re-embutir a URL
 *    no provedor a cada re-registro (sync/reconciliação re-registram o webhook
 *    — só hash quebraria o re-registro). Desvio consciente do "só hash" do PRD.
 *  - `webhook_secret_hash` (SHA-256): lookup na validação do inbound — o
 *    segredo recebido é hasheado e buscado por índice; o hash encontrado ainda
 *    é comparado com timingSafeEqual.
 *  - Rotação com JANELA: o hash anterior segue válido por ROTATION_WINDOW_MS
 *    (sem downtime enquanto o provedor ainda chama com a URL velha); depois,
 *    só o novo.
 *  - Saúde POR CANAL: last_received/last_valid/last_error — hit rejeitado num
 *    canal não contamina o estado de outro. Ausência de hit ≠ falha (webhook
 *    só dispara com tráfego).
 *
 * O segredo GLOBAL continua aceito (canais legados registrados com a URL
 * antiga) — 0-regressão; a credencial por canal entra no registro/re-registro.
 * Isolado por org nas mutações; a VALIDAÇÃO do inbound é por hash global
 * (o webhook não é autenticado por sessão — a credencial É a identidade).
 */
import crypto from "node:crypto";
import db from "./db.js";
import { EncryptionService } from "./EncryptionService.js";
import { EvolutionService } from "./EvolutionService.js";
import { logAuthEvent } from "./auditLog.js";

const ROTATION_WINDOW_MS = 48 * 60 * 60_000;

function sha256(s: string): string { return crypto.createHash("sha256").update(s).digest("hex"); }
function genSecret(): string { return "whc_" + crypto.randomBytes(18).toString("hex"); }

export class ChannelWebhookCredentialService {
  /**
   * Segredo do canal por IDENTIFIER (gera e persiste na 1ª vez). Chamado pelo
   * provider injetado no EvolutionService na hora de REGISTRAR o webhook —
   * a credencial nasce junto do registro. null = canal não existe (o registro
   * segue com o segredo global, comportamento antigo).
   */
  static ensureForInstance(identifier: string): string | null {
    const idf = String(identifier || "").trim();
    if (!idf) return null;
    const ch = db.prepare(
      `SELECT id, webhook_secret_enc FROM channels WHERE provider IN ('evolution','evolution_go') AND identifier = ?`
    ).get(idf) as any;
    if (!ch) return null;
    if (ch.webhook_secret_enc) {
      try { const s = EncryptionService.decrypt(ch.webhook_secret_enc); if (s) return s; } catch { /* re-gera abaixo */ }
    }
    const secret = genSecret();
    db.prepare(`UPDATE channels SET webhook_secret_enc = ?, webhook_secret_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(EncryptionService.encrypt(secret), sha256(secret), ch.id);
    return secret;
  }

  /**
   * VALIDAÇÃO do inbound: o segredo recebido pertence a algum canal? Aceita o
   * hash ATUAL sempre e o ANTERIOR dentro da janela de rotação. O hash achado
   * por índice ainda é conferido com timingSafeEqual (paranoia barata).
   */
  static verify(provided: string): { channelId: string; identifier: string; organizationId: string; usedPrev: boolean } | null {
    const p = String(provided || "").trim();
    if (!p.startsWith("whc_")) return null; // formato próprio — segredo global não passa por aqui
    const h = sha256(p);
    const row = db.prepare(
      `SELECT id, identifier, organization_id, webhook_secret_hash, webhook_secret_prev_hash, webhook_secret_rotated_at
         FROM channels WHERE webhook_secret_hash = ? OR webhook_secret_prev_hash = ? LIMIT 1`
    ).get(h, h) as any;
    if (!row) return null;
    const safeEq = (x: string | null) => !!x && x.length === h.length && crypto.timingSafeEqual(Buffer.from(String(x)), Buffer.from(h));
    if (safeEq(row.webhook_secret_hash)) {
      return { channelId: row.id, identifier: row.identifier, organizationId: row.organization_id, usedPrev: false };
    }
    if (safeEq(row.webhook_secret_prev_hash)) {
      const rotatedAt = row.webhook_secret_rotated_at ? Date.parse(String(row.webhook_secret_rotated_at)) : 0;
      if (rotatedAt && Date.now() - rotatedAt <= ROTATION_WINDOW_MS) {
        return { channelId: row.id, identifier: row.identifier, organizationId: row.organization_id, usedPrev: true };
      }
    }
    return null;
  }

  /**
   * ROTAÇÃO explícita (owner/admin): o segredo atual vira "anterior" (válido
   * pela janela), um novo é gerado e o webhook é RE-REGISTRADO no provedor
   * best-effort (falha remota não desfaz a rotação — a janela cobre até o
   * próximo sync re-registrar). Auditada sem expor o segredo.
   */
  static async rotate(orgId: string, channelId: string, actorUserId?: string | null): Promise<{ ok: boolean; code?: "channel_not_found"; reregistered?: boolean }> {
    const ch = db.prepare(
      `SELECT id, identifier, token_encrypted, webhook_secret_hash FROM channels
        WHERE id = ? AND organization_id = ? AND provider IN ('evolution','evolution_go')`
    ).get(channelId, orgId) as any;
    if (!ch) return { ok: false, code: "channel_not_found" };
    const secret = genSecret();
    db.prepare(
      `UPDATE channels SET webhook_secret_prev_hash = webhook_secret_hash, webhook_secret_rotated_at = CURRENT_TIMESTAMP,
              webhook_secret_enc = ?, webhook_secret_hash = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND organization_id = ?`
    ).run(EncryptionService.encrypt(secret), sha256(secret), ch.id, orgId);
    let reregistered = false;
    try {
      let token = "";
      try { token = EncryptionService.decrypt(ch.token_encrypted) || ""; } catch { token = ""; }
      if (token) reregistered = (await EvolutionService.registerWebhook(String(ch.identifier), token)).ok;
    } catch { /* best-effort — o sync re-registra na próxima passada */ }
    try { logAuthEvent(orgId, actorUserId || "system", ch.id, "CHANNEL_WEBHOOK_SECRET_ROTATED", { instanceName: ch.identifier, reregistered }); } catch { /* noop */ }
    return { ok: true, reregistered };
  }

  /**
   * SAÚDE por canal: carimba o hit atribuído a este identifier. Best-effort —
   * nunca lança pro handler do webhook. Hit válido limpa o erro; rejeitado
   * registra o motivo SEM tocar o last_valid (o último válido continua sendo
   * evidência histórica).
   */
  static recordHit(identifier: string, ok: boolean, reason: string): void {
    const idf = String(identifier || "").trim();
    if (!idf) return;
    try {
      if (ok) {
        db.prepare(
          `UPDATE channels SET webhook_last_received_at = CURRENT_TIMESTAMP, webhook_last_valid_at = CURRENT_TIMESTAMP, webhook_last_error = NULL
            WHERE provider IN ('evolution','evolution_go') AND identifier = ?`
        ).run(idf);
      } else {
        db.prepare(
          `UPDATE channels SET webhook_last_received_at = CURRENT_TIMESTAMP, webhook_last_error = ?
            WHERE provider IN ('evolution','evolution_go') AND identifier = ?`
        ).run(String(reason || "rejeitado").slice(0, 120), idf);
      }
    } catch { /* best-effort */ }
  }
}
