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
import { ClinicProfessionalRelationshipService } from "./ClinicProfessionalRelationshipService.js";

const TTL_DAYS = 30;
const SESSION_TTL = "12h";
const SCOPE = "professional_portal";
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");

function hashToken(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }
/** URL do webapp do profissional. Absoluta se APP_URL definido; senão relativa (honesto). */
function accessUrl(token: string): string { return `${APP_URL}/profissional/${token}`; }

export interface ProfessionalSessionClaims { professionalId: string; scope: string; }

export const deps: {
  randomToken: () => string;
  /** Envio do magic-link (injetável nos testes). Best-effort/honesto; reusa o ÚNICO transporte da org. */
  sendEmail: (orgId: string, to: string, subject: string, body: string) => Promise<{ sent: boolean; reason?: string }>;
} = {
  randomToken: () => randomBytes(32).toString("hex"),
  sendEmail: async (orgId, to, subject, body) => {
    const { FalaTuEmailService } = await import("./FalaTuEmailService.js");
    return FalaTuEmailService.sendPlain(orgId, to, subject, body);
  },
};

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

  // ── F7.2 — Emissão pela clínica (política: só um vínculo ACEITO pode emitir) ──

  /** Confere que o vínculo é da org e está ACEITO; devolve o professionalId ou lança. */
  private static requireAcceptedRel(orgId: string, relationshipId: string): { professionalId: string; professionalName: string | null } {
    const rel = ClinicProfessionalRelationshipService.get(orgId, String(relationshipId || ""));
    if (!rel) throw new Error("relationship_not_found");                 // isolamento (RN-PN-2)
    if (rel.status !== "accepted") throw new Error("relationship_not_accepted");
    return { professionalId: rel.professionalId, professionalName: rel.professional?.name ?? null };
  }

  /**
   * A clínica (vínculo aceito) gera o magic-link do profissional. Devolve a URL pronta pra
   * compartilhar (a clínica já fala com o profissional — entrega pelo canal dela). Token
   * global: serve pra TODAS as clínicas do profissional (uma identidade, um acesso).
   */
  static issueForRelationship(orgId: string, relationshipId: string, actorId?: string): { url: string; token: string; expiresAt: string; professionalName: string | null } {
    const { professionalId, professionalName } = this.requireAcceptedRel(orgId, relationshipId);
    const { token, expiresAt } = this.generateToken(professionalId, { issuerOrgId: orgId, actorId });
    return { url: accessUrl(token), token, expiresAt, professionalName };
  }

  /**
   * F11.3 — Emite E ENTREGA o magic-link ao e-mail da identidade GLOBAL do profissional,
   * best-effort, pela clínica emissora (reusa o transporte da org — sem canal paralelo §184).
   * A entrega NUNCA bloqueia a emissão: o token válido volta sempre; `delivery` conta o que
   * aconteceu com HONESTIDADE (`no_destination` = profissional sem e-mail cadastrado;
   * `no_channel` = a clínica não tem como enviar). O `token`/`url` seguem no retorno pra
   * clínica compartilhar manualmente quando o envio automático não rolar. WhatsApp fica
   * DEFERIDO (o profissional é identidade global, sem contato/consentimento por-org).
   */
  static async issueAndSend(orgId: string, relationshipId: string, actorId?: string): Promise<{ url: string; token: string; expiresAt: string; professionalName: string | null; delivery: { channel: "email"; to: string | null; sent: boolean; reason?: string } }> {
    const issued = this.issueForRelationship(orgId, relationshipId, actorId);
    const { professionalId } = this.requireAcceptedRel(orgId, relationshipId);
    const to = String(ProfessionalService.getById(professionalId)?.email || "").trim() || null;
    let delivery: { channel: "email"; to: string | null; sent: boolean; reason?: string };
    if (!to) {
      delivery = { channel: "email", to: null, sent: false, reason: "no_destination" };
    } else {
      const subject = "Seu acesso à Agenda Federada";
      const body = [
        `Olá${issued.professionalName ? `, ${issued.professionalName}` : ""}!`,
        ``,
        `Você recebeu acesso à sua agenda pela clínica. Abra o link abaixo pra ver seus horários, o que tem a receber e ajustar sua disponibilidade:`,
        ``,
        issued.url,
        ``,
        `O link é pessoal — não compartilhe. Ele expira em ${new Date(issued.expiresAt).toLocaleDateString("pt-BR")}.`,
      ].join("\n");
      const r = await deps.sendEmail(orgId, to, subject, body);
      delivery = { channel: "email", to, sent: r.sent, reason: r.reason };
    }
    try { logAuthEvent(orgId, actorId || "system", professionalId, "PROF_AUTH_LINK_SENT", { channel: "email", sent: delivery.sent, reason: delivery.reason }); } catch { /* noop */ }
    return { ...issued, delivery };
  }

  /** Status do link do profissional do vínculo (sem expor o token). Só vínculo da org. */
  static statusForRelationship(orgId: string, relationshipId: string): { active: boolean; expiresAt: string | null; lastAccessAt: string | null } {
    const { professionalId } = this.requireAcceptedRel(orgId, relationshipId);
    return this.status(professionalId);
  }

  /** Revoga o link do profissional do vínculo (só vínculo aceito da org). */
  static revokeForRelationship(orgId: string, relationshipId: string, actorId?: string): { revoked: boolean } {
    const { professionalId } = this.requireAcceptedRel(orgId, relationshipId);
    return { revoked: this.revoke(professionalId, actorId) };
  }
}

export default ProfessionalAuthService;
