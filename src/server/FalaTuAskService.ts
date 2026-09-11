/**
 * FalaTuAskService — "Conversar com o negócio" (ADR-151/160, fatia PRD-review).
 *
 * O QUE ENTREGA: o dono fala/escreve uma PERGUNTA ("quanto a loja fez em
 * dinheiro no dia 31 de agosto?", "quem está de folga amanhã?") e o Fala Tu
 * RESPONDE com o dado real — não vira item pendente de inbox. É a peça que
 * faltava: até aqui o Fala Tu só CAPTURAVA (TASK|EVENT|LIST|NOTE); agora ele
 * também RESPONDE.
 *
 * COMO (roteador — determinístico ANTES de LLM, convenção do repo):
 *   1. `classify()` é PURO (regex sobre a string, 0 IA, 0 DB → roda em CI sem
 *      chave). Reconhece as perguntas PONTUAIS que têm resposta exata no banco:
 *        - `cash_on_day`  → vendas em DINHEIRO numa data (retail_daily_closing_items)
 *        - `sales_on_day` → faturamento TOTAL numa data (retail_daily_closings)
 *        - `who_is_off`   → quem folga numa data (RetailScheduleTemplateService)
 *   2. Casou → responde por QUERY DIRETA, EXATA e ATERRADA. Sem dado no período
 *      → ADMITE ("não encontrei fechamento desse dia"), NUNCA inventa número
 *      (RN-151 / RN-004).
 *   3. Não casou (pergunta aberta: "por que caiu?", "como melhorar?") → delega
 *      pro `ExecutiveAdvisorService.ask` — o motor de resposta em linguagem
 *      natural que JÁ existe, ancorado no panorama real (§184: motor único,
 *      sem engine paralelo). É o "gera a resposta pelos agentes de IA".
 *
 * DINHEIRO É ROLE-GATED (§73): faturamento/vendas só pra dono, sócio, admin ou
 * GERENTE. Colaborador comum pode perguntar folga/escala, mas a resposta de
 * dinheiro vem barrada com aviso honesto — nunca o número. O gate vive DENTRO
 * do service (não só na rota), pra valer em qualquer canal (web e WhatsApp).
 *
 * POSTURA (espelha `BeautyFalaTuIntents`): HELPER opt-in POR CIMA do Fala Tu.
 * O `FalaTuService` NÃO é modificado (0-regressão dura pras verticais que já
 * usam captura). A rota decide quando chamar.
 */
import db from "./db.js";
import { BusinessTimeService } from "./BusinessTimeService.js";
import { RetailScheduleTemplateService } from "./RetailScheduleTemplateService.js";
import { ExecutiveAdvisorService } from "./ExecutiveAdvisorService.js";
import { RecoveryAssessmentService } from "./RecoveryAssessmentService.js";
import { RecoveryPlanService } from "./RecoveryPlanService.js";

export type FalaTuAskKind = "cash_on_day" | "sales_on_day" | "who_is_off" | "open_question" | "record" | "record_expense" | "record_sale" | "record_contact" | "record_appointment" | "record_receivable" | "financial_recovery";

export interface FalaTuAskClassification {
  kind: FalaTuAskKind;
  date: string | null; // YYYY-MM-DD quando a pergunta é datada
  needsMoney: boolean; // true = a resposta expõe dinheiro (role-gated)
}

export interface FalaTuAskResult {
  kind: FalaTuAskKind;
  answer: string; // texto pronto pra devolver ao dono (o "relatório")
  date: string | null;
  grounded: boolean; // true = veio de query direta; false = LLM (agentes de IA)
  moneyRestricted: boolean; // true = pergunta de dinheiro barrada por RBAC
  data?: any; // dados estruturados quando determinístico (pra UI montar cartão)
}

