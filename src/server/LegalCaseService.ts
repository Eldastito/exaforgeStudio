import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * Legal Case (ADR-191 F4) — o PROCESSO da vertical Advocacia.
 *
 * Registro LONGITUDINAL do caso, modelado no `clinic_care_episodes` (D2 — tabela
 * própria `legal_cases`, não sobrecarrega a clínica). Cliente=contact, área=
 * clinic_specialties, advogado=clinic_professionals (reuso da F3). Vocabulário
 * PROCESSUAL: abrir → (on_hold) → encerrar/arquivar.
 *
 * NÚMERO CNJ (RN-ADV-08 — nunca inventa): validado pelo DÍGITO VERIFICADOR (módulo
 * 97, ISO 7064, Resolução CNJ 65/2008). Número malformado ou com DV errado é
 * REJEITADO; ausente fica NULL (caso consultivo/pré-processual). Unique por org.
 * Isolado por organization_id.
 */

const nowISO = () => new Date().toISOString();
const CASE_TYPES = new Set(["judicial", "consultivo", "administrativo"]);
const LIVE = new Set(["active", "on_hold"]);

export interface CaseInput {
  contactId: string;
  practiceAreaId?: string | null;
  responsibleLawyerId?: string | null;
  cnjNumber?: string | null;
  title: string;
  caseType?: string | null;
  court?: string | null;
  comarca?: string | null;
  opposingParty?: string | null;
  phase?: string | null;
}

export class LegalCaseService {
  /** Valida + normaliza o número CNJ pelo dígito verificador (módulo 97). Ausente → null.
   *  Formato: NNNNNNN-DD.AAAA.J.TR.OOOO (20 dígitos). Nunca inventa (RN-ADV-08). */
  static normalizeCnj(raw?: string | null): string | null {
    const s = String(raw ?? "").trim();
    if (!s) return null;
    const d = s.replace(/\D/g, "");
    if (d.length !== 20) throw new Error("Número CNJ deve ter 20 dígitos (NNNNNNN-DD.AAAA.J.TR.OOOO).");
    const seq = d.slice(0, 7), dv = d.slice(7, 9), ano = d.slice(9, 13), seg = d.slice(13, 14), trib = d.slice(14, 16), orig = d.slice(16, 20);
    // DV = 98 - ((NNNNNNN AAAA J TR OOOO seguido de "00") mod 97). Compara com o informado.
    const base = BigInt(seq + ano + seg + trib + orig + "00");
    const expected = (98n - (base % 97n)).toString().padStart(2, "0");
    if (expected !== dv) throw new Error("Número CNJ inválido (dígito verificador não confere).");
    return `${seq}-${dv}.${ano}.${seg}.${trib}.${orig}`;
  }

