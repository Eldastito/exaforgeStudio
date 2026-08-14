/**
 * SecurityConfigurationService — validação de configuração de segurança no BOOT (SEC-F2 / SEC-04).
 *
 * FAIL CLOSED opt-in: em produção, se faltar segredo crítico, o serviço AVISA alto e marca
 * `degraded`; e — quando `SECURITY_STRICT_BOOT=1` — sinaliza `hasCritical` para o boot ABORTAR
 * (o `server.ts` decide o `process.exit`). Sem a flag, NÃO bloqueia o boot (não brica um deploy
 * que hoje deriva a cifra do `JWT_SECRET`); a flag é ligada DEPOIS da migração de chaves.
 *
 * Determinístico e injetável (`validateBoot(env)`), sem DB nem efeitos — roda em CI. Espelha a
 * semântica real do `EncryptionService.resolveKey()` (chave = `ENCRYPTION_KEY || JWT_SECRET`;
 * sem nenhum dos dois → chave HARDCODED conhecida). O relatório é REDIGIDO: expõe presença/
 * tamanho/códigos, NUNCA o valor do segredo.
 *
 * MIGRAÇÃO SEGURA (por que não hard-fail imediato): hoje a cifra usa `sha256(JWT_SECRET)`. Definir
 * uma `ENCRYPTION_KEY` NOVA e aleatória tornaria os segredos já cifrados indecifráveis. O caminho
 * seguro é: (1) `ENCRYPTION_KEY` := valor atual do `JWT_SECRET` (preserva a leitura), (2) rotacionar
 * para uma chave dedicada com `scripts/rotate-encryption-key.ts`, (3) ligar `SECURITY_STRICT_BOOT=1`.
 */

export type BootSeverity = "critical" | "warning";
export interface BootIssue { code: string; severity: BootSeverity; message: string; }
export interface BootReport {
  production: boolean;
  strict: boolean;
  ok: boolean;
  degraded: boolean;
  hasCritical: boolean;
  issues: BootIssue[];
}

const MIN_KEY_LEN = 16;
const PLACEHOLDER_PATTERNS = [/^change[-_ ]?me/i, /^your[-_ ]/i, /placeholder/i, /^example/i, /zappflow-dev-key-fallback/i];

export class SecurityConfigurationService {
  /** Valida a configuração de segredos (puro/determinístico). Não lê DB, não tem efeito. */
  static validateBoot(env: Record<string, string | undefined> = process.env): BootReport {
    const production = env.NODE_ENV === "production";
    const strict = /^(1|true|yes|on)$/i.test(String(env.SECURITY_STRICT_BOOT || ""));
    const issues: BootIssue[] = [];

    const encKey = env.ENCRYPTION_KEY || "";
    const jwt = env.JWT_SECRET || "";

    // Material da chave de cifra — espelha EncryptionService.resolveKey (ENCRYPTION_KEY || JWT_SECRET).
    if (!encKey && !jwt) {
      issues.push({ code: "encryption_key_fallback", severity: "critical",
        message: "Nem ENCRYPTION_KEY nem JWT_SECRET definidos — a cifra usa a chave HARDCODED conhecida ('zappflow-dev-key-fallback'). Segredos em repouso ficam trivialmente decifráveis." });
    } else if (!encKey && jwt) {
      issues.push({ code: "encryption_key_derived", severity: "warning",
        message: "ENCRYPTION_KEY ausente — cifra derivada do JWT_SECRET. Rotacionar o JWT quebra a leitura dos segredos guardados. Defina ENCRYPTION_KEY dedicada (SEC-04)." });
    }
    if (encKey && jwt && encKey === jwt) {
      issues.push({ code: "encryption_key_equals_jwt", severity: "warning",
        message: "ENCRYPTION_KEY === JWT_SECRET — mesmos ciclos de vida; comprometer um expõe assinatura de sessão E cifra de segredos. Use valores distintos (SEC-04)." });
    }
    if (encKey && encKey.length < MIN_KEY_LEN) {
      issues.push({ code: "encryption_key_short", severity: "warning",
        message: `ENCRYPTION_KEY curta (${encKey.length} < ${MIN_KEY_LEN} chars). Gere com 'openssl rand -hex 32'.` });
    }
    for (const [label, val] of [["ENCRYPTION_KEY", encKey], ["JWT_SECRET", jwt]] as const) {
      if (val && PLACEHOLDER_PATTERNS.some((re) => re.test(val))) {
        issues.push({ code: `weak_${label.toLowerCase()}_placeholder`, severity: "critical",
          message: `${label} parece um placeholder/valor de exemplo — troque por um segredo aleatório antes de subir em produção.` });
      }
    }
    // JWT_SECRET fora do ambiente em produção: EncryptionService lê o env CRU; multi-instância exige env.
    if (production && !jwt) {
      issues.push({ code: "jwt_secret_env_missing", severity: "warning",
        message: "JWT_SECRET não está no ambiente (usando o segredo persistido em DATA_DIR). Multi-instância e a cifra dedicada exigem JWT_SECRET no ambiente." });
    }

    const hasCritical = issues.some((i) => i.severity === "critical");
    return { production, strict, ok: issues.length === 0, degraded: issues.length > 0, hasCritical, issues };
  }

  /**
   * Loga o relatório (crítico → error, senão warn) e o devolve. NÃO chama `process.exit` — quem
   * decide abortar é o `server.ts` (produção + strict + crítico), mantendo este serviço testável.
   */
  static enforceBoot(env: Record<string, string | undefined> = process.env): BootReport {
    const r = this.validateBoot(env);
    for (const i of r.issues) {
      const line = `[SECURITY] boot ${i.severity}: ${i.code} — ${i.message}`;
      if (i.severity === "critical") console.error(line); else console.warn(line);
    }
    if (r.production && r.degraded && !r.strict) {
      console.warn("[SECURITY] Configuração de segurança DEGRADADA em produção. Após corrigir os segredos, ligue SECURITY_STRICT_BOOT=1 para exigir boot fail-closed (SEC-04).");
    }
    if (r.production && r.strict && r.hasCritical) {
      console.error("[SECURITY] SECURITY_STRICT_BOOT=1 + falha CRÍTICA de configuração — o boot deve ser abortado (fail-closed).");
    }
    return r;
  }

  /** Relatório REDIGIDO para a rota master (nunca inclui valores de segredo). */
  static report(env: Record<string, string | undefined> = process.env): BootReport {
    return this.validateBoot(env);
  }
}

export default SecurityConfigurationService;
