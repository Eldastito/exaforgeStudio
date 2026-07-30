/**
 * Módulo Clínica — ALERGIAS DO PACIENTE (ADR-080 Fase 25).
 *
 * Cadastro clínico de alergias a droga/alimento/latex/outros e checagem
 * cruzada contra itens da receita. Bloqueia emissão de receita com item
 * cujo nome cruze com alergia GRAVE (`severe`), permite gravar warning
 * pra alergias `mild`/`moderate` (rastro no docmento — auditor vê que a
 * decisão foi consciente).
 *
 * Dado sensível (LGPD Art. 11): ler/gravar exige consent `dados_sensiveis`,
 * mesmo guardrail do encounter/documents.
 *
 * `active=0` = soft delete. Nunca DELETE de row — histórico de alergia é
 * dado clínico (paciente pode revalidar depois; auditor pode precisar do
 * rastro). `deactivated_at`/`deactivated_by` preservam autoria da baixa.
 *
 * Match determinístico: substância normalizada (lower + trim, sem acento
 * removido — nomes de droga não têm acento na farmacopeia). Cruza contra
 * `drug` do item da receita via `includes` case-insensitive nos dois
 * sentidos (item contém substância OU substância contém item — "Dipirona
 * sódica 500mg" bate contra alergia "dipirona"; alergia "amoxicilina +
 * clavulanato" bate contra item "amoxicilina").
 *
 * Determinístico, zero-token, isolado por `organization_id`.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { LgpdService } from "./LgpdService.js";

export type AllergyKind = "drug" | "food" | "latex" | "other";
export type AllergySeverity = "mild" | "moderate" | "severe";

const ALLOWED_KINDS: AllergyKind[] = ["drug", "food", "latex", "other"];
const ALLOWED_SEVERITIES: AllergySeverity[] = ["mild", "moderate", "severe"];
const SENSITIVE_CONSENT = "dados_sensiveis";

export interface Allergy {
  id: string;
  organizationId: string;
  contactId: string;
  substance: string;         // forma normalizada (busca)
  substanceDisplay: string;  // forma original (UI)
  kind: AllergyKind;
  severity: AllergySeverity;
  reaction: string | null;
  notes: string | null;
  active: boolean;
  createdBy: string | null;
  createdAt: string;
  deactivatedBy: string | null;
  deactivatedAt: string | null;
}

export interface AllergyAlert {
  allergyId: string;
  substance: string;         // display
  severity: AllergySeverity;
  kind: AllergyKind;
  reaction: string | null;
  matchedItem: string;       // texto do `drug` do item da receita
  matchedItemIndex: number;  // posição no array de items
}

function requireConsent(orgId: string, contactId: string) {
  if (!LgpdService.hasConsent(orgId, contactId, SENSITIVE_CONSENT)) {
    const e: any = new Error(
      "Consentimento LGPD para dados sensíveis (saúde) é obrigatório para acessar alergias."
    );
    e.code = "LGPD_CONSENT_REQUIRED";
    throw e;
  }
}

/**
 * Normaliza substância para BUSCA — não estraga o display. Lower + trim +
 * colapsa espaços internos. Não remove acento (nomes farmacológicos oficiais
 * são sem acento; se o usuário digitar com acento é problema dele). Não
 * remove pontuação (dosagem cai fora via campo separado).
 */
function normalizeSubstance(s: string): string {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function hydrate(r: any): Allergy | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    contactId: r.contact_id,
    substance: r.substance,
    substanceDisplay: r.substance_display,
    kind: r.kind,
    severity: r.severity,
    reaction: r.reaction ?? null,
    notes: r.notes ?? null,
    active: Number(r.active || 0) === 1,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    deactivatedBy: r.deactivated_by ?? null,
    deactivatedAt: r.deactivated_at ?? null,
  };
}

