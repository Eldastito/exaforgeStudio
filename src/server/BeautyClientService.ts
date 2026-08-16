import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * BeautyClientService (ADR-169 F22 / BEAUTY-023) — cadastro de CLIENTE walk-in
 * do salão.
 *
 * Contexto: um salão recebe clientes que CHEGAM no balcão sem ter mandado
 * mensagem antes. Até aqui, contatos só nasciam de mensagem inbound
 * (`webhookProcessor`), então a recepção não tinha como cadastrar uma cliente
 * nova pra rodar a Beauty AI — o seletor de cliente ficava vazio e o fluxo
 * inteiro travava. Esta fatia dá à recepção um cadastro manual mínimo (nome +
 * telefone) reusando a MESMA tabela `contacts` (§37 — sem CRM paralelo),
 * espelhando o padrão `BalcaoService.ensureFiadoContact` (canal sintético).
 *
 * Decisões:
 *  - Canal sintético `provider='manual'` por org (criado sob demanda) — os
 *    contatos cadastrados na mão ficam num canal próprio, sem depender de um
 *    número de WhatsApp conectado. Não gera ticket (não polui o Kanban).
 *  - `list()` lê a tabela `contacts` DIRETO (não de `/api/tickets`, que só
 *    enxerga contatos com conversa) — é a fonte correta pro seletor da
 *    BeautyView, que precisa ver TODOS os contatos, inclusive os walk-in.
 *  - Dedupe por `(org, channel, identifier=telefone||nome)` via o índice UNIQUE
 *    já existente — reenviar o mesmo cadastro devolve o contato existente
 *    (idempotente), nunca duplica.
 *  - Isolamento por `organization_id` em TODA query (RN-BS-07).
 */
// Ficha técnica capilar — vocab FECHADO (RN-BS-11). Só o que ajuda de
// verdade na recomendação/simulação. Peso/altura/idade ficam FORA
// (minimização LGPD — não mudam recomendação de cor/corte).
export const HAIR_TYPES = ["liso", "ondulado", "cacheado", "crespo"] as const;
export const HAIR_THICKNESS = ["fino", "medio", "grosso"] as const;
export const HAIR_LENGTHS = ["curto", "medio", "longo"] as const;
export const CHEMICAL_HISTORY = ["virgem", "coloracao", "descoloracao", "progressiva", "henna"] as const;
export const MAINTENANCE_PREFS = ["baixa", "media", "alta"] as const;
export const LEAD_SOURCES = ["indicacao", "instagram", "passou_na_porta", "google", "whatsapp", "outro"] as const;

const inVocab = (v: unknown, vocab: readonly string[]): string | null => {
  const s = String(v || "").trim().toLowerCase();
  return vocab.includes(s) ? s : null;
};

export interface BeautyClientProfile {
  hairType: string | null;
  hairThickness: string | null;
  hairLength: string | null;
  chemicalHistory: string | null;
  maintenancePref: string | null;
  leadSource: string | null;
  leadSourceOther: string | null;
  notes: string | null;
}

export class BeautyClientService {
  static profileVocabulary() {
    return {
      hairTypes: HAIR_TYPES, hairThickness: HAIR_THICKNESS, hairLengths: HAIR_LENGTHS,
      chemicalHistory: CHEMICAL_HISTORY, maintenancePrefs: MAINTENANCE_PREFS, leadSources: LEAD_SOURCES,
    };
  }

  /** Grava/atualiza a ficha capilar do contato (upsert por (org,contact)). */
  static saveProfile(orgId: string, contactId: string, p: Partial<BeautyClientProfile>): BeautyClientProfile {
    const contact = db.prepare(`SELECT id FROM contacts WHERE id = ? AND organization_id = ?`).get(contactId, orgId);
    if (!contact) throw new Error("Contato não encontrado nesta organização.");
    const lead = inVocab(p.leadSource, LEAD_SOURCES);
    const clean = {
      hair_type: inVocab(p.hairType, HAIR_TYPES),
      hair_thickness: inVocab(p.hairThickness, HAIR_THICKNESS),
      hair_length: inVocab(p.hairLength, HAIR_LENGTHS),
      chemical_history: inVocab(p.chemicalHistory, CHEMICAL_HISTORY),
      maintenance_pref: inVocab(p.maintenancePref, MAINTENANCE_PREFS),
      lead_source: lead,
      // F33 — detalhe do "Outro" só faz sentido quando lead_source='outro';
      // em qualquer outra origem o texto livre é ignorado (não polui a ficha).
      lead_source_other: lead === "outro" ? (String(p.leadSourceOther || "").trim().slice(0, 120) || null) : null,
      notes: String(p.notes || "").slice(0, 500) || null,
    };
    db.prepare(
      `INSERT INTO beauty_client_profiles (id, organization_id, contact_id, hair_type, hair_thickness, hair_length, chemical_history, maintenance_pref, lead_source, lead_source_other, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, contact_id) DO UPDATE SET
         hair_type = COALESCE(excluded.hair_type, hair_type),
         hair_thickness = COALESCE(excluded.hair_thickness, hair_thickness),
         hair_length = COALESCE(excluded.hair_length, hair_length),
         chemical_history = COALESCE(excluded.chemical_history, chemical_history),
         maintenance_pref = COALESCE(excluded.maintenance_pref, maintenance_pref),
         lead_source = COALESCE(excluded.lead_source, lead_source),
         -- F33: se a origem não foi tocada (excluded null) → mantém; se virou
         -- 'outro' → grava o texto novo; se virou origem do vocab → limpa o
         -- detalhe (senão o COALESCE preservaria o texto antigo, poluindo).
         lead_source_other = CASE
           WHEN excluded.lead_source IS NULL THEN lead_source_other
           WHEN excluded.lead_source = 'outro' THEN excluded.lead_source_other
           ELSE NULL END,
         notes = COALESCE(excluded.notes, notes),
         updated_at = CURRENT_TIMESTAMP`,
    ).run(randomUUID(), orgId, contactId, clean.hair_type, clean.hair_thickness, clean.hair_length,
          clean.chemical_history, clean.maintenance_pref, clean.lead_source, clean.lead_source_other, clean.notes);
    return this.getProfile(orgId, contactId)!;
  }

