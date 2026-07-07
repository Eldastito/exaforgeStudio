import { randomUUID } from "node:crypto";
import db from "./db.js";

/**
 * Journal de Frustrações do Dono — Tier 2 (Carlos Domingos, ADR-046).
 *
 * O livro "Oportunidades Disfarçadas" mostra que muitos negócios (Nike,
 * Post-it, Airbnb) nasceram da IRRITAÇÃO do próprio fundador com algo do
 * cotidiano. O problema é que a maioria dos donos ESQUECE essas irritações
 * antes de aproveitá-las. Este serviço captura o registro rápido (10-30s,
 * voz ou texto) e agrupa em padrões mensais.
 *
 * Categorização: heurística por palavras-chave em pt-BR. Falsos positivos são
 * aceitáveis — o dono revisa antes de agir. Uma categorização por IA (chamada
 * assíncrona a chat()) fica como upgrade futuro se necessário.
 */

export type FrustrationCategory =
  | "operacional"     // fluxo interno, tempo, retrabalho
  | "ferramenta"      // sistema, planilha, integração
  | "pessoas"         // equipe, contratação, gestão
  | "processo"        // procedimento formal
  | "financeiro"      // dinheiro, custos, preço
  | "cliente"         // atendimento, reclamação, expectativa
  | "outro";

export interface Frustration {
  id: string;
  organizationId: string;
  userId: string | null;
  text: string;
  category: FrustrationCategory;
  source: "text" | "voice_transcribed";
  createdAt: string;
}

const CATEGORY_KEYWORDS: Record<FrustrationCategory, string[]> = {
  operacional: ["demora", "atrasa", "retrabalho", "correria", "fila", "acumulou", "sobrecar", "tempo"],
  ferramenta: ["sistema", "planilha", "excel", "erro", "bug", "trava", "integração", "integracao", "api", "site", "app"],
  pessoas: ["funcionário", "funcionario", "equipe", "colaborad", "contratar", "sair", "demiti", "faltou ao trabalho", "atrasou o", "briga"],
  processo: ["procedimento", "regra", "burocracia", "aprovação", "aprovacao", "documento", "assinatura"],
  financeiro: ["dinheiro", "caro", "custo", "receita", "margem", "prejuízo", "prejuizo", "boleto", "juros", "banco"],
  cliente: ["cliente", "reclamou", "reclamação", "reclamacao", "cancelou", "avaliação", "avaliacao", "nps", "consumidor"],
  outro: [],
};

function classify(text: string): FrustrationCategory {
  const t = (text || "").toLowerCase();
  let best: FrustrationCategory = "outro";
  let bestScore = 0;
  for (const cat of Object.keys(CATEGORY_KEYWORDS) as FrustrationCategory[]) {
    if (cat === "outro") continue;
    const score = CATEGORY_KEYWORDS[cat].reduce((acc, kw) => acc + (t.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best;
}

export const FrustrationJournalService = {
  /**
   * Registra uma frustração. Sanitiza tamanho, classifica automaticamente,
   * devolve a linha criada. Best-effort: lança apenas se orgId/text vazio.
   */
  record(organizationId: string, userId: string | null, text: string, source: "text" | "voice_transcribed" = "text"): Frustration {
    if (!organizationId) throw new Error("organizationId obrigatório");
    const clean = String(text || "").trim().slice(0, 2000);
    if (!clean) throw new Error("Texto vazio.");
    const id = randomUUID();
    const category = classify(clean);
    db.prepare(
      `INSERT INTO owner_frustrations (id, organization_id, user_id, text, category, source)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, organizationId, userId || null, clean, category, source);
    return { id, organizationId, userId, text: clean, category, source, createdAt: new Date().toISOString() };
  },

  list(orgId: string, opts: { sinceDays?: number; limit?: number } = {}): Frustration[] {
    const days = Math.max(1, Math.floor(Number(opts.sinceDays) || 60));
    const limit = Math.min(500, Math.max(1, Math.floor(Number(opts.limit) || 200)));
    const rows = db.prepare(
      `SELECT id, organization_id, user_id, text, category, source, created_at
         FROM owner_frustrations
        WHERE organization_id = ? AND created_at >= datetime('now', '-${days} days')
        ORDER BY created_at DESC LIMIT ${limit}`
    ).all(orgId) as any[];
    return rows.map((r) => ({
      id: r.id, organizationId: r.organization_id, userId: r.user_id, text: r.text,
      category: r.category as FrustrationCategory, source: r.source, createdAt: r.created_at,
    }));
  },

  delete(orgId: string, id: string): boolean {
    const info = db.prepare(`DELETE FROM owner_frustrations WHERE id = ? AND organization_id = ?`).run(id, orgId);
    return info.changes > 0;
  },

  /**
   * Resumo agregado por categoria + destaque de "categoria que mais apareceu"
   * — usado para: (a) card mensal no Diretor IA e (b) alertar quando um tema
   * ultrapassa limiar (ex.: 4+ frustrações em ferramenta no mês → sugerir
   * automação/troca de sistema).
   */
  digest(orgId: string, days = 30): { total: number; byCategory: Record<string, number>; topCategory: string | null; topCount: number } {
    const rows = db.prepare(
      `SELECT category, COUNT(*) c FROM owner_frustrations
        WHERE organization_id = ? AND created_at >= datetime('now', '-${Math.max(1, Math.floor(days))} days')
        GROUP BY category`
    ).all(orgId) as any[];
    const byCategory: Record<string, number> = {};
    let total = 0, topCategory: string | null = null, topCount = 0;
    for (const r of rows) {
      byCategory[r.category] = Number(r.c);
      total += Number(r.c);
      if (Number(r.c) > topCount) { topCount = Number(r.c); topCategory = r.category; }
    }
    return { total, byCategory, topCategory, topCount };
  },
};
