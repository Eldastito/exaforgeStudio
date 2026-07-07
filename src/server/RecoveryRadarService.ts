import { randomUUID } from "node:crypto";
import db from "./db.js";
import { BusinessManifestoService } from "./BusinessManifestoService.js";

/**
 * Radar de Recuperação — Tier 2 (Disney, ADR-047).
 *
 * "O Jeito Disney de Encantar os Clientes" ensina que quando algo dá errado,
 * a RECUPERAÇÃO se torna o momento memorável — não a falha. Este serviço:
 *
 * 1. Detecta problem events (cancelamento, PIX expirado, reclamação, atraso)
 * 2. Gera playbook Disney em 4 passos: reconhecer com empatia + assumir +
 *    resolver rápido + oferecer algo PESSOAL (não desconto — mimo, prioridade,
 *    mensagem escrita, atendimento diferenciado)
 * 3. Registra o evento pra o dono poder MEDIR taxa de recuperação — a
 *    métrica que os grandes têm e a maioria de PMEs não.
 *
 * O playbook é template + tom do Manifesto (Tier 1) quando disponível. A
 * decisão de EXECUTAR (enviar mensagem, aplicar mimo) fica com o humano — o
 * radar só sugere e rastreia. Menos automação, mais consciência.
 */

export type RecoveryTrigger =
  | "order_cancelled"
  | "pix_expired"
  | "complaint_detected"
  | "delay_detected"
  | "delivery_delayed";

export type RecoveryStatus =
  | "triggered"
  | "playbook_sent"
  | "resolved_positive"
  | "resolved_neutral"
  | "escalated_human"
  | "dismissed";

