/**
 * SignalLanguage — linguagem EMPRESARIAL dos sinais (PRD Fase 1, F1.7a).
 *
 * Tradução PURA (sem DB, sem imports) do que o motor detectou para o que o gestor entende:
 *   "Sinal 'retail_store_stockout' no domínio inventory…"  →  "Produtos com divergência de estoque identificados"
 * Segue o princípio do ADR-163 F4 (UxPresentationService): é FORMA, não fonte — não decide, não cria alerta,
 * não renomeia nada no ledger (o `signal_type`/`domain`/`dedupe_key` continuam intactos: dedupe e consumidores
 * dependem deles). Só muda o que aparece.
 *
 * Cada sinal vira: título (1 linha) · significado (o que importa pro negócio) · rótulo de AÇÃO ESPECÍFICO
 * (nunca "Agir") · o que acontece ao clicar (o gestor sabe ANTES) · se a operação foi afetada (sim/não/ainda
 * não sabemos — nunca chuta) · público (dono × técnico).
 * Honestidade: só usa números que vêm na evidência; sinal desconhecido cai num texto genérico por domínio/tipo
 * de ação (`known:false`), NUNCA vaza o identificador técnico. Termos técnicos (retail_*, inventory, runtime,
 * dead_letter…) não aparecem em nenhum texto — o teste varre o catálogo.
 */
export type Affected = "yes" | "no" | "unknown";
export interface SignalPresentation {
  title: string;
  meaning: string;
  actionLabel: string;
  actionWillDo: string;
  operationAffected: Affected;
  audience: "owner" | "technical";
  domainLabel: string;
  known: boolean;
}
export interface SignalInput { signalType?: string | null; domain?: string | null; evidence?: any; actionType?: string | null; severity?: string | null }

type Entry = {
  title: string | ((ev: any) => string);
  meaning: string;
  actionLabel: string;
  actionWillDo: string;
  affected?: Affected;
  audience?: "owner" | "technical";
};

export const DOMAIN_LABEL: Record<string, string> = {
  finance: "Finanças", production: "Produção", procurement: "Compras", inventory: "Estoque", sales: "Vendas",
  retail_ops: "Varejo", retail_floor: "Atendimento de Loja", retail: "Varejo", tasks: "Tarefas", people: "Pessoas",
  agenda: "Agenda", consumption: "Consumo", security: "Segurança", compliance: "Compliance", collection: "Cobrança",
  clinic: "Clínica", education: "Escola", runtime: "Automações", platform: "Plataforma", plan: "Seu plano",
  reputation: "Reputação", social: "Redes sociais", content: "Conteúdo", falatu: "FalaTu", outcome_assurance: "Resultados",
  sales_recovery: "Recuperação de vendas", recovery: "Recuperação", operations: "Operação", churn: "Clientes", legal: "Jurídico",
  beauty: "Beleza", prospect: "Prospecção", mission: "Missões", learning: "Aprendizado",
};
export const domainLabel = (d: string | null | undefined): string => DOMAIN_LABEL[String(d || "")] || "Seu negócio";

const inStore = (ev: any, base: string) => (ev?.store ? `${base} — ${ev.store}` : base);
const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : null);

