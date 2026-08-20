/**
 * ProfessionalAuthService — ADR-180 F7.1: auth PASSWORDLESS do profissional (webapp de
 * autoatendimento da Agenda Federada).
 *
 * O profissional é GLOBAL (identidade no ecossistema, §90) e atende em N clínicas — não
 * cabe no modelo `users` (UNIQUE por e-mail + preso a 1 org). Aqui ele entra por MAGIC-LINK:
 *
 *   1) uma clínica com vínculo ACEITO gera um token (32 bytes, devolvido UMA vez; no banco
 *      só o hash SHA-256 + TTL + active — molde do ClinicPortalService). O link é entregue
 *      ao e-mail/telefone da identidade global (F7.2).
 *   2) o profissional abre `/profissional/:token`; a página troca o token por uma SESSÃO —
 *      um JWT com escopo `professional_portal` e `professionalId`, SEM `organizationId`,
 *      que NUNCA passa pelo `requireAuth` do staff (middleware próprio).
 *
 * Guardrails: token global (sem org — o acesso é da identidade); resolve SEMPRE por hash
 * (nunca por id); a sessão jamais carrega organizationId nem toca `users`. Determinístico
 * (nowFn/tokenFn injetáveis nos testes via `deps`).
 */
import { randomUUID, randomBytes, createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import db from "./db.js";
import { JWT_SECRET } from "./config/secret.js";
import { logAuthEvent } from "./auditLog.js";
import { ProfessionalService } from "./ProfessionalService.js";

const TTL_DAYS = 30;
const SESSION_TTL = "12h";
const SCOPE = "professional_portal";

function hashToken(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }

export interface ProfessionalSessionClaims { professionalId: string; scope: string; }

export const deps: { randomToken: () => string } = { randomToken: () => randomBytes(32).toString("hex") };

export class ProfessionalAuthService {
  /**
   * (Re)gera o magic-link do profissional (identidade GLOBAL). Invalida os anteriores
   * (um link ativo por profissional). Retorna o token CRU uma única vez. `issuerOrgId` é
   * só auditoria (qual clínica gerou) — não confere propriedade sobre a identidade.
   */
  static generateToken(professionalId: string, opts?: { issuerOrgId?: string; actorId?: string }): { token: string; expiresAt: string } {
    const prof = ProfessionalService.getById(String(professionalId || ""));
    if (!prof) throw new Error("professional_not_found");
    db.prepare(`UPDATE professional_auth_tokens SET active = 0 WHERE professional_id = ? AND active = 1`).run(professionalId);
    const raw = deps.randomToken();
    const id = randomUUID();
    db.prepare(`INSERT INTO professional_auth_tokens (id, professional_id, token_hash, active, expires_at) VALUES (?, ?, ?, 1, datetime('now', ?))`)
      .run(id, professionalId, hashToken(raw), `+${TTL_DAYS} days`);
    try { logAuthEvent(opts?.issuerOrgId || "system", opts?.actorId || "system", professionalId, "PROF_AUTH_TOKEN_ISSUED", { tokenId: id }); } catch { /* noop */ }
    const row = db.prepare(`SELECT expires_at FROM professional_auth_tokens WHERE id = ?`).get(id) as any;
    return { token: raw, expiresAt: row.expires_at };
  }

  /** Revoga o link ativo do profissional (invalida futuras trocas por sessão). */
  static revoke(professionalId: string, actorId?: string): boolean {
    const r = db.prepare(`UPDATE professional_auth_tokens SET active = 0 WHERE professional_id = ? AND active = 1`).run(professionalId);
    if (r.changes > 0) { try { logAuthEvent("system", actorId || "system", professionalId, "PROF_AUTH_TOKEN_REVOKED", {}); } catch { /* noop */ } }
    return r.changes > 0;
  }

  /** Status do link (sem expor o token). */
  static status(professionalId: string): { active: boolean; expiresAt: string | null; lastAccessAt: string | null } {
    const row = db.prepare(`SELECT expires_at, last_access_at FROM professional_auth_tokens WHERE professional_id = ? AND active = 1 AND expires_at > CURRENT_TIMESTAMP ORDER BY created_at DESC LIMIT 1`).get(professionalId) as any;
    return { active: !!row, expiresAt: row?.expires_at || null, lastAccessAt: row?.last_access_at || null };
  }

  /** Resolve o magic-link (marca last_access) → professionalId. Lança se inválido/expirado. */
  static resolveToken(rawToken: string): { professionalId: string } {
    const raw = String(rawToken || "").trim();
    if (!raw) throw new Error("token_invalid");
    const tok = db.prepare(`SELECT * FROM professional_auth_tokens WHERE token_hash = ? AND active = 1 AND expires_at > CURRENT_TIMESTAMP`).get(hashToken(raw)) as any;
    if (!tok) throw new Error("token_invalid_or_expired");
    db.prepare(`UPDATE professional_auth_tokens SET last_access_at = CURRENT_TIMESTAMP WHERE id = ?`).run(tok.id);
    return { professionalId: tok.professional_id };
  }

  /**
   * Troca o magic-link por uma SESSÃO (JWT escopado). O JWT carrega só
   * `{ professionalId, scope }` — NUNCA organizationId (não é sessão de staff). Devolve
   * também a identidade pública do profissional pra UI.
   */
  static startSession(rawToken: string): { session: string; professional: any } {
    const { professionalId } = this.resolveToken(rawToken);
    const prof = ProfessionalService.getById(professionalId);
    if (!prof) throw new Error("professional_not_found");
    const session = jwt.sign({ professionalId, scope: SCOPE } as ProfessionalSessionClaims, JWT_SECRET, { expiresIn: SESSION_TTL });
    return { session, professional: { id: prof.id, name: prof.name, council: prof.council, registrationNumber: prof.registrationNumber, specialties: prof.specialties } };
  }

  /**
   * Verifica um JWT de sessão do profissional. Só aceita o escopo `professional_portal` e
   * EXIGE ausência de organizationId (um token de staff nunca vira sessão de profissional).
   */
  static verifySession(token: string): { professionalId: string } | null {
    try {
      const d = jwt.verify(String(token || ""), JWT_SECRET) as any;
      if (!d || d.scope !== SCOPE || !d.professionalId || d.organizationId) return null;
      return { professionalId: String(d.professionalId) };
    } catch { return null; }
  }
}

export default ProfessionalAuthService;
