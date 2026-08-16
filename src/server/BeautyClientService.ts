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
export class BeautyClientService {
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
  static create(orgId: string, input: { name?: string; phone?: string }): { id: string; name: string; identifier: string } {
    const name = String(input.name || "").trim();
    if (!name) throw new Error("Informe o nome da cliente.");
    const phone = String(input.phone || "").trim();
    const identifier = phone || name;

    const channelId = this.ensureManualChannel(orgId);
    const existing = db.prepare(
      `SELECT id, name FROM contacts WHERE organization_id = ? AND channel_id = ? AND identifier = ?`
    ).get(orgId, channelId, identifier) as any;
    if (existing) {
      // Atualiza o nome se o cadastro trouxe um mais completo (idempotente,
      // nunca duplica). Mantém o contato existente.
      if (existing.name !== name) {
        db.prepare(`UPDATE contacts SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(name, existing.id);
      }
      return { id: existing.id, name, identifier };
    }
    const contactId = randomUUID();
    db.prepare(
      `INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`
    ).run(contactId, orgId, channelId, name, identifier);
    return { id: contactId, name, identifier };
  }
}
