/**
 * AdaptiveOnboardingService — PRD 6 / ADR-163 F5 (§17-§25): onboarding adaptativo.
 *
 * O princípio (§17-§20): em vez de um formulário longo, o ZapFlow OBSERVA o que já
 * sabe, INFERE o perfil da empresa e CONFIRMA ("identifiquei X, correto?"), pedindo
 * só as LACUNAS (§21). É COMPOSIÇÃO (D1/CA17) — lê `organization_settings` + sinais
 * que já existem (lojas, equipe); nenhum motor/tabela novo.
 *
 * GUARDRAIL DURO — RN-UX-6 (§24-§25): o autodiscovery NUNCA inventa. Todo campo
 * declara `source` + `confidence`; valor ausente vira `status:"unknown"` ("ainda
 * não sei") e entra na fila de perguntas — jamais um palpite apresentado como fato.
 *
 * GUARDRAIL DURO — RN-UX-3 (§27/CA11): confirmar ≠ autorizar política material. O
 * `confirm` só grava campo DESCRITIVO (nome/segmento); campo que altera entitlement
 * (vertical/plano) é recusado com motivo — a troca passa pelo fluxo de blueprint.
 *
 * Isolado por org (RN-004: derivado por query); auditável (`logAuthEvent`).
 */
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

export type FieldStatus = "known" | "uncertain" | "unknown";
export interface ProfileField {
  key: string; label: string;
  value: string | number | null;
  displayValue: string;
  source: string;                       // organization_settings | derived:retail_stores | ...
  confidence: "alta" | "média" | "baixa" | null;
  status: FieldStatus;
  needsConfirmation: boolean;           // confirmation-first (§18-20)
  question: string | null;              // preenchido só quando é lacuna (§21)
}

// Campos DESCRITIVOS que a confirmação pode gravar direto (não mexem em
// entitlement/política material). Chave lógica → coluna em organization_settings.
const CONFIRMABLE: Record<string, string> = { businessName: "business_name", segment: "segment" };
// Campos que ALTERAM entitlement/blueprint — confirmar aqui é recusado (RN-UX-3).
const MATERIAL_FIELDS = new Set(["vertical", "plan"]);

export class AdaptiveOnboardingService {
  /** Observa→infere→apresenta: o perfil autodescoberto + as lacunas a perguntar. */
  static discover(orgId: string, _user?: any): {
    adaptiveOnboardingEnabled: boolean;
    profile: ProfileField[];
    gaps: ProfileField[];
    completeness: number;
    nextQuestion: string | null;
    generatedAt: string;
  } {
    const s = db.prepare(
      `SELECT business_name, vertical, segment, phone, adaptive_onboarding_enabled FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any || {};
    const count = (sql: string) => { try { return (db.prepare(sql).get(orgId) as any)?.n || 0; } catch { return 0; } };
    const stores = count(`SELECT COUNT(*) n FROM retail_stores WHERE organization_id = ?`);
    const team = count(`SELECT COUNT(*) n FROM employees WHERE organization_id = ?`)
      || count(`SELECT COUNT(*) n FROM users WHERE organization_id = ?`);

    const profile: ProfileField[] = [
      this.textField("businessName", "Nome do negócio", s.business_name, "organization_settings",
        "Qual é o nome do seu negócio?"),
      this.textField("vertical", "Ramo de atuação", s.vertical, "organization_settings",
        "Em qual ramo você atua?"),
      this.textField("segment", "Segmento", s.segment, "organization_settings",
        "Como você descreveria seu segmento?"),
      this.textField("contact", "Contato (WhatsApp)", s.phone, "organization_settings",
        "Qual o WhatsApp de contato?"),
      // Derivados: contagem>0 é conhecido; 0 é INCERTO (pode ser negócio de um ponto só) — nunca "inventado".
      this.countField("units", "Unidades/Lojas", stores, "derived:retail_stores",
        "Você opera em quantas unidades?"),
      this.countField("team", "Equipe", team, "derived:employees/users",
        "Quantas pessoas trabalham com você?"),
    ];

    const gaps = profile.filter((f) => f.status !== "known");
    const known = profile.length - gaps.length;
    return {
      adaptiveOnboardingEnabled: !!Number(s.adaptive_onboarding_enabled),
      profile,
      gaps,
      completeness: Math.round((known / profile.length) * 100) / 100,
      // Pergunta UMA por vez (§21) — a lacuna de maior prioridade (ordem do profile).
      nextQuestion: gaps.length ? gaps[0].question : null,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Confirma/corrige um campo. Só grava DESCRITIVO (RN-UX-3): campo material
   * (vertical/plano) é recusado com motivo — não vira autorização por inferência.
   */
  static confirm(orgId: string, actorId: string | undefined, input: { key: string; value?: string | null }): {
    applied: boolean; key: string; value: string | null; reason?: string;
  } {
    const key = String(input?.key || "");
    if (MATERIAL_FIELDS.has(key)) {
      return { applied: false, key, value: null, reason: "Alterar ramo/plano muda o que o ZapFlow libera — isso passa pelo fluxo de onboarding/blueprint, não por confirmação (RN-UX-3)." };
    }
    const col = CONFIRMABLE[key];
    if (!col) return { applied: false, key, value: null, reason: "Campo não confirmável por aqui." };
    const value = input.value != null ? String(input.value).trim() : null;
    if (!value) return { applied: false, key, value: null, reason: "Valor vazio — nada a gravar." };
    db.prepare(`UPDATE organization_settings SET ${col} = ? WHERE organization_id = ?`).run(value, orgId);
    logAuthEvent(orgId, actorId, null, "ONBOARDING_FIELD_CONFIRMED", { key, column: col });
    return { applied: true, key, value };
  }

  // ── helpers ──

  private static textField(key: string, label: string, raw: any, source: string, question: string): ProfileField {
    const value = raw != null && String(raw).trim() ? String(raw).trim() : null;
    const known = value != null;
    return {
      key, label, value, displayValue: known ? value! : "ainda não sei",
      source: known ? source : "—",
      confidence: known ? "alta" : null,
      status: known ? "known" : "unknown",
      needsConfirmation: known,                 // confirmation-first pro que EU acho que sei
      question: known ? null : question,        // pergunto só a lacuna
    };
  }

  private static countField(key: string, label: string, n: number, source: string, question: string): ProfileField {
    if (n > 0) {
      return { key, label, value: n, displayValue: String(n), source, confidence: "alta", status: "known", needsConfirmation: true, question: null };
    }
    // 0 é ambíguo (pode ser 1 ponto só sem cadastro) — INCERTO, não inventado.
    return { key, label, value: null, displayValue: "ainda não sei", source: "—", confidence: null, status: "uncertain", needsConfirmation: false, question };
  }
}

export default AdaptiveOnboardingService;
