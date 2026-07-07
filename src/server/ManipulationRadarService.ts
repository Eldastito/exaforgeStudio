import { randomUUID } from "node:crypto";
import db from "./db.js";
import { BusinessManifestoService } from "./BusinessManifestoService.js";

/**
 * Radar de Manipulação — Tier 2 (Simon Sinek, "Comece pelo Porquê", ADR-050).
 *
 * Sinek separa manipulação de inspiração:
 *   MANIPULAÇÃO → desconto, urgência, pressão, medo, apelo social vago.
 *                  Funciona no CURTO prazo, corrói marca no longo.
 *   INSPIRAÇÃO  → Por Quê, história, transformação, resultado real.
 *                  Constrói fidelidade, indicação, marca duradoura.
 *
 * Este serviço lê textos de mensagens outbound (do dono ou gerados pela
 * IA) e sinaliza — heuristicamente, sem LLM na primeira passagem — quando
 * a comunicação está descendo pra tática de manipulação. A ideia NÃO é
 * proibir promoção. É deixar visível pro dono quando ele/a IA está
 * abandonando o Por Quê e virando "loja de esquina descontista".
 */

export type ManipulationTactic = "discount" | "urgency" | "pressure" | "scarcity" | "fear";
export type ManipulationSeverity = "low" | "medium" | "high";
export type ManipulationStatus = "open" | "dismissed" | "reformulated";
export type ManipulationSource = "ai_outbound" | "manager_typed" | "campaign_copy" | "other";

export interface ManipulationAlert {
  id: string;
  organizationId: string;
  messageSource: ManipulationSource;
  messageRef: string | null;
  sampleText: string;
  tactics: ManipulationTactic[];
  severity: ManipulationSeverity;
  suggestion: string;
  status: ManipulationStatus;
  handledBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// Léxico calibrado pro pt-BR conversacional. Cada tática pode ter várias
// famílias — o objetivo é bom recall, o dono descarta o que não faz sentido.
const LEXICON: Record<ManipulationTactic, RegExp[]> = {
  discount: [
    /\b(\d{1,2})\s*%\s*(off|de\s+desconto|desconto)\b/i,
    /\bdesconto\s+(especial|imperd[íi]vel|exclusivo|relâmpago|de\s+at[ée]|super)\b/i,
    /\bpre[çc]o\s+(promocional|imperd[íi]vel|de\s+f[áa]brica)\b/i,
    /\bpague\s+\d+\s+leve\s+\d+\b/i,
    /\bfrete\s+gr[áa]tis\b/i,
    /\bmetade\s+do\s+pre[çc]o\b/i,
  ],
  urgency: [
    /\bs[óo]\s+hoje\b/i,
    /\b[úu]ltim[ao]s?\s+(dia|hora|chance|unidade)/i,
    /\btermina\s+(hoje|agora|em\s+\d)/i,
    /\bcorra\b/i,
    /\bpromo\s+relampago\b/i,
    /\baproveita?\s+agora\b/i,
    /\bpor\s+tempo\s+limitad[ao]\b/i,
    /\bacaba\s+(hoje|amanha|em\s+\d)/i,
  ],
  pressure: [
    /\bn[ãa]o\s+perc[ae]\b/i,
    /\bn[ãa]o\s+deixe\s+(escapar|passar)\b/i,
    /\bvoc[êe]\s+precisa\b/i,
    /\bantes\s+que\s+acabe\b/i,
    /\b[úu]ltima\s+oportunidade\b/i,
    /\bgarant[ea]\s+j[áa]\b/i,
    /\bagora\s+ou\s+nunca\b/i,
  ],
  scarcity: [
    /\brestam?\s+\d+\b/i,
    /\bapenas\s+\d+\s+(vaga|unidade|pe[çc]a)/i,
    /\b[úu]ltim[ao]s?\s+\d+\b/i,
    /\bestoque\s+(quase\s+)?acabando\b/i,
    /\bpouco[s]?\s+em\s+estoque\b/i,
  ],
  fear: [
    /\bvoc[êe]\s+vai\s+(se\s+arrepender|perder)\b/i,
    /\bn[ãa]o\s+seja\s+(o\s+)?[úu]ltim/i,
    /\btodos?\s+(j[áa]|est[ãa]o)\s+comprand/i,
  ],
};

const TACTIC_LABEL: Record<ManipulationTactic, string> = {
  discount: "desconto",
  urgency: "urgência",
  pressure: "pressão",
  scarcity: "escassez",
  fear: "medo",
};

const SAMPLE_MAX = 600;

/**
 * Analisa um texto e devolve as táticas encontradas + severidade.
 * Exportado pra permitir chamada standalone (previews de campanha etc.).
 */
export function analyzeText(text: string): { tactics: ManipulationTactic[]; severity: ManipulationSeverity; matches: string[] } {
  const t = String(text || "");
  const found: ManipulationTactic[] = [];
  const matches: string[] = [];
  (Object.keys(LEXICON) as ManipulationTactic[]).forEach((tactic) => {
    const hit = LEXICON[tactic].some((re) => {
      const m = t.match(re);
      if (m) { matches.push(m[0]); return true; }
      return false;
    });
    if (hit) found.push(tactic);
  });
  const severity: ManipulationSeverity = found.length >= 3 ? "high" : found.length === 2 ? "medium" : "low";
  return { tactics: found, severity, matches };
}

function buildSuggestion(orgId: string, tactics: ManipulationTactic[]): string {
  const m = BusinessManifestoService.get(orgId);
  const why = m?.whyStatement?.trim() || "";
  const parts: string[] = [];
  parts.push(`Reformule ancorando no "Por Quê" da marca em vez de apelar por tática.`);
  if (why) parts.push(`Seu Por Quê: "${why}".`);
  parts.push(`Táticas detectadas: ${tactics.map((t) => TACTIC_LABEL[t]).join(", ")}.`);
  parts.push(`Sugestão: comece pela TRANSFORMAÇÃO ("por que isso muda a vida do cliente") e só depois mencione preço/prazo.`);
  return parts.join(" ");
}

export const ManipulationRadarService = {
  /**
   * Analisa e, se detectar tática, registra um alerta. Idempotente:
   * mesma mensagem (sample_text hash) não gera duplicata na janela de
   * 24 horas — se o dono repete o alerta 5 vezes, ele/a IA já sabe.
   */
  scan(input: {
    organizationId: string;
    text: string;
    source?: ManipulationSource;
    ref?: string | null;
  }): ManipulationAlert | null {
    try {
      if (!input.organizationId || !input.text) return null;
      const { tactics, severity, matches } = analyzeText(input.text);
      if (tactics.length === 0) return null;

      const source: ManipulationSource = input.source || "other";
      const sample = String(input.text).slice(0, SAMPLE_MAX);
      const normKey = sample.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);

      const existing = db.prepare(
        `SELECT * FROM manipulation_alerts
          WHERE organization_id = ? AND message_source = ?
            AND lower(substr(sample_text, 1, 200)) = ?
            AND status = 'open'
            AND created_at >= datetime('now', '-1 days')
          ORDER BY created_at DESC LIMIT 1`
      ).get(input.organizationId, source, normKey) as any;
      if (existing) return this.rowTo(existing);

      const suggestion = buildSuggestion(input.organizationId, tactics);
      const id = randomUUID();
      db.prepare(
        `INSERT INTO manipulation_alerts (id, organization_id, message_source, message_ref, sample_text, tactics_json, severity, suggestion, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`
      ).run(id, input.organizationId, source, input.ref || null, sample, JSON.stringify(tactics), severity, suggestion);
      return this.rowTo(db.prepare(`SELECT * FROM manipulation_alerts WHERE id = ?`).get(id) as any);
    } catch (e) {
      console.error("[ManipulationRadar] scan falhou:", e);
      return null;
    }
  },