  static open(orgId: string, input: CaseInput, actorId: string | null = null): any {
    const title = String(input?.title || "").trim();
    if (!title) throw new Error("Dê um título ao processo.");
    const contact = db.prepare(`SELECT id FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, input.contactId) as any;
    if (!contact) throw new Error("Cliente não encontrado.");
    if (input.practiceAreaId) {
      const a = db.prepare(`SELECT id FROM clinic_specialties WHERE organization_id = ? AND id = ?`).get(orgId, input.practiceAreaId) as any;
      if (!a) throw new Error("Área do direito não encontrada.");
    }
    if (input.responsibleLawyerId) {
      const l = db.prepare(`SELECT id FROM clinic_professionals WHERE organization_id = ? AND id = ?`).get(orgId, input.responsibleLawyerId) as any;
      if (!l) throw new Error("Advogado responsável não encontrado.");
    }
    const caseType = input.caseType ? String(input.caseType) : "judicial";
    if (!CASE_TYPES.has(caseType)) throw new Error(`Tipo de caso inválido: ${caseType}.`);
    const cnj = this.normalizeCnj(input.cnjNumber);

    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO legal_cases (id, organization_id, contact_id, practice_area_id, responsible_lawyer_id,
           cnj_number, title, case_type, court, comarca, opposing_party, phase, status, started_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      ).run(id, orgId, input.contactId, input.practiceAreaId || null, input.responsibleLawyerId || null,
        cnj, title, caseType, input.court || null, input.comarca || null, input.opposingParty || null, input.phase || null, nowISO(), actorId);
    } catch (e: any) {
      if (String(e?.message || "").includes("UNIQUE") || e?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new Error("Já existe um processo com este número CNJ.");
      }
      throw e;
    }
    logAuthEvent(orgId, actorId, input.contactId, "LEGAL_CASE_OPENED", { caseId: id, cnj, title });
    return this.get(orgId, id);
  }

  static get(orgId: string, id: string): any {
    return db.prepare(`SELECT * FROM legal_cases WHERE organization_id = ? AND id = ?`).get(orgId, id) || null;
  }

  static list(orgId: string, opts: { status?: string } = {}): any[] {
    if (opts.status) return db.prepare(`SELECT * FROM legal_cases WHERE organization_id = ? AND status = ? ORDER BY started_at DESC`).all(orgId, opts.status) as any[];
    return db.prepare(`SELECT * FROM legal_cases WHERE organization_id = ? ORDER BY (status IN ('closed','archived')) ASC, started_at DESC`).all(orgId) as any[];
  }

  static listByClient(orgId: string, contactId: string): any[] {
    return db.prepare(`SELECT * FROM legal_cases WHERE organization_id = ? AND contact_id = ? ORDER BY started_at DESC`).all(orgId, contactId) as any[];
  }

  static listByLawyer(orgId: string, lawyerId: string): any[] {
    return db.prepare(`SELECT * FROM legal_cases WHERE organization_id = ? AND responsible_lawyer_id = ? ORDER BY started_at DESC`).all(orgId, lawyerId) as any[];
  }

  /** Reatribui o advogado responsável (o processo pertence ao escritório, não à pessoa). */
  static transfer(orgId: string, id: string, responsibleLawyerId: string, actorId: string | null = null): any {
    const c = this.get(orgId, id);
    if (!c) throw new Error("Processo não encontrado.");
    const l = db.prepare(`SELECT id FROM clinic_professionals WHERE organization_id = ? AND id = ?`).get(orgId, responsibleLawyerId) as any;
    if (!l) throw new Error("Advogado não encontrado.");
    db.prepare(`UPDATE legal_cases SET responsible_lawyer_id = ?, updated_at = ? WHERE organization_id = ? AND id = ?`).run(responsibleLawyerId, nowISO(), orgId, id);
    logAuthEvent(orgId, actorId, c.contact_id, "LEGAL_CASE_TRANSFERRED", { caseId: id, to: responsibleLawyerId });
    return this.get(orgId, id);
  }

  static setPhase(orgId: string, id: string, phase: string | null, actorId: string | null = null): any {
    const c = this.get(orgId, id);
    if (!c) throw new Error("Processo não encontrado.");
    db.prepare(`UPDATE legal_cases SET phase = ?, updated_at = ? WHERE organization_id = ? AND id = ?`).run(phase || null, nowISO(), orgId, id);
    return this.get(orgId, id);
  }

  /** Encerra o processo (análogo de alta; preserva o histórico — nunca DELETE). */
  static close(orgId: string, id: string, reason: string | null = null, actorId: string | null = null): any {
    const c = this.get(orgId, id);
    if (!c) throw new Error("Processo não encontrado.");
    if (!LIVE.has(c.status)) throw new Error("Processo já está encerrado/arquivado.");
    db.prepare(`UPDATE legal_cases SET status = 'closed', closed_at = ?, closed_reason = ?, closed_by = ?, updated_at = ? WHERE organization_id = ? AND id = ?`)
      .run(nowISO(), reason || null, actorId, nowISO(), orgId, id);
    logAuthEvent(orgId, actorId, c.contact_id, "LEGAL_CASE_CLOSED", { caseId: id, reason });
    return this.get(orgId, id);
  }

  static reopen(orgId: string, id: string, actorId: string | null = null): any {
    const c = this.get(orgId, id);
    if (!c) throw new Error("Processo não encontrado.");
    if (c.status !== "closed") throw new Error("Só é possível reabrir um processo encerrado.");
    db.prepare(`UPDATE legal_cases SET status = 'active', closed_at = NULL, closed_reason = NULL, closed_by = NULL, updated_at = ? WHERE organization_id = ? AND id = ?`)
      .run(nowISO(), orgId, id);
    logAuthEvent(orgId, actorId, c.contact_id, "LEGAL_CASE_REOPENED", { caseId: id });
    return this.get(orgId, id);
  }
}

export default LegalCaseService;
