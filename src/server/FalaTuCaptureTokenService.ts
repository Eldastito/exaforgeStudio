import { createHash, randomBytes, randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * ADR-154 F8.4 — tokens pessoais de captura (API aberta write-only).
 *
 * Fundação dos plugues externos da Fase 8 (Atalho Siri, Share Target Android,
 * adesivo NFC, Zapier/n8n/ERP): um token longevo por usuário que autentica
 * EXCLUSIVAMENTE a rota de ingestão (`POST /api/falatu-ingest/capture`).
 *
 * Decisões e porquês:
 * - **Hash, nunca claro** — o banco guarda só sha256(token). O claro é
 *   mostrado UMA vez no create (o dono cola no atalho/integração e pronto).
 *   Dump do banco não vira credencial. Comparação por igualdade do hash é
 *   suficiente: o token tem 256 bits de entropia — não existe ataque de
 *   timing prático contra lookup indexado de hash de segredo aleatório
 *   (diferente do PIN de 4-6 dígitos da Fase 28, que exige timingSafeEqual).
 * - **Write-only por construção** — o service não dá superfície de leitura a
 *   quem só tem token: verify() devolve apenas a identidade (org, user) pro
 *   router de ingestão, que expõe UMA rota (capture). Vazamento de token no
 *   pior caso enche o inbox de PENDENTES do próprio dono (RN-151: nada
 *   materializa sem confirm humano na sessão); não lê, não confirma, não
 *   apaga nada.
 * - **Revogação é UPDATE** (convenção nº 9) — a linha revogada fica como
 *   trilha de que a credencial existiu (e quando foi usada por último).
 * - **Teto de tokens ativos por usuário** — 10. Não é quota de segurança, é
 *   higiene: força rotular e revogar em vez de acumular credencial esquecida.
 * - **Custo de IA** não é policiado aqui: capture() já passa por
 *   PlanService.aiAllowed + ai_usage_ledger (mesma régua da sessão).
 */

const TOKEN_PREFIX = "ftk_";
const MAX_ACTIVE_TOKENS_PER_USER = 10;
const LABEL_MAX = 60;

const sha256 = (raw: string) => createHash("sha256").update(raw).digest("hex");

export interface CaptureTokenIdentity {
  tokenId: string;
  orgId: string;
  userId: string;
}

export class FalaTuCaptureTokenService {
  /**
   * Cria um token e devolve o CLARO uma única vez. Label é obrigatório
   * (invariante: sem rótulo não há como o dono saber o que revogar depois).
   */
  static create(orgId: string, userId: string, label: unknown): { id: string; token: string; label: string } {
    if (typeof label !== "string" || !label.trim()) throw new Error("Dê um nome ao token (ex.: 'Atalho Siri').");
    const cleanLabel = label.trim().slice(0, LABEL_MAX);
    const active = db
      .prepare(`SELECT COUNT(*) c FROM falatu_capture_tokens WHERE organization_id = ? AND user_id = ? AND revoked_at IS NULL`)
      .get(orgId, userId) as any;
    if (Number(active?.c || 0) >= MAX_ACTIVE_TOKENS_PER_USER) {
      throw new Error(`Limite de ${MAX_ACTIVE_TOKENS_PER_USER} tokens ativos atingido. Revogue um antes de criar outro.`);
    }
    const id = randomUUID();
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    db.prepare(`INSERT INTO falatu_capture_tokens (id, organization_id, user_id, token_hash, label) VALUES (?, ?, ?, ?, ?)`)
      .run(id, orgId, userId, sha256(token), cleanLabel);
    logAuthEvent(orgId, userId, null, "FALATU_CAPTURE_TOKEN_CREATE", { tokenId: id, label: cleanLabel });
    return { id, token, label: cleanLabel };
  }

  /** Lista os tokens do usuário — sem hash (o claro nem existe mais). */
  static list(orgId: string, userId: string): any[] {
    return db
      .prepare(`SELECT id, label, created_at, last_used_at, revoked_at FROM falatu_capture_tokens WHERE organization_id = ? AND user_id = ? ORDER BY created_at DESC`)
      .all(orgId, userId);
  }

  /** Revoga (UPDATE, nunca DELETE). Filtro por dono na própria query — anti-IDOR. */
  static revoke(orgId: string, userId: string, tokenId: string): { ok: true } {
    const r = db
      .prepare(`UPDATE falatu_capture_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND user_id = ? AND revoked_at IS NULL`)
      .run(tokenId, orgId, userId);
    if (r.changes === 0) throw new Error("Token não encontrado ou já revogado.");
    logAuthEvent(orgId, userId, null, "FALATU_CAPTURE_TOKEN_REVOKE", { tokenId });
    return { ok: true };
  }

  /**
   * Resolve um token claro em identidade (org, user) — ou null se inválido,
   * malformado ou revogado. Não decide autorização de módulo: quem chama
   * (router de ingestão) confere FalaTuService.orgEnabled, o MESMO gate da
   * sessão (fonte única, sem duplicar invariante aqui).
   */
  static verify(rawToken: unknown): CaptureTokenIdentity | null {
    if (typeof rawToken !== "string") return null;
    const raw = rawToken.trim();
    if (!raw.startsWith(TOKEN_PREFIX) || raw.length < 20 || raw.length > 200) return null;
    const row = db
      .prepare(`SELECT id, organization_id, user_id FROM falatu_capture_tokens WHERE token_hash = ? AND revoked_at IS NULL`)
      .get(sha256(raw)) as any;
    if (!row) return null;
    // Best-effort (convenção nº 7): rastro de último uso nunca derruba a captura.
    try {
      db.prepare(`UPDATE falatu_capture_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
    } catch { /* noop */ }
    return { tokenId: row.id, orgId: row.organization_id, userId: row.user_id };
  }
}
