/**
 * ExecutiveQueryToolsService — F1 do plano "Diretor IA com ferramentas de
 * consulta aterradas" (docs/prd/PLANO-DIRETOR-IA-FERRAMENTAS.md, 20/09/2026).
 *
 * CARDÁPIO de consultas prontas e seguras que a IA escolhe e executa (F2) em
 * vez de responder de um panorama fixo. Cada ferramenta é CÓDIGO determinístico
 * sobre as mesmas fontes das telas — o modelo nunca gera SQL (RN-DIR-1).
 *
 * Guardrails (RN-DIR):
 *  - org sempre da sessão (1º arg, isolamento multi-tenant) — RN-DIR-2;
 *  - dinheiro por papel (§73): ferramenta `money:true` só roda/aparece com
 *    canSeeMoney; metas redigem alvos em R$ pra papel restrito — RN-DIR-3;
 *  - honestidade dura: sem dado → diz que não tem (nunca 0 inventado); a régua
 *    do #1722 vale aqui — fechamento 'pending' (placeholder) ou de data futura
 *    NUNCA é venda — RN-DIR-4;
 *  - resolução determinística de LOJA (normaliza acento/caixa, substring nos 2
 *    sentidos; ambíguo → devolve `clarify`, nunca chuta) e de PERÍODO no fuso
 *    do negócio (closing_date é data local BR);
 *  - read-only: nenhuma ferramenta escreve nada.
 */
import db from "./db.js";
import { BusinessGoalService } from "./BusinessGoalService.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { RetailCommissionService } from "./RetailCommissionService.js";

export interface ExecutiveToolDef {
  name: string;
  description: string;
  money: boolean;
  args: { name: string; description: string; required?: boolean }[];
}

export interface ExecutiveToolResult {
  ok: boolean;
  tool: string;
  /** Texto pronto (PT-BR, fatos) pro modelo citar na resposta final. */
  summary?: string;
  /** Dados estruturados (testes/rotas). */
  data?: any;
  /** Pergunta de volta quando o argumento é ambíguo (nunca chuta). */
  clarify?: string;
  error?: "tool_not_found" | "forbidden_money" | "missing_arg" | "invalid_period";
}

