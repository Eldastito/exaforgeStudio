import { randomUUID } from "node:crypto";
import db from "./db.js";
import { BusinessManifestoService } from "./BusinessManifestoService.js";

/**
 * Notas de Reconhecimento — Tier 2 (Hunter, "O Monge e o Executivo",
 * liderança-servidora, ADR-049).
 *
 * Filosofia: liderar é servir. Servir começa por RECONHECER — enxergar
 * o esforço do outro e nomear em voz alta. O dono de PME vive apagando
 * incêndio; reconhecer fica no fim da lista, sempre. O Diretor IA detecta
 * momentos de reconhecimento (CSAT máximo, recompra fiel, cliente
 * recuperado, ticket alto, mensagem carinhosa) e SUGERE uma nota curta —
 * o dono revê, ajusta e decide se envia. Automatizar 100% mata o valor:
 * o reconhecimento importa porque VEM DO DONO, não da IA.
 *
 * A IA aqui é MEMÓRIA + PROMPT, não voz.
 */

export type RecognitionTrigger =
  | "csat_high"          // CSAT 9-10 no NPS
  | "loyal_repurchase"   // recompra > N-ésima
  | "high_ticket_order"  // pedido de valor acima da média
  | "recovered_customer" // cliente recuperado do Radar de Recuperação
  | "kind_message";      // mensagem carinhosa do cliente (elogio, agradecimento)

export type RecognitionStatus = "suggested" | "dismissed" | "sent";
export type RecognitionTargetType = "customer" | "employee" | "partner";

