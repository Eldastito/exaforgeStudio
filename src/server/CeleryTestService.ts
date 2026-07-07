import { randomUUID } from "node:crypto";
import db from "./db.js";
import { BusinessManifestoService } from "./BusinessManifestoService.js";

/**
 * Celery Test — Tier 2 (Simon Sinek, "Comece pelo Porquê", ADR-050).
 *
 * A metáfora: você está no mercado e alguém sugere colocar salsão no
 * carrinho. Antes de comprar, você olha pro carrinho e pergunta —
 * "isso combina com o resto do que estou levando"? Se combina, coloca.
 * Se destoa, deixa. Empresas que colecionam "salsãos" (produtos,
 * canais, práticas) que não combinam com o Manifesto perdem foco,
 * confundem cliente e diluem marca.
 *
 * Este serviço faz a pergunta SEMANAL ao dono: "há alguma decisão
 * essa semana que precisa passar pelo teste do carrinho?" A resposta
 * fica registrada — não pra polícia, pra o dono ver o padrão do
 * próprio pensamento com o tempo.
 */

export type CeleryDecision = "keeps" | "drops" | "needs_review";
export type CeleryStatus = "pending" | "answered";

export interface CeleryTest {
  id: string;
  organizationId: string;
  subject: string;
  question: string;
  answer: string | null;
  decision: CeleryDecision | null;
  status: CeleryStatus;
  weekOf: string;
  answeredAt: string | null;
  handledBy: string | null;
  createdAt: string;
}

const SUBJECT_MAX = 240;
const ANSWER_MAX = 2000;

function weekOfIso(date = new Date()): string {
  // YYYY-Wnn (ISO week) — chave de dedupe semanal.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((+d - +yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function buildQuestion(orgId: string, subject: string): string {
  const m = BusinessManifestoService.get(orgId);
  const why = m?.whyStatement?.trim();
  const cleanSubject = subject.trim().slice(0, 180) || "essa nova decisão";
  const base = `Se você colocasse "${cleanSubject}" no carrinho junto com tudo que sua marca já entrega, ela combinaria com o resto — ou destoaria?`;
  const anchor = why
    ? `\n\nSeu Por Quê: "${why}"\nUse ele como bússola. Se destoa do Por Quê, deixa fora do carrinho.`
    : `\n\nDica: sem Manifesto preenchido, esse teste fica no chute. Vale abrir o Manifesto da Marca antes.`;
  return base + anchor;
}

export const CeleryTestService = {
  /**
   * Cria um Celery Test para o assunto. Dedupe: se JÁ existe um teste
   * PENDENTE para o mesmo assunto (mesmo texto normalizado) na semana
   * atual, devolve o existente.
   */
  create(orgId: string, subject: string, opts: { question?: string } = {}): CeleryTest | null {
    try {
      const s = String(subject || "").trim().slice(0, SUBJECT_MAX);
      if (!orgId || !s) return null;
      const week = weekOfIso();
      const norm = s.toLowerCase();

      const existing = db.prepare(
        `SELECT * FROM celery_tests
          WHERE organization_id = ? AND week_of = ? AND status = 'pending'
            AND lower(subject) = ?
          ORDER BY created_at DESC LIMIT 1`
      ).get(orgId, week, norm) as any;
      if (existing) return this.rowTo(existing);

      const question = String(opts.question || buildQuestion(orgId, s)).slice(0, 2000);
      const id = randomUUID();
      db.prepare(
        `INSERT INTO celery_tests (id, organization_id, subject, question, status, week_of) VALUES (?, ?, ?, ?, 'pending', ?)`
      ).run(id, orgId, s, question, week);
      return this.rowTo(db.prepare(`SELECT * FROM celery_tests WHERE id = ?`).get(id) as any);
    } catch (e) {
      console.error("[CeleryTest] create falhou:", e);
      return null;
    }
  },

  /**
   * Registra a resposta do dono. decision decide o que fica gravado:
   * keeps (mantém), drops (fora do carrinho), needs_review (mais tempo).
   */
  answer(orgId: string, id: string, patch: { answer?: string; decision: CeleryDecision; handledBy?: string }): CeleryTest | null {
    const row = db.prepare(`SELECT * FROM celery_tests WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!row) return null;
    const answer = String(patch.answer || "").trim().slice(0, ANSWER_MAX);
    if (!["keeps", "drops", "needs_review"].includes(patch.decision)) return null;
    db.prepare(
      `UPDATE celery_tests SET answer = ?, decision = ?, status = 'answered', answered_at = CURRENT_TIMESTAMP,
         handled_by = COALESCE(?, handled_by)
       WHERE id = ? AND organization_id = ?`
    ).run(answer || null, patch.decision, patch.handledBy || null, id, orgId);
    return this.rowTo(db.prepare(`SELECT * FROM celery_tests WHERE id = ?`).get(id) as any);
  },

  list(orgId: string, opts: { status?: CeleryStatus | "all"; limit?: number } = {}): CeleryTest[] {
    const where: string[] = ["organization_id = ?"];
    const params: any[] = [orgId];
    if (opts.status && opts.status !== "all") {
      where.push("status = ?");
      params.push(opts.status);
    }
    const limit = Math.min(200, Math.max(1, Math.floor(Number(opts.limit) || 50)));
    const rows = db.prepare(
      `SELECT * FROM celery_tests WHERE ${where.join(" AND ")}
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT ${limit}`
    ).all(...params) as any[];
    return rows.map((r) => this.rowTo(r));
  },

  /** Métricas simples: pendentes + distribuição de decisões nos últimos N dias. */
  metrics(orgId: string, days = 60): { pending: number; keeps: number; drops: number; needsReview: number; total: number } {
    const rows = db.prepare(
      `SELECT status, decision FROM celery_tests
         WHERE organization_id = ? AND created_at >= datetime('now', ?)`
    ).all(orgId, `-${Math.max(1, Math.floor(days))} days`) as any[];
    let pending = 0, keeps = 0, drops = 0, needsReview = 0;
    for (const r of rows) {
      if (r.status === "pending") pending++;
      else if (r.decision === "keeps") keeps++;
      else if (r.decision === "drops") drops++;
      else if (r.decision === "needs_review") needsReview++;
    }
    return { pending, keeps, drops, needsReview, total: rows.length };
  },

  currentWeek(): string {
    return weekOfIso();
  },

  rowTo(row: any): CeleryTest {
    return {
      id: row.id,
      organizationId: row.organization_id,
      subject: row.subject,
      question: row.question,
      answer: row.answer || null,
      decision: (row.decision as CeleryDecision) || null,
      status: row.status as CeleryStatus,
      weekOf: row.week_of,
      answeredAt: row.answered_at || null,
      handledBy: row.handled_by || null,
      createdAt: row.created_at,
    };
  },
};
