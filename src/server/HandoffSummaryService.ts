import db from "./db.js";
import { chat } from "./llm.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Transição Invisível: gera e guarda um resumo em texto do atendimento no
 * momento em que a conversa passa para um humano. O atendente que recebe vê o
 * contexto direto na tela (sem precisar ler a thread inteira nem o cliente
 * repetir a história).
 */
export class HandoffSummaryService {
  /** Monta o resumo a partir do histórico já carregado (rápido, sem reconsultar o banco). */
  static async fromHistory(
    history: { role: string; text: string }[],
    currentMessage?: string,
  ): Promise<string> {
    const linhas = history.map((m) => `${m.role}: ${m.text}`);
    if (currentMessage) linhas.push(`Cliente: ${currentMessage}`);
    if (linhas.length === 0) return "";
    const prompt = `Você é o assistente que está PASSANDO este atendimento para um colega humano.
Resuma em tópicos curtos para o atendente assumir sem que o cliente precise repetir nada.
Inclua: o que o cliente quer, o problema principal, o que já foi feito/respondido e o próximo passo sugerido.
Seja objetivo (máx. 6 tópicos).

Conversa:
${linhas.join("\n")}

Resumo para o atendente:`;
    try {
      return (await chat(prompt, { temperature: 0.3 })).trim();
    } catch (e) {
      console.error("[Handoff] Falha ao gerar resumo:", e);
      return "";
    }
  }

  /** Carrega as últimas mensagens do ticket e resume (usado no handoff manual). */
  static async fromTicket(ticketId: string): Promise<string> {
    const rows = db.prepare(`
      SELECT sender_type, content FROM messages
      WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 20
    `).all(ticketId) as any[];
    const history = rows.reverse().map((r) => ({
      role: r.sender_type === "contact" ? "Cliente" : (r.sender_type === "agent" ? "Atendente" : "Assistente"),
      text: r.content,
    }));
    return this.fromHistory(history);
  }

  /** Persiste o resumo no ticket (+ histórico em ticket_summaries) e devolve o texto. */
  static save(orgId: string, ticketId: string, summary: string, reason?: string): void {
    if (!summary) return;
    try {
      db.prepare("UPDATE tickets SET handoff_summary = ?, handoff_reason = COALESCE(?, handoff_reason) WHERE id = ?")
        .run(summary, reason || null, ticketId);
      db.prepare("INSERT INTO ticket_summaries (id, organization_id, ticket_id, summary_text) VALUES (?, ?, ?, ?)")
        .run(uuidv4(), orgId, ticketId, summary);
    } catch (e) {
      console.error("[Handoff] Falha ao salvar resumo:", e);
    }
  }
}
