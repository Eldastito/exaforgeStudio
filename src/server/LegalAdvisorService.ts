import db from "./db.js";
import { randomUUID } from "crypto";
import { chat, isAIConfigured } from "./llm.js";
import { CDC_ARTICLES, CDC_VERSION, LEGAL_SOURCE, LegalArticle } from "./data/cdc.js";

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

export interface LegalAnswer {
  grounded: boolean;
  orientacao: string;
  artigos: { numero: string; titulo: string; texto: string }[];
  disclaimer: string;
  fonte: string;
  versao: string;
}

export class LegalAdvisorService {
  /** Recupera os artigos do CDC mais relevantes por casamento de termos. */
  static retrieve(question: string, topK = 3): { article: LegalArticle; score: number }[] {
    const q = norm(question);
    if (!q) return [];
    const scored = CDC_ARTICLES.map((article) => {
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
    const artigos = hits.map((h) => ({ numero: h.article.numero, titulo: h.article.titulo, texto: h.article.texto }));

    let grounded = hits.length > 0;
    let orientacao: string;

    if (!grounded) {
      orientacao =
        "Não encontrei amparo direto no Código de Defesa do Consumidor para essa pergunta, então não vou arriscar uma resposta. Reformule focando na relação com o cliente/consumidor (troca, garantia, arrependimento, cobrança, oferta) ou procure um advogado para o caso.";
    } else {
      orientacao = await this.compose(question, hits.map((h) => h.article), context);
    }

    this.audit(orgId, actorId, question, artigos.map((a) => a.numero), grounded);

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
      .map((a) => `Art. ${a.numero} (${a.titulo}): ${a.texto}\nOrientação de referência: ${a.orientacao}`)
      .join("\n\n");
    const system =
      "Você é uma consultora jurídica que protege o LOJISTA em relações de consumo, sempre DENTRO da lei. " +
      "Responda APENAS com base nos artigos do CDC fornecidos — não cite lei que não esteja ali, não invente número de artigo. " +
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

  /** Metadados da base legal (para a UI mostrar fonte/versão). */
  static baseInfo() {
    return { fonte: LEGAL_SOURCE, versao: CDC_VERSION, artigos: CDC_ARTICLES.length };
  }
}

export default LegalAdvisorService;