const CATALOG: Record<string, Entry> = {
  // ── Estoque / reposição ─────────────────────────────────────────────────
  retail_store_stockout: {
    title: (ev) => inStore(ev, "Produtos com divergência de estoque identificados"),
    meaning: "O saldo de alguns itens ficou negativo: em geral é venda sem entrada, transferência não lançada ou sincronização atrasada.",
    actionLabel: "Investigar divergência", actionWillDo: "Cria uma tarefa para conferir os itens com saldo negativo e descobrir a causa.", affected: "yes",
  },
  retail_transfer_suggested: {
    title: "Há peças sobrando em uma loja e faltando em outra", meaning: "Redistribuir entre as lojas pode gerar venda com o que já temos.",
    actionLabel: "Preparar transferência", actionWillDo: "Prepara o pedido de transferência entre as lojas para você aprovar.", affected: "no",
  },
  retail_floor_replenishment_request: {
    title: "Um pedido de transferência entre lojas está em aberto", meaning: "A loja pediu a peça de outra unidade para não perder a venda.",
    actionLabel: "Acompanhar transferência", actionWillDo: "Abre o pedido para você acompanhar até a peça chegar.", affected: "no",
  },
  retail_floor_unmet_demand: {
    title: (ev) => inStore(ev, "Clientes pediram peças que não conseguimos oferecer"), meaning: "Houve procura por tamanhos, cores ou peças que não estavam disponíveis.",
    actionLabel: "Ver o que faltou", actionWillDo: "Cria uma tarefa para revisar o que os clientes pediram e o que fazer a respeito.", affected: "yes",
  },
  retail_floor_out_of_assortment: {
    title: (ev) => inStore(ev, "Clientes procuraram peças que a loja não trabalha"), meaning: "A procura fora do mix é um sinal do que pode valer a pena incluir.",
    actionLabel: "Avaliar mix", actionWillDo: "Cria uma tarefa para avaliar se essas peças devem entrar no mix.", affected: "no",
  },
  retail_floor_code_unresolved: {
    title: (ev) => inStore(ev, "Uma etiqueta não foi reconhecida na loja"), meaning: "O leitor não achou a peça: ela pode estar sem cadastro ou com código diferente.",
    actionLabel: "Vincular código ao produto", actionWillDo: "Cria uma tarefa para ligar esse código ao produto certo no catálogo.", affected: "yes",
  },
  retail_reserve_low: {
    title: "A reserva da loja online está acabando", meaning: "Quando a reserva zera, o cliente online não consegue comprar.",
    actionLabel: "Reabastecer a reserva", actionWillDo: "Cria uma tarefa para separar mais peças para a loja online.", affected: "no",
  },
  retail_online_reserve_out: {
    title: "A reserva da loja online acabou", meaning: "Peças da vitrine online estão sem estoque reservado.",
    actionLabel: "Reabastecer a reserva", actionWillDo: "Cria uma tarefa para separar peças para a loja online.", affected: "yes",
  },
  retail_product_no_online_sales: {
    title: "Um produto não vende online", meaning: "O item está exposto mas não gera pedidos.",
    actionLabel: "Revisar vitrine e preço", actionWillDo: "Cria uma tarefa para revisar foto, preço e posição do produto.", affected: "no",
  },
  retail_discontinued_online_stock: {
    title: "Produto fora de linha ainda aparece para venda online", meaning: "Pode gerar pedido de algo que não será reposto.",
    actionLabel: "Revisar vitrine", actionWillDo: "Cria uma tarefa para tirar ou ajustar o produto na vitrine.", affected: "no",
  },
  retail_sales_concentration: {
    title: "As vendas estão concentradas em poucos produtos", meaning: "Depender de poucos itens aumenta o risco se a procura cair.",
    actionLabel: "Revisar o mix", actionWillDo: "Cria uma tarefa para diversificar o que é destaque.", affected: "no",
  },
  // ── Metas e pessoas ─────────────────────────────────────────────────────
  retail_store_below_quota: {
    title: (ev) => inStore(ev, "A loja está abaixo da meta"), meaning: "O resultado do período está atrás da meta combinada.",
    actionLabel: "Criar plano de recuperação", actionWillDo: "Cria uma tarefa com o plano para recuperar o resultado da loja.", affected: "yes",
  },
  retail_seller_below_quota: {
    title: "Um vendedor está abaixo da meta", meaning: "O desempenho individual ficou atrás da cota.",
    actionLabel: "Revisar desempenho", actionWillDo: "Cria uma tarefa para conversar com o vendedor e entender o que está atrapalhando.", affected: "yes",
  },
  seller_goal_streak: {
    title: (ev) => {
      const n = num(ev?.streak);
      const who = ev?.seller ? String(ev.seller) : "Um vendedor";
      return n && n >= 2 ? `${who} — ${n}º mês seguido abaixo da meta` : `${who} — abaixo da meta neste mês`;
    },
    meaning: "Meses fechados consecutivos abaixo da meta (meses sem meta ou com férias não contam).",
    actionLabel: "Analisar desempenho", actionWillDo: "Cruza vendas, ticket e peças da pessoa para mostrar onde está perdendo resultado.", affected: "yes",
  },
  retail_seller_concentration: {
    title: "Poucas pessoas concentram as vendas", meaning: "Se uma delas faltar, o resultado cai.",
    actionLabel: "Revisar escala e equipe", actionWillDo: "Cria uma tarefa para distribuir melhor o atendimento.", affected: "no",
  },
  retail_store_no_closing: {
    title: (ev) => inStore(ev, "O fechamento do dia não foi enviado"), meaning: "Sem o fechamento não dá para conferir venda, meta e dinheiro.",
    actionLabel: "Cobrar fechamento", actionWillDo: "Envia o pedido de fechamento ao responsável da loja.", affected: "yes",
  },
  retail_writeback_backlog: {
    title: "Há vendas esperando baixa no caixa", meaning: "Baixas pendentes deixam o estoque e o caixa desatualizados.",
    actionLabel: "Lançar as baixas", actionWillDo: "Cria uma tarefa para lançar as baixas pendentes.", affected: "yes",
  },
  // ── Atendimento de Loja ─────────────────────────────────────────────────
  retail_floor_queue_delay: {
    title: (ev) => { const m = num(ev?.allBusyMinutes); return inStore(ev, m ? `Clientes podem ter esperado: todos os vendedores estavam ocupados por ${m} min` : "Clientes podem ter esperado: todos os vendedores estavam ocupados"); },
    meaning: "Quando ninguém está livre, cliente vai embora sem ser atendido.",
    actionLabel: "Revisar escala", actionWillDo: "Cria uma tarefa para ajustar a escala nos horários de pico.", affected: "yes",
  },
  retail_floor_long_service: {
    title: (ev) => inStore(ev, "Alguns atendimentos foram muito longos"), meaning: "Atendimento longo segura o vendedor e pode deixar outros clientes esperando.",
    actionLabel: "Revisar atendimentos", actionWillDo: "Cria uma tarefa para entender por que esses atendimentos demoraram.", affected: "no",
  },
  retail_floor_declared_vs_pdv_gap: {
    title: (ev) => inStore(ev, "Vendas declaradas no atendimento não aparecem no caixa"), meaning: "Pode ser venda não registrada, ou atendimento marcado como vendido sem ter vendido.",
    actionLabel: "Comparar vendas", actionWillDo: "Cria uma tarefa para conferir o que foi declarado contra o que o caixa registrou.", affected: "yes",
  },
  retail_floor_conversion_drop: {
    title: (ev) => inStore(ev, "A conversão dos atendimentos caiu"), meaning: "Menos clientes atendidos estão virando venda que na semana anterior.",
    actionLabel: "Comparar semanas", actionWillDo: "Cria uma tarefa para comparar as duas semanas e achar o que mudou.", affected: "yes",
  },
  retail_floor_network_recovery: {
    title: "A rede salvou vendas usando o estoque de outras lojas", meaning: "Peças que faltavam numa loja foram atendidas por outra.",
    actionLabel: "Ver vendas recuperadas", actionWillDo: "Abre a lista das vendas recuperadas pela rede.", affected: "no",
  },
  // ── Finanças ────────────────────────────────────────────────────────────
  receivable_overdue: { title: "Há clientes com pagamento vencido", meaning: "Dinheiro que já deveria ter entrado está parado.", actionLabel: "Preparar cobrança", actionWillDo: "Prepara a cobrança dos vencidos para você aprovar antes de enviar.", affected: "yes" },
  cash_below_minimum: { title: "O caixa está abaixo do mínimo", meaning: "A reserva de segurança que você definiu foi ultrapassada.", actionLabel: "Reforçar o caixa", actionWillDo: "Cria um plano para cobrar e negociar entradas.", affected: "yes" },
  cash_break_risk: { title: "Há risco de faltar caixa", meaning: "No ritmo atual, as saídas podem passar as entradas.", actionLabel: "Antecipar entradas", actionWillDo: "Cria um plano para antecipar entradas e adiar saídas.", affected: "yes" },
  payable_due_soon: { title: "Há contas para pagar chegando", meaning: "Vencimentos próximos podem apertar o caixa.", actionLabel: "Revisar contas a pagar", actionWillDo: "Abre as contas próximas do vencimento para você decidir.", affected: "no" },
  owner_draw_excess: { title: "As retiradas estão acima do que o caixa sustenta", meaning: "Retirar mais que o sustentável drena o capital de giro.", actionLabel: "Revisar retiradas", actionWillDo: "Cria uma tarefa para rever o valor das retiradas.", affected: "no" },
  data_quality_low: { title: "Alguns dados estão incompletos", meaning: "Números com lacuna podem levar a decisões erradas.", actionLabel: "Corrigir os dados", actionWillDo: "Cria uma tarefa listando o que falta preencher.", affected: "yes" },
  below_breakeven: { title: "O mês projeta ficar abaixo do ponto de equilíbrio", meaning: "No ritmo atual, o resultado do mês tende a ser negativo (é uma projeção, não um fato).", actionLabel: "Ver a projeção", actionWillDo: "Abre a projeção do mês para você avaliar o que ajustar.", affected: "no" },
  // ── Resultados / execução ───────────────────────────────────────────────
  done_without_outcome: { title: "Uma ação foi concluída, mas o resultado não foi medido", meaning: "Sem medir, não dá para saber se a ação funcionou.", actionLabel: "Registrar o resultado", actionWillDo: "Cria uma tarefa para registrar o que aconteceu depois da ação.", affected: "no" },
  confirmation_timed_out: { title: "Não recebemos a confirmação de uma ação", meaning: "A ação foi feita, mas ninguém confirmou se deu certo.", actionLabel: "Cobrar confirmação", actionWillDo: "Pede a confirmação ao responsável.", affected: "unknown" },
  // ── Integração / automação (técnico traduzido) ──────────────────────────
  alterdata_auth_falha: { title: "Não conseguimos acessar a Alterdata", meaning: "Sem esse acesso, estoque e vendas do dia podem estar desatualizados.", actionLabel: "Reconectar a Alterdata", actionWillDo: "Abre a tela de conexão para renovar o acesso.", affected: "yes" },
  vertical_intelligence_stale: { title: "A pesquisa de mercado do seu segmento está desatualizada", meaning: "As comparações de mercado podem estar antigas.", actionLabel: "Pedir atualização", actionWillDo: "Registra o pedido de atualização para a equipe da plataforma.", affected: "no", audience: "technical" },
  // ── Plano ───────────────────────────────────────────────────────────────
  plan_near_limit_ai: { title: "O uso de IA está perto do limite do plano", meaning: "Ao atingir o limite, alguns recursos param.", actionLabel: "Ver opções de plano", actionWillDo: "Mostra as opções de upgrade; nada é contratado sem você confirmar.", affected: "no" },
  plan_near_limit_contacts: { title: "A base de contatos está perto do limite do plano", meaning: "Ao atingir o limite, novos contatos deixam de entrar.", actionLabel: "Ver opções de plano", actionWillDo: "Mostra as opções de upgrade; nada é contratado sem você confirmar.", affected: "no" },
  plan_near_limit_channels: { title: "Os canais conectados chegaram ao limite do plano", meaning: "Não dá para conectar mais canais sem ampliar o plano.", actionLabel: "Ver opções de plano", actionWillDo: "Mostra as opções de upgrade; nada é contratado sem você confirmar.", affected: "no" },
  plan_near_limit_users: { title: "O número de usuários chegou ao limite do plano", meaning: "Não dá para convidar mais pessoas sem ampliar o plano.", actionLabel: "Ver opções de plano", actionWillDo: "Mostra as opções de upgrade; nada é contratado sem você confirmar.", affected: "no" },
  plan_module_gap: { title: "Há um módulo útil ao seu segmento fora do seu plano", meaning: "Um recurso feito para o seu tipo de negócio não está disponível hoje.", actionLabel: "Ver opções de plano", actionWillDo: "Mostra o módulo e o plano que o inclui; nada é contratado sem você confirmar.", affected: "no" },
};

