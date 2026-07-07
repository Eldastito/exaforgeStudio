import { randomUUID } from "node:crypto";
import db from "./db.js";

/**
 * Checklist de Fundamentos — Tier 2 (Carlos Domingos, "Problema é sinal,
 * não fim", ADR-050).
 *
 * Filosofia: campanha em cima de fundamento quebrado NÃO conserta —
 * amplifica o problema. Se sua entrega tá atrasando, mais tráfego =
 * mais reclamação. Se seu atendimento não responde no SLA, mais leads
 * = mais gente desistindo. Se seu CSAT tá caindo, mais campanha =
 * mais detrator no mundo.
 *
 * Este serviço rola um health-check ANTES da campanha. Cinco itens
 * essenciais, cada um verificado direto no banco (SLA de atendimento,
 * CSAT, reclamações abertas, cobertura de estoque, tickets travados).
 * Se tudo estiver ok → passed. Se algum atenção → passed_with_warnings.
 * Se algum crítico → blocked (recomenda pausar campanha e arrumar).
 *
 * Retorno é SUGESTÃO. O dono decide se segue ou não — como sempre.
 */

export type CheckItemStatus = "ok" | "attention" | "critical" | "unknown";
export type FundamentalsStatus = "passed" | "passed_with_warnings" | "blocked";

export interface CheckItem {
  key: string;
  label: string;
  status: CheckItemStatus;
  evidence: string;
}

export interface FundamentalsCheck {
  id: string;
  organizationId: string;
  campaignRef: string | null;
  items: CheckItem[];
  score: number;
  status: FundamentalsStatus;
  recommendation: string;
  handledBy: string | null;
  createdAt: string;
}

const STATUS_TO_SCORE: Record<CheckItemStatus, number> = {
  ok: 100, attention: 60, critical: 20, unknown: 50,
};

function fmtPct(n: number): string { return `${Math.round(n)}%`; }
function fmtHours(h: number): string { return h >= 1 ? `${Math.round(h * 10) / 10}h` : `${Math.round(h * 60)}min`; }

/**
 * Executa os checks direto no banco. Cada função devolve um item
 * completo. Todos os checks NUNCA lançam — se a tabela não existir
 * ou a query falhar, retornam status 'unknown' com evidência do erro.
 */
function checkAttendanceSla(orgId: string): CheckItem {
  try {
    // Aproximação: 1ª resposta média em tickets abertos nos últimos 7 dias.
    const row = db.prepare(
      `SELECT AVG((julianday(first_response_at) - julianday(created_at)) * 24) AS avg_hours,
              COUNT(*) AS n
         FROM tickets
        WHERE organization_id = ? AND created_at >= datetime('now', '-7 days')
          AND first_response_at IS NOT NULL`
    ).get(orgId) as any;
    const n = Number(row?.n) || 0;
    const avgH = Number(row?.avg_hours);
    if (!n) return { key: "attendance_sla", label: "Atendimento respondendo em SLA?", status: "unknown", evidence: "Sem tickets com 1ª resposta nos últimos 7 dias." };
    if (!isFinite(avgH)) return { key: "attendance_sla", label: "Atendimento respondendo em SLA?", status: "unknown", evidence: `${n} ticket(s), sem dado de tempo.` };
    if (avgH <= 0.5) return { key: "attendance_sla", label: "Atendimento respondendo em SLA?", status: "ok", evidence: `Média de 1ª resposta: ${fmtHours(avgH)} em ${n} ticket(s).` };
    if (avgH <= 2) return { key: "attendance_sla", label: "Atendimento respondendo em SLA?", status: "attention", evidence: `Média de 1ª resposta: ${fmtHours(avgH)} em ${n} ticket(s). Acima de 30min já sinaliza atenção.` };
    return { key: "attendance_sla", label: "Atendimento respondendo em SLA?", status: "critical", evidence: `Média de 1ª resposta: ${fmtHours(avgH)} em ${n} ticket(s). Cliente está esperando demais — campanha vai piorar.` };
  } catch (e: any) {
    return { key: "attendance_sla", label: "Atendimento respondendo em SLA?", status: "unknown", evidence: `Não deu pra medir (${e?.message || e}).` };
  }
}

