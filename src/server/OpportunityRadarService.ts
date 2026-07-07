import { randomUUID } from "node:crypto";
import db from "./db.js";

/**
 * Radar de Oportunidades Disfarçadas — Tier 2 (Carlos Domingos, ADR-046).
 *
 * Filosofia: "problema é sinal, não fim". Toda reclamação, cancelamento,
 * falta de estoque, ou cliente pedindo produto que você não tem é o mercado
 * gritando o que quer. Este serviço varre 5 fontes de dados dos últimos 30
 * dias, detecta padrões repetidos (frequência mínima), e cria oportunidades
 * ACIONÁVEIS que o dono decide reconhecer, implementar ou descartar.
 *
 * Categorias detectadas:
 * - stock_out: mesmo produto ficou sem estoque N vezes (giro alto disfarçado)
 * - product_gap: N clientes distintos perguntaram por produto que você não tem
 * - service_complaint: N mensagens com sinais de reclamação (fricção sistêmica)
 * - cancellation_reason: N pedidos cancelados no mesmo estágio (funil furando)
 * - delay_pattern: N clientes reclamaram de prazo/demora (oportunidade express)
 *
 * Best-effort: nunca lança. Dedupe: se já existe oportunidade ativa da mesma
 * categoria com título similar nos últimos 90 dias, atualiza a existente em
 * vez de duplicar — evita spam de "descobri de novo".
 */

export type OpportunityCategory =
  | "stock_out"
  | "product_gap"
  | "service_complaint"
  | "cancellation_reason"
  | "delay_pattern";

export type OpportunityStatus = "new" | "acknowledged" | "in_progress" | "implemented" | "dismissed";