// Automações (`domain: runtime`): a categoria da exceção diz o que aconteceu, em linguagem simples.
const RUNTIME_BY_CATEGORY: Record<string, Entry> = {
  integration_failed: { title: "Uma integração falhou", meaning: "Uma conexão com outro sistema não respondeu como esperado.", actionLabel: "Ver o que falhou", actionWillDo: "Abre os detalhes da integração para você ou o suporte tratar.", affected: "unknown", audience: "technical" },
  credential_missing: { title: "Falta uma credencial para uma automação", meaning: "Uma automação não consegue rodar sem esse acesso.", actionLabel: "Informar a credencial", actionWillDo: "Abre a tela para você informar o acesso que falta.", affected: "unknown", audience: "technical" },
  data_missing: { title: "Falta um dado para uma automação continuar", meaning: "Uma automação parou esperando informação.", actionLabel: "Completar a informação", actionWillDo: "Abre o item para você completar o que falta.", affected: "unknown", audience: "technical" },
  decision_needed: { title: "Uma automação espera a sua decisão", meaning: "O processo está parado até você decidir.", actionLabel: "Decidir agora", actionWillDo: "Abre a decisão pendente.", affected: "no" },
  approval_needed: { title: "Uma ação espera a sua aprovação", meaning: "Nada será executado até você aprovar.", actionLabel: "Revisar e aprovar", actionWillDo: "Abre a ação para você aprovar ou recusar.", affected: "no" },
  sla_at_risk: { title: "Um prazo está perto de estourar", meaning: "Uma ação combinada pode atrasar.", actionLabel: "Priorizar esta ação", actionWillDo: "Abre a ação para você priorizar antes do prazo.", affected: "yes" },
  risk_high: { title: "Uma ação foi marcada como de risco alto", meaning: "Merece a sua revisão antes de seguir.", actionLabel: "Revisar o risco", actionWillDo: "Abre a ação com o motivo do risco.", affected: "yes" },
  conflict: { title: "Duas ações entram em conflito", meaning: "Executar as duas pode dar resultado indesejado.", actionLabel: "Resolver o conflito", actionWillDo: "Abre as ações para você escolher qual segue.", affected: "yes" },
  irreversible_action: { title: "Uma ação não pode ser desfeita depois de feita", meaning: "Vale confirmar antes de seguir.", actionLabel: "Confirmar antes de seguir", actionWillDo: "Abre a ação para sua confirmação.", affected: "yes" },
  sensitive_customer: { title: "Um cliente sensível está envolvido", meaning: "Pede cuidado extra no contato.", actionLabel: "Revisar o caso", actionWillDo: "Abre o caso para você revisar antes de qualquer contato.", affected: "yes" },
};