  static getProfile(orgId: string, contactId: string): BeautyClientProfile | null {
    const r = db.prepare(`SELECT * FROM beauty_client_profiles WHERE organization_id = ? AND contact_id = ?`).get(orgId, contactId) as any;
    if (!r) return null;
    return {
      hairType: r.hair_type, hairThickness: r.hair_thickness, hairLength: r.hair_length,
      chemicalHistory: r.chemical_history, maintenancePref: r.maintenance_pref,
      leadSource: r.lead_source, leadSourceOther: r.lead_source_other ?? null, notes: r.notes,
    };
  }

  /** Canal sintético "manual" da org (cadastro de balcão), criado sob demanda. */
  private static ensureManualChannel(orgId: string): string {
    const ch = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND provider = 'manual'`).get(orgId) as any;
    if (ch) return ch.id;
    const chId = randomUUID();
    db.prepare(
      `INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'manual', 'Cadastro', 'manual', 'connected')`
    ).run(chId, orgId);
    return chId;
  }

  /** Lista os contatos da org (para o seletor de cliente da Beauty AI). */
  static list(orgId: string): Array<{ id: string; name: string; identifier: string | null }> {
    const rows = db.prepare(
      `SELECT id, name, identifier FROM contacts WHERE organization_id = ? ORDER BY COALESCE(name, identifier) COLLATE NOCASE ASC`
    ).all(orgId) as any[];
    return rows.map(r => ({ id: r.id, name: r.name || "Sem nome", identifier: r.identifier || null }));
  }

  /**
   * Cria (ou reusa) um contato manual com nome + telefone. Retorna o contato.
   * `name` é obrigatório (o service valida o invariante); `phone` é opcional
   * mas recomendado — sem telefone, o identifier cai pro nome (a dedupe fica
   * mais fraca, mas não quebra).
   */
  static create(
    orgId: string,
    input: { name?: string; phone?: string; email?: string; profile?: Partial<BeautyClientProfile> },
  ): { id: string; name: string; identifier: string } {
    const name = String(input.name || "").trim();
    if (!name) throw new Error("Informe o nome da cliente.");
    const phone = String(input.phone || "").trim();
    const email = String(input.email || "").trim() || null;
    const identifier = phone || name;

    const channelId = this.ensureManualChannel(orgId);
    const existing = db.prepare(
      `SELECT id, name FROM contacts WHERE organization_id = ? AND channel_id = ? AND identifier = ?`
    ).get(orgId, channelId, identifier) as any;
    let contactId: string;
    if (existing) {
      // Atualiza nome/email se o cadastro trouxe mais completo (idempotente,
      // nunca duplica). Mantém o contato existente.
      contactId = existing.id;
      if (existing.name !== name) {
        db.prepare(`UPDATE contacts SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(name, contactId);
      }
      if (email) {
        try { db.prepare(`UPDATE contacts SET email = ? WHERE id = ? AND (email IS NULL OR email = '')`).run(email, contactId); } catch { /* coluna pode não existir em schema antigo */ }
      }
    } else {
      contactId = randomUUID();
      db.prepare(
        `INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`
      ).run(contactId, orgId, channelId, name, identifier);
      if (email) {
        try { db.prepare(`UPDATE contacts SET email = ? WHERE id = ?`).run(email, contactId); } catch { /* noop */ }
      }
    }
    // Ficha capilar opcional junto do cadastro (lead completo de balcão).
    if (input.profile && Object.values(input.profile).some(v => v != null && String(v).trim() !== "")) {
      try { this.saveProfile(orgId, contactId, input.profile); } catch { /* best-effort */ }
    }
    return { id: contactId, name, identifier };
  }
}
