import db from "./db.js";
import { randomUUID } from "crypto";
import { chat, isAIConfigured } from "./llm.js";
import { CDC_ARTICLES, LEGAL_LIBRARY, NORM_BY_KEY, refLabel, normKey, CDC_VERSION, LEGAL_SOURCE, LegalArticle } from "./data/cdc.js";

/**
 * Consultora Jurídica (ADR-115) — orienta o lojista ANCORADA no Código de
 * Defesa do Consumidor, para ele não se prejudicar em relação de consumo.
 *
 * Frugal e testável (ADR-088 D5): a RECUPERAÇÃO é determinística por termos
 * sobre a base do CDC (custo zero, sem embedding), então a resposta é sempre
 * GROUNDED — sem amparo na base, diz que não encontrou (nunca inventa lei). O
 * LLM entra SÓ para redigir a orientação a partir dos artigos recuperados; sem
 * chave de IA, cai no texto protetivo já curado por artigo. O disclaimer é
 * cravado por código em TODA resposta. Isolado por organization_id.
 */

const DISCLAIMER =
  "Esta é uma orientação baseada no Código de Defesa do Consumidor e não substitui um advogado. Em caso complexo, litígio ou dúvida, procure um profissional do Direito.";

// Normaliza para o match: minúsculas, sem acento, espaços colapsados.
function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface LegalCitation { numero: string; titulo: string; texto: string; fonte: string; ref: string }
export interface LegalAnswer {
  grounded: boolean;
  orientacao: string;
  artigos: LegalCitation[];
  disclaimer: string;
  fonte: string;
  versao: string;
}

function cite(a: LegalArticle): LegalCitation {
  return { numero: a.numero, titulo: a.titulo, texto: a.texto, fonte: a.fonte || "cdc", ref: refLabel(a) };
}

export class LegalAdvisorService {
  /** Recupera as normas (CDC + súmulas + PROCON) mais relevantes por termos. */
  static retrieve(question: string, topK = 3): { article: LegalArticle; score: number }[] {
    const q = norm(question);
    if (!q) return [];
    const scored = LEGAL_LIBRARY.map((article) => {
      let score = 0;
      for (const termo of article.termos) {
        const t = norm(termo);
        if (t && q.includes(t)) score += t.length >= 6 ? 2 : 1; // termo específico pesa mais
      }
      // Reforço leve: menção direta ao número do artigo ("art 42", "artigo 42").
      if (new RegExp(`\\bart(?:igo)?\\.?\\s*${article.numero}\\b`).test(q)) score += 3;
      return { article, score };
    }).filter((s) => s.score > 0);
    scored.sort((a, b) => b.score - a.score || Number(a.article.numero) - Number(b.article.numero));
    return scored.slice(0, topK);
  }

  /**
   * Responde à dúvida do lojista: orientação protetiva + artigos citados +
   * disclaimer obrigatório. Sem amparo na base → recusa honesta (grounded=false).
   */
  static async ask(orgId: string, question: string, context?: string, actorId?: string): Promise<LegalAnswer> {
    const hits = this.retrieve(question);
    const artigos = hits.map((h) => cite(h.article));

    let grounded = hits.length > 0;
    let orientacao: string;

    if (!grounded) {
      orientacao =
        "Não encontrei amparo direto na base legal (CDC, súmulas do STJ, PROCON) para essa pergunta, então não vou arriscar uma resposta. Reformule focando na relação com o cliente/consumidor (troca, garantia, arrependimento, cobrança, oferta) ou procure um advogado para o caso.";
    } else {
      orientacao = await this.compose(question, hits.map((h) => h.article), context);
    }

    this.audit(orgId, actorId, question, hits.map((h) => normKey(h.article)), grounded);

    return { grounded, orientacao, artigos, disclaimer: DISCLAIMER, fonte: LEGAL_SOURCE, versao: CDC_VERSION };
  }

