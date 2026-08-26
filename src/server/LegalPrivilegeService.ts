import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { LgpdService } from "./LgpdService.js";

/**
 * Legal Privilege (ADR-191 F9) — SIGILO profissional advogado↔cliente.
 *
 * REUSA o mecanismo LGPD de consentimento (`contact_consents` via `LgpdService`) como
 * gate — NÃO cria mecanismo novo (D6). Categoria `sigilo_profissional`, base legal
 * EXERCÍCIO DE DIREITOS / EOAB Art.34 (NÃO é `dados_sensiveis`, que é saúde). O gate é
 * OPT-IN por org (`advocacia_sigilo_enabled`, default 0 → 0-regressão): desligado, tudo
 * opera como antes; ligado, o CONTEÚDO dos documentos do caso (corpo/PDF) só é exposto
 * quando o cliente tem o consentimento ATIVO — revogou, perde-se o acesso ao conteúdo
 * (espelha o gate de `dados_sensiveis` da clínica). Isolado por organization_id.
 */

export const SIGILO_CONSENT = "sigilo_profissional";

export class LegalPrivilegeService {
  static isEnabled(orgId: string): boolean {
    const o = db.prepare(`SELECT advocacia_sigilo_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return !!(o && Number(o.advocacia_sigilo_enabled) === 1);
  }

  static setEnabled(orgId: string, on: boolean, actorId: string | null = null): { enabled: boolean } {
    db.prepare(`UPDATE organization_settings SET advocacia_sigilo_enabled = ? WHERE organization_id = ?`).run(on ? 1 : 0, orgId);
    logAuthEvent(orgId, actorId, null, "LEGAL_SIGILO_GATE_TOGGLED", { enabled: !!on });
    return { enabled: !!on };
  }

  static hasConsent(orgId: string, contactId: string): boolean {
    return LgpdService.hasConsent(orgId, contactId, SIGILO_CONSENT);
  }

  /** Registra o consentimento de sigilo do cliente (base legal exercício de direitos). */
  static grant(orgId: string, contactId: string, actorId: string | null = null): { granted: boolean } {
    const c = db.prepare(`SELECT id FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, contactId) as any;
    if (!c) throw new Error("Cliente não encontrado.");
    LgpdService.grantConsent(orgId, contactId, SIGILO_CONSENT, { legalBasis: "exercicio_de_direitos", actorId: actorId || undefined });
    return { granted: true };
  }

  static revoke(orgId: string, contactId: string, actorId: string | null = null): { revoked: boolean } {
    const ok = LgpdService.revokeConsent(orgId, contactId, SIGILO_CONSENT, actorId || undefined);
    return { revoked: ok };
  }

  static status(orgId: string, contactId: string): { enabled: boolean; hasConsent: boolean } {
    return { enabled: this.isEnabled(orgId), hasConsent: this.hasConsent(orgId, contactId) };
  }

  /** Barra a exposição de conteúdo sigiloso quando o gate está ligado e falta consentimento.
   *  Desligado → no-op (0-regressão). Lança SIGILO_REQUIRED. */
  static assertAccess(orgId: string, contactId: string): void {
    if (!this.isEnabled(orgId)) return;
    if (this.hasConsent(orgId, contactId)) return;
    const e: any = new Error("Acesso ao conteúdo sigiloso requer consentimento do cliente (sigilo profissional).");
    e.code = "SIGILO_REQUIRED";
    throw e;
  }

  /** Versão booleana pra redigir listas sem lançar. */
  static canAccess(orgId: string, contactId: string): boolean {
    if (!this.isEnabled(orgId)) return true;
    return this.hasConsent(orgId, contactId);
  }
}

export default LegalPrivilegeService;
