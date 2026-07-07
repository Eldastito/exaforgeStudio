import { randomUUID, createHash } from "node:crypto";
import db from "./db.js";
import { chat, isAIConfigured } from "./llm.js";
import { BusinessManifestoService } from "./BusinessManifestoService.js";

/**
 * Big Idea Bar — Tier 2 (Cole Nussbaumer Knaflic, "Storytelling com Dados",
 * ADR-048).
 *
 * Filosofia: dado ≠ decisão. Um gráfico mostra "vendas caíram 15%" — mas o
 * dono precisa de "e daí?". A Big Idea Bar entrega, no topo de cada painel,
 * UMA FRASE que sintetiza o dado + a AÇÃO recomendada, ancorada no Manifesto
 * (Tier 1) da marca. Não substitui gráficos — antecede eles com significado.
 *
 * Cache por hash: a IA só é chamada quando o dado bruto muda (evita gasto
 * absurdo com LLM em cada refresh). Devolução tem confidence — quando baixa,
 * a UI pode alertar o dono a ler com cautela.
 */

export interface BigIdea {
  id: string;
  organizationId: string;
  panelKey: string;
  headline: string;
  recommendedAction: string;
  confidence: number;
  createdAt: string;
}

const HEADLINE_MAX = 240;
const ACTION_MAX = 300;

function hashData(data: any): string {
  const canon = JSON.stringify(data, Object.keys(data || {}).sort());
  return createHash("sha1").update(canon).digest("hex").slice(0, 16);
}

/**
 * Cabeçalho do prompt: apoia-se no método Knaflic (contexto → mensagem única
 * → ação) e no Manifesto (tom + Por Quê) quando disponível.
 */
function buildPrompt(orgId: string, panelKey: string, data: any): string {
  const manifesto = BusinessManifestoService.toPromptHeader(orgId);
  const dataStr = JSON.stringify(data, null, 2).slice(0, 6000);
  return `${manifesto ? manifesto + "\n\n" : ""}Você é um assessor executivo que aplica o método de Cole Nussbaumer Knaflic ("Storytelling com Dados"). Sua missão: destilar o dado de um painel executivo em UMA "Big Idea" (headline) — uma frase que responde "e daí?" — MAIS a ação recomendada. Nunca descreva o dado; INTERPRETE.

REGRAS:
- Headline: 1 frase, no máximo 30 palavras, específica. Ex.: "Seu ticket médio caiu 15% este mês, puxado pelo produto X — a curva mostra tendência de queda contínua."
- Action: 1-2 frases práticas. Comece com verbo. Ex.: "Rode uma campanha de reativação com foco em quem comprou X nos últimos 90 dias — se em 7 dias não reagir, considere desconto de 10% pontual."
- Evite chavões e generalidades ("acompanhe as métricas", "atenção").
- Se o dado é neutro ou insuficiente, diga honestamente na headline (ex.: "amostra ainda pequena — 3 pedidos não permitem conclusão").
- Confidence: 0-100, quão confiável é sua leitura dado o volume/qualidade do dado.

PAINEL: ${panelKey}
DADOS BRUTOS:
${dataStr}

Devolva SOMENTE JSON:
{
  "headline": "1 frase de e daí?",
  "action": "verbo + ação concreta",
  "confidence": 85
}`;
}

export const BigIdeaBarService = {
  /**
   * Retorna a Big Idea para (org, panel, data) — do cache se o hash bate, ou
   * gera nova via LLM. Melhoria de vida: nunca lança; se a IA falhar devolve
   * uma versão degradada (sem IA, apenas eco do dado). Isso mantém o painel
   * usável mesmo quando a IA está fora.
   */
  async get(orgId: string, panelKey: string, data: any, opts: { force?: boolean } = {}): Promise<BigIdea | null> {
    const hash = hashData(data);

    if (!opts.force) {
      const cached = db.prepare(
        `SELECT * FROM big_ideas WHERE organization_id = ? AND panel_key = ? AND data_hash = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(orgId, panelKey, hash) as any;
      if (cached) return this.rowToIdea(cached);
    }

    if (!isAIConfigured()) return null;

    let parsed: any = {};
    try {
      const raw = await chat(buildPrompt(orgId, panelKey, data), {
        system: "Assessor executivo — responda SOMENTE em JSON válido.",
        json: true,
        temperature: 0.3,
      });
      const cleaned = String(raw).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("[BigIdeaBar] LLM falhou", e);
      return null;
    }

    const headline = String(parsed.headline || "").trim().slice(0, HEADLINE_MAX);
    const action = String(parsed.action || "").trim().slice(0, ACTION_MAX);
    if (!headline) return null;
    const confidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 70)));

    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO big_ideas (id, organization_id, panel_key, data_hash, headline, recommended_action, confidence, raw_data_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, orgId, panelKey, hash, headline, action, confidence, JSON.stringify(data).slice(0, 8000));
    } catch (e) {
      // Race condition rara: outro request já persistiu o mesmo (org, panel, hash).
      // Nesse caso lê o registro persistido e devolve — a idempotência do índice único cobre.
      const cached = db.prepare(
        `SELECT * FROM big_ideas WHERE organization_id = ? AND panel_key = ? AND data_hash = ?
         ORDER BY created_at DESC LIMIT 1`
      ).get(orgId, panelKey, hash) as any;
      if (cached) return this.rowToIdea(cached);
    }

    return {
      id, organizationId: orgId, panelKey,
      headline, recommendedAction: action, confidence,
      createdAt: new Date().toISOString(),
    };
  },

  /** Última Big Idea gerada para um painel — usada para UI mostrar mesmo enquanto o novo hash está sendo processado. */
  latest(orgId: string, panelKey: string): BigIdea | null {
    const row = db.prepare(
      `SELECT * FROM big_ideas WHERE organization_id = ? AND panel_key = ? ORDER BY created_at DESC LIMIT 1`
    ).get(orgId, panelKey) as any;
    return row ? this.rowToIdea(row) : null;
  },

  rowToIdea(row: any): BigIdea {
    return {
      id: row.id, organizationId: row.organization_id, panelKey: row.panel_key,
      headline: row.headline, recommendedAction: row.recommended_action || "",
      confidence: Number(row.confidence || 70), createdAt: row.created_at,
    };
  },
};