  /**
   * Redige o "como proceder". Com LLM: sintetiza ESTRITAMENTE a partir dos
   * artigos recuperados (grounding), tom conservador e a favor do lojista, sem
   * orientar ilegalidade. Sem LLM: concatena a orientação curada de cada artigo.
   */
  private static async compose(question: string, articles: LegalArticle[], context?: string): Promise<string> {
    const curated = articles.map((a) => a.orientacao).join(" ");
    if (!isAIConfigured()) return curated;

    const base = articles
      .map((a) => `${refLabel(a)} (${a.titulo}): ${a.texto}\nOrientação de referência: ${a.orientacao}`)
      .join("\n\n");
    const system =
      "Você é uma consultora jurídica que protege o LOJISTA em relações de consumo, sempre DENTRO da lei. " +
      "Responda APENAS com base nas normas fornecidas (CDC, súmulas do STJ, PROCON) — não cite norma que não esteja ali, não invente número de artigo/súmula. " +
      "Tom prático e conservador, a favor do lojista, mas NUNCA oriente prática abusiva ou ilegal (ex.: reter produto indevidamente, expor/constranger devedor, negar direito garantido). " +
      "Escreva 'como proceder' em 2 a 4 frases, linguagem simples de dono de pequeno negócio. Não inclua aviso legal (será acrescentado depois).";
    const prompt =
      `PERGUNTA DO LOJISTA:\n"${question}"\n\n` +
      (context ? `CONTEXTO:\n${context}\n\n` : "") +
      `ARTIGOS DO CDC RECUPERADOS (única base permitida):\n${base}\n\n` +
      `Escreva a orientação prática e protetiva ao lojista.`;
    try {
      const out = (await chat(prompt, { temperature: 0.3, system })).trim();
      return out || curated;
    } catch {
      return curated; // frugalidade/robustez: nunca quebra por causa da IA
    }
  }

