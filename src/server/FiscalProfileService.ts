/**
 * FiscalProfileService — ADR-181 F1: Perfil Fiscal da org (prontidão Reforma Tributária).
 *
 * Identidade fiscal ESTRUTURADA por-org que o motor CBS/IBS/IS (F3) precisa: regime tributário
 * + inscrições + município (código IBGE — fato gerador do IBS) + a opção pelo regime regular
 * (Simples híbrido). É o recorte fiscal de 1ª classe — NÃO substitui o fluxo de formalização
 * MEI do Comigo (`comigo_cnpj`/`comigo_formalization`), que é grosseiro; aqui o CNPJ continua
 * sendo lido/escrito por aquele fluxo (fonte única), e o perfil fiscal só o REFLETE.
 *
 * Guardrails (RN-FISCAL):
 *  - Nada é presumido: regime não declarado → null; NUNCA "chuta" MEI/Simples (RN-FISCAL-4).
 *  - `completeness` é DERIVADO (RN-004), não um flag mutável — diz o que falta pro cálculo.
 *  - Simples default = DAS: `regimeRegularOptin` nasce 0; só o dono liga o híbrido (RN-FISCAL-9).
 *  - Isolamento por organization_id (convenção nº 1). Determinístico. `save` só grava o patch.
 *  - Sem lógica de alíquota/emissão aqui — isto é só identidade (a lei vive na base curada F2).
 */
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

/** Regimes tributários aceitos. String livre validada aqui (não enum de coluna — convenção nº 2). */
export const FISCAL_REGIMES = ["mei", "simples", "simples_hibrido", "presumido", "real"] as const;
export type FiscalRegime = (typeof FISCAL_REGIMES)[number];

export interface FiscalProfile {
  organizationId: string;
  cnpj: string | null;              // reflete comigo_cnpj (fonte única)
  regime: FiscalRegime | null;      // null = não declarado (nunca presumido)
  regimeRegularOptin: boolean;      // Simples híbrido: recolhe CBS/IBS por fora (gera crédito)
  municipalRegistration: string | null;
  stateRegistration: string | null;
  municipalityIbge: string | null; // código IBGE do município (chave do IBS municipal)
  municipalityName: string | null;
  uf: string | null;                // reflete address_state
}

export interface FiscalProfileInput {
  regime?: string | null;
  regimeRegularOptin?: boolean;
  municipalRegistration?: string | null;
  stateRegistration?: string | null;
  municipalityIbge?: string | null;
  municipalityName?: string | null;
}

/** O que ainda falta para o motor CBS/IBS/IS calcular (derivado, RN-004). */
export interface FiscalCompleteness {
  complete: boolean;
  missing: string[];                // ex.: ["regime", "cnpj", "municipalityIbge"]
  regimeIsSimples: boolean;         // simples ou simples_hibrido (afeta o cálculo/crédito)
}

function normDigits(v: unknown, max: number): string | null {
  const s = String(v ?? "").replace(/\D/g, "").slice(0, max);
  return s || null;
}
function normText(v: unknown, max = 120): string | null {
  const s = String(v ?? "").trim().slice(0, max);
  return s || null;
}

export class FiscalProfileService {
  /** Perfil fiscal da org. Campos ausentes voltam null (honesto — nunca inventado). */
  static get(orgId: string): FiscalProfile {
    const o = db.prepare(
      `SELECT comigo_cnpj, fiscal_regime, fiscal_regime_regular_optin,
              fiscal_municipal_registration, fiscal_state_registration,
              fiscal_municipality_ibge, fiscal_municipality_name, address_state
         FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any;
    if (!o) throw new Error("organization_not_found");
    const regime = FISCAL_REGIMES.includes(o.fiscal_regime) ? (o.fiscal_regime as FiscalRegime) : null;
    return {
      organizationId: orgId,
      cnpj: o.comigo_cnpj || null,
      regime,
      regimeRegularOptin: !!Number(o.fiscal_regime_regular_optin),
      municipalRegistration: o.fiscal_municipal_registration || null,
      stateRegistration: o.fiscal_state_registration || null,
      municipalityIbge: o.fiscal_municipality_ibge || null,
      municipalityName: o.fiscal_municipality_name || null,
      uf: o.address_state || null,
    };
  }

  /**
   * Grava o patch passado (só os campos presentes — não zera o que não veio). Regime inválido
   * → erro (não silencia). `regimeRegularOptin` só faz sentido no Simples; fora do Simples
   * força 0 (não há "híbrido" pra Presumido/Real — o campo fica inerte, mas nunca mente).
   */
  static save(orgId: string, input: FiscalProfileInput, actorId?: string): FiscalProfile {
    const cur = this.get(orgId); // valida a org existir
    const sets: string[] = [];
    const vals: any[] = [];

    if (input.regime !== undefined) {
      const r = input.regime === null ? null : String(input.regime).trim().toLowerCase();
      if (r !== null && !FISCAL_REGIMES.includes(r as FiscalRegime)) throw new Error("fiscal_regime_invalid");
      sets.push("fiscal_regime = ?"); vals.push(r);
    }
    if (input.regimeRegularOptin !== undefined) {
      // Só liga híbrido se o regime (novo ou atual) for Simples. Fora do Simples → 0.
      const effRegime = input.regime !== undefined ? input.regime : cur.regime;
      const isSimples = effRegime === "simples" || effRegime === "simples_hibrido";
      sets.push("fiscal_regime_regular_optin = ?"); vals.push(isSimples && input.regimeRegularOptin ? 1 : 0);
    }
    if (input.municipalRegistration !== undefined) { sets.push("fiscal_municipal_registration = ?"); vals.push(normDigits(input.municipalRegistration, 30)); }
    if (input.stateRegistration !== undefined) { sets.push("fiscal_state_registration = ?"); vals.push(normDigits(input.stateRegistration, 30)); }
    if (input.municipalityIbge !== undefined) { sets.push("fiscal_municipality_ibge = ?"); vals.push(normDigits(input.municipalityIbge, 7)); }
    if (input.municipalityName !== undefined) { sets.push("fiscal_municipality_name = ?"); vals.push(normText(input.municipalityName)); }

    if (sets.length) {
      vals.push(orgId);
      db.prepare(`UPDATE organization_settings SET ${sets.join(", ")} WHERE organization_id = ?`).run(...vals);
      try { logAuthEvent(orgId, actorId || "system", null, "FISCAL_PROFILE_UPDATE", { fields: sets.map((s) => s.split(" = ")[0]) }); } catch { /* noop */ }
    }
    return this.get(orgId);
  }

  /**
   * O que falta para o motor CBS/IBS/IS calcular (RN-FISCAL-4). NÃO tenta calcular nada —
   * só reporta a lacuna de identidade. CNPJ e regime são o mínimo; o município (IBGE) é
   * exigido pro IBS municipal; a inscrição estadual só é cobrada de contribuinte de mercadoria
   * (não bloqueia serviço puro), então fica FORA do mínimo (avisada, não exigida).
   */
  static completeness(orgId: string): FiscalCompleteness {
    const p = this.get(orgId);
    const missing: string[] = [];
    if (!p.cnpj) missing.push("cnpj");
    if (!p.regime) missing.push("regime");
    if (!p.municipalityIbge) missing.push("municipalityIbge");
    if (!p.uf) missing.push("uf");
    const regimeIsSimples = p.regime === "simples" || p.regime === "simples_hibrido";
    return { complete: missing.length === 0, missing, regimeIsSimples };
  }
}

export default FiscalProfileService;