function checkCsat(orgId: string): CheckItem {
  try {
    const row = db.prepare(
      `SELECT AVG(score) AS avg_score, COUNT(*) AS n
         FROM satisfaction_surveys
        WHERE organization_id = ? AND status = 'answered' AND answered_at >= datetime('now', '-30 days')`
    ).get(orgId) as any;
    const n = Number(row?.n) || 0;
    const avg = Number(row?.avg_score);
    if (n < 3) return { key: "csat", label: "CSAT saudável (nota média)?", status: "unknown", evidence: `Amostra pequena — ${n} resposta(s) nos últimos 30 dias.` };
    const avg10 = Math.round(avg * 10) / 10;
    if (avg >= 4) return { key: "csat", label: "CSAT saudável (nota média)?", status: "ok", evidence: `Média ${avg10}/5 em ${n} resposta(s).` };
    if (avg >= 3.5) return { key: "csat", label: "CSAT saudável (nota média)?", status: "attention", evidence: `Média ${avg10}/5 em ${n} resposta(s). Abaixo de 4, dá sinal de fricção.` };
    return { key: "csat", label: "CSAT saudável (nota média)?", status: "critical", evidence: `Média ${avg10}/5 em ${n} resposta(s). Cliente atual insatisfeito — arruma antes de subir campanha.` };
  } catch (e: any) {
    return { key: "csat", label: "CSAT saudável (nota média)?", status: "unknown", evidence: `Não deu pra medir (${e?.message || e}).` };
  }
}

function checkOpenComplaints(orgId: string): CheckItem {
  try {
    // Reclamações não resolvidas: recovery_events com status ativo há mais de 3 dias.
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM recovery_events
        WHERE organization_id = ? AND status IN ('triggered','playbook_sent')
          AND created_at < datetime('now', '-3 days')`
    ).get(orgId) as any;
    const n = Number(row?.n) || 0;
    if (n === 0) return { key: "open_complaints", label: "Sem reclamações abertas há > 3 dias?", status: "ok", evidence: `Nenhuma reclamação parada há mais de 3 dias.` };
    if (n <= 2) return { key: "open_complaints", label: "Sem reclamações abertas há > 3 dias?", status: "attention", evidence: `${n} reclamação(ões) aberta(s) há mais de 3 dias.` };
    return { key: "open_complaints", label: "Sem reclamações abertas há > 3 dias?", status: "critical", evidence: `${n} reclamações aguardando ação — cada nova venda vira mais fila.` };
  } catch (e: any) {
    return { key: "open_complaints", label: "Sem reclamações abertas há > 3 dias?", status: "unknown", evidence: `Não deu pra medir (${e?.message || e}).` };
  }
}

function checkInventoryCoverage(orgId: string): CheckItem {
  try {
    // Aproximação: quantos produtos ativos estão sem estoque.
    const totalRow = db.prepare(
      `SELECT COUNT(*) AS n FROM products_services WHERE organization_id = ? AND status = 'active'`
    ).get(orgId) as any;
    const total = Number(totalRow?.n) || 0;
    if (total === 0) return { key: "inventory", label: "Estoque com cobertura?", status: "unknown", evidence: `Sem produtos ativos cadastrados.` };
    const outRow = db.prepare(
      `SELECT COUNT(*) AS n FROM products_services p
        WHERE p.organization_id = ? AND p.status = 'active'
          AND COALESCE((SELECT SUM(stock_quantity) FROM inventory_items i WHERE i.product_id = p.id), 0) <= 0`
    ).get(orgId) as any;
    const out = Number(outRow?.n) || 0;
    const outPct = (out / total) * 100;
    if (outPct <= 5) return { key: "inventory", label: "Estoque com cobertura?", status: "ok", evidence: `${out}/${total} produto(s) sem estoque (${fmtPct(outPct)}).` };
    if (outPct <= 15) return { key: "inventory", label: "Estoque com cobertura?", status: "attention", evidence: `${out}/${total} sem estoque (${fmtPct(outPct)}). Ruptura próxima.` };
    return { key: "inventory", label: "Estoque com cobertura?", status: "critical", evidence: `${out}/${total} produtos sem estoque (${fmtPct(outPct)}). Campanha vai gerar frustração.` };
  } catch (e: any) {
    return { key: "inventory", label: "Estoque com cobertura?", status: "unknown", evidence: `Não deu pra medir (${e?.message || e}).` };
  }
}

function checkStaleTickets(orgId: string): CheckItem {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM tickets
        WHERE organization_id = ? AND status IN ('open','pending','in_progress')
          AND updated_at < datetime('now', '-2 days')`
    ).get(orgId) as any;
    const n = Number(row?.n) || 0;
    if (n === 0) return { key: "stale_tickets", label: "Tickets sem atividade > 2 dias?", status: "ok", evidence: `Nenhum ticket travado.` };
    if (n <= 5) return { key: "stale_tickets", label: "Tickets sem atividade > 2 dias?", status: "attention", evidence: `${n} ticket(s) sem atividade há mais de 2 dias.` };
    return { key: "stale_tickets", label: "Tickets sem atividade > 2 dias?", status: "critical", evidence: `${n} tickets abandonados — atendimento tá afogando.` };
  } catch (e: any) {
    return { key: "stale_tickets", label: "Tickets sem atividade > 2 dias?", status: "unknown", evidence: `Não deu pra medir (${e?.message || e}).` };
  }
}

