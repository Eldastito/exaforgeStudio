import { randomUUID } from "node:crypto";
import db from "./db.js";

/**
 * ContentLeadAttributionService — Content→Lead Attribution (PRD 11 / ADR-168 F7).
 *
 * Escreve o 1º elo do fio conteúdo→lead→venda→receita→margem: registra que um LEAD
 * (`contacts`) chegou por um CONTEÚDO (pelo `correlation_id` da campanha/publicação). O
 * `ContentOutcomeResolver` (em `BusinessOutcomeResolver`, registrado no registry do PRD 8)
 * LÊ essa tabela pra dizer se o conteúdo produziu resultado de negócio.
 *
 * Este serviço só ESCREVE (o resolver só LÊ) — separação clara. A ORIGEM do vínculo é do
 * caller (uma landing com UTM, um inbound de WhatsApp com ref, tag manual) — aqui só
 * persistimos o fato, validando que o contato existe.
 *
 * Guardrails:
 *  - RN-CG-03 — sem dupla contagem: UNIQUE(org, correlation_id, contact_id) + INSERT idempotente.
 *  - RN-CG-01 — um lead é MAIS que engajamento (é o 1º valor de negócio do conteúdo); mas o
 *    dinheiro (venda/receita/margem) é a F8 — aqui não se inventa valor.
 *  - convenção nº 1 — isolamento por org; valida o contato pertencer à org.
 */

export class ContentLeadAttributionService {
  /**
   * Atribui um lead a um conteúdo (idempotente). Valida que o contato existe na org (não
   * inventa lead). `actionId`/`source` opcionais (procedência). Devolve se criou ou já existia.
   */
  static attribute(orgId: string, input: { correlationId: string; contactId: string; actionId?: string | null; source?: string | null }):
    { attributed: boolean; alreadyExisted: boolean; id: string | null } {
    if (!orgId) throw new Error("orgId obrigatório");
    const correlationId = String(input?.correlationId || "").trim();
    const contactId = String(input?.contactId || "").trim();
    if (!correlationId) throw new Error("correlationId obrigatório");
    if (!contactId) throw new Error("contactId obrigatório");

    // Valida o lead: o contato tem que existir NESTA org (RN-CG-01 — não inventa lead).
    const contact = db.prepare("SELECT id FROM contacts WHERE id = ? AND organization_id = ?").get(contactId, orgId) as any;
    if (!contact) throw new Error("Contato (lead) não encontrado nesta organização.");

    const existing = db.prepare(
      "SELECT id FROM content_lead_attributions WHERE organization_id = ? AND correlation_id = ? AND contact_id = ?"
    ).get(orgId, correlationId, contactId) as any;
    if (existing) return { attributed: false, alreadyExisted: true, id: existing.id };

    const id = randomUUID();
    db.prepare(
      `INSERT OR IGNORE INTO content_lead_attributions (id, organization_id, correlation_id, contact_id, action_id, source)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, correlationId, contactId, input.actionId || null, input.source || null);
    // Confirma o que ficou (corrida: outra thread pode ter inserido a mesma chave).
    const row = db.prepare("SELECT id FROM content_lead_attributions WHERE organization_id = ? AND correlation_id = ? AND contact_id = ?").get(orgId, correlationId, contactId) as any;
    return { attributed: row?.id === id, alreadyExisted: row?.id !== id, id: row?.id || null };
  }

  /** Leads atribuídos a um conteúdo (por correlation_id). */
  static leadsFor(orgId: string, correlationId: string): Array<{ contactId: string; source: string | null; actionId: string | null; createdAt: string }> {
    return (db.prepare(
      "SELECT contact_id, source, action_id, created_at FROM content_lead_attributions WHERE organization_id = ? AND correlation_id = ? ORDER BY created_at ASC"
    ).all(orgId, correlationId) as any[]).map((r) => ({ contactId: r.contact_id, source: r.source ?? null, actionId: r.action_id ?? null, createdAt: r.created_at }));
  }

  /** Contagem de leads por conteúdo (derivado — o que o resolver reflete). */
  static leadCount(orgId: string, correlationId: string): number {
    const r = db.prepare("SELECT COUNT(*) AS n FROM content_lead_attributions WHERE organization_id = ? AND correlation_id = ?").get(orgId, correlationId) as any;
    return Number(r?.n || 0);
  }
}

export default ContentLeadAttributionService;
