import db from "./db.js";
import { TOTPService } from "./TOTPService.js";
import { EncryptionService } from "./EncryptionService.js";
import { ApprovalPolicyService } from "./ApprovalPolicyService.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * StepUpMfaService (ADR-159 F6 / D6, parte 1).
 *
 * Step-up (re-autenticação) por MFA para EXECUTAR uma ação crítica: financeira/
 * destrutiva (fonte única `ApprovalPolicyService.isFinancialOrDestructive`) ACIMA
 * de um limiar por-org. Reusa o SEGUNDO FATOR REAL do usuário — `users.mfa_secret`
 * + `TOTPService.verify` (o mesmo do login) —, NÃO o PIN de clínica/varejo (fator
 * errado). Opt-in por org (`step_up_mfa_enabled`).
 *
 * ONDE: o gate vive na rota HUMANA `POST /actions/:id/execute`. Os fluxos de
 * SISTEMA (reroutes F2: dispatchGoverned/cadence/scheduler) chamam
 * `CommandExecutorService.execute` DIRETO, sem passar por essa rota — logo são
 * estruturalmente ISENTOS (o step-up nunca trava um envio automático governado).
 *
 * LOCKOUT: `TOTPService.verify` é puro (sem trava). Aqui aplicamos o molde da
 * Fase 28 (5 tentativas / 15min) por (org,user) — em memória do processo
 * (single-process better-sqlite3); reset no acerto. Erros com `e.code` estável
 * (STEP_UP_LOCKED | STEP_UP_INVALID | STEP_UP_ENROLL_REQUIRED) pra a rota mapear.
 */

const LOCKOUT_MAX = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

interface Attempts { count: number; firstAt: number; }
const attempts = new Map<string, Attempts>();

function throwCoded(code: string, message: string): never {
  const e = new Error(message) as any; e.code = code; throw e;
}

export class StepUpMfaService {
  /** Config de step-up da org (flag + limiar em centavos). */
  static config(orgId: string): { enabled: boolean; thresholdCents: number } {
    const r = db.prepare("SELECT COALESCE(step_up_mfa_enabled,0) AS en, COALESCE(step_up_mfa_threshold_cents,0) AS th FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return { enabled: Number(r?.en) === 1, thresholdCents: Number(r?.th) || 0 };
  }

  /**
   * A ação exige step-up? org opt-in + financeira/destrutiva + |valor| ≥ limiar.
   * `action` = linha de decision_actions ({domain, action_type, expected_impact}).
   */
  static requiresStepUp(orgId: string, action: { domain: string; action_type: string; expected_impact?: number | null }): boolean {
    const cfg = this.config(orgId);
    if (!cfg.enabled) return false;
    if (!ApprovalPolicyService.isFinancialOrDestructive(action.domain, action.action_type)) return false;
    const cents = Math.round(Math.abs(Number(action.expected_impact) || 0) * 100);
    return cents >= cfg.thresholdCents;
  }

  private static lockKey(orgId: string, userId: string) { return `${orgId}:${userId}`; }

  private static registerFail(orgId: string, userId: string): void {
    const key = this.lockKey(orgId, userId);
    const now = Date.now();
    const a = attempts.get(key);
    if (!a || now - a.firstAt > LOCKOUT_WINDOW_MS) attempts.set(key, { count: 1, firstAt: now });
    else a.count++;
  }
  private static isLocked(orgId: string, userId: string): boolean {
    const a = attempts.get(this.lockKey(orgId, userId));
    if (!a) return false;
    if (Date.now() - a.firstAt > LOCKOUT_WINDOW_MS) { attempts.delete(this.lockKey(orgId, userId)); return false; }
    return a.count >= LOCKOUT_MAX;
  }
  private static clear(orgId: string, userId: string): void { attempts.delete(this.lockKey(orgId, userId)); }

  /**
   * Verifica o TOTP fresco do usuário pra liberar a execução crítica. LANÇA
   * (com `e.code`) em: locked, sem MFA cadastrado, ou código inválido. Auditado
   * em `auth_audit_logs`. No sucesso, zera o contador de tentativas.
   */
  static assertVerified(orgId: string, userId: string | undefined, token: string | undefined): void {
    if (!userId) throwCoded("STEP_UP_INVALID", "Usuário não identificado para step-up MFA.");
    if (this.isLocked(orgId, userId)) {
      try { logAuthEvent(orgId, userId, userId, "MFA_STEP_UP_LOCKED", {}); } catch { /* noop */ }
      throwCoded("STEP_UP_LOCKED", "Muitas tentativas de MFA. Tente novamente em alguns minutos.");
    }
    const u = db.prepare("SELECT mfa_enabled, mfa_secret FROM users WHERE id = ? AND organization_id = ?").get(userId, orgId) as any;
    if (!u || Number(u.mfa_enabled) !== 1 || !u.mfa_secret) {
      // Org exige step-up mas o usuário não tem 2º fator — precisa cadastrar MFA.
      try { logAuthEvent(orgId, userId, userId, "MFA_STEP_UP_ENROLL_REQUIRED", {}); } catch { /* noop */ }
      throwCoded("STEP_UP_ENROLL_REQUIRED", "Ative o MFA (autenticação em duas etapas) para executar ações críticas.");
    }
    const secret = EncryptionService.decrypt(u.mfa_secret);
    const ok = !!secret && TOTPService.verify(secret, String(token || ""));
    if (!ok) {
      this.registerFail(orgId, userId);
      try { logAuthEvent(orgId, userId, userId, "MFA_STEP_UP_FAILED", {}); } catch { /* noop */ }
      throwCoded("STEP_UP_INVALID", "Código MFA inválido.");
    }
    this.clear(orgId, userId);
    try { logAuthEvent(orgId, userId, userId, "MFA_STEP_UP_VERIFIED", {}); } catch { /* noop */ }
  }

  /** Só pra teste: limpa o estado de lockout em memória. */
  static _resetForTests(): void { attempts.clear(); }
}

export default StepUpMfaService;