// ── Formatação BRL sem depender de locale do runtime (node em CI pode não ter
// pt-BR). Milhar com ponto, decimal com vírgula. ──
function brl(n: number): string {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const neg = v < 0;
  const [int, dec] = Math.abs(v).toFixed(2).split(".");
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}R$ ${intFmt},${dec}`;
}

const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, "março": 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

function pad2(n: number): string { return String(n).padStart(2, "0"); }

// Soma/subtrai dias de uma data ISO sem escorregar por fuso (ancora ao meio-dia UTC).
function addDays(iso: string, days: number): string {
  const dt = new Date(iso + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Extrai a data mencionada no texto. Retorna YYYY-MM-DD ou null. NUNCA "chuta"
// uma data quando o texto não tem nenhuma (o caller decide o default).
export function extractDate(text: string, today: string): string | null {
  const t = String(text || "").toLowerCase();
  // Relativas. "amanhã" termina em vogal acentuada (ã), que não é word-char —
  // por isso não fechamos com \b à direita (fecharia falso); usamos lookahead
  // de "não vem outra letra" pra não casar "amanhecer".
  if (/depois de amanh[aã](?![a-zà-ú])/.test(t)) return addDays(today, 2);
  if (/\bamanh[aã](?![a-zà-ú])/.test(t)) return addDays(today, 1);
  if (/\banteontem\b/.test(t)) return addDays(today, -2);
  if (/\bontem\b/.test(t)) return addDays(today, -1);
  if (/\bhoje\b/.test(t)) return today;
  // ISO explícita
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // "31 de agosto" / "31 de agosto de 2025"
  const ext = t.match(/(\d{1,2})\s*de\s*([a-zç]+)(?:\s*de\s*(\d{4}))?/);
  if (ext) {
    const d = Number(ext[1]);
    const m = MONTHS[ext[2]];
    if (m && d >= 1 && d <= 31) {
      const y = ext[3] ? Number(ext[3]) : Number(today.slice(0, 4));
      return `${y}-${pad2(m)}-${pad2(d)}`;
    }
  }
  // dd/mm ou dd/mm/aaaa (aceita "-" também)
  const num = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (num) {
    const d = Number(num[1]);
    const m = Number(num[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      let y = num[3] ? Number(num[3]) : Number(today.slice(0, 4));
      if (y < 100) y += 2000;
      return `${y}-${pad2(m)}-${pad2(d)}`;
    }
  }
  return null;
}

// Cues (regex auditável). Cada regra é uma linha que o dono consegue ler.
const CASH_RE = /\b(dinheiro|em esp[eé]cie)\b/i;
const SALES_CUE_RE = /\b(vend|faturou|faturamento|fatur[oó]|receita|fez|entrou|receb|quanto|total|caixa)\b/i;
const SALES_RE = /\b(vend|faturou|faturamento|fatur[oó]|receita|total de venda)\b/i;
const OFF_RE = /\b(folga|folgando|folgar|de folga|escala|quem (est[aá]|vai estar|vai) (de folga|folgando))\b/i;
// F4 (gravar) — verbos de GRAVAÇÃO no INÍCIO da fala. O dono pede pra guardar
// algo ("anota ligar pro contador amanhã", "grava: comprar embalagens"). Isso
// NÃO responde — vira captura PENDENTE (Fala→Faz→Confere), reusando a porta de
// gravação que já existe; nunca escrita direta (RN-151).
const RECORD_RE = /^(?:grava|gravar|anota|anotar|registra|registrar|guarda|guardar|salva|salvar|cadastra|cadastrar|lan[çc]a|lan[çc]ar)\b[:,]?\s*/i;
const RECORD_LABEL: Record<string, string> = { TASK: "tarefa", EVENT: "compromisso", LIST: "lista", NOTE: "nota", UNKNOWN: "nota" };
// F5 (gravar despesa) — registro de DESPESA de negócio: palavra de despesa +
// pista de valor (R$, "reais", ou número de 2+ dígitos — evita casar "dia 5").
// Vai pro pipeline GOVERNADO (proposta→aprovação→execução), não pra captura.
const EXPENSE_KW_RE = /\b(despesa|despesas|gasto|gastei|gastar|conta a pagar|contas a pagar|boleto|paguei|fornecedor)\b/i;
const AMOUNT_CUE_RE = /r\$|\breais\b|\bconto\b|\d{2,}/i;
// F6 (venda) — registro de VENDA como ENTRADA de caixa. Cue com VERBO/imperativo
// de venda (vendi/faturei/"registra a venda") — NUNCA o substantivo "faturamento"
// solto, que é PERGUNTA (sales_on_day). Assim "quanto foi o faturamento?" segue
// pergunta e "registra a venda de R$500" vira registro.
const SALE_RECORD_RE = /\bvendi\b|\bvendeu\b|\bfaturei\b|(?:registra(?:r)?|lan[çc]a(?:r)?|anota(?:r)?|grava(?:r)?)\s+(?:a\s+|uma\s+)?venda\b/i;
// Pergunta nunca é registro: "quanto vendi..." é consulta (cash/sales), não venda
// a gravar. Palavra interrogativa ou "?" → bloqueia os kinds de gravação.
const QUESTION_RE = /\b(quanto|quantos|quanta|quantas|qual|quais|quando|quem|onde|por\s?que|porqu[eê]|como)\b|\?/i;
// F7 (cliente) — cadastro de CLIENTE/CONTATO por comando (verbo + cliente/contato).
const CONTACT_RE = /(?:cadastra(?:r)?|adiciona(?:r)?|registra(?:r)?|salva(?:r)?|cria(?:r)?)\s+(?:o\s+|a\s+|um\s+|uma\s+|meu\s+|minha\s+|novo\s+|nova\s+)?(?:cliente|contato)\b/i;
// F11 (compromisso) — verbo de AGENDAR + (substantivo de compromisso OU "com").
const APPOINTMENT_VERB_RE = /\b(?:agenda(?:r)?|agende|marca(?:r)?|marque)\b/i;
const APPOINTMENT_NOUN_RE = /\b(reuni[aã]o|compromisso|consulta|atendimento|visita|call|encontro|hor[aá]rio)\b/i;
// F12 (recebível/fiado) — registro de conta A RECEBER (dinheiro futuro).
const RECEIVABLE_KW_RE = /\b(receb[íi]ve(l|is)|fiado|a\s*receber|conta[s]?\s*a\s*receber)\b/i;
// Recuperação financeira (Fala Tu → F3, PRD-ZF-UNIFIED-GAP-CLOSURE-03) — o dono
// descreve CRISE de caixa/dívida na linguagem dele ("tô no vermelho", "muita
// dívida", "quanto tempo eu aguento", "como recupero a empresa"). Só INTERCEPTA o
// que hoje cairia em open_question (checado por ÚLTIMO em classify) → 0-regressão
// dura. Não casa perguntas de venda/folga nem os registros (cues distintos).
const RECOVERY_RE = /\brecupera(?:r|[çc][aã]o)\b|\bno vermelho\b|\bendivid\w*|\bquebrar\b|\bquebrando\b|\bfechar as portas\b|\bcrise financeira\b|\bem crise\b|\bsobreviv\w*|\bt[oô] apertad|\bsem (?:dinheiro|caixa) (?:pra|para) pagar\b|\bn[aã]o (?:vou )?conseguir pagar\b|\bd[ií]vidas?\b|\bt[oô] devendo\b|\bestou devendo\b|\bquanto tempo (?:eu )?(?:aguento|aguent|sobrevivo|de caixa)\b/i;

export class FalaTuAskService {
  /**
   * Classificador PURO (sem DB, sem IA). Decide se a pergunta tem resposta
   * pontual no banco e qual data ela pede. `today` é injetado pra ser
   * determinístico (a rota passa a data comercial da org).
   */
  static classify(text: string, today: string): FalaTuAskClassification {
    const t = String(text || "");
    const date = extractDate(t, today);
    // Pergunta nunca vira registro (ex.: "quanto vendi em dinheiro no dia X" é
    // consulta, não venda a gravar). Só as gravações são bloqueadas por isto.
    const isQuestion = QUESTION_RE.test(t);
    // Despesa primeiro: "lança a despesa de R$200 com fornecedor Y" é registro
    // financeiro GOVERNADO (dinheiro que sai), não captura de nota. needsMoney
    // porque expõe/escreve dinheiro (§73).
    if (!isQuestion && EXPENSE_KW_RE.test(t) && AMOUNT_CUE_RE.test(t)) {
      return { kind: "record_expense", date: null, needsMoney: true };
    }
    // Venda ANTES da gravação genérica ("registra a venda" contém "registra") e
    // ANTES da pergunta de faturamento (cue é verbo de venda, não "faturamento").
    if (!isQuestion && SALE_RECORD_RE.test(t) && AMOUNT_CUE_RE.test(t)) {
      return { kind: "record_sale", date: null, needsMoney: true };
    }
    // Recebível/fiado (conta a receber) — dinheiro futuro. Role-gated (§73).
    if (!isQuestion && RECEIVABLE_KW_RE.test(t) && AMOUNT_CUE_RE.test(t)) {
      return { kind: "record_receivable", date: null, needsMoney: true };
    }
    // Cliente ANTES da gravação genérica ("registra o cliente" contém "registra").
    // Não é dinheiro → needsMoney false (mas a rota já exige write no módulo).
    if (!isQuestion && CONTACT_RE.test(t)) {
      return { kind: "record_contact", date: null, needsMoney: false };
    }
    // Compromisso: "agenda/marca reunião com <cliente> <data> <hora>".
    if (!isQuestion && APPOINTMENT_VERB_RE.test(t) && (APPOINTMENT_NOUN_RE.test(t) || /\bcom\b/i.test(t))) {
      return { kind: "record_appointment", date: null, needsMoney: false };
    }
    // Gravação: um verbo de gravar no início é PEDIDO PRA GUARDAR, não
    // pergunta — senão "anota vender mais" viraria consulta de vendas.
    if (!isQuestion && RECORD_RE.test(t)) {
      return { kind: "record", date: null, needsMoney: false };
    }
    // Folga/escala tem prioridade quando o texto é claramente sobre isso.
    if (OFF_RE.test(t)) {
      return { kind: "who_is_off", date, needsMoney: false };
    }
    // Dinheiro específico (forma de pagamento) antes de faturamento genérico.
    if (CASH_RE.test(t) && SALES_CUE_RE.test(t)) {
      return { kind: "cash_on_day", date, needsMoney: true };
    }
    // Faturamento total num dia.
    if (SALES_RE.test(t)) {
      return { kind: "sales_on_day", date, needsMoney: true };
    }
    // Recuperação financeira: crise de caixa/dívida. Checado POR ÚLTIMO — só rouba
    // do open_question (perguntas datadas de venda/folga e os registros já casaram
    // acima). needsMoney:false porque a resposta NÃO expõe R$ no texto (só IRF/
    // fôlego/plano); os valores vão no `data`, redigidos por papel (§73).
    if (RECOVERY_RE.test(t)) {
      return { kind: "financial_recovery", date: null, needsMoney: false };
    }
    return { kind: "open_question", date, needsMoney: false };
  }

  /**
   * Só dono, sócio, admin ou GERENTE veem dinheiro (§73). Sócio, no modelo do
   * sistema, entra como owner/admin; gerente é reconhecido pelo perfil (RBAC).
   * O gate vive aqui (service) pra valer em qualquer canal.
   */
  static canSeeMoney(orgId: string, user: any): boolean {
    const role = String(user?.role || "").toLowerCase();
    if (role === "owner" || role === "admin") return true;
    const rpId = user?.role_profile_id;
    if (rpId) {
      try {
        const rp = db.prepare("SELECT system_key FROM role_profiles WHERE id = ? AND organization_id = ?").get(rpId, orgId) as any;
        if (rp && String(rp.system_key || "").toLowerCase() === "gerente") return true;
      } catch { /* noop */ }
    }
    return false;
  }

  // ── Respostas determinísticas (query direta, aterrada, admite lacuna) ──

  private static answerCashOnDay(orgId: string, date: string): FalaTuAskResult {
    const row = db.prepare(
      `SELECT COALESCE(SUM(i.informed_amount), 0) AS total, COUNT(DISTINCT c.id) AS closings
         FROM retail_daily_closing_items i
         JOIN retail_daily_closings c ON c.id = i.closing_id
        WHERE c.organization_id = ? AND c.closing_date = ? AND LOWER(i.payment_method) = 'dinheiro'`
    ).get(orgId, date) as any;
    const closings = Number(row?.closings || 0);
    const total = Number(row?.total || 0);
    if (closings === 0) {
      return {
        kind: "cash_on_day", date, grounded: true, moneyRestricted: false,
        answer: `Não encontrei fechamento de caixa para ${fmtDate(date)}. Ou o dia ainda não foi fechado, ou não houve movimento registrado — não tenho esse número pra te dar.`,
        data: { total: null, closings: 0 },
      };
    }
    const lojas = closings === 1 ? "1 fechamento" : `${closings} fechamentos`;
    return {
      kind: "cash_on_day", date, grounded: true, moneyRestricted: false,
      answer: `Em ${fmtDate(date)}, as vendas em dinheiro somaram ${brl(total)} (${lojas} de loja).`,
      data: { total, closings },
    };
  }

  private static answerSalesOnDay(orgId: string, date: string): FalaTuAskResult {
    const row = db.prepare(
      `SELECT COALESCE(SUM(informed_total), 0) AS total, COUNT(*) AS closings
         FROM retail_daily_closings WHERE organization_id = ? AND closing_date = ?`
    ).get(orgId, date) as any;
    const closings = Number(row?.closings || 0);
    const total = Number(row?.total || 0);
    if (closings === 0) {
      return {
        kind: "sales_on_day", date, grounded: true, moneyRestricted: false,
        answer: `Não encontrei fechamento de caixa para ${fmtDate(date)} — não tenho o faturamento desse dia pra informar.`,
        data: { total: null, closings: 0 },
      };
    }
    const lojas = closings === 1 ? "1 fechamento" : `${closings} fechamentos`;
    return {
      kind: "sales_on_day", date, grounded: true, moneyRestricted: false,
      answer: `Em ${fmtDate(date)}, o faturamento total informado foi ${brl(total)} (${lojas} de loja).`,
      data: { total, closings },
    };
  }

  private static answerWhoIsOff(orgId: string, date: string): FalaTuAskResult {
    const off = RetailScheduleTemplateService.whoIsOff(orgId, date);
    if (!off.length) {
      return {
        kind: "who_is_off", date, grounded: true, moneyRestricted: false,
        answer: `Não há ninguém marcado de folga em ${fmtDate(date)}. (Se a escala desse dia ainda não foi montada, pode ser que só não esteja lançada.)`,
        data: { off: [] },
      };
    }
    const nomes = off.map((o: any) => {
      const nome = o.sellerName || o.sellerKey || "colaborador";
      return o.storeName ? `${nome} (${o.storeName})` : nome;
    });
    const lista = nomes.length === 1 ? nomes[0] : nomes.slice(0, -1).join(", ") + " e " + nomes[nomes.length - 1];
    return {
      kind: "who_is_off", date, grounded: true, moneyRestricted: false,
      answer: `Em ${fmtDate(date)}, ${nomes.length === 1 ? "está" : "estão"} de folga: ${lista}.`,
      data: { off },
    };
  }

  /**
   * Resposta de RECUPERAÇÃO FINANCEIRA (F3). COMPÕE o `RecoveryPlanService` (que já
   * compõe assessment/IRF/priorização/orçamento) — read-only, determinístico, NÃO
   * recalcula nem inventa. O TEXTO é livre de R$ (só IRF/fôlego/crise/plano — que o
   * módulo não trata como dinheiro); os valores em R$ ficam no `data.plan`, já
   * redigido por papel quando `includeMoney=false` (§73). Sem dados → ADMITE.
   */
  private static answerRecovery(orgId: string, includeMoney: boolean): FalaTuAskResult {
    const plan = safe(() => RecoveryPlanService.plan(orgId, { includeMoney }), null as any);
    const mission = safe(() => RecoveryPlanService.suggestMission(orgId), null as any);
    const irf = plan?.irf;                 // { score, faixa } | null
    const runway = plan?.runway;           // { survivalDays, firstRupture } | null
    const hasDiag = !!plan && (irf?.score != null || (runway && runway.survivalDays != null));

    if (!hasDiag) {
      return {
        kind: "financial_recovery", date: null, grounded: true, moneyRestricted: false,
        answer: "Ainda não consigo montar seu quadro de recuperação — faltam dados de caixa e/ou o Mapa da Dívida. Lance o caixa e as contas (e cadastre suas dívidas) que eu monto o diagnóstico: fôlego, índice de recuperabilidade e o plano de ação.",
        data: { plan: plan || null },
      };
    }

    const FAIXA: Record<string, string> = { recuperavel: "recuperável", dificil: "difícil", critico: "crítico", indefinido: "indefinido" };
    const CRISE: Record<string, string> = {
      operational: "crise operacional — a operação perde dinheiro antes da dívida",
      financial: "crise financeira — a operação gera caixa, mas a dívida aperta",
      mixed: "crise mista — operação e dívida pressionam juntas",
      stable: "quadro estável no momento",
      undetermined: "quadro ainda indefinido (dados parciais)",
    };

    const parts: string[] = [];
    if (irf?.score != null) parts.push(`Índice de Recuperabilidade (IRF): ${irf.score}/100 — faixa ${FAIXA[irf.faixa] || irf.faixa}.`);
    const shape = plan?.crisis?.shape;
    if (shape && CRISE[shape]) parts.push(`Diagnóstico: ${CRISE[shape]}.`);
    if (runway?.survivalDays != null) {
      let r = `Fôlego de caixa estimado: ~${runway.survivalDays} dia(s).`;
      if (runway.firstRupture?.weeksAhead != null) r += ` Primeira ruptura projetada em ~${runway.firstRupture.weeksAhead} semana(s).`;
      parts.push(r);
    }
    const titles = (plan?.sections || []).map((s: any) => s.title).filter(Boolean);
    if (titles.length) parts.push(`O plano prioriza, nesta ordem: ${titles.join(" → ")}.`);
    if (plan?.professionalReviewRecommended) parts.push("⚠️ Recomendo validação com um profissional (contador/advogado) — há risco jurídico ou quadro misto.");
    if (mission?.missionLayerEnabled) {
      if (mission.draft) parts.push(`Posso registrar a missão "${mission.draft.title}" (meta: IRF ≥ ${mission.draft.targetValue}) pra acompanhar — confirme em Missões; não crio sozinho.`);
      else if (mission.alreadyCovered) parts.push("Você já tem uma missão de recuperação em andamento.");
    }
    if (!includeMoney) parts.push("(Os valores em R$ do quadro estão ocultos pelo seu perfil — mostro o diagnóstico sem os números.)");
    if (plan?.disclaimer) parts.push(plan.disclaimer);

    return {
      kind: "financial_recovery", date: null, grounded: true, moneyRestricted: false,
      answer: parts.join(" "),
      data: { plan, mission },
    };
  }

  /**
   * Ponto de entrada: recebe a pergunta em linguagem natural e devolve a
   * resposta. `user` traz role/role_profile_id pro gate de dinheiro. `opts.now`
   * permite injetar a data nos testes.
   */
  static async answer(orgId: string, user: any, question: string, opts: { now?: Date } = {}): Promise<FalaTuAskResult> {
    const q = String(question || "").trim();
    const today = BusinessTimeService.businessDate(orgId, opts.now || new Date());
    if (!q) {
      return { kind: "open_question", answer: "Faça uma pergunta sobre o seu negócio (ex.: \"quanto vendi em dinheiro hoje?\" ou \"quem está de folga amanhã?\").", date: null, grounded: true, moneyRestricted: false };
    }
    const cls = this.classify(q, today);

    // Dinheiro é role-gated — barra ANTES de consultar (§73).
    if (cls.needsMoney && !this.canSeeMoney(orgId, user)) {
      return {
        kind: cls.kind, date: cls.date, grounded: true, moneyRestricted: true,
        answer: "Informações de faturamento e vendas são restritas ao dono, sócios, administradores e gerentes. Peça a um deles ou fale com o administrador da conta.",
      };
    }

    // Datadas sem data explícita → default HOJE (não é inventar; é o padrão
    // natural de "quanto vendi em dinheiro?" sem dizer o dia).
    const date = cls.date || today;

    switch (cls.kind) {
      case "cash_on_day": return this.answerCashOnDay(orgId, date);
      case "sales_on_day": return this.answerSalesOnDay(orgId, date);
      case "who_is_off": return this.answerWhoIsOff(orgId, date);
      case "financial_recovery": {
        // Porta conversacional pro Financial Recovery OS (F3). Só responde se o
        // módulo está LIGADO (opt-in) — off → não anuncia, cai na pergunta aberta
        // (motor único, 0-regressão). Dinheiro role-gated via includeMoney.
        if (RecoveryAssessmentService.isEnabled(orgId)) {
          return this.answerRecovery(orgId, this.canSeeMoney(orgId, user));
        }
        const off = await ExecutiveAdvisorService.ask(orgId, q, { canSeeMoney: this.canSeeMoney(orgId, user) });
        return { kind: "open_question", answer: off, date: cls.date, grounded: false, moneyRestricted: false };
      }
      case "open_question":
      default: {
        // Pergunta aberta → agentes de IA (motor único, grounded no panorama).
        // CA-04/INV-11: a pergunta aberta é `needsMoney:false`, então NÃO passa
        // pelo gate acima — mas o panorama do Diretor carrega financeiro. Projeta
        // por usuário: quem não pode ver dinheiro recebe o panorama redigido, em
        // vez de o faturamento vazar por "como estão minhas finanças?".
        const text = await ExecutiveAdvisorService.ask(orgId, q, { canSeeMoney: this.canSeeMoney(orgId, user) });
        return { kind: "open_question", answer: text, date: cls.date, grounded: false, moneyRestricted: false };
      }
    }
  }

  /**
   * Superfície CONVERSACIONAL: o dono ou PERGUNTA (→ answer, F1) ou pede pra
   * GRAVAR (→ captura PENDENTE via FalaTuService.capture, Fala→Faz→Confere).
   * Gravar NUNCA escreve direto: cria só o item pendente que o humano confirma
   * (RN-151). Reusa a porta de gravação existente — sem novo caminho de escrita.
   * `opts.source` marca o canal (whatsapp/falatu_web) pro item ser confirmável
   * no fluxo do canal certo.
   */
  static async converse(orgId: string, user: any, text: string, opts: { now?: Date; source?: string } = {}): Promise<FalaTuAskResult> {
    const t = String(text || "").trim();
    const today = BusinessTimeService.businessDate(orgId, opts.now || new Date());
    const cls = this.classify(t, today);

    // Registro de DESPESA → pipeline GOVERNADO (proposta→aprovação→execução).
    // Dinheiro é role-gated (§73): só dono/sócio/admin/gerente propõem.
    if (cls.kind === "record_expense") {
      if (!this.canSeeMoney(orgId, user)) {
        return { kind: "record_expense", date: null, grounded: true, moneyRestricted: true, answer: "Lançar despesas é restrito ao dono, sócios, administradores e gerentes." };
      }
      const { FalatuRecordService } = await import("./FalatuRecordService.js");
      const r = FalatuRecordService.recordExpense(orgId, user, t, { now: opts.now });
      if (!r.proposed) {
        return { kind: "record_expense", date: null, grounded: true, moneyRestricted: false, answer: "Entendi que é uma despesa, mas não peguei o valor. Diga o valor — ex.: *lança a despesa de R$200 com a padaria*." };
      }
      const sup = r.supplierName ? ` (${r.supplierName})` : "";
      return {
        kind: "record_expense", date: null, grounded: true, moneyRestricted: false,
        answer: `📝 Preparei o lançamento da despesa de ${brl(r.amount || 0)}${sup}, vencendo ${fmtDate(r.dueDate || "")}. Aprove em *Aprovações* pra gravar — não lanço sozinho.`,
        data: { actionId: r.actionId, awaitingApproval: true },
      };
    }

    // Registro de VENDA → mesmo pipeline governado (entrada de caixa). Role-gated.
    if (cls.kind === "record_sale") {
      if (!this.canSeeMoney(orgId, user)) {
        return { kind: "record_sale", date: null, grounded: true, moneyRestricted: true, answer: "Registrar vendas é restrito ao dono, sócios, administradores e gerentes." };
      }
      const { FalatuRecordService } = await import("./FalatuRecordService.js");
      const r = FalatuRecordService.recordSale(orgId, user, t, { now: opts.now });
      if (!r.proposed) {
        return { kind: "record_sale", date: null, grounded: true, moneyRestricted: false, answer: "Entendi que é uma venda, mas não peguei o valor. Diga o valor — ex.: *registra a venda de R$500*." };
      }
      return {
        kind: "record_sale", date: null, grounded: true, moneyRestricted: false,
        answer: `📝 Preparei o registro da venda de ${brl(r.amount || 0)} (entrada de caixa em ${fmtDate(r.eventDate || "")}). Aprove em *Aprovações* pra gravar — não lanço sozinho.`,
        data: { actionId: r.actionId, awaitingApproval: true },
      };
    }

    // Cadastro de CLIENTE → pipeline governado (não é dinheiro; sem role-gate de §73).
    if (cls.kind === "record_contact") {
      const { FalatuRecordService } = await import("./FalatuRecordService.js");
      const r = FalatuRecordService.recordContact(orgId, user, t);
      if (!r.proposed) {
        return { kind: "record_contact", date: null, grounded: true, moneyRestricted: false, answer: "Entendi que é um cliente, mas não peguei o nome. Diga o nome — ex.: *cadastra o cliente João, telefone 11 99999-0000*." };
      }
      const extra = [r.phone ? `tel ${r.phone}` : null, r.email || null].filter(Boolean).join(", ");
      return {
        kind: "record_contact", date: null, grounded: true, moneyRestricted: false,
        answer: `📝 Preparei o cadastro do cliente *${r.name}*${extra ? ` (${extra})` : ""}. Aprove em *Aprovações* pra salvar — não cadastro sozinho.`,
        data: { actionId: r.actionId, awaitingApproval: true },
      };
    }

    // Recebível/fiado → pipeline governado (conta a receber). Role-gated (§73).
    if (cls.kind === "record_receivable") {
      if (!this.canSeeMoney(orgId, user)) {
        return { kind: "record_receivable", date: null, grounded: true, moneyRestricted: true, answer: "Lançar recebíveis é restrito ao dono, sócios, administradores e gerentes." };
      }
      const { FalatuRecordService } = await import("./FalatuRecordService.js");
      const r = FalatuRecordService.recordReceivable(orgId, user, t, { now: opts.now });
      if (!r.proposed) {
        return { kind: "record_receivable", date: null, grounded: true, moneyRestricted: false, answer: "Entendi que é um recebível, mas não peguei o valor. Diga o valor — ex.: *lança um recebível de R$500 do cliente João, vence 10/09*." };
      }
      const cli = r.clientName ? ` (${r.clientName})` : "";
      return {
        kind: "record_receivable", date: null, grounded: true, moneyRestricted: false,
        answer: `📝 Preparei o recebível de ${brl(r.amount || 0)}${cli}, vencendo ${fmtDate(r.dueDate || "")}. Aprove em *Aprovações* pra lançar — não lanço sozinho.`,
        data: { actionId: r.actionId, awaitingApproval: true },
      };
    }

    // Compromisso com cliente → pipeline governado (cria appointment na aprovação).
    if (cls.kind === "record_appointment") {
      const { FalatuRecordService } = await import("./FalatuRecordService.js");
      const r = FalatuRecordService.recordAppointment(orgId, user, t, { now: opts.now });
      if (!r.proposed) {
        const msg = r.reason === "no_contact_name" ? "Com quem é o compromisso? Ex.: *marca reunião com João amanhã às 10h*."
          : r.reason === "no_datetime" ? `Faltou a data ou a hora do compromisso com *${r.contactName}*. Ex.: *amanhã às 10h*.`
          : r.reason === "contact_not_found" ? `Não achei o cliente *${r.contactName}* no seu cadastro. Cadastre primeiro (ex.: *cadastra o cliente ${r.contactName}*) e agende depois.`
          : `Achei mais de um cliente com *${r.contactName}*. Seja mais específico com o nome completo.`;
        return { kind: "record_appointment", date: null, grounded: true, moneyRestricted: false, answer: msg };
      }
      return {
        kind: "record_appointment", date: null, grounded: true, moneyRestricted: false,
        answer: `📝 Preparei o agendamento: *${r.title}* com *${r.contactName}* em ${fmtDate(r.date || "")} às ${r.time}. Aprove em *Aprovações* pra confirmar — não agendo sozinho.`,
        data: { actionId: r.actionId, awaitingApproval: true },
      };
    }

    if (cls.kind !== "record") return this.answer(orgId, user, t, { now: opts.now });

    const userId = user?.userId || user?.id;
    const content = t.replace(RECORD_RE, "").trim();
    if (!content) {
      return { kind: "record", answer: "O que é pra gravar? Ex.: *anota ligar pro contador amanhã* — pode ser áudio também.", date: null, grounded: true, moneyRestricted: false };
    }
    const { FalaTuService } = await import("./FalaTuService.js");
    const item: any = await FalaTuService.capture(orgId, userId, { text: content, source: opts.source || "falatu_web" });
    // Protocolo (regra de código no capture) não vira item pendente — devolve o
    // desfecho como está, sem fingir que "anotou".
    if (item?.protocol) {
      return { kind: "record", answer: `Protocolo: ${item.protocol.name || item.protocol.kind}.`, date: null, grounded: true, moneyRestricted: false, data: { protocol: item.protocol } };
    }
    const label = RECORD_LABEL[String(item?.intent || "NOTE")] || "nota";
    return {
      kind: "record", date: null, grounded: true, moneyRestricted: false,
      answer: `📝 Anotei como *${label}*: ${item?.summary || content}. Confirme pra gravar (na aba *Inbox*).`,
      data: { pendingId: item?.id || null, intent: item?.intent || null },
    };
  }
}

// Data legível pro dono (dd/mm/aaaa). Fora da classe pra ser reutilizável.
function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

// Compõe read-models do F3 sem propagar erro pro caller (RN-FR-7 read-only).
function safe<T>(fn: () => T, fb: T): T { try { return fn(); } catch { return fb; } }