export interface Opportunity {
  id: string;
  organizationId: string;
  category: OpportunityCategory;
  title: string;
  description: string;
  suggestedAction: string;
  evidenceCount: number;
  sampleEvidences: any[];
  status: OpportunityStatus;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Palavras que sinalizam reclamação em mensagem de cliente. Não é NLP — é
// filtro grosseiro. Falsos positivos são aceitáveis; o dono revisa antes de agir.
const COMPLAINT_KEYWORDS = [
  "ruim", "péssim", "horrível", "reclam", "cancelar", "cancelo",
  "demora", "demorou", "demorad", "esper", "atras",
  "quebrad", "quebrou", "defeit", "não funcion", "nao funcion",
  "problema", "erro", "errado", "furad", "insatisf", "decepcion",
];
// Palavras que sinalizam "cliente pedindo produto que a gente não tem"
// (bot respondendo negativamente, ou cliente perguntando por item ausente).
const CATALOG_MISS_KEYWORDS_BOT = [
  "não temos", "nao temos", "infelizmente não", "infelizmente nao",
  "não trabalh", "nao trabalh", "não vend", "nao vend",
  "não faz parte", "nao faz parte", "fora do nosso",
];
const DELAY_KEYWORDS = ["demor", "atras", "prazo", "quando chega", "quando vem"];

function score(text: string, kws: string[]): number {
  const t = (text || "").toLowerCase();
  let hits = 0;
  for (const kw of kws) if (t.includes(kw)) hits++;
  return hits;
}

export const OpportunityRadarService = {
  /**
   * Roda o scan completo para uma organização, cria/atualiza oportunidades no
   * banco e retorna a lista das oportunidades ativas após o scan. Idempotente:
   * pode rodar várias vezes por dia sem duplicar.
   */
  scan(organizationId: string, windowDays = 30): Opportunity[] {
    const since = `datetime('now', '-${Math.max(1, Math.floor(windowDays))} days')`;

    try {
      this.detectStockOuts(organizationId, since);
      this.detectServiceComplaints(organizationId, since);
      this.detectCatalogGaps(organizationId, since);
      this.detectCancellationReasons(organizationId, since);
      this.detectDelayPattern(organizationId, since);
    } catch (e) { console.error("[OpportunityRadar] scan falhou", e); }

    // Marca a run
    try {
      db.prepare(`UPDATE organization_settings SET opportunity_radar_last_run = CURRENT_TIMESTAMP WHERE organization_id = ?`).run(organizationId);
    } catch { /* noop */ }

    return this.list(organizationId, { status: "new" });
  },

  detectStockOuts(orgId: string, since: string) {
    // Produtos que ficaram <= 0 e foram repostos mais de uma vez no período:
    // sinal de que giram alto e o dono está subestimando estoque.
    let rows: any[] = [];
    try {
      rows = db.prepare(`
        SELECT p.id AS product_id, p.name AS product_name, COUNT(*) AS zero_events
          FROM stock_movements m
          JOIN products_services p ON p.id = m.product_service_id
         WHERE m.organization_id = ?
           AND m.created_at >= ${since}
           AND m.type = 'entrada'
         GROUP BY p.id, p.name
        HAVING zero_events >= 2
        ORDER BY zero_events DESC
        LIMIT 20
      `).all(orgId) as any[];
    } catch { return; }

    for (const r of rows) {
      this.upsert(orgId, {
        category: "stock_out",
        title: `Reposição frequente: ${r.product_name}`,
        description: `Produto foi reposto ${r.zero_events} vezes nos últimos dias — sinal de que gira mais do que o estoque acompanha.`,
        suggestedAction: `Aumente o estoque mínimo deste produto ou torne-o carro-chefe da vitrine. Alta rotação disfarçada é oportunidade de escala.`,
        evidenceCount: Number(r.zero_events),
        sampleEvidences: [{ productId: r.product_id, productName: r.product_name, reposições: Number(r.zero_events) }],
      });
    }
  },

  detectServiceComplaints(orgId: string, since: string) {
    // Mensagens do cliente com múltiplos sinais de reclamação
    let rows: any[] = [];
    try {
      rows = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.ticket_id, c.name AS contact_name
          FROM messages m
          JOIN tickets t ON t.id = m.ticket_id
          JOIN contacts c ON c.id = t.contact_id
         WHERE m.organization_id = ?
           AND m.sender_type = 'contact'
           AND m.created_at >= ${since}
           AND LENGTH(m.content) BETWEEN 15 AND 500
         ORDER BY m.created_at DESC
         LIMIT 500
      `).all(orgId) as any[];
    } catch { return; }

    const complaints = rows.filter((r) => score(r.content, COMPLAINT_KEYWORDS) >= 1);
    if (complaints.length < 3) return;

    this.upsert(orgId, {
      category: "service_complaint",
      title: `${complaints.length} sinais de reclamação nos últimos 30 dias`,
      description: `Identificamos ${complaints.length} mensagens com termos como "ruim", "demora", "problema", "reclamo" — algo está gerando fricção sistêmica no atendimento.`,
      suggestedAction: `Revise essas mensagens. Se a maioria é sobre o MESMO tema (prazo, produto específico, canal), esse tema é a oportunidade de melhoria mais urgente do mês.`,
      evidenceCount: complaints.length,
      sampleEvidences: complaints.slice(0, 5).map((r) => ({
        messageId: r.id, contact: r.contact_name, snippet: String(r.content || "").slice(0, 160), date: r.created_at,
      })),
    });
  },

  detectCatalogGaps(orgId: string, since: string) {
    // Bot respondeu "não temos" com frequência — cada resposta assim é um
    // cliente virando as costas por causa de gap de catálogo.
    let botRows: any[] = [];
    try {
      botRows = db.prepare(`
        SELECT m.id, m.content, m.created_at, c.name AS contact_name
          FROM messages m
          JOIN tickets t ON t.id = m.ticket_id
          JOIN contacts c ON c.id = t.contact_id
         WHERE m.organization_id = ?
           AND m.sender_type IN ('bot','agent')
           AND m.created_at >= ${since}
         ORDER BY m.created_at DESC
         LIMIT 500
      `).all(orgId) as any[];
    } catch { return; }
    const gaps = botRows.filter((r) => score(r.content, CATALOG_MISS_KEYWORDS_BOT) >= 1);
    if (gaps.length < 3) return;
    this.upsert(orgId, {
      category: "product_gap",
      title: `${gaps.length} clientes pediram produtos que você não tem`,
      description: `A IA disse "não temos" ${gaps.length} vezes nos últimos dias. Cada 'não temos' é um cliente que virou as costas — o mercado está te dizendo o que expandir.`,
      suggestedAction: `Leia esses casos e mapeie quais produtos foram pedidos. Se 3+ pessoas pediram o mesmo item, é sinal forte para incluir no catálogo.`,
      evidenceCount: gaps.length,
      sampleEvidences: gaps.slice(0, 5).map((r) => ({
        messageId: r.id, contact: r.contact_name, aiSaid: String(r.content || "").slice(0, 180), date: r.created_at,
      })),
    });
  },

  detectCancellationReasons(orgId: string, since: string) {
    let count = 0;
    let samples: any[] = [];
    try {
      const rows = db.prepare(`
        SELECT o.id, o.notes, o.total_amount, o.created_at, o.status, c.name AS contact_name
          FROM orders o
          LEFT JOIN contacts c ON c.id = o.contact_id
         WHERE o.organization_id = ?
           AND o.created_at >= ${since}
           AND o.status IN ('cancelado', 'devolucao', 'reembolso')
         ORDER BY o.created_at DESC
         LIMIT 100
      `).all(orgId) as any[];
      count = rows.length;
      samples = rows.slice(0, 5).map((r) => ({
        orderId: r.id, contact: r.contact_name, total: r.total_amount,
        status: r.status, notes: String(r.notes || "").slice(0, 160), date: r.created_at,
      }));
    } catch { return; }
    if (count < 3) return;
    this.upsert(orgId, {
      category: "cancellation_reason",
      title: `${count} pedidos cancelados/devolvidos nos últimos 30 dias`,
      description: `Cancelamentos e devoluções acumulados são o funil te contando onde a experiência quebra — pagamento, entrega, expectativa vs realidade.`,
      suggestedAction: `Ligue (ou peça pra IA perguntar) 3 desses clientes cancelados: "o que faltou pra você ter seguido?". A resposta vale mais que qualquer pesquisa.`,
      evidenceCount: count,
      sampleEvidences: samples,
    });
  },

  detectDelayPattern(orgId: string, since: string) {
    let rows: any[] = [];
    try {
      rows = db.prepare(`
        SELECT m.id, m.content, m.created_at, c.name AS contact_name
          FROM messages m
          JOIN tickets t ON t.id = m.ticket_id
          JOIN contacts c ON c.id = t.contact_id
         WHERE m.organization_id = ?
           AND m.sender_type = 'contact'
           AND m.created_at >= ${since}
           AND LENGTH(m.content) BETWEEN 8 AND 400
         ORDER BY m.created_at DESC
         LIMIT 500
      `).all(orgId) as any[];
    } catch { return; }
    const delays = rows.filter((r) => score(r.content, DELAY_KEYWORDS) >= 1);
    if (delays.length < 3) return;
    this.upsert(orgId, {
      category: "delay_pattern",
      title: `${delays.length} clientes mencionaram demora/prazo`,
      description: `Clientes falando de prazo com frequência sinalizam que a expectativa não bate com a promessa. Isto é matéria-bruta de uma oferta express.`,
      suggestedAction: `Crie uma modalidade "entrega prioritária" (mesmo com taxa maior). Muitos aceitam pagar por rapidez — e essa opção reduz o cancelamento por impaciência.`,
      evidenceCount: delays.length,
      sampleEvidences: delays.slice(0, 5).map((r) => ({
        messageId: r.id, contact: r.contact_name, snippet: String(r.content || "").slice(0, 160), date: r.created_at,
      })),
    });
  },

  /** Insere ou atualiza uma oportunidade (dedupe por category+title). */
  upsert(organizationId: string, input: Omit<Opportunity, "id" | "organizationId" | "status" | "firstSeenAt" | "lastSeenAt" | "createdAt" | "updatedAt"> & { firstSeenAt?: string; lastSeenAt?: string }) {
    const existing = db.prepare(
      `SELECT id, status, first_seen_at FROM disguised_opportunities
        WHERE organization_id = ? AND category = ? AND title = ?
          AND status IN ('new', 'acknowledged', 'in_progress')
        ORDER BY updated_at DESC LIMIT 1`
    ).get(organizationId, input.category, input.title) as any;

    const evJson = JSON.stringify(input.sampleEvidences || []);
    if (existing) {
      db.prepare(
        `UPDATE disguised_opportunities SET
            description = ?, suggested_action = ?, evidence_count = ?, sample_evidences_json = ?,
            last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(input.description, input.suggestedAction, input.evidenceCount, evJson, existing.id);
      return existing.id;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO disguised_opportunities
         (id, organization_id, category, title, description, suggested_action, evidence_count, sample_evidences_json, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(id, organizationId, input.category, input.title, input.description, input.suggestedAction, input.evidenceCount, evJson);
    return id;
  },

  list(orgId: string, opts: { status?: OpportunityStatus | "all"; category?: OpportunityCategory; limit?: number } = {}): Opportunity[] {
    const where: string[] = ["organization_id = ?"];
    const params: any[] = [orgId];
    if (opts.status && opts.status !== "all") { where.push("status = ?"); params.push(opts.status); }
    if (opts.category) { where.push("category = ?"); params.push(opts.category); }
    const limit = Math.min(200, Math.max(1, Math.floor(Number(opts.limit) || 100)));
    const rows = db.prepare(
      `SELECT * FROM disguised_opportunities WHERE ${where.join(" AND ")}
         ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'acknowledged' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END,
                  evidence_count DESC, updated_at DESC
         LIMIT ${limit}`
    ).all(...params) as any[];
    return rows.map(this.rowToOpp);
  },

  updateStatus(orgId: string, id: string, status: OpportunityStatus, actorId?: string): boolean {
    const row = db.prepare(`SELECT id FROM disguised_opportunities WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!row) return false;
    const ackFields = status === "acknowledged" ? `, acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by = ?` : "";
    const stmt = db.prepare(`UPDATE disguised_opportunities SET status = ?, updated_at = CURRENT_TIMESTAMP${ackFields} WHERE id = ? AND organization_id = ?`);
    if (status === "acknowledged") stmt.run(status, actorId || null, id, orgId);
    else stmt.run(status, id, orgId);
    return true;
  },

  rowToOpp(row: any): Opportunity {
    let samples: any[] = [];
    try { samples = JSON.parse(row.sample_evidences_json || "[]"); } catch { samples = []; }
    return {
      id: row.id, organizationId: row.organization_id, category: row.category,
      title: row.title, description: row.description || "", suggestedAction: row.suggested_action || "",
      evidenceCount: Number(row.evidence_count || 0), sampleEvidences: samples, status: row.status,
      firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  },
};