export interface RecognitionNote {
  id: string;
  organizationId: string;
  targetType: RecognitionTargetType;
  targetId: string | null;
  targetName: string | null;
  triggerType: RecognitionTrigger;
  triggerContext: any;
  suggestedMessage: string;
  status: RecognitionStatus;
  sentAt: string | null;
  dismissedAt: string | null;
  handledBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DetectInput {
  organizationId: string;
  targetType?: RecognitionTargetType;
  targetId?: string | null;
  targetName?: string | null;
  triggerType: RecognitionTrigger;
  context?: any;
}

const TRIGGER_LABEL: Record<RecognitionTrigger, string> = {
  csat_high: "Nota máxima no CSAT",
  loyal_repurchase: "Cliente fiel voltou a comprar",
  high_ticket_order: "Compra acima da média",
  recovered_customer: "Cliente recuperado depois de problema",
  kind_message: "Mensagem carinhosa recebida",
};

// Janela anti-spam: mesma pessoa + mesmo trigger não gera nova sugestão em N dias.
const DEDUPE_DAYS = 30;
const MESSAGE_MAX = 500;

export const RecognitionNotesService = {
  /**
   * Detecta um momento de reconhecimento e cria uma nota sugerida.
   * Idempotente: se já existe uma nota (qualquer status) para o mesmo
   * target+trigger dentro dos últimos 30 dias, devolve a existente em
   * vez de duplicar — reconhecer 3 vezes seguidas por CSAT alto perde
   * o significado.
   *
   * NUNCA envia sozinho. Só sugere.
   */
  detect(input: DetectInput): RecognitionNote | null {
    try {
      if (!input.organizationId || !input.triggerType) return null;
      const targetType = input.targetType || "customer";

      const existing = input.targetId
        ? db.prepare(
          `SELECT * FROM recognition_notes
            WHERE organization_id = ? AND target_type = ? AND target_id = ? AND trigger_type = ?
              AND created_at >= datetime('now', ?)
            ORDER BY created_at DESC LIMIT 1`
        ).get(input.organizationId, targetType, input.targetId, input.triggerType, `-${DEDUPE_DAYS} days`) as any
        : null;

      if (existing) return this.rowToNote(existing);

      const resolvedName = input.targetName
        || (input.targetId && targetType === "customer"
          ? (db.prepare(`SELECT name FROM contacts WHERE id = ? AND organization_id = ?`).get(input.targetId, input.organizationId) as any)?.name
          : null)
        || null;

      const suggestedMessage = this.buildMessage(input.organizationId, input.triggerType, {
        ...(input.context || {}),
        targetName: resolvedName,
      });

      const id = randomUUID();
      db.prepare(
        `INSERT INTO recognition_notes
           (id, organization_id, target_type, target_id, target_name, trigger_type, trigger_context_json, suggested_message, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'suggested')`
      ).run(
        id, input.organizationId, targetType, input.targetId || null, resolvedName,
        input.triggerType, JSON.stringify(input.context || {}), suggestedMessage,
      );
      return this.rowToNote(db.prepare(`SELECT * FROM recognition_notes WHERE id = ?`).get(id) as any);
    } catch (e) {
      console.error("[RecognitionNotes] detect falhou:", e);
      return null;
    }
  },

  /**
   * Constrói a mensagem sugerida a partir de template + tom do Manifesto
   * quando disponível. Deliberadamente CURTA — reconhecimento longo soa
   * falso. Prefere primeira pessoa (o dono fala) e nome próprio.
   */
  buildMessage(orgId: string, trigger: RecognitionTrigger, ctx: any = {}): string {
    const manifesto = BusinessManifestoService.get(orgId);
    const tone = manifesto?.toneVoice || "próximo e cordial";
    const name = String(ctx.targetName || "").trim();
    const saud = name ? `Oi ${name.split(/\s+/)[0]}` : "Oi";

    const templates: Record<RecognitionTrigger, string> = {
      csat_high:
        `${saud}, vi sua nota máxima na avaliação e queria agradecer de verdade — feedback assim é o que me faz seguir. Se puder me contar em uma frase o que mais te marcou, vou usar como bússola. Obrigado!`,
      loyal_repurchase:
        `${saud}, notei que essa é mais uma compra sua com a gente — obrigado pela confiança repetida. Não é comum, e eu percebo. Qualquer coisa que precisar, me chama direto.`,
      high_ticket_order:
        `${saud}, quero registrar aqui: fico honrado com sua compra hoje. Vou acompanhar pessoalmente pra tudo sair como você espera. Se surgir qualquer dúvida no caminho, fala comigo.`,
      recovered_customer:
        `${saud}, obrigado por ter dado uma nova chance depois do problema. Sei que não foi fácil e valorizo muito você ter voltado. Vou ficar de olho no seu próximo pedido pessoalmente.`,
      kind_message:
        `${saud}, sua mensagem carinhosa fez o meu dia. Guardei aqui. Obrigado por reservar um minuto pra escrever — significa bastante pra quem faz esse trabalho todo dia.`,
    };

    const msg = templates[trigger] || `${saud}, obrigado. Sua atitude não passou despercebida por aqui.`;
    return [
      msg,
      ``,
      `— TOM sugerido: ${tone}`,
      `— RASCUNHO. Ajuste antes de enviar. Hunter ensina: liderar é reconhecer o esforço do outro.`,
    ].join("\n").slice(0, MESSAGE_MAX + 200);
  },

  list(orgId: string, opts: { status?: RecognitionStatus | "all"; limit?: number } = {}): RecognitionNote[] {
    const where: string[] = ["organization_id = ?"];
    const params: any[] = [orgId];
    if (opts.status && opts.status !== "all") {
      where.push("status = ?");
      params.push(opts.status);
    } else {
      // Default: só sugeridas primeiro (fila do dono) + últimas enviadas
      // ficam mais embaixo por ORDER BY.
    }
    const limit = Math.min(200, Math.max(1, Math.floor(Number(opts.limit) || 100)));
    const rows = db.prepare(
      `SELECT * FROM recognition_notes WHERE ${where.join(" AND ")}
         ORDER BY CASE status WHEN 'suggested' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END,
                  created_at DESC LIMIT ${limit}`
    ).all(...params) as any[];
    return rows.map((r) => this.rowToNote(r));
  },

  markSent(orgId: string, id: string, opts: { handledBy?: string } = {}): boolean {
    const row = db.prepare(`SELECT id, status FROM recognition_notes WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!row) return false;
    if (row.status === "sent") return true;
    db.prepare(
      `UPDATE recognition_notes SET status = 'sent', sent_at = CURRENT_TIMESTAMP,
         handled_by = COALESCE(?, handled_by), updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`
    ).run(opts.handledBy || null, id, orgId);
    return true;
  },

  dismiss(orgId: string, id: string, opts: { handledBy?: string } = {}): boolean {
    const row = db.prepare(`SELECT id, status FROM recognition_notes WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!row) return false;
    if (row.status === "dismissed") return true;
    db.prepare(
      `UPDATE recognition_notes SET status = 'dismissed', dismissed_at = CURRENT_TIMESTAMP,
         handled_by = COALESCE(?, handled_by), updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`
    ).run(opts.handledBy || null, id, orgId);
    return true;
  },

  /** Métrica curta pro card do dono: quantas sugestões abertas + taxa de envio no período. */
  metrics(orgId: string, days = 30): { pending: number; sentPct: number | null; total: number; byTrigger: Record<string, number> } {
    const pending = (db.prepare(
      `SELECT COUNT(*) AS n FROM recognition_notes WHERE organization_id = ? AND status = 'suggested'`
    ).get(orgId) as any)?.n || 0;

    const rows = db.prepare(
      `SELECT status, trigger_type FROM recognition_notes
         WHERE organization_id = ? AND created_at >= datetime('now', ?)`
    ).all(orgId, `-${Math.max(1, Math.floor(days))} days`) as any[];

    const byTrigger: Record<string, number> = {};
    let sent = 0, resolvedTotal = 0;
    for (const r of rows) {
      byTrigger[r.trigger_type] = (byTrigger[r.trigger_type] || 0) + 1;
      if (r.status === "sent") { sent++; resolvedTotal++; }
      else if (r.status === "dismissed") { resolvedTotal++; }
    }
    // Amostra pequena não vira nota — melhor mostrar "—" que enganar.
    const sentPct = resolvedTotal >= 3 ? Math.round((sent / resolvedTotal) * 100) : null;
    return { pending, sentPct, total: rows.length, byTrigger };
  },

  labelFor(t: RecognitionTrigger): string {
    return TRIGGER_LABEL[t] || t;
  },

  rowToNote(row: any): RecognitionNote {
    let ctx: any = {};
    try { ctx = row.trigger_context_json ? JSON.parse(row.trigger_context_json) : {}; } catch { ctx = {}; }
    return {
      id: row.id,
      organizationId: row.organization_id,
      targetType: (row.target_type || "customer") as RecognitionTargetType,
      targetId: row.target_id || null,
      targetName: row.target_name || null,
      triggerType: row.trigger_type as RecognitionTrigger,
      triggerContext: ctx,
      suggestedMessage: row.suggested_message || "",
      status: row.status as RecognitionStatus,
      sentAt: row.sent_at || null,
      dismissedAt: row.dismissed_at || null,
      handledBy: row.handled_by || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    };
  },
};
