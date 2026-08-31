/**
 * AccountIdentityService — ADR-199 F0a: fundação de IDENTIDADE do ZapFlow Grupo.
 *
 * Decisão D1/§4.1: hoje "um humano = uma linha em `users` = uma org" (users.email
 * UNIQUE global). Pra um mesmo humano ter linha de `users` em N orgs, a CREDENCIAL de
 * login (email + password_hash + MFA) sobe pra `account_identities` (GLOBAL, sem
 * organization_id — precedente já validado: professionals, vertical_intelligence).
 * `users.identity_id` liga as linhas do mesmo humano; cada org mantém sua linha de
 * `users` intacta (role/permissões/escopo de loja por-org).
 *
 * ESCOPO DESTA FATIA (F0a): só CRIA a camada e faz o BACKFILL idempotente/reversível.
 * O login segue lendo `users` (não muda comportamento — 0-regressão); a migração dos
 * lookups por email pra identidade é a F0b, e o rebuild de users.email UNIQUE é a F0c.
 *
 * Guardrails:
 *  - RN-GRP-04: users.email NULO nunca gera identidade (bots/sistema seguem legado).
 *  - RN-GRP-08: aditivo, idempotente (rodar backfill 2× não duplica), reversível
 *    (`reverseBackfill` desvincula identity_id e remove identidades órfãs que o
 *    backfill criou — `users` volta ao estado anterior).
 *  - Forward-compatível com a F0c: quando users.email deixar de ser único, o backfill
 *    agrupa por email e liga TODAS as linhas àquela identidade (uma credencial por
 *    humano). Hoje, com email único, isso é naturalmente 1:1.
 *  - A identidade NÃO conhece grupo/holding (isso é OrgGroupService); e nenhum service
 *    org-scoped conhece identidade (RN-GRP-01/RN-GRP-05).
 */
import { randomUUID } from "crypto";
import db from "./db.js";

export interface AccountIdentity {
  id: string;
  email: string;
  status: string;
  mfaEnabled: boolean;
  createdAt: string;
}

export interface BackfillStats {
  usersScanned: number;
  identitiesCreated: number;
  usersLinked: number;
  skippedNullEmail: number;
  alreadyLinked: number;
}

function normEmail(s?: string | null): string | null {
  const v = String(s ?? "").trim().toLowerCase();
  return v.length ? v : null;
}

export class AccountIdentityService {
  private static map(r: any): AccountIdentity {
    return {
      id: r.id, email: r.email, status: r.status || "active",
      mfaEnabled: !!r.mfa_enabled, createdAt: r.created_at,
    };
  }

  static getById(id: string): AccountIdentity | null {
    const r = db.prepare("SELECT * FROM account_identities WHERE id = ?").get(String(id || "")) as any;
    return r ? AccountIdentityService.map(r) : null;
  }

  static getByEmail(email: string): AccountIdentity | null {
    const e = normEmail(email);
    if (!e) return null;
    const r = db.prepare("SELECT * FROM account_identities WHERE email = ?").get(e) as any;
    return r ? AccountIdentityService.map(r) : null;
  }

  // ==========================================================================
  // ADR-199 F0b — a identidade vira a FONTE DE VERDADE da credencial no login e o
  // ÚNICO ponto que lê `users` por email GLOBAL. Objetivos:
  //  - RN-GRP-02: nenhum outro arquivo faz `FROM users WHERE email` (gate de lint);
  //    todo lookup global passa por aqui, pronto pra F0c relaxar users.email UNIQUE.
  //  - RN-GRP-03: trocar senha/MFA revoga TODAS as sessões do humano (bump de
  //    security_version em cada linha de users ligada), não só de uma marca.
  //  - 0-regressão: enquanto users.email é único (pré-F0c) a resolução é 1:1 e o
  //    login se comporta igual ao legado (match EXATO por email, credencial idêntica).
  // ==========================================================================

  /**
   * O ÚNICO lugar que lê `users` por email GLOBAL (login-style). Match EXATO
   * (case-sensitive), igual ao login legado — 0-regressão. Devolve linhas cruas.
   */
  static usersByEmail(email: string): any[] {
    const e = String(email ?? "");
    if (!e) return [];
    return db.prepare("SELECT * FROM users WHERE email = ?").all(e) as any[];
  }

  /** Existe conta (linha de users OU identidade) com este email? Para dup-check de cadastro. */
  static userExistsByEmail(email: string): boolean {
    if (AccountIdentityService.usersByEmail(email).length > 0) return true;
    return AccountIdentityService.getByEmail(email) !== null;
  }