export interface RecoveryEvent {
  id: string;
  organizationId: string;
  contactId: string | null;
  ticketId: string | null;
  orderId: string | null;
  triggerType: RecoveryTrigger;
  triggerContext: any;
  playbookText: string;
  status: RecoveryStatus;
  playbookSentAt: string | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  handledBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DetectInput {
  organizationId: string;
  contactId?: string | null;
  ticketId?: string | null;
  orderId?: string | null;
  triggerType: RecoveryTrigger;
  context?: any;
}

const TRIGGER_LABEL: Record<RecoveryTrigger, string> = {
  order_cancelled: "Pedido cancelado",
  pix_expired: "PIX venceu sem pagamento",
  complaint_detected: "Reclamação detectada",
  delay_detected: "Cliente mencionou demora",
  delivery_delayed: "Entrega atrasou",
};

export const RecoveryRadarService = {
  /**
   * Único ponto de entrada — chamado por rotas/scheduler/OpportunityRadar
   * quando algo problem event acontece. Idempotente: se já existe um evento
   * ATIVO (triggered ou playbook_sent) para o mesmo contact+trigger nos
   * últimos 7 dias, atualiza contexto e retorna o existente em vez de duplicar.
   */
  detect(input: DetectInput): RecoveryEvent | null {
    try {
      if (!input.organizationId || !input.triggerType) return null;

      const existing = input.contactId
        ? db.prepare(
          `SELECT * FROM recovery_events
            WHERE organization_id = ? AND contact_id = ? AND trigger_type = ?
              AND status IN ('triggered','playbook_sent')
              AND created_at >= datetime('now', '-7 days')
            ORDER BY created_at DESC LIMIT 1`
        ).get(input.organizationId, input.contactId, input.triggerType) as any
        : null;

      if (existing) {
        db.prepare(
          `UPDATE recovery_events SET trigger_context_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(JSON.stringify(input.context || {}), existing.id);
        return this.rowToEvent(db.prepare(`SELECT * FROM recovery_events WHERE id = ?`).get(existing.id) as any);
      }

      const contactName = input.contactId
        ? (db.prepare(`SELECT name FROM contacts WHERE id = ? AND organization_id = ?`).get(input.contactId, input.organizationId) as any)?.name
        : null;

      const playbookText = this.buildPlaybook(input.organizationId, input.triggerType, {
        ...(input.context || {}),
        contactName: contactName || input.context?.contactName || null,
      });

      const id = randomUUID();
      db.prepare(
        `INSERT INTO recovery_events
           (id, organization_id, contact_id, ticket_id, order_id, trigger_type, trigger_context_json, playbook_text, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'triggered')`
      ).run(
        id, input.organizationId, input.contactId || null, input.ticketId || null,
        input.orderId || null, input.triggerType, JSON.stringify(input.context || {}), playbookText,
      );
      return this.rowToEvent(db.prepare(`SELECT * FROM recovery_events WHERE id = ?`).get(id) as any);
    } catch (e) {
      console.error("[RecoveryRadar] detect falhou:", e);
      return null;
    }
  },

  /**
   * Gera o playbook Disney em 4 passos (empatia + responsabilidade + solução
   * + algo pessoal), calibrado pelo tom do Manifesto quando disponível. É
   * template — o humano ajusta antes de enviar. NÃO é "envie automaticamente"
   * (recuperação genérica automática é PIOR que problema não recuperado).
   */
  buildPlaybook(orgId: string, trigger: RecoveryTrigger, ctx: any = {}): string {
    const manifesto = BusinessManifestoService.get(orgId);
    const tone = manifesto?.toneVoice || "próximo e cordial";
    const nomeCliente = ctx.contactName || "";
    const saudacao = nomeCliente ? `Oi ${nomeCliente},` : "Oi,";

    const passos = {
      order_cancelled: {
        recognize: "vi aqui que seu pedido acabou sendo cancelado.",
        responsibility: "quero entender o que aconteceu do meu lado — se foi algo que a gente poderia ter feito diferente, eu quero saber.",
        solve: "posso te ajudar com o que precisar: gerar um novo pedido do jeito que faz mais sentido pra você, mudar produto, mudar forma de pagamento — o que for melhor.",
        personal: `E, independente de você seguir ou não com a gente agora, saber sua impressão vale muito. Se preferir só me contar o que atrapalhou, sem compromisso, tá ótimo.`,
      },
      pix_expired: {
        recognize: "notei que o PIX venceu antes de você conseguir pagar.",
        responsibility: "às vezes o prazo é curto demais e nem sempre o cliente consegue no timing — a culpa não é sua.",
        solve: "posso gerar um novo agora mesmo com prazo maior, ou se você mudou de ideia sobre o pedido, também tá tudo bem. Como prefere seguir?",
        personal: "Sem pressão nenhuma. Se estiver com dúvida no produto, também posso te ajudar a decidir sem compromisso.",
      },
      complaint_detected: {
        recognize: "percebi que sua experiência não foi como a gente promete — e isso me incomoda.",
        responsibility: "quero entender o que exatamente atrapalhou pra corrigir na raiz, não só no seu caso.",
        solve: "me conta o que aconteceu com o máximo de detalhe que puder — vou tratar como prioridade agora.",
        personal: "E enquanto a gente resolve, se tiver algo específico que ajudaria (ex.: falar direto com alguém, agilizar, remarcar), me diz — a gente ajusta.",
      },
      delay_detected: {
        recognize: "vi que você mencionou o tempo/prazo por aqui.",
        responsibility: "sei que esperar é chato, ainda mais quando o combinado não bate com a realidade.",
        solve: "deixa eu conferir seu caso específico agora e volto com uma previsão real — sem enrolação.",
        personal: "Se o prazo não fizer mais sentido pra você, também posso ver alternativa (retirada, entrega express, troca de item por algo que temos pronto).",
      },
      delivery_delayed: {
        recognize: "sua entrega atrasou e eu sei o quanto isso frustra.",
        responsibility: "a responsabilidade é nossa de te avisar antes — a gente falhou nisso.",
        solve: "estou vendo o rastreio agora e volto com previsão real, além de opções (redirecionar, priorizar, cancelar sem custo se preferir).",
        personal: "E na próxima compra, te deixo com um cuidado extra — vou marcar seu contato aqui pra receber prioridade no atendimento.",
      },
    } as const;

    const p = passos[trigger];
    return [
      `${saudacao}`,
      ``,
      `1️⃣ Reconhecer: ${p.recognize}`,
      `2️⃣ Assumir: ${p.responsibility}`,
      `3️⃣ Resolver: ${p.solve}`,
      `4️⃣ Cuidado pessoal: ${p.personal}`,
      ``,
      `— TOM sugerido: ${tone}`,
      `— Este é um RASCUNHO. Ajuste antes de enviar. A Disney ensina: "a recuperação é o momento memorável — não a falha".`,
    ].join("\n");
  },

  list(orgId: string, opts: { status?: RecoveryStatus | "active" | "all"; limit?: number } = {}): RecoveryEvent[] {
    const where: string[] = ["organization_id = ?"];
    const params: any[] = [orgId];
    if (opts.status === "active") {
      where.push("status IN ('triggered','playbook_sent')");
    } else if (opts.status && opts.status !== "all") {
      where.push("status = ?");
      params.push(opts.status);
    }
    const limit = Math.min(200, Math.max(1, Math.floor(Number(opts.limit) || 100)));
    const rows = db.prepare(
      `SELECT * FROM recovery_events WHERE ${where.join(" AND ")}
         ORDER BY CASE status WHEN 'triggered' THEN 0 WHEN 'playbook_sent' THEN 1 ELSE 2 END,
                  created_at DESC LIMIT ${limit}`
    ).all(...params) as any[];
    return rows.map((r) => this.rowToEvent(r));
  },

  updateStatus(orgId: string, id: string, status: RecoveryStatus, opts: { notes?: string; handledBy?: string } = {}): boolean {
    const row = db.prepare(`SELECT id, status FROM recovery_events WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!row) return false;
    const resolvedFlag = ["resolved_positive", "resolved_neutral", "escalated_human", "dismissed"].includes(status);
    const sentFlag = status === "playbook_sent";
    const sqlParts: string[] = ["status = ?", "updated_at = CURRENT_TIMESTAMP"];
    const bindings: any[] = [status];
    if (sentFlag && !row.playbook_sent_at) { sqlParts.push("playbook_sent_at = CURRENT_TIMESTAMP"); }
    if (resolvedFlag) { sqlParts.push("resolved_at = CURRENT_TIMESTAMP"); }
    if (opts.notes !== undefined) { sqlParts.push("resolution_notes = ?"); bindings.push(String(opts.notes).slice(0, 1000)); }
    if (opts.handledBy) { sqlParts.push("handled_by = ?"); bindings.push(opts.handledBy); }
    bindings.push(id, orgId);
    db.prepare(`UPDATE recovery_events SET ${sqlParts.join(", ")} WHERE id = ? AND organization_id = ?`).run(...bindings);
    return true;
  },

  /**
   * Métricas de recuperação (o painel do dono). Recovery rate = eventos
   * resolved_positive / total encerrados no período. Se o denominador for
   * pequeno, mostra "sem dados suficientes" em vez de percentual enganoso.
   */
  metrics(orgId: string, days = 30): { total: number; recovered: number; recoveryRate: number | null; byTrigger: Record<string, number>; avgResolutionHours: number | null } {
    const rows = db.prepare(
      `SELECT trigger_type, status,
              CASE WHEN resolved_at IS NOT NULL THEN (julianday(resolved_at) - julianday(created_at)) * 24 END AS hours_to_resolve
         FROM recovery_events
        WHERE organization_id = ? AND created_at >= datetime('now', '-${Math.max(1, Math.floor(days))} days')`
    ).all(orgId) as any[];

    const total = rows.length;
    const closed = rows.filter((r) => ["resolved_positive", "resolved_neutral", "dismissed"].includes(r.status));
    const positive = rows.filter((r) => r.status === "resolved_positive").length;
    const rate = closed.length >= 3 ? positive / closed.length : null;
    const byTrigger: Record<string, number> = {};
    for (const r of rows) byTrigger[r.trigger_type] = (byTrigger[r.trigger_type] || 0) + 1;
    const hoursArr = rows.map((r) => r.hours_to_resolve).filter((h) => typeof h === "number" && h >= 0);
    const avg = hoursArr.length ? hoursArr.reduce((a, b) => a + b, 0) / hoursArr.length : null;

    return {
      total,
      recovered: positive,
      recoveryRate: rate != null ? Math.round(rate * 100) / 100 : null,
      byTrigger,
      avgResolutionHours: avg != null ? Math.round(avg * 10) / 10 : null,
    };
  },

  labelFor(t: RecoveryTrigger): string { return TRIGGER_LABEL[t] || t; },

  rowToEvent(row: any): RecoveryEvent {
    let ctx: any = {};
    try { ctx = JSON.parse(row.trigger_context_json || "{}"); } catch { ctx = {}; }
    return {
      id: row.id, organizationId: row.organization_id, contactId: row.contact_id,
      ticketId: row.ticket_id, orderId: row.order_id, triggerType: row.trigger_type,
      triggerContext: ctx, playbookText: row.playbook_text || "", status: row.status,
      playbookSentAt: row.playbook_sent_at, resolvedAt: row.resolved_at,
      resolutionNotes: row.resolution_notes, handledBy: row.handled_by,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  },
};