function buildRecommendation(status: FundamentalsStatus, items: CheckItem[]): string {
  const criticals = items.filter((i) => i.status === "critical").map((i) => i.label);
  const attentions = items.filter((i) => i.status === "attention").map((i) => i.label);

  if (status === "blocked") {
    return `PAUSE ANTES DE SUBIR. Fundamento crítico: ${criticals.join("; ")}. Carlos Domingos ensina: problema é sinal — arrume antes, campanha depois. Você vai gastar em anúncio pra amplificar o sintoma que já sente.`;
  }
  if (status === "passed_with_warnings") {
    return `Pode subir com cuidado. Atenção: ${attentions.join("; ")}. Deixe alguém monitorando o funil junto.`;
  }
  return `Tudo alinhado. Fundamentos ok — pode subir a campanha com tranquilidade e acompanhar as métricas.`;
}

export const FundamentalsChecklistService = {
  /**
   * Roda o checklist AGORA. Persiste o resultado e devolve.
   * campaignRef é opcional — permite atrelar o check a uma campanha
   * específica (id/nome) pra rastreabilidade.
   */
  run(orgId: string, opts: { campaignRef?: string; handledBy?: string } = {}): FundamentalsCheck | null {
    if (!orgId) return null;
    const items: CheckItem[] = [
      checkAttendanceSla(orgId),
      checkCsat(orgId),
      checkOpenComplaints(orgId),
      checkInventoryCoverage(orgId),
      checkStaleTickets(orgId),
    ];
    const score = Math.round(items.reduce((s, i) => s + STATUS_TO_SCORE[i.status], 0) / items.length);
    const hasCritical = items.some((i) => i.status === "critical");
    const hasAttention = items.some((i) => i.status === "attention");
    const status: FundamentalsStatus = hasCritical ? "blocked" : hasAttention ? "passed_with_warnings" : "passed";
    const recommendation = buildRecommendation(status, items);

    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO fundamentals_checks (id, organization_id, campaign_ref, items_json, score, status, recommendation, handled_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, orgId, opts.campaignRef || null, JSON.stringify(items), score, status, recommendation, opts.handledBy || null);
    } catch (e) {
      console.error("[Fundamentals] insert falhou:", e);
      return null;
    }
    return this.rowTo(db.prepare(`SELECT * FROM fundamentals_checks WHERE id = ?`).get(id) as any);
  },

  latest(orgId: string): FundamentalsCheck | null {
    const row = db.prepare(
      `SELECT * FROM fundamentals_checks WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(orgId) as any;
    return row ? this.rowTo(row) : null;
  },

  list(orgId: string, opts: { limit?: number } = {}): FundamentalsCheck[] {
    const limit = Math.min(50, Math.max(1, Math.floor(Number(opts.limit) || 20)));
    const rows = db.prepare(
      `SELECT * FROM fundamentals_checks WHERE organization_id = ? ORDER BY created_at DESC LIMIT ${limit}`
    ).all(orgId) as any[];
    return rows.map((r) => this.rowTo(r));
  },

  rowTo(row: any): FundamentalsCheck {
    let items: CheckItem[] = [];
    try { items = JSON.parse(row.items_json || "[]"); } catch { items = []; }
    return {
      id: row.id,
      organizationId: row.organization_id,
      campaignRef: row.campaign_ref || null,
      items,
      score: Number(row.score || 0),
      status: row.status as FundamentalsStatus,
      recommendation: row.recommendation || "",
      handledBy: row.handled_by || null,
      createdAt: row.created_at,
    };
  },
};