  /**
   * Garante (idempotente) uma identidade pra linha de `users` e liga identity_id,
   * copiando a credencial atual (senha/MFA) da linha. Email nulo → null (RN-GRP-04).
   * Usado no login preguiçoso (usuário sem identidade ganha uma no 1º login pós-F0b).
   */
  static ensureForUser(userId: string): string | null {
    const u = db.prepare("SELECT id, email, password_hash, mfa_secret, mfa_enabled, mfa_backup_codes, identity_id FROM users WHERE id = ?").get(String(userId || "")) as any;
    if (!u) return null;
    if (u.identity_id) {
      const ex = db.prepare("SELECT 1 FROM account_identities WHERE id = ?").get(u.identity_id);
      if (ex) return u.identity_id;
    }
    const email = normEmail(u.email);
    if (!email) return null; // RN-GRP-04
    let identity = db.prepare("SELECT id FROM account_identities WHERE email = ?").get(email) as any;
    if (!identity) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO account_identities (id, email, password_hash, mfa_secret, mfa_enabled, mfa_backup_codes, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active') ON CONFLICT(email) DO NOTHING`
      ).run(id, email, u.password_hash ?? null, u.mfa_secret ?? null, u.mfa_enabled ? 1 : 0, u.mfa_backup_codes ?? null);
      identity = db.prepare("SELECT id FROM account_identities WHERE email = ?").get(email) as any;
    }
    if (!identity) return null;
    db.prepare("UPDATE users SET identity_id = ? WHERE id = ? AND (identity_id IS NULL OR identity_id != ?)").run(identity.id, u.id, identity.id);
    return identity.id;
  }

  /**
   * Resolve o registro de login por email: a LINHA de users a assinar (claims) + a
   * CREDENCIAL a validar (da identidade quando existe — RN-GRP-02; senão da própria
   * linha, fallback legado). Match exato (0-regressão). Garante a identidade
   * preguiçosamente. null quando não há usuário (login falha igual ao legado).
   */
  static resolveLogin(email: string): { user: any; credential: { password_hash: string | null; mfa_enabled: number; mfa_secret: string | null; mfa_backup_codes: string | null }; identityId: string | null } | null {
    const rows = AccountIdentityService.usersByEmail(email);
    if (!rows.length) return null;
    const user = rows[0]; // pré-F0c: no máx. 1 linha por email (F0c: switch-org escolhe a org).
    const identityId = AccountIdentityService.ensureForUser(user.id) || user.identity_id || null;
    let credential = { password_hash: user.password_hash ?? null, mfa_enabled: user.mfa_enabled ? 1 : 0, mfa_secret: user.mfa_secret ?? null, mfa_backup_codes: user.mfa_backup_codes ?? null };
    if (identityId) {
      const idn = db.prepare("SELECT password_hash, mfa_enabled, mfa_secret, mfa_backup_codes FROM account_identities WHERE id = ?").get(identityId) as any;
      if (idn) credential = { password_hash: idn.password_hash ?? null, mfa_enabled: idn.mfa_enabled ? 1 : 0, mfa_secret: idn.mfa_secret ?? null, mfa_backup_codes: idn.mfa_backup_codes ?? null };
    }
    return { user, credential, identityId };
  }

  /**
   * Escreve credencial (senha e/ou MFA) na IDENTIDADE e ESPELHA em TODAS as linhas de
   * `users` ligadas (mantém leituras legadas válidas). bumpSv=true (default) revoga
   * TODAS as sessões do humano (RN-GRP-03). bumpSv=false p/ consumo de backup-code no
   * login (não é troca de credencial). Atômico. Devolve os userIds afetados.
   */
  static setCredentialByUser(
    userId: string,
    patch: { passwordHash?: string | null; mfaEnabled?: number | boolean; mfaSecret?: string | null; mfaBackupCodes?: string | null },
    opts: { bumpSv?: boolean } = {}
  ): string[] {
    const bumpSv = opts.bumpSv !== false;
    const identityId = AccountIdentityService.ensureForUser(userId);
    const affected: string[] = [];
    const setSql: string[] = []; const vals: any[] = [];
    if (patch.passwordHash !== undefined) { setSql.push("password_hash = ?"); vals.push(patch.passwordHash); }
    if (patch.mfaEnabled !== undefined) { setSql.push("mfa_enabled = ?"); vals.push(patch.mfaEnabled ? 1 : 0); }
    if (patch.mfaSecret !== undefined) { setSql.push("mfa_secret = ?"); vals.push(patch.mfaSecret); }
    if (patch.mfaBackupCodes !== undefined) { setSql.push("mfa_backup_codes = ?"); vals.push(patch.mfaBackupCodes); }
    if (!setSql.length) return affected;
    const assign = setSql.join(", ");
    const tx = db.transaction(() => {
      if (identityId) {
        db.prepare(`UPDATE account_identities SET ${assign}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals, identityId);
        const linked = db.prepare("SELECT id FROM users WHERE identity_id = ?").all(identityId) as any[];
        for (const r of linked) {
          db.prepare(`UPDATE users SET ${assign}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals, r.id);
          affected.push(r.id);
          if (bumpSv) db.prepare("UPDATE users SET security_version = COALESCE(security_version, 1) + 1 WHERE id = ?").run(r.id);
        }
      } else {
        // Sem identidade (email nulo, ex.: bot): escreve só na linha (comportamento legado).
        db.prepare(`UPDATE users SET ${assign}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals, userId);
        affected.push(userId);
        if (bumpSv) db.prepare("UPDATE users SET security_version = COALESCE(security_version, 1) + 1 WHERE id = ?").run(userId);
      }
    });
    tx();
    return affected;
  }

  /**
   * As organizações em que a identidade tem linha de `users` — a FONTE DE VERDADE do
   * membership pro switch-org (F0c). Não usa org_group_members (o grupo é só agregação);
   * o acesso a uma org é ter linha de `users` ligada por identity_id. Só linhas ativas.
   */
  static orgsForIdentity(identityId: string): string[] {
    if (!identityId) return [];
    const rows = db.prepare(
      `SELECT DISTINCT organization_id FROM users
        WHERE identity_id = ? AND (global_status IS NULL OR global_status NOT IN ('blocked','deleted'))`
    ).all(String(identityId)) as any[];
    return rows.map((r) => r.organization_id);
  }

  /** Todas as linhas de `users` (id + org) ligadas a esta identidade — usado pela F0b/F0c. */
  static usersForIdentity(identityId: string): { userId: string; organizationId: string }[] {
    if (!identityId) return [];
    const rows = db.prepare("SELECT id, organization_id FROM users WHERE identity_id = ?").all(String(identityId)) as any[];
    return rows.map((r) => ({ userId: r.id, organizationId: r.organization_id }));
  }

  /**
   * BACKFILL idempotente: pra cada linha de `users` com email não-nulo, garante uma
   * `account_identity` (uma por email) e liga `users.identity_id`. Copia a credencial
   * (password_hash + MFA) pra identidade a partir da 1ª linha que a tiver (determinístico
   * por created_at). Rodar 2× não duplica nem re-escreve (só liga o que faltava).
   *
   * NÃO altera `users` além de setar identity_id (credencial permanece em `users`
   * também — 0-regressão pro login legado; a remoção da duplicação vem na F0b/F0c).
   */
  static backfill(): BackfillStats {
    const stats: BackfillStats = { usersScanned: 0, identitiesCreated: 0, usersLinked: 0, skippedNullEmail: 0, alreadyLinked: 0 };
    const users = db.prepare(
      "SELECT id, email, password_hash, mfa_secret, mfa_enabled, mfa_backup_codes, identity_id, created_at FROM users ORDER BY created_at ASC, id ASC"
    ).all() as any[];

    const tx = db.transaction(() => {
      for (const u of users) {
        stats.usersScanned++;
        const email = normEmail(u.email);
        if (!email) { stats.skippedNullEmail++; continue; }               // RN-GRP-04
        if (u.identity_id) {
          // Já ligado — confirma que a identidade existe (defensivo) e segue.
          const exists = db.prepare("SELECT 1 FROM account_identities WHERE id = ?").get(u.identity_id);
          if (exists) { stats.alreadyLinked++; continue; }
          // identity_id órfão (identidade removida): trata como não-ligado e re-liga abaixo.
        }
        // Garante a identidade (uma por email). ON CONFLICT no-op mantém idempotência.
        let identity = db.prepare("SELECT id FROM account_identities WHERE email = ?").get(email) as any;
        if (!identity) {
          const id = randomUUID();
          db.prepare(
            `INSERT INTO account_identities (id, email, password_hash, mfa_secret, mfa_enabled, mfa_backup_codes, status)
             VALUES (?, ?, ?, ?, ?, ?, 'active')
             ON CONFLICT(email) DO NOTHING`
          ).run(id, email, u.password_hash ?? null, u.mfa_secret ?? null, u.mfa_enabled ? 1 : 0, u.mfa_backup_codes ?? null);
          identity = db.prepare("SELECT id FROM account_identities WHERE email = ?").get(email) as any;
          if (identity && identity.id === id) stats.identitiesCreated++;
        } else {
          // Identidade já existe (email compartilhado, cenário F0c): completa a credencial
          // se estiver vazia, nunca sobrescreve uma existente.
          if (u.password_hash) {
            db.prepare("UPDATE account_identities SET password_hash = COALESCE(password_hash, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND password_hash IS NULL").run(u.password_hash, identity.id);
          }
        }
        if (identity) {
          db.prepare("UPDATE users SET identity_id = ? WHERE id = ? AND (identity_id IS NULL OR identity_id != ?)").run(identity.id, u.id, identity.id);
          stats.usersLinked++;
        }
      }
    });
    tx();
    return stats;
  }

  /**
   * Reversão (RN-GRP-08): desvincula `users.identity_id` (users volta ao estado
   * anterior) e remove as identidades que ficaram órfãs — exceto as referenciadas por
   * org_groups.owner_identity_id (não quebrar uma holding já criada). Idempotente.
   */
  static reverseBackfill(): { usersUnlinked: number; identitiesRemoved: number } {
    let usersUnlinked = 0, identitiesRemoved = 0;
    const tx = db.transaction(() => {
      usersUnlinked = db.prepare("UPDATE users SET identity_id = NULL WHERE identity_id IS NOT NULL").run().changes as number;
      identitiesRemoved = db.prepare(
        `DELETE FROM account_identities
          WHERE id NOT IN (SELECT identity_id FROM users WHERE identity_id IS NOT NULL)
            AND id NOT IN (SELECT owner_identity_id FROM org_groups)`
      ).run().changes as number;
    });
    tx();
    return { usersUnlinked, identitiesRemoved };
  }
}