  list(orgId: string, opts: { status?: ManipulationStatus | "all"; limit?: number } = {}): ManipulationAlert[] {
    const where: string[] = ["organization_id = ?"];
    const params: any[] = [orgId];
    if (opts.status && opts.status !== "all") {
      where.push("status = ?");
      params.push(opts.status);
    }
    const limit = Math.min(200, Math.max(1, Math.floor(Number(opts.limit) || 50)));
    const rows = db.prepare(
      `SELECT * FROM manipulation_alerts WHERE ${where.join(" AND ")}
         ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT ${limit}`
    ).all(...params) as any[];
    return rows.map((r) => this.rowTo(r));
  },

  updateStatus(orgId: string, id: string, status: ManipulationStatus, opts: { handledBy?: string } = {}): boolean {
    const row = db.prepare(`SELECT id FROM manipulation_alerts WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!row) return false;
    db.prepare(
      `UPDATE manipulation_alerts SET status = ?, handled_by = COALESCE(?, handled_by), updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`
    ).run(status, opts.handledBy || null, id, orgId);
    return true;
  },

  metrics(orgId: string, days = 30): { open: number; total: number; byTactic: Record<string, number> } {
    const rows = db.prepare(
      `SELECT status, tactics_json FROM manipulation_alerts
         WHERE organization_id = ? AND created_at >= datetime('now', ?)`
    ).all(orgId, `-${Math.max(1, Math.floor(days))} days`) as any[];
    let open = 0;
    const byTactic: Record<string, number> = {};
    for (const r of rows) {
      if (r.status === "open") open++;
      try {
        const tactics = JSON.parse(r.tactics_json || "[]") as ManipulationTactic[];
        for (const t of tactics) byTactic[t] = (byTactic[t] || 0) + 1;
      } catch { /* row inválido, ignora */ }
    }
    return { open, total: rows.length, byTactic };
  },

  labelFor(t: ManipulationTactic): string { return TACTIC_LABEL[t] || t; },

  rowTo(row: any): ManipulationAlert {
    let tactics: ManipulationTactic[] = [];
    try { tactics = JSON.parse(row.tactics_json || "[]"); } catch { tactics = []; }
    return {
      id: row.id,
      organizationId: row.organization_id,
      messageSource: row.message_source as ManipulationSource,
      messageRef: row.message_ref || null,
      sampleText: row.sample_text || "",
      tactics,
      severity: row.severity as ManipulationSeverity,
      suggestion: row.suggestion || "",
      status: row.status as ManipulationStatus,
      handledBy: row.handled_by || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    };
  },
};
