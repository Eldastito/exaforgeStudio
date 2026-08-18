/**
 * HelpKnowledgeService — ADR-179 F1: base de ajuda do USUÁRIO + recuperação grounded.
 *
 * É a camada de CONTEÚDO por trás do Tutor de Ajuda (que É o Fala Tu respondendo
 * dúvida — RN-UX-1/RN-HELP-4, sem 2º motor de chat). O `ZeroTrainingHelpService`
 * continua sendo o cérebro determinístico; este service só entrega o ARTIGO CURADO
 * que aterra a resposta.
 *
 * Guardrails (RN-HELP):
 *  - RN-HELP-1 (grounded/nunca inventa): responde SÓ do artigo publicado recuperado;
 *    sem cobertura → não inventa, admite e REGISTRA a lacuna (`help_gap_log`).
 *  - RN-HELP-2 (citação sempre): a resposta carrega o artigo-fonte.
 *  - RN-HELP-3 (curadoria humana): só artigo `status='published'` COM `reviewed_by`
 *    é recuperável. Rascunho nunca vai ao ar.
 *  - RN-HELP-5 (não indexa doc técnica crua): a base é conteúdo do usuário, não ADR.
 *  - RN-HELP-6 (LGPD): a lacuna guarda a query NORMALIZADA (sem PII), por-org.
 *  - RN-HELP-8 (determinístico antes de LLM): recuperação por sobreposição de termos,
 *    roda em CI sem chave de IA; o LLM (fallback do Fala Tu) só reescreve o recuperado.
 *
 * A base é GLOBAL (o "como faço" é o mesmo p/ todos os tenants) com recorte OPCIONAL
 * por vertical (vertical NULL = todas). Semente idempotente dos módulos mais usados.
 */
import { randomUUID } from "crypto";
import db from "./db.js";

export interface HelpArticle {
  id: string;
  vertical: string | null;
  module_key: string | null;
  title: string;
  what: string | null;
  purpose: string | null;
  steps: string[];
  commonErrors: string[];
  keywords: string;
  reviewedBy: string;
  sourceRef: string | null;
}

// Termos curtos/comuns que não ajudam a discriminar artigos (não pontuam).
const STOP = new Set([
  "que", "com", "por", "para", "pra", "como", "onde", "quando", "qual", "quais",
  "uma", "meu", "minha", "seus", "suas", "dos", "das", "num", "numa", "isso",
  "faz", "fazer", "faço", "tem", "the", "and", "you", "sobre", "está", "estao",
  "mais", "menos", "aqui", "esse", "essa", "este", "esta", "não", "nao", "sim",
]);