function contactExists(orgId: string, contactId: string): boolean {
  const r = db.prepare(`SELECT id FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, contactId) as any;
  return !!r;
}

export class ClinicPatientAllergyService {
  /**
   * Registra uma nova alergia. Valida contato existe no org, whitelist de
   * `kind` e `severity`, substância não vazia. Sem UNIQUE — a mesma
   * substância pode ser registrada de novo depois de desativada (novo
   * episódio), ou coexistir em severidades diferentes (dermatologista
   * marca `mild` na 1ª exposição, atendimento em PS marca `severe` depois
   * de anafilaxia — o gestor decide se desativa a antiga ou não).
   */
  static add(orgId: string, contactId: string, actorId: string | null, input: {
    substance: string;
    kind?: AllergyKind;
    severity?: AllergySeverity;
    reaction?: string | null;
    notes?: string | null;
  }): Allergy {
    if (!contactExists(orgId, contactId)) throw new Error("Paciente não encontrado.");
    requireConsent(orgId, contactId);

    const substanceDisplay = String(input.substance || "").trim();
    if (!substanceDisplay) throw new Error("Informe a substância da alergia.");
    const substance = normalizeSubstance(substanceDisplay);
    if (!substance) throw new Error("Informe a substância da alergia.");

    const kind = String(input.kind || "drug").trim() as AllergyKind;
    if (!ALLOWED_KINDS.includes(kind)) {
      const e: any = new Error(`Tipo inválido. Use: ${ALLOWED_KINDS.join(", ")}.`);
      e.code = "ALLERGY_INVALID_KIND"; throw e;
    }
    const severity = String(input.severity || "moderate").trim() as AllergySeverity;
    if (!ALLOWED_SEVERITIES.includes(severity)) {
      const e: any = new Error(`Severidade inválida. Use: ${ALLOWED_SEVERITIES.join(", ")}.`);
      e.code = "ALLERGY_INVALID_SEVERITY"; throw e;
    }

    const reaction = input.reaction ? String(input.reaction).trim().slice(0, 500) || null : null;
    const notes = input.notes ? String(input.notes).trim().slice(0, 1000) || null : null;

    const id = randomUUID();
    db.prepare(
      `INSERT INTO clinical_patient_allergies
         (id, organization_id, contact_id, substance, substance_display, kind, severity, reaction, notes, active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(id, orgId, contactId, substance, substanceDisplay.slice(0, 200), kind, severity, reaction, notes, actorId);

    logAuthEvent(orgId, actorId, contactId, "CLINIC_ALLERGY_ADDED", {
      allergyId: id, substance: substanceDisplay, kind, severity,
    });

    return this.get(orgId, id, { bypassConsent: true })!;
  }

  /**
   * Atualiza campos mutáveis da alergia (severity/reaction/notes; NUNCA a
   * substância — pra trocar substância desativa a linha e cria outra, senão
   * o histórico fica ambíguo).
   */
  static update(orgId: string, allergyId: string, actorId: string | null, patch: {
    severity?: AllergySeverity;
    reaction?: string | null;
    notes?: string | null;
    kind?: AllergyKind;
  }): Allergy {
    const before = this.get(orgId, allergyId, { bypassConsent: true });
    if (!before) throw new Error("Alergia não encontrada.");
    requireConsent(orgId, before.contactId);

    const fields: string[] = [], params: any[] = [];
    if (patch.severity !== undefined) {
      const s = String(patch.severity || "").trim() as AllergySeverity;
      if (!ALLOWED_SEVERITIES.includes(s)) {
        const e: any = new Error(`Severidade inválida. Use: ${ALLOWED_SEVERITIES.join(", ")}.`);
        e.code = "ALLERGY_INVALID_SEVERITY"; throw e;
      }
      fields.push("severity = ?"); params.push(s);
    }
    if (patch.kind !== undefined) {
      const k = String(patch.kind || "").trim() as AllergyKind;
      if (!ALLOWED_KINDS.includes(k)) {
        const e: any = new Error(`Tipo inválido. Use: ${ALLOWED_KINDS.join(", ")}.`);
        e.code = "ALLERGY_INVALID_KIND"; throw e;
      }
      fields.push("kind = ?"); params.push(k);
    }
    if (patch.reaction !== undefined) {
      fields.push("reaction = ?");
      params.push(patch.reaction ? String(patch.reaction).trim().slice(0, 500) || null : null);
    }
    if (patch.notes !== undefined) {
      fields.push("notes = ?");
      params.push(patch.notes ? String(patch.notes).trim().slice(0, 1000) || null : null);
    }
    if (!fields.length) return before;

    db.prepare(
      `UPDATE clinical_patient_allergies SET ${fields.join(", ")} WHERE id = ? AND organization_id = ?`
    ).run(...params, allergyId, orgId);

    logAuthEvent(orgId, actorId, before.contactId, "CLINIC_ALLERGY_UPDATED", {
      allergyId, changed: Object.keys(patch),
    });
    return this.get(orgId, allergyId, { bypassConsent: true })!;
  }

  /**
   * Soft delete — `active=0` + timestamp/actor da baixa. Idempotente: 2ª
   * chamada sobre alergia já desativada devolve o estado atual sem tocar
   * o timestamp da 1ª baixa. Row nunca sai do banco.
   */
  static deactivate(orgId: string, allergyId: string, actorId: string | null): Allergy {
    const before = this.get(orgId, allergyId, { bypassConsent: true });
    if (!before) throw new Error("Alergia não encontrada.");
    requireConsent(orgId, before.contactId);
    if (!before.active) return before;

    db.prepare(
      `UPDATE clinical_patient_allergies
         SET active = 0, deactivated_by = ?, deactivated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`
    ).run(actorId, allergyId, orgId);

    logAuthEvent(orgId, actorId, before.contactId, "CLINIC_ALLERGY_DEACTIVATED", {
      allergyId, substance: before.substanceDisplay,
    });
    return this.get(orgId, allergyId, { bypassConsent: true })!;
  }

  /**
   * Get por id. Consent gate padrão; `bypassConsent` só pra reuso interno
   * (add/update/deactivate já checaram; ou o hook em `createPrescription`
   * que precisa comparar alergias sem duplicar o gate do próprio prescription).
   * Row inexistente NÃO gata consent (padrão do módulo — nada a esconder).
   */
  static get(orgId: string, allergyId: string, opts: { bypassConsent?: boolean } = {}): Allergy | null {
    const r = db.prepare(
      `SELECT * FROM clinical_patient_allergies WHERE id = ? AND organization_id = ?`
    ).get(allergyId, orgId);
    const h = hydrate(r);
    if (!h) return null;
    if (!opts.bypassConsent) requireConsent(orgId, h.contactId);
    return h;
  }

  /**
   * Lista alergias de um paciente. Default só ATIVAS (o que interfere em
   * receita nova); `includeInactive` traz baixadas também (auditor/painel
   * de histórico). Ordena por severity (severe first) e depois por created_at
   * DESC — quem for exibir na UI vê primeiro o que mais importa.
   */
  static list(orgId: string, contactId: string, opts: { includeInactive?: boolean } = {}): Allergy[] {
    requireConsent(orgId, contactId);
    const rows = db.prepare(
      `SELECT * FROM clinical_patient_allergies
        WHERE organization_id = ? AND contact_id = ?
          ${opts.includeInactive ? "" : "AND active = 1"}`
    ).all(orgId, contactId) as any[];
    const SEV_RANK: Record<AllergySeverity, number> = { severe: 0, moderate: 1, mild: 2 };
    return rows.map((r) => hydrate(r)!).filter(Boolean).sort((a, b) => {
      const sa = SEV_RANK[a.severity] ?? 3, sb = SEV_RANK[b.severity] ?? 3;
      if (sa !== sb) return sa - sb;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
  }

  /**
   * Checa itens de receita contra alergias ATIVAS do paciente. Devolve
   * `alerts[]` — vazio quando nada casa. Sem consent lançado NÃO acontece
   * aqui — o gate é responsabilidade do caller (o `createPrescription` já
   * pediu consent antes de chegar). Volume esperado é pequeno (alergias
   * por paciente <20, itens por receita <10) — O(n·m) em memória é fino.
   *
   * Match TOKEN-based: substância e item viram conjuntos de tokens (palavras
   * ≥3 chars, sem números/pontuação). Match se QUALQUER token não-trivial
   * da substância aparece em qualquer token do item OU vice-versa (substring
   * em qualquer sentido dentro do token). Cobre:
   *   - "Dipirona 500mg" vs "dipirona" → token "dipirona" == "dipirona" ✓
   *   - "amoxicilina + clavulanato" vs "amoxicilina 500" → token "amoxicilina" == "amoxicilina" ✓
   *   - "Amoxicilina 500" vs "amoxicilina" (desativada — não passa pra cá) → não bate
   *   - "Losartana" vs "Losar" → prefixo dentro de token ✓ (defensivo)
   * Ignora tokens ≤2 chars ("de", "e", "500") e tokens que sejam só dígitos
   * (dose não deve gerar match espúrio).
   */
  static checkPrescription(orgId: string, contactId: string, items: Array<{ drug?: string }>): AllergyAlert[] {
    if (!Array.isArray(items) || !items.length) return [];
    const rows = db.prepare(
      `SELECT * FROM clinical_patient_allergies
        WHERE organization_id = ? AND contact_id = ? AND active = 1`
    ).all(orgId, contactId) as any[];
    if (!rows.length) return [];

    const tokenize = (s: string): string[] =>
      normalizeSubstance(s)
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !/^\d+$/.test(t));

    const substanceTokensByRow = rows.map((r) => ({ row: r, tokens: tokenize(String(r.substance || "")) }));

    const alerts: AllergyAlert[] = [];
    items.forEach((item, idx) => {
      const drugText = String(item?.drug || "");
      const itemTokens = tokenize(drugText);
      if (!itemTokens.length) return;
      for (const { row: r, tokens: sTokens } of substanceTokensByRow) {
        if (!sTokens.length) continue;
        // Match: algum token da substância aparece dentro de algum token do
        // item (ou vice-versa) — cobre plural, sufixo de dosagem colado, prefixo.
        const hit = sTokens.some((st) =>
          itemTokens.some((it) => it.includes(st) || st.includes(it))
        );
        if (hit) {
          alerts.push({
            allergyId: r.id,
            substance: r.substance_display,
            severity: r.severity,
            kind: r.kind,
            reaction: r.reaction ?? null,
            matchedItem: drugText,
            matchedItemIndex: idx,
          });
        }
      }
    });
    return alerts;
  }

  /** Helper — algum alerta severo entre os alertas? */
  static hasSevere(alerts: AllergyAlert[]): boolean {
    return alerts.some((a) => a.severity === "severe");
  }
}

export default ClinicPatientAllergyService;
