/**
 * Resolução COMUM de identidade do remetente (PRD WhatsApp Unificado — RF-04 §10).
 *
 * Hoje a identidade do remetente é re-derivada em cada serviço, por dois
 * conceitos NÃO relacionados:
 *   - `users.phone`  → GestorCommandService.resolveUser / CoordenadorService (com RBAC)
 *   - `authorized_managers.identifier` → AIOrchestratorService (só filiação, SEM RBAC)
 *
 * Esta fachada CONCILIA os dois num único ponto read-only, SEM elevar privilégio
 * (RN-RF04). Invariantes duros:
 *
 *   1. Telefone é ENDEREÇO do canal, não substitui o usuário/perfil (§10). O
 *      papel vem SEMPRE do `users` casado — NUNCA da presença em
 *      `authorized_managers`. Um número que só consta como manager legado é
 *      `legacyManagerOnly` e carrega `role: null` (não vira admin).
 *   2. Vínculo AMBÍGUO fica PENDENTE (§10): se 2+ usuários casam o mesmo número
 *      (tolerância de 9º dígito/sufixo), NÃO escolhe um — devolve `user: null`,
 *      `ambiguous: true`. O chamador decide (pedir desambiguação), nunca o
 *      resolvedor "chuta" uma identidade.
 *   3. Registra o NÍVEL DE CONFIANÇA do match: `exact` (dígitos idênticos após
 *      normalizar DDI) → high; `tolerant` (casou só por 9º dígito/sufixo) →
 *      medium. Migração/roteamento futuro usa isso; não aumenta privilégio.
 *
 * Multi-tenant: TODA consulta filtra `organization_id` (1º arg). Read-only —
 * não escreve nada, não muda estado. Nasce testado; os consumidores
 * (Gestor/Coordenador/Orchestrator) são religados na fatia de modo misto (F3.3),
 * então esta fatia é 0-regressão.
 */
import db from "./db.js";
import { onlyDigits, phoneMatches } from "./phoneMatch.js";

export type SenderMatchType = "exact" | "tolerant" | "ambiguous" | "none";
export type SenderConfidence = "high" | "medium" | "low" | "none";

export interface ResolvedSender {
  /** Usuário casado por `users.phone` (linha completa) — a identidade/perfil REAL. null se não houver 1 único match. */
  user: any | null;
  /** Papel REAL do usuário casado. NUNCA derivado de `authorized_managers`. null sem usuário. */
  role: string | null;
  /** Perfil de papel do usuário casado (RBAC). null sem usuário. */
  roleProfileId: string | null;
  /** O número consta em `authorized_managers` desta org? */
  isAuthorizedManager: boolean;
  /** Consta como manager MAS não há usuário casado → vínculo legado, identidade NÃO plena, sem papel. */
  legacyManagerOnly: boolean;
  /** 2+ usuários casaram o mesmo número → pendente (não escolhe). */
  ambiguous: boolean;
  matchType: SenderMatchType;
  confidence: SenderConfidence;
}

/** Normaliza pra comparação de igualdade EXATA (dígitos, sem DDI 55). */
function normExact(v: unknown): string {
  const d = onlyDigits(v);
  return d.length >= 12 && d.startsWith("55") ? d.slice(2) : d;
}

export class SenderIdentityService {
  /**
   * Resolve quem é o remetente `fromNumber` na org `orgId`, conciliando
   * `users.phone` e `authorized_managers` sem elevar privilégio.
   */
  static resolve(orgId: string, fromNumber: string): ResolvedSender {
    const empty: ResolvedSender = {
      user: null, role: null, roleProfileId: null,
      isAuthorizedManager: false, legacyManagerOnly: false,
      ambiguous: false, matchType: "none", confidence: "none",
    };
    const from = String(fromNumber || "").trim();
    if (!orgId || !from) return empty;

    // ── Usuários da org com telefone (mesma régua do GestorCommandService) ──
    const users = db.prepare(
      "SELECT id, name, email, phone, role, role_profile_id FROM users WHERE organization_id = ? AND phone IS NOT NULL AND phone != '' AND COALESCE(global_status,'active') = 'active'",
    ).all(orgId) as any[];
    const userMatches = users.filter((u) => phoneMatches(u.phone, from));

    // ── Managers legados da org ──
    const managers = db.prepare(
      "SELECT id, identifier, name FROM authorized_managers WHERE organization_id = ?",
    ).all(orgId) as any[];
    const mgrMatches = managers.filter((m) => phoneMatches(m.identifier, from));
    const isAuthorizedManager = mgrMatches.length > 0;

    // ── Ambiguidade de usuário: 2+ casaram → pendente, não escolhe (§10) ──
    if (userMatches.length > 1) {
      return {
        ...empty,
        isAuthorizedManager,
        legacyManagerOnly: false, // há usuário(s); só não sabemos QUAL — não é "só legado"
        ambiguous: true,
        matchType: "ambiguous",
        confidence: "low",
      };
    }

    const user = userMatches.length === 1 ? userMatches[0] : null;
    const legacyManagerOnly = isAuthorizedManager && !user;

    // ── Confiança: baseada no match que ANCORA a identidade resolvida ──
    // (usuário se houver; senão o vínculo de manager legado).
    let matchType: SenderMatchType = "none";
    let confidence: SenderConfidence = "none";
    if (user) {
      const exact = normExact(user.phone) === normExact(from);
      matchType = exact ? "exact" : "tolerant";
      confidence = exact ? "high" : "medium";
    } else if (legacyManagerOnly) {
      const exact = mgrMatches.some((m) => normExact(m.identifier) === normExact(from));
      matchType = exact ? "exact" : "tolerant";
      confidence = exact ? "high" : "medium";
    }

    return {
      user,
      // Papel/perfil vêm SÓ do usuário — presença em authorized_managers nunca eleva.
      role: user ? (user.role ?? null) : null,
      roleProfileId: user ? (user.role_profile_id ?? null) : null,
      isAuthorizedManager,
      legacyManagerOnly,
      ambiguous: false,
      matchType,
      confidence,
    };
  }
}
