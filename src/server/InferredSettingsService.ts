/**
 * InferredSettingsService — PRD 6 / ADR-163 F6 (§26/§101): inferred settings.
 *
 * O ciclo é OBSERVAR → INFERIR → SUGERIR → CONFIRMAR. O ZapFlow nota um padrão
 * (ex.: reembolsos financeiros acontecendo SEM regra de aprovação configurada) e
 * SUGERE uma banda valor→papel — mas a sugestão é inerte até um humano confirmar.
 *
 * GUARDRAIL DURO — RN-UX-3 (§27/CA11): inferência NUNCA vira autorização de
 * política material. `suggestions()` só LÊ e propõe; `apply()` é o ÚNICO caminho
 * que grava, e só roda com a confirmação explícita do gestor (RBAC na rota). A
 * escrita reusa `ApprovalPolicyService.setBands` — nenhum motor de governança novo
 * (RN-159-4). Sugestão conservadora: nunca propõe "allow" pra ação financeira —
 * no máximo require_approval/escalate (dinheiro que sai só afrouxa por decisão
 * humana explícita, jamais por sugestão).
 *
 * Escopo: sugestões de política são coisa de gestor — só visão completa as recebe
 * (§73/RBAC). Derivado por query (RN-004), isolado por org.
 */
import db from "./db.js";
import { ApprovalPolicyService, AutonomyBand } from "./ApprovalPolicyService.js";
import { ContextProjectionService } from "./ContextProjectionService.js";
import { logAuthEvent } from "./auditLog.js";

const OBSERVE_WINDOW_DAYS = 90;

export interface InferredSuggestion {
  key: string;                 // determinístico: `${domain}:${actionType}` (idempotente na UI)
  domain: string;
  actionType: string;
  title: string;
  rationale: string;
  observed: { count: number; maxAmount: number; sinceDays: number };
  suggestedBands: AutonomyBand[];
  confidence: "alta" | "média" | "baixa";
  status: "suggested";         // sempre — nunca "applied" sem confirmação
}

const round = (n: number) => {
  // Arredonda pra um teto "redondo" legível (R$ 500 / 1.000 / 5.000 …).
  const abs = Math.abs(n);
  if (abs <= 500) return 500;
  const mag = Math.pow(10, Math.floor(Math.log10(abs)));
  return Math.ceil(abs / mag) * mag;
};

export class InferredSettingsService {
  /**
   * Observa ações financeiras/destrutivas SEM banda configurada e sugere uma
   * regra. Só pra gestor (visão completa). NUNCA aplica nada.
   */
  static suggestions(orgId: string, user: any): { inferredSettingsEnabled: boolean; suggestions: InferredSuggestion[]; generatedAt: string } {
    const enabledRow = db.prepare(`SELECT COALESCE(inferred_settings_enabled,0) e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    const enabled = !!(enabledRow && Number(enabledRow.e));
    // Política de autonomia é matéria de gestor — role-gate (RN-UX-2/§73).
    if (!ContextProjectionService.hasFullBusinessVisibility(orgId, user)) {
      return { inferredSettingsEnabled: enabled, suggestions: [], generatedAt: new Date().toISOString() };
    }

    const rows = db.prepare(
      `SELECT domain, action_type, COUNT(*) n, MAX(ABS(COALESCE(expected_impact,0))) max_amount
         FROM decision_actions
        WHERE organization_id = ? AND datetime(created_at) >= datetime('now', ?)
        GROUP BY domain, action_type`
    ).all(orgId, `-${OBSERVE_WINDOW_DAYS} day`) as any[];

    const suggestions: InferredSuggestion[] = [];
    for (const r of rows) {
      const domain = r.domain, actionType = r.action_type;
      if (!ApprovalPolicyService.isFinancialOrDestructive(domain, actionType)) continue;
      // Já governado? (banda explícita configurada) → nada a sugerir.
      const c = ApprovalPolicyService.resolveContract(orgId, { domain, actionType, amount: r.max_amount });
      if (c.band) continue;

      const count = Number(r.n) || 0;
      const maxAmount = Number(r.max_amount) || 0;
      const threshold = round(maxAmount);
      // Conservador: exige aprovação até o teto observado; acima, escala pro dono.
      const suggestedBands: AutonomyBand[] = [
        { upTo: threshold, state: "require_approval", role: null },
        { upTo: null, state: "escalate", role: "owner" },
      ];
      suggestions.push({
        key: `${domain}:${actionType}`,
        domain, actionType,
        title: `Definir regra de aprovação para "${actionType}"`,
        rationale: `Observei ${count} ${count > 1 ? "ações" : "ação"} de "${actionType}" em ${domain} nos últimos ${OBSERVE_WINDOW_DAYS} dias (maior valor ${maxAmount ? `R$ ${maxAmount}` : "—"}) sem regra de aprovação. Sugiro exigir aprovação até R$ ${threshold} e escalar pro dono acima disso.`,
        observed: { count, maxAmount, sinceDays: OBSERVE_WINDOW_DAYS },
        suggestedBands,
        confidence: count >= 5 ? "alta" : count >= 2 ? "média" : "baixa",
        status: "suggested",
      });
    }
    // Mais observações primeiro (sugestão mais fundamentada no topo).
    suggestions.sort((a, b) => b.observed.count - a.observed.count);
    return { inferredSettingsEnabled: enabled, suggestions, generatedAt: new Date().toISOString() };
  }

  /**
   * Aplica UMA sugestão — o ÚNICO caminho que grava política (RN-UX-3). Só com
   * confirmação explícita do gestor (RBAC validado na rota). Grava via
   * `ApprovalPolicyService.setBands` (reuso; sem engine novo) e audita.
   */
  static apply(orgId: string, actorId: string | undefined, input: { domain: string; actionType: string; bands: AutonomyBand[] }): {
    applied: boolean; domain: string; actionType: string; bands: AutonomyBand[]; reason?: string;
  } {
    const domain = String(input?.domain || "").trim();
    const actionType = String(input?.actionType || "").trim();
    const bands = Array.isArray(input?.bands) ? input.bands : [];
    if (!domain || !actionType) return { applied: false, domain, actionType, bands: [], reason: "domain e actionType obrigatórios." };
    if (!bands.length) return { applied: false, domain, actionType, bands: [], reason: "Nenhuma banda informada — nada a aplicar." };
    // Sanidade: estados válidos; `upTo` numérico ou null. Config torta não vira política.
    const VALID = new Set(["allow", "require_approval", "escalate", "deny"]);
    for (const b of bands) {
      if (!VALID.has(String(b?.state))) return { applied: false, domain, actionType, bands: [], reason: `Estado inválido: ${b?.state}.` };
      if (b.upTo != null && !(Number(b.upTo) >= 0)) return { applied: false, domain, actionType, bands: [], reason: "upTo deve ser número ≥ 0 ou null." };
    }
    ApprovalPolicyService.setBands(orgId, domain, actionType, bands);
    logAuthEvent(orgId, actorId, null, "INFERRED_SETTING_APPLIED", { domain, actionType, bands });
    return { applied: true, domain, actionType, bands };
  }
}

export default InferredSettingsService;