const TZ = () => process.env.TZ_DISPLAY || "America/Sao_Paulo";
const hojeTz = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ() });
const addDays = (date: string, n: number) => new Date(Date.parse(date + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const brl = (v: number) => `R$ ${Number(v || 0).toFixed(2)}`;
const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

/** Fechamento REAL (régua do #1722): pending é placeholder, futuro não existe. */
const REAL = `status NOT IN ('pending','rejected')`;

export class ExecutiveQueryToolsService {
  static readonly TOOLS: ExecutiveToolDef[] = [
    {
      name: "vendas_por_loja", money: true,
      description: "Vendas (fechamentos reais) por loja e período: total, dias fechados e, em dia único, cota e bateu/faltou. Períodos: hoje, ontem, anteontem, semana (últimos 7 dias), semana_passada, mes (mês até hoje), mes_passado, ou {from,to}.",
      args: [
        { name: "store", description: "Nome (ou parte) da loja; vazio = todas as lojas" },
        { name: "period", description: "hoje|ontem|anteontem|semana|semana_passada|mes|mes_passado (default: ontem)" },
        { name: "from", description: "Data inicial YYYY-MM-DD (alternativa a period)" },
        { name: "to", description: "Data final YYYY-MM-DD (alternativa a period)" },
      ],
    },
    {
      name: "fechamentos_status", money: false,
      description: "Situação dos fechamentos de um dia por loja: quem enviou, quem está pendente e divergências (sem valores em R$).",
      args: [{ name: "date", description: "Dia YYYY-MM-DD ou hoje|ontem (default: ontem)" }],
    },
    {
      name: "estoque_loja", money: false,
      description: "Estoque de um produto por loja (disponível − reservado), na rede ou numa loja específica.",
      args: [
        { name: "product", description: "Nome (ou parte) do produto/referência", required: true },
        { name: "store", description: "Nome (ou parte) da loja; vazio = todas" },
      ],
    },
    {
      name: "metas_progresso", money: false,
      description: "Metas do mês e distância à meta (realizado, quanto falta, ritmo). Metas em R$ só aparecem pra quem pode ver dinheiro.",
      args: [],
    },
    {
      name: "metas_abaixo_cota", money: true,
      description: "Lojas que ficaram ABAIXO DA COTA diária no período: por loja, os dias em que ficou abaixo, quanto faltou por dia, o total de dias negativos e o saldo do mês (realizado − cota). Só conta dias com cota lançada E fechamento real (pending/rejeitado/futuro não entram). Período default: mês atual. Aceita hoje|ontem|semana|mes|mes_passado ou {from,to}.",
      args: [
        { name: "store", description: "Nome (ou parte) da loja; vazio = todas as lojas" },
        { name: "period", description: "mes|mes_passado|semana ou {from,to} (default: mês atual)" },
        { name: "from", description: "Data inicial YYYY-MM-DD (alternativa a period)" },
        { name: "to", description: "Data final YYYY-MM-DD (alternativa a period)" },
      ],
    },
    {
      name: "caixa_resumo", money: true,
      description: "Resumo financeiro do negócio agora: caixa atual, total a receber e total a pagar.",
      args: [],
    },
    {
      name: "a_receber", money: true,
      description: "Recebíveis em aberto: total a receber, detalhe fiado × contas e quanto está vencido.",
      args: [],
    },
    {
      name: "comissao_estimada", money: true,
      description: "Comissão estimada da equipe de varejo num período (mês atual por default).",
      args: [{ name: "period", description: "mes|mes_passado ou {from,to} (default: mês atual)" }],
    },
    {
      name: "catalogo_produto", money: true,
      description: "Preço e (quando controlado) estoque geral de um produto do catálogo.",
      args: [{ name: "product", description: "Nome (ou parte) do produto/serviço", required: true }],
    },
  ];

  /** Cardápio visível pro papel — ferramenta de dinheiro some pra quem não pode (§73). */
  static list(opts: { canSeeMoney?: boolean } = {}): ExecutiveToolDef[] {
    const money = opts.canSeeMoney !== false;
    return this.TOOLS.filter((t) => money || !t.money);
  }

  static run(orgId: string, tool: string, args: Record<string, any> = {}, opts: { canSeeMoney?: boolean } = {}): ExecutiveToolResult {
    const money = opts.canSeeMoney !== false;
    const def = this.TOOLS.find((t) => t.name === tool);
    if (!orgId || !def) return { ok: false, tool, error: "tool_not_found" };
    if (def.money && !money) return { ok: false, tool, error: "forbidden_money" };
    try {
      switch (def.name) {
        case "vendas_por_loja": return this.vendasPorLoja(orgId, args);
        case "fechamentos_status": return this.fechamentosStatus(orgId, args);
        case "estoque_loja": return this.estoqueLoja(orgId, args);
        case "metas_progresso": return this.metasProgresso(orgId, { canSeeMoney: money });
        case "metas_abaixo_cota": return this.metasAbaixoCota(orgId, args);
        case "caixa_resumo": return this.caixaResumo(orgId);
        case "a_receber": return this.aReceber(orgId);
        case "comissao_estimada": return this.comissaoEstimada(orgId, args);
        case "catalogo_produto": return this.catalogoProduto(orgId, args);
      }
    } catch (e) {
      console.error(`[DiretorTools] Falha em ${tool}:`, e);
    }
    return { ok: false, tool, error: "tool_not_found" };
  }

  // ── Resolução determinística de loja ──────────────────────────────────────
  /** null = sem filtro (todas); {store} = achou; {clarify} = ambíguo/não achou. */
  static resolveStore(orgId: string, term?: string | null): { store?: { id: string; name: string }; clarify?: string } | null {
    // Sem pontuação: "avenida brasil" precisa casar "Av. brasil".
    const clean = (s: string) => norm(s).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const t = clean(term || "");
    if (!t) return null;
    const stores = db.prepare(`SELECT id, name, COALESCE(code,'') AS code FROM retail_stores WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    // Token a token: cada palavra da busca precisa casar alguma palavra da loja
    // (igual, prefixo em qualquer sentido — "avenida"↔"av" — ou contida: "rio"
    // em "carioca"). Determinístico; ambíguo devolve clarify, nunca chuta.
    const tokMatch = (qt: string, st: string) => st === qt || st.startsWith(qt) || qt.startsWith(st) || st.includes(qt);
    const hits = stores.filter((s) => {
      const n = clean(s.name), c = clean(s.code);
      if (n.includes(t) || t.includes(n)) return true;
      if (c && (c === t || c.includes(t))) return true;
      const qts = t.split(" "); const sts = n.split(" ");
      return qts.every((qt) => sts.some((st) => tokMatch(qt, st)));
    });
    if (hits.length === 1) return { store: { id: hits[0].id, name: hits[0].name } };
    if (hits.length > 1) return { clarify: `Encontrei mais de uma loja parecida com "${term}": ${hits.map((h) => h.name).join(", ")}. Qual delas?` };
    return { clarify: `Não encontrei a loja "${term}". Lojas ativas: ${stores.map((s) => s.name).join(", ") || "nenhuma"}.` };
  }

  // ── Resolução determinística de período (fuso do negócio) ────────────────
  static resolvePeriod(args: { period?: string; from?: string; to?: string } = {}): { from: string; to: string; label: string } | { error: "invalid_period" } {
    const hoje = hojeTz();
    const isDate = (s: any) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (args.from || args.to) {
      if (!isDate(args.from) || !isDate(args.to) || args.from! > args.to!) return { error: "invalid_period" };
      const to = args.to! > hoje ? hoje : args.to!; // futuro não existe (RN-DIR-4)
      return { from: args.from!, to, label: `${args.from} a ${to}` };
    }
    const p = norm(args.period || "ontem").replace(/\s+/g, "_");
    const ontem = addDays(hoje, -1);
    switch (p) {
      case "hoje": return { from: hoje, to: hoje, label: `hoje (${hoje})` };
      case "ontem": return { from: ontem, to: ontem, label: `ontem (${ontem})` };
      case "anteontem": { const d = addDays(hoje, -2); return { from: d, to: d, label: `anteontem (${d})` }; }
      case "semana": return { from: addDays(hoje, -6), to: hoje, label: `últimos 7 dias (${addDays(hoje, -6)} a ${hoje})` };
      case "semana_passada": {
        // Segunda a domingo ANTERIORES (semana comercial cheia).
        const dow = new Date(hoje + "T12:00:00Z").getUTCDay(); // 0=dom
        const inicioDestaSemana = addDays(hoje, -((dow + 6) % 7)); // segunda desta semana
        const from = addDays(inicioDestaSemana, -7);
        return { from, to: addDays(from, 6), label: `semana passada (${from} a ${addDays(from, 6)})` };
      }
      case "mes": case "mes_atual": case "este_mes": return { from: `${hoje.slice(0, 7)}-01`, to: hoje, label: `mês atual até ${hoje}` };
      case "mes_passado": {
        const first = `${hoje.slice(0, 7)}-01`;
        const lastPrev = addDays(first, -1);
        return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev, label: `mês passado (${lastPrev.slice(0, 7)})` };
      }
      default: return { error: "invalid_period" };
    }
  }

  // ── Ferramentas ───────────────────────────────────────────────────────────
  private static vendasPorLoja(orgId: string, args: Record<string, any>): ExecutiveToolResult {
    const period = this.resolvePeriod(args);
    if ("error" in period) return { ok: false, tool: "vendas_por_loja", error: "invalid_period" };
    const st = this.resolveStore(orgId, args.store);
    if (st?.clarify) return { ok: true, tool: "vendas_por_loja", clarify: st.clarify };

    const where = st?.store ? `AND c.store_id = ?` : "";
    const params: any[] = [orgId, period.from, period.to, ...(st?.store ? [st.store.id] : [])];
    const rows = db.prepare(
      `SELECT c.store_id, s.name, COALESCE(SUM(c.informed_total),0) AS sales, COUNT(*) AS n,
              MAX(c.quota_amount) AS last_quota
         FROM retail_daily_closings c JOIN retail_stores s ON s.id = c.store_id
        WHERE c.organization_id = ? AND c.closing_date BETWEEN ? AND ? AND c.${REAL} ${where}
        GROUP BY c.store_id ORDER BY sales DESC`
    ).all(...params) as any[];

    const singleDay = period.from === period.to;
    const lines: string[] = [];
    let total = 0;
    for (const r of rows) {
      total += Number(r.sales || 0);
      let extra = "";
      if (singleDay) {
        const q = Number(r.last_quota || 0), v = Number(r.sales || 0);
        if (q > 0) extra = v >= q ? ` · cota ${brl(q)} → BATEU (+${brl(v - q)})` : ` · cota ${brl(q)} → faltou ${brl(q - v)}`;
      } else {
        extra = ` (${r.n} dia(s) fechado(s))`;
      }
      lines.push(`- ${r.name}: ${brl(r.sales)}${extra}`);
    }
    // Loja pedida sem fechamento no período → honesto, nunca 0 inventado.
    if (st?.store && !rows.length) {
      return { ok: true, tool: "vendas_por_loja", data: { period, store: st.store.name, rows: [] }, summary: `${st.store.name}, ${period.label}: nenhum fechamento REAL registrado (pode estar pendente de envio). Não há venda a informar — não invente valor.` };
    }
    if (!rows.length) {
      return { ok: true, tool: "vendas_por_loja", data: { period, rows: [] }, summary: `Nenhum fechamento real registrado em ${period.label}.` };
    }
    const head = st?.store ? `Vendas de ${st.store.name}, ${period.label} (fechamentos reais):` : `Vendas por loja, ${period.label} (fechamentos reais):`;
    const totalLine = rows.length > 1 ? `\nTotal: ${brl(total)}.` : "";
    return { ok: true, tool: "vendas_por_loja", data: { period, rows }, summary: `${head}\n${lines.join("\n")}${totalLine}` };
  }

  private static fechamentosStatus(orgId: string, args: Record<string, any>): ExecutiveToolResult {
    const p = this.resolvePeriod({ period: args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? undefined : (args.date || "ontem"), from: /^\d{4}-\d{2}-\d{2}$/.test(args.date || "") ? args.date : undefined, to: /^\d{4}-\d{2}-\d{2}$/.test(args.date || "") ? args.date : undefined });
    if ("error" in p) return { ok: false, tool: "fechamentos_status", error: "invalid_period" };
    const date = p.to;
    const stores = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`).all(orgId) as any[];
    if (!stores.length) return { ok: true, tool: "fechamentos_status", summary: "Nenhuma loja ativa cadastrada." };
    const closings = db.prepare(`SELECT store_id, status, divergence_status FROM retail_daily_closings WHERE organization_id = ? AND closing_date = ?`).all(orgId, date) as any[];
    const by = new Map<string, any>(closings.map((c: any) => [c.store_id, c]));
    const enviados: string[] = [], pendentes: string[] = [], divergentes: string[] = [];
    for (const s of stores) {
      const c = by.get(s.id);
      if (!c || c.status === "pending") pendentes.push(s.name);
      else if (c.status === "rejected") pendentes.push(`${s.name} (rejeitado — reenviar)`);
      else { enviados.push(s.name); if (c.divergence_status === "divergent") divergentes.push(s.name); }
    }
    const parts = [`Fechamentos de ${date}:`];
    parts.push(`- Enviados: ${enviados.length ? enviados.join(", ") : "nenhum"}`);
    parts.push(`- Pendentes: ${pendentes.length ? pendentes.join(", ") : "nenhum"}`);
    if (divergentes.length) parts.push(`- Com DIVERGÊNCIA (informado ≠ sistema): ${divergentes.join(", ")}`);
    return { ok: true, tool: "fechamentos_status", data: { date, enviados, pendentes, divergentes }, summary: parts.join("\n") };
  }

  private static estoqueLoja(orgId: string, args: Record<string, any>): ExecutiveToolResult {
    const term = norm(args.product || "");
    if (!term) return { ok: false, tool: "estoque_loja", error: "missing_arg" };
    const st = this.resolveStore(orgId, args.store);
    if (st?.clarify) return { ok: true, tool: "estoque_loja", clarify: st.clarify };

    const prods = (db.prepare(`SELECT id, name FROM products_services WHERE organization_id = ? AND active = 1`).all(orgId) as any[])
      .filter((pr) => norm(pr.name).includes(term)).slice(0, 5);
    if (!prods.length) return { ok: true, tool: "estoque_loja", summary: `Nenhum produto ativo casa com "${args.product}". Peça o nome exato ao gestor — não invente estoque.` };

    const where = st?.store ? `AND i.store_id = ?` : "";
    const lines: string[] = [];
    for (const pr of prods) {
      const rows = db.prepare(
        `SELECT s.name AS store_name, SUM(i.quantity_available - i.quantity_reserved) AS sellable
           FROM retail_store_inventory i JOIN retail_stores s ON s.id = i.store_id
          WHERE i.organization_id = ? AND i.product_service_id = ? ${where}
          GROUP BY i.store_id ORDER BY s.name`
      ).all(...([orgId, pr.id, ...(st?.store ? [st.store.id] : [])] as any[])) as any[];
      if (!rows.length) { lines.push(`- ${pr.name}: sem registro de estoque${st?.store ? ` em ${st.store.name}` : " nas lojas"}`); continue; }
      lines.push(`- ${pr.name}: ` + rows.map((r) => `${r.store_name} ${Math.max(0, Number(r.sellable || 0))} un.${Number(r.sellable) < 0 ? " (estoque NEGATIVO no sistema — conferir)" : ""}`).join(" · "));
    }
    return { ok: true, tool: "estoque_loja", data: { products: prods.map((p) => p.name) }, summary: `Estoque (disponível − reservado)${st?.store ? ` em ${st.store.name}` : " por loja"}:\n${lines.join("\n")}` };
  }

  private static metasProgresso(orgId: string, opts: { canSeeMoney: boolean }): ExecutiveToolResult {
    const { goals } = BusinessGoalService.progress(orgId);
    // §73: meta em R$ expõe faturamento — papel restrito só vê metas de contagem.
    const visible = opts.canSeeMoney ? goals : goals.filter((g) => g.unit !== "BRL");
    if (!visible.length) return { ok: true, tool: "metas_progresso", summary: "Nenhuma meta do mês definida (ou visível pro seu papel)." };
    const fmt = (v: number, unit: string) => (unit === "BRL" ? brl(v) : `${v}`);
    const lines = visible.map((g) => {
      const pace = g.reached ? "META BATIDA" : g.paceStatus === "on_track" ? "no ritmo" : "abaixo do ritmo";
      return `- ${g.label}: meta ${fmt(g.target, g.unit)} · realizado ${fmt(g.current, g.unit)} (${g.attainmentPct}%) · falta ${fmt(g.remaining, g.unit)} → ${pace}`;
    });
    return { ok: true, tool: "metas_progresso", data: { goals: visible }, summary: `Metas do mês:\n${lines.join("\n")}` };
  }

  /**
   * Lojas ABAIXO DA COTA diária no período (RN-DIR-4: honesto, nunca inventa).
   * Só considera dias com cota lançada (`quota_amount > 0`) E fechamento REAL
   * (pending/rejeitado/futuro não entram — são "desconhecidos", não "negativos").
   * Por loja: os dias negativos, quanto faltou por dia, a soma dos dias negativos
   * e o saldo do mês (realizado − cota acumulado — dias bons compensam os ruins).
   * As duas leituras são reportadas separadas de propósito: confundi-las é o erro
   * clássico de "quanto estou fora da meta".
   */
  private static metasAbaixoCota(orgId: string, args: Record<string, any>): ExecutiveToolResult {
    const period = this.resolvePeriod(args.period || args.from || args.to ? args : { period: "mes" });
    if ("error" in period) return { ok: false, tool: "metas_abaixo_cota", error: "invalid_period" };
    const st = this.resolveStore(orgId, args.store);
    if (st?.clarify) return { ok: true, tool: "metas_abaixo_cota", clarify: st.clarify };

    const where = st?.store ? `AND c.store_id = ?` : "";
    const params: any[] = [orgId, period.from, period.to, ...(st?.store ? [st.store.id] : [])];
    const rows = db.prepare(
      `SELECT c.store_id, s.name AS store_name, c.closing_date AS date,
              c.quota_amount AS quota, COALESCE(c.informed_total,0) AS realized
         FROM retail_daily_closings c JOIN retail_stores s ON s.id = c.store_id
        WHERE c.organization_id = ? AND c.closing_date BETWEEN ? AND ?
          AND c.${REAL} AND c.quota_amount > 0 ${where}
        ORDER BY s.name, c.closing_date`
    ).all(...params) as any[];

    if (!rows.length) {
      return { ok: true, tool: "metas_abaixo_cota", data: { period, stores: [] },
        summary: `Nenhum dia com COTA lançada e fechamento real em ${period.label}. Sem cota registrada não dá pra dizer quem ficou abaixo — nada a inventar.` };
    }

    // Agrupa por loja; calcula dias negativos + saldo do mês.
    const byStore = new Map<string, { name: string; considered: number; belowDays: { date: string; quota: number; realized: number; diff: number }[]; net: number }>();
    for (const r of rows) {
      const quota = Number(r.quota || 0), realized = Number(r.realized || 0);
      const diff = realized - quota; // negativo = abaixo da cota
      const g = byStore.get(r.store_id) || { name: r.store_name, considered: 0, belowDays: [], net: 0 };
      g.considered++; g.net += diff;
      if (diff < 0) g.belowDays.push({ date: r.date, quota, realized, diff });
      byStore.set(r.store_id, g);
    }

    // Foco do pedido: só lojas com pelo menos um dia abaixo. Pior saldo primeiro.
    const stores = [...byStore.values()].filter((g) => g.belowDays.length > 0).sort((a, b) => a.net - b.net);
    if (!stores.length) {
      return { ok: true, tool: "metas_abaixo_cota", data: { period, stores: [] },
        summary: `Nenhuma loja ficou abaixo da cota em ${period.label} (nos dias com cota lançada e fechamento real).` };
    }

    const lines: string[] = [];
    const out: any[] = [];
    for (const g of stores) {
      const sumBelow = g.belowDays.reduce((a, d) => a + d.diff, 0); // negativo
      lines.push(`\n▸ ${g.name} — ${g.belowDays.length} de ${g.considered} dia(s) abaixo da cota:`);
      for (const d of g.belowDays) lines.push(`   ${d.date}: cota ${brl(d.quota)} · vendeu ${brl(d.realized)} · faltou ${brl(-d.diff)}`);
      const netTxt = g.net < 0 ? `NEGATIVO ${brl(g.net)} (faltam ${brl(-g.net)} pra fechar a meta acumulada)` : `positivo +${brl(g.net)} (os dias bons compensaram)`;
      lines.push(`   → Soma só dos dias negativos: ${brl(sumBelow)}. Saldo do mês (realizado − cota): ${netTxt}.`);
      out.push({ name: g.name, consideredDays: g.considered, belowDays: g.belowDays, sumBelow, netMonth: g.net });
    }
    const header = `Lojas abaixo da cota — ${period.label} (só dias com cota lançada e fechamento real):`;
    const note = `\n\nObs.: dias sem cota lançada ou sem fechamento enviado NÃO entram — são desconhecidos, não "negativos".`;
    return { ok: true, tool: "metas_abaixo_cota", data: { period, stores: out }, summary: header + lines.join("\n") + note };
  }

  // ── F4: finanças/comissão/catálogo (todas money — §73 já barra no run) ────
  private static caixaResumo(orgId: string): ExecutiveToolResult {
    const s = FinancialLedgerService.summary(orgId) as any;
    const summary = `Financeiro agora:\n- Caixa atual: ${brl(s.caixaAtual)}\n- A receber: ${brl(s.aReceber)}\n- A pagar (em aberto): ${brl(s.aPagar)}`;
    return { ok: true, tool: "caixa_resumo", data: { caixaAtual: s.caixaAtual, aReceber: s.aReceber, aPagar: s.aPagar }, summary };
  }

  private static aReceber(orgId: string): ExecutiveToolResult {
    const s = FinancialLedgerService.summary(orgId) as any;
    const det = s.aReceberDetalhe || {};
    const venc = s.aReceberVencido ? `\n- Vencido: ${brl(s.aReceberVencido)} (atenção)` : "";
    const summary = `A receber: ${brl(s.aReceber)}\n- Fiado: ${brl(det.fiado)} · Contas: ${brl(det.manual)}${venc}`;
    return { ok: true, tool: "a_receber", data: { aReceber: s.aReceber, detalhe: det, vencido: s.aReceberVencido || 0 }, summary };
  }

  private static comissaoEstimada(orgId: string, args: Record<string, any>): ExecutiveToolResult {
    const period = this.resolvePeriod(args.period || args.from || args.to ? args : { period: "mes" });
    if ("error" in period) return { ok: false, tool: "comissao_estimada", error: "invalid_period" };
    const total = RetailCommissionService.estimateTotal(orgId, period.from, period.to);
    return { ok: true, tool: "comissao_estimada", data: { period, total }, summary: `Comissão estimada da equipe (${period.label}): ${brl(total)}. (estimativa dos fechamentos do período — o valor final sai no fechamento da comissão)` };
  }

  private static catalogoProduto(orgId: string, args: Record<string, any>): ExecutiveToolResult {
    const term = norm(args.product || "");
    if (!term) return { ok: false, tool: "catalogo_produto", error: "missing_arg" };
    const rows = (db.prepare(
      `SELECT ps.id, ps.name, ps.type, ps.price, ps.currency, ps.stock_control_enabled,
              inv.quantity_available, inv.quantity_reserved
         FROM products_services ps
    LEFT JOIN inventory_items inv ON inv.product_service_id = ps.id AND inv.variant_id IS NULL
        WHERE ps.organization_id = ? AND ps.active = 1 AND COALESCE(ps.storefront_visible,1) = 1`
    ).all(orgId) as any[]).filter((r) => norm(r.name).includes(term)).slice(0, 8);
    if (!rows.length) return { ok: true, tool: "catalogo_produto", summary: `Nenhum produto ativo casa com "${args.product}". Peça o nome exato — não invente preço nem estoque.` };
    const lines = rows.map((r) => {
      const price = r.price != null ? `${r.currency || "R$"} ${Number(r.price).toFixed(2)}` : "preço sob consulta";
      let stock = "";
      if (r.stock_control_enabled) {
        const sellable = Math.max(0, Number(r.quantity_available || 0) - Number(r.quantity_reserved || 0));
        stock = sellable > 0 ? ` · estoque geral ${sellable}` : " · SEM estoque";
      }
      return `- ${r.name} (${r.type}): ${price}${stock}`;
    });
    return { ok: true, tool: "catalogo_produto", data: { count: rows.length }, summary: `Catálogo:\n${lines.join("\n")}` };
  }
}