function tokenize(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

// Semente dos módulos mais usados (ADR-179 F1). Conteúdo CURADO/humano (reviewedBy).
// GLOBAL por padrão (vertical NULL) → serve toda a base; um artigo clínico prova o
// recorte por vertical. Ids fixos → seed idempotente (INSERT OR IGNORE).
const SEED: Array<Omit<HelpArticle, "id"> & { id: string; status?: string }> = [
  {
    id: "help_seed_central_saude",
    vertical: null,
    module_key: "central_saude",
    title: "Central de Saúde do negócio",
    what: "O painel que resume como o seu negócio está indo — o que precisa de você e o valor que a plataforma protegeu.",
    purpose: "Ver num lugar só o que exige atenção (aprovações, riscos, oportunidades) sem abrir tela por tela.",
    steps: [
      "Abra 'Hoje' / Central de Saúde no menu.",
      "Leia os cartões de atenção do topo — são o que precisa da sua decisão.",
      "Para receber o resumo toda manhã no WhatsApp, ative o campo 'Receber este resumo no WhatsApp' e envie um teste.",
      "Se o teste falhar, confirme que o número tem DDD e está no formato do WhatsApp.",
    ],
    commonErrors: [
      "Número sem DDD/DDI: o envio de teste falha. Use o número completo do WhatsApp.",
      "Confundir 'sem itens agora' com erro: quando não há pendência, o painel fica limpo de propósito.",
    ],
    keywords: "central saude resumo diario whatsapp manha painel atencao valor protegido",
    reviewedBy: "equipe_zapflow",
    sourceRef: "ADR-163",
  },
  {
    id: "help_seed_diretor",
    vertical: null,
    module_key: "diretor",
    title: "Diretor Executivo IA",
    what: "Um conselheiro de gestão que lê os seus dados reais e responde perguntas de negócio.",
    purpose: "Entender onde você ganha ou perde dinheiro e decidir o próximo passo com base em fato, não achismo.",
    steps: [
      "Abra 'Diretor IA' no menu.",
      "Escolha uma aba (Operações, Recuperação, Analisar decisão) ou faça uma pergunta.",
      "Se 'Operações/Recuperação' aparecer desligado, é o Execution Runtime — peça ao Admin Master para ligar no painel Runtime.",
      "Toda ação sugerida passa pela sua confirmação antes de executar.",
    ],
    commonErrors: [
      "'Execution Runtime desligado': as abas de execução só funcionam com o runtime ligado (Admin Master → Runtime).",
      "Esperar que ele execute sozinho: o Diretor propõe; quem aprova é você.",
    ],
    keywords: "diretor executivo ia conselheiro operacoes recuperacao execution runtime analisar decisao",
    reviewedBy: "equipe_zapflow",
    sourceRef: "ADR-152/156",
  },
  {
    id: "help_seed_vendas",
    vertical: null,
    module_key: "vendas",
    title: "Vendas e fechamento de pedido",
    what: "Onde você registra pedidos e fecha vendas dos seus produtos e serviços.",
    purpose: "Transformar um atendimento em venda registrada, com valor e forma de pagamento.",
    steps: [
      "Abra 'Vendas' no menu.",
      "Crie um pedido e escolha os itens do catálogo.",
      "Informe o cliente, a forma de pagamento e confirme o fechamento.",
      "Acompanhe o pedido até pago em 'Resultados'.",
    ],
    commonErrors: [
      "Produto não aparece: cadastre-o no Catálogo antes de vender.",
      "Fechar sem forma de pagamento: o pedido fica pendente até você concluir.",
    ],
    keywords: "vendas pedido fechamento venda cliente pagamento catalogo produto",
    reviewedBy: "equipe_zapflow",
    sourceRef: "ADR-083",
  },
  {
    id: "help_seed_atendimento",
    vertical: null,
    module_key: "retail_floor",
    title: "Atendimento de loja (lista da vez)",
    what: "A fila de atendimento da loja: quem é o próximo vendedor, o cronômetro e o desfecho de cada atendimento.",
    purpose: "Organizar o rodízio de vendedores e registrar o resultado de cada atendimento no balcão.",
    steps: [
      "Abra 'Atendimento de Loja'.",
      "Toque em 'Chamar próximo' para pegar o cliente da vez.",
      "Ao terminar, registre o desfecho (vendeu, não vendeu, orçamento) e o número da boleta.",
      "Se faltar peça no estoque local, use a reposição para pedir de outra loja.",
    ],
    commonErrors: [
      "Esquecer de registrar o desfecho: o atendimento fica aberto e trava a fila.",
      "Boleta repetida: cada venda usa um número de boleta único no turno.",
    ],
    keywords: "atendimento loja lista vez fila vendedor cronometro desfecho boleta estoque reposicao",
    reviewedBy: "equipe_zapflow",
    sourceRef: "ADR-175/176",
  },
  {
    id: "help_seed_estoque",
    vertical: null,
    module_key: "compras",
    title: "Estoque e reposição (Compras)",
    what: "O controle do que você tem em estoque e a lista de compra que a IA sugere quando algo fica crítico.",
    purpose: "Não perder venda por falta de produto — a IA detecta o estoque baixo e prepara a reposição.",
    steps: [
      "Abra 'Compras' no menu.",
      "Defina o mínimo e o alvo dos produtos que quer controlar.",
      "Quando o saldo cair abaixo do mínimo, a IA gera uma sugestão de compra.",
      "Revise a lista e confirme o pedido ao fornecedor — nada é comprado sem a sua confirmação.",
    ],
    commonErrors: [
      "Sem mínimo/alvo definido, a IA não sabe 'quanto falta' — saldo negativo sozinho não vira falta.",
      "Esperar compra automática: a sugestão sempre passa pela sua confirmação.",
    ],
    keywords: "estoque compras reposicao minimo alvo saldo fornecedor pedido de compra falta",
    reviewedBy: "equipe_zapflow",
    sourceRef: "ADR-170",
  },
  {
    // Exemplo de recorte POR VERTICAL (saúde) — não deve aparecer p/ varejo.
    id: "help_seed_clinica",
    vertical: "saude",
    module_key: "clinica",
    title: "Alta do paciente na clínica",
    what: "O encerramento do tratamento de um paciente, dado pelo profissional com PIN.",
    purpose: "Registrar a alta de forma segura — só o médico responsável conclui, com confirmação por PIN.",
    steps: [
      "Abra o prontuário do paciente na Clínica.",
      "Selecione 'Dar alta' no episódio de tratamento.",
      "Confirme com o PIN do profissional responsável.",
    ],
    commonErrors: [
      "Tentar dar alta sem PIN: a alta é do médico e exige o PIN (não dá para 'esquecer' o paciente).",
      "Renovar ciclo achando que é alta: renovar ciclo e dar alta são ações diferentes.",
    ],
    keywords: "clinica alta paciente pin medico episodio tratamento ciclo",
    reviewedBy: "equipe_zapflow",
    sourceRef: "ADR-145",
  },
];

let _seeded = false;

export class HelpKnowledgeService {
  /** Semeia a base curada (idempotente, GLOBAL). Chamado sob demanda. */
  static ensureSeeded(): void {
    if (_seeded) return;
    const ins = db.prepare(`
      INSERT OR IGNORE INTO help_articles
        (id, vertical, module_key, title, what, purpose, steps_json, common_errors_json, keywords, reviewed_by, source_ref, status)
      VALUES (@id, @vertical, @module_key, @title, @what, @purpose, @steps, @errors, @keywords, @reviewed_by, @source_ref, @status)
    `);
    const tx = db.transaction(() => {
      for (const a of SEED) {
        ins.run({
          id: a.id, vertical: a.vertical, module_key: a.module_key, title: a.title,
          what: a.what, purpose: a.purpose,
          steps: JSON.stringify(a.steps || []), errors: JSON.stringify(a.commonErrors || []),
          keywords: a.keywords, reviewed_by: a.reviewedBy, source_ref: a.sourceRef,
          status: a.status || "published",
        });
      }
    });
    try { tx(); _seeded = true; } catch { /* best-effort: tabela pode não existir em fluxo atípico */ }
  }

  /** Casa um termo com o conjunto de palavras, tolerando plural/derivação por prefixo. */
  private static matches(set: Set<string>, t: string): boolean {
    if (set.has(t)) return true;
    for (const w of set) {
      if (t.length >= 4 && w.startsWith(t)) return true;   // compra → compras
      if (w.length >= 4 && t.startsWith(w)) return true;   // reposição/reposicoes
    }
    return false;
  }

  private static mapRow(r: any): HelpArticle {
    let steps: string[] = []; let errors: string[] = [];
    try { steps = JSON.parse(r.steps_json || "[]"); } catch { steps = []; }
    try { errors = JSON.parse(r.common_errors_json || "[]"); } catch { errors = []; }
    return {
      id: r.id, vertical: r.vertical ?? null, module_key: r.module_key ?? null, title: r.title,
      what: r.what ?? null, purpose: r.purpose ?? null, steps, commonErrors: errors,
      keywords: r.keywords || "", reviewedBy: r.reviewed_by, sourceRef: r.source_ref ?? null,
    };
  }

  private static verticalOf(orgId: string): string | null {
    const o = db.prepare(`SELECT vertical FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return o?.vertical ?? null;
  }

  /**
   * Recupera o melhor artigo PUBLICADO p/ a pergunta (determinístico, RN-HELP-8).
   * Só artigos GLOBAIS (vertical NULL) ou da vertical da org (RN-HELP-7/recorte).
   * Retorna null quando nada ultrapassa o limiar (sem cobertura → não inventa).
   */
  static retrieve(orgId: string, query: string, moduleKey?: string | null): HelpArticle | null {
    this.ensureSeeded();
    const tokens = tokenize(query);
    if (tokens.length === 0) return null;
    const vertical = this.verticalOf(orgId);
    const rows = db.prepare(
      `SELECT * FROM help_articles WHERE status = 'published' AND (vertical IS NULL OR vertical = ?)`
    ).all(vertical) as any[];
    if (rows.length === 0) return null;

    let best: { art: HelpArticle; score: number } | null = null;
    for (const r of rows) {
      const art = this.mapRow(r);
      const kw = new Set(tokenize(art.keywords));
      const title = new Set(tokenize(art.title));
      const body = new Set(tokenize(`${art.what || ""} ${art.purpose || ""}`));
      let score = 0;
      for (const t of tokens) {
        // Casamento por PALAVRA (não substring — "alta" não casa "falta"), tolerando
        // plural/derivação por prefixo (compra↔compras). Peso maior p/ termos curados.
        if (this.matches(kw, t)) score += 3;
        else if (this.matches(title, t)) score += 2;
        else if (this.matches(body, t)) score += 1;
      }
      if (moduleKey && art.module_key === moduleKey) score += 2; // bônus contextual (tela atual)
      if (score > 0 && (!best || score > best.score)) best = { art, score };
    }
    // Limiar: exige sobreposição real (evita "casar" por um único termo fraco).
    return best && best.score >= 3 ? best.art : null;
  }

  /** Registra a lacuna (RN-HELP-1) — query normalizada, sem PII (RN-HELP-6). Upsert incrementa. */
  static logGap(orgId: string, query: string, moduleKey?: string | null): void {
    const norm = tokenize(query).join(" ");
    if (!norm) return;
    const mk = moduleKey || ""; // '' em vez de NULL → índice único efetivo
    try {
      db.prepare(`
        INSERT INTO help_gap_log (id, organization_id, query_norm, module_key, hits)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT (organization_id, query_norm, module_key)
        DO UPDATE SET hits = hits + 1, last_seen_at = CURRENT_TIMESTAMP
      `).run(randomUUID(), orgId, norm, mk);
    } catch { /* best-effort: lacuna nunca quebra a resposta */ }
  }

  /**
   * Resposta grounded: retorna o artigo recuperado (com citação) OU sinaliza a
   * ausência de cobertura E registra a lacuna. NÃO inventa (RN-HELP-1/2).
   */
  static answer(orgId: string, query: string, moduleKey?: string | null): {
    found: boolean;
    article: { id: string; title: string; moduleKey: string | null; steps: string[]; commonErrors: string[]; sourceRef: string | null } | null;
    message: string | null;
  } {
    const art = this.retrieve(orgId, query, moduleKey);
    if (art) {
      const steps = art.steps.map((s, i) => `${i + 1}) ${s}`).join(" ");
      const msg = `${art.what || art.title}${steps ? ` Passo a passo: ${steps}` : ""} (fonte: ${art.title})`;
      return {
        found: true,
        article: { id: art.id, title: art.title, moduleKey: art.module_key, steps: art.steps, commonErrors: art.commonErrors, sourceRef: art.sourceRef },
        message: msg,
      };
    }
    this.logGap(orgId, query, moduleKey);
    return { found: false, article: null, message: null };
  }

  /** Curadoria: lista artigos (default só publicados). Usado pelo painel master (F2). */
  static list(opts?: { status?: string; vertical?: string | null }): HelpArticle[] {
    this.ensureSeeded();
    const status = opts?.status || "published";
    const rows = db.prepare(`SELECT * FROM help_articles WHERE status = ? ORDER BY module_key, title`).all(status) as any[];
    return rows.map((r) => this.mapRow(r));
  }
}

export default HelpKnowledgeService;