  private static audit(orgId: string, actorId: string | undefined, question: string, numeros: string[], grounded: boolean) {
    try {
      db.prepare(
        `INSERT INTO legal_consultations (id, organization_id, actor_user_id, question, articles, grounded)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), orgId, actorId || null, String(question || "").slice(0, 1000), numeros.join(","), grounded ? 1 : 0);
    } catch { /* auditoria nunca pode quebrar a consulta */ }
  }

  /** Perguntas sugeridas (atalhos da UI) — cobrem os temas mais comuns. */
  static suggestedTopics(): { label: string; question: string }[] {
    return [
      { label: "Troca de produto com defeito", question: "Cliente comprou e o produto veio com defeito, sou obrigado a devolver o dinheiro na hora?" },
      { label: "Arrependimento em 7 dias", question: "Cliente comprou pela internet e quer devolver sem defeito, tenho que aceitar?" },
      { label: "Como cobrar quem me deve", question: "Como faço para cobrar um cliente que ficou devendo no fiado sem correr risco?" },
      { label: "Prazo para reclamar", question: "Quantos dias o cliente tem para reclamar de um produto com defeito?" },
      { label: "Errei o preço no anúncio", question: "Anunciei um produto com o preço errado, sou obrigado a vender por aquele valor?" },
      { label: "Posso negativar o cliente?", question: "Posso colocar o nome do cliente no SPC/Serasa por causa de uma dívida?" },
    ];
  }

  // ── Ganchos proativos por situação (ADR-115 Fatia 2/3) ──────────────────────
  // Mapeia um MOMENTO do negócio → dica protetiva + normas que a sustentam
  // (chaves `${fonte}:${numero}`, cobrindo CDC + súmulas + PROCON).
  // Determinístico (zero-token) e sempre grounded: a IA SUGERE a conduta no
  // momento certo; o lojista decide (ADR-091 §6).
  private static SITUATIONS: Record<string, { titulo: string; dica: string; refs: string[] }> = {
    cobranca_fiado: {
      titulo: "Cobrando quem te deve",
      dica: "Pode cobrar — inclusive o fiado — mas sempre em PARTICULAR e com cortesia. Nunca exponha, avise terceiros, publique o nome ou ameace: isso é constrangimento proibido e pode virar dano moral contra você. Confira o valor certo e ofereça parcelar. É por isso que o lembrete daqui é gentil.",
      refs: ["cdc:42", "cdc:43"],
    },
    devolucao_troca: {
      titulo: "Cliente quer trocar ou devolver",
      dica: "Se for DEFEITO, você tem até 30 dias para consertar ou trocar antes de devolver o dinheiro — ofereça o reparo primeiro. Confira também o prazo do cliente para reclamar (30 dias não durável / 90 durável). Troca por gosto, sem defeito, em compra feita na loja física, é cortesia sua — não obrigação.",
      refs: ["cdc:18", "cdc:26", "cdc:49"],
    },
    arrependimento: {
      titulo: "Compra feita fora da loja (internet/WhatsApp)",
      dica: "Venda por internet, WhatsApp ou telefone dá ao cliente 7 dias corridos para se arrepender, mesmo sem defeito, com devolução do valor corrigido (frete incluído). Compra presencial na loja NÃO tem esse direito. Deixe sua política de troca visível para evitar mal-entendido.",
      refs: ["cdc:49", "cdc:18"],
    },
    negativacao: {
      titulo: "Antes de negativar (SPC/Serasa)",
      dica: "Negativar sem avisar antes, ou com valor errado, gera dano moral contra você. Confira se a dívida existe e está correta, envie o aviso por escrito com antecedência e só então registre. A negativação não pode passar de 5 anos. Muitas vezes um acordo de parcelamento resolve sem chegar a isso.",
      refs: ["cdc:43", "sumula_stj:359", "sumula_stj:385"],
    },
    reclamacao_procon: {
      titulo: "Fui notificado pelo PROCON",
      dica: "Não ignore: responda dentro do prazo, de forma educada e documentada, com sua versão e uma proposta de solução (conserto, troca ou reembolso conforme o caso). Guarde os comprovantes. Resolver por acordo costuma sair muito mais barato que a multa e o desgaste.",
      refs: ["procon:resposta", "cdc:6"],
    },
    chargeback: {
      titulo: "Cliente contestou a compra no cartão (chargeback)",
      dica: "Sua defesa é a PROVA: guarde comprovante de entrega, conversa, nota e dados da venda, e conteste no prazo da adquirente. Em venda a distância, confira os dados antes de despachar. Se foi arrependimento legítimo em 7 dias, o reembolso é devido de qualquer forma.",
      refs: ["procon:chargeback", "cdc:49"],
    },
  };

  /** Dica proativa para um momento do negócio (ou null se a chave não existe). */
  static forSituation(key: string, orgId?: string, actorId?: string) {
    const s = this.SITUATIONS[key];
    if (!s) return null;
    const artigos = s.refs.map((k) => NORM_BY_KEY[k]).filter(Boolean).map((a) => cite(a));
    if (orgId) this.audit(orgId, actorId, `[situação] ${key}`, s.refs, true);
    return { key, titulo: s.titulo, dica: s.dica, artigos, disclaimer: DISCLAIMER, fonte: LEGAL_SOURCE, versao: CDC_VERSION };
  }

  /** Lista das situações disponíveis (para a UI oferecer a dica no lugar certo). */
  static situations(): { key: string; titulo: string }[] {
    return Object.entries(this.SITUATIONS).map(([key, v]) => ({ key, titulo: v.titulo }));
  }

  /**
   * Histórico de consultas por tema (ADR-115 Fatia 3): o que o lojista mais
   * consultou, agregado pela norma citada — mostra onde ele tem mais dúvida/
   * risco. Ignora as dicas proativas (só perguntas reais). Isolado por org.
   */
  static history(orgId: string, limit = 6) {
    const rows = db.prepare(
      "SELECT articles, grounded FROM legal_consultations WHERE organization_id = ? AND question NOT LIKE '[situação]%'"
    ).all(orgId) as any[];
    const total = rows.length;
    const grounded = rows.filter((r) => r.grounded).length;
    const counts = new Map<string, number>();
    for (const r of rows) {
      for (const key of String(r.articles || "").split(",").map((s) => s.trim()).filter(Boolean)) {
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    const temas = [...counts.entries()]
      .map(([key, n]) => {
        const norm = NORM_BY_KEY[key];
        return { key, ref: norm ? refLabel(norm) : key, titulo: norm?.titulo || key, count: n };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
    return { total, grounded, recusadas: total - grounded, temas };
  }

  /** Metadados da base legal (para a UI mostrar fonte/versão). */
  static baseInfo() {
    const porFonte = LEGAL_LIBRARY.reduce((acc: Record<string, number>, a) => {
      const f = a.fonte || "cdc"; acc[f] = (acc[f] || 0) + 1; return acc;
    }, {});
    return { fonte: LEGAL_SOURCE, versao: CDC_VERSION, artigos: CDC_ARTICLES.length, normas: LEGAL_LIBRARY.length, porFonte };
  }
}

export default LegalAdvisorService;