const FALLBACK_BY_ACTION: Record<string, { actionLabel: string; actionWillDo: string }> = {
  create_task: { actionLabel: "Criar tarefa", actionWillDo: "Cria uma tarefa para a equipe tratar." },
  collection: { actionLabel: "Preparar cobrança", actionWillDo: "Prepara a cobrança para você aprovar antes de enviar." },
  prepare_purchase: { actionLabel: "Preparar pedido de compra", actionWillDo: "Prepara um rascunho de compra para você revisar." },
  retail_transfer: { actionLabel: "Preparar transferência", actionWillDo: "Prepara a transferência entre lojas para você aprovar." },
  propose_upgrade: { actionLabel: "Ver opções de plano", actionWillDo: "Mostra as opções; nada é contratado sem você confirmar." },
};
const FALLBACK_DEFAULT = { actionLabel: "Ver detalhes e decidir", actionWillDo: "Abre os detalhes para você decidir o que fazer." };

/** Traduz um sinal. Nunca lança e nunca devolve o identificador técnico. */
export function presentSignal(input: SignalInput): SignalPresentation {
  const type = String(input.signalType || "");
  const domain = String(input.domain || "");
  const ev = input.evidence && typeof input.evidence === "object" ? input.evidence : {};
  let entry: Entry | undefined = CATALOG[type];
  if (!entry && domain === "runtime") entry = RUNTIME_BY_CATEGORY[String(ev.category || "")] || RUNTIME_BY_CATEGORY[type];
  const dl = domainLabel(domain);
  if (entry) {
    let title: string;
    try { title = typeof entry.title === "function" ? entry.title(ev) : entry.title; } catch { title = typeof entry.title === "function" ? "Ponto de atenção" : entry.title; }
    return { title, meaning: entry.meaning, actionLabel: entry.actionLabel, actionWillDo: entry.actionWillDo, operationAffected: entry.affected || "unknown", audience: entry.audience || "owner", domainLabel: dl, known: true };
  }
  const fb = FALLBACK_BY_ACTION[String(input.actionType || "")] || FALLBACK_DEFAULT;
  return {
    title: domain ? `Ponto de atenção em ${dl}` : "Ponto de atenção no seu negócio",
    meaning: "Detectado automaticamente. Abra os detalhes para entender o que aconteceu.",
    actionLabel: fb.actionLabel, actionWillDo: fb.actionWillDo, operationAffected: "unknown",
    audience: domain === "runtime" || domain === "platform" ? "technical" : "owner", domainLabel: dl, known: false,
  };
}

/** Só p/ teste/auditoria: as chaves do catálogo e todos os textos estáticos (varredura de jargão). */
export const _catalog = { CATALOG, RUNTIME_BY_CATEGORY, FALLBACK_BY_ACTION, FALLBACK_DEFAULT };
