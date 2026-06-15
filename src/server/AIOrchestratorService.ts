import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { searchContext } from "./geminiRAG.js";
import { AnalyticsService } from "./AnalyticsService.js";
import { BusinessContextService } from "./BusinessContextService.js";
import { CampaignService } from "./CampaignService.js";
import { InventoryService } from "./InventoryService.js";
import { CustomerProfileService } from "./CustomerProfileService.js";
import { chat } from "./llm.js";
import { PlanService } from "./PlanService.js";
import { GoogleOAuthService } from "./GoogleOAuthService.js";
import { GoogleAutomationService } from "./GoogleAutomationService.js";
import { ReservationService } from "./ReservationService.js";
import { SubscriptionService } from "./SubscriptionService.js";

export class AIOrchestratorService {
  /**
   * Process a message and coordinate with the proper AI Agent. 
   */
  static async processMessage(params: {
    message: string;
    organizationId: string;
    senderId: string;
    contactName?: string;
    channelId: string;
    ticketStage?: string;
    history?: { role: string; text: string }[];
    contactId?: string;
    provider?: string;
    areaPersona?: string;
    areaId?: string | null;
  }): Promise<{ reply: string, actions: any[], newStage?: string, needsHuman: boolean, newAppointment?: any, newDelivery?: any, newOrder?: { items: { productId?: string; name: string; unitPrice: number; quantity: number }[]; autoClose: boolean }, cancelOrder?: boolean, customerEmail?: string, routeToArea?: string, newReservation?: { resource: string; start: string; end: string; units: number; guests?: number }, sendSubscriptionPix?: boolean, exportPdf?: boolean, pdfTitle?: string, pdfBody?: string }> {
    
    // 1. Verificar se é um Gestor Autorizado (com casamento tolerante ao 9º dígito BR)
    const manager = this.findAuthorizedManager(params.senderId, params.organizationId);

    let isManager = !!manager;
    let text = params.message.trim();
    let isOrchestratorCommand = false;

    // Só ativa o Orquestrador (modo admin) se for um GESTOR autorizado e a
    // mensagem começar com "zap" (tolerante: Zap, Zapp, Zapflow, Zappflow…). Se
    // NÃO for gestor mas usar "zap", NÃO revelamos a existência do canal admin
    // (anti-recon): a mensagem é tratada como um cliente comum pelo atendimento.
    if (isManager && text.toLowerCase().replace(/[^a-z]/g, "").startsWith("zap")) {
      isOrchestratorCommand = true;
    }

    // CONFIRMAÇÃO de ação pendente (Zapp dispara campanha com confirmação):
    // se um gestor tem uma ação aguardando "SIM", a resposta dele resolve a ação,
    // mesmo sem o prefixo "zapp".
    if (isManager) {
      const pending = this.getPendingAction(params.organizationId, params.senderId);
      if (pending) {
        const t = text.toLowerCase();
        const confirmed = /^(sim|confirmo|confirmar|pode|pode enviar|manda|envia|ok|isso|👍)\b/.test(t);
        const denied = /^(n[ãa]o|cancela|cancelar|para|pare|deixa)\b/.test(t);
        if (confirmed) {
          const reply = await this.executePendingAction(params.organizationId, params.senderId, pending);
          return { reply, actions: [], needsHuman: false };
        }
        if (denied) {
          this.clearPendingAction(pending.id);
          return { reply: "Tudo bem, cancelei. 👍 Se quiser, é só pedir de novo quando estiver pronto.", actions: [], needsHuman: false };
        }
        // Resposta ambígua: mantém a ação e pede confirmação explícita.
        return { reply: "Você tem uma campanha aguardando confirmação. Responda *SIM* para enviar ou *NÃO* para cancelar.", actions: [], needsHuman: false };
      }
    }

    // Guarda anti-injeção de prompt: no canal admin (Orquestrador), uma tentativa de
    // manipular as instruções é recusada sem executar nada (read-only por natureza).
    if (isOrchestratorCommand && this.isPromptInjection(text)) {
      this.logInteraction({
        organizationId: params.organizationId,
        agentUsed: "orchestrator_agent",
        inputPrompt: "BLOCKED (prompt_injection): " + params.message.slice(0, 200),
        outputResponse: "blocked",
        confidence: 0,
        needsHuman: 0,
        actions: "[]",
      });
      return {
        reply: "Não consegui processar esse comando. Por segurança, reformule o pedido em linguagem natural (ex.: \"Zapp, me dá o resumo de vendas de hoje\").",
        actions: [],
        needsHuman: false,
      };
    }

    let agentToUse = isOrchestratorCommand ? "orchestrator_agent" : "attendance_agent";

    // GUARDRAIL DE CUSTO (opt-in): se AI_DAILY_LIMIT estiver definido (>0),
    // limita o nº de respostas automáticas por organização por dia. Sem a env,
    // o comportamento é EXATAMENTE o de hoje (ilimitado). Ao exceder, em vez de
    // chamar a OpenAI, transfere para um humano com uma mensagem educada.
    if (this.dailyLimitReached(params.organizationId)) {
      return {
        reply: "No momento estou com um volume alto de atendimentos automáticos. Um de nossos atendentes vai te responder em breve. 🙏",
        actions: [],
        newStage: params.ticketStage,
        needsHuman: true,
      };
    }

    // Enforcement do plano (Fase 2): bloqueia se a org está suspensa/bloqueada ou
    // estourou o limite mensal do plano. Transfere para humano em vez de cortar.
    const planCheck = PlanService.aiAllowed(params.organizationId);
    if (!planCheck.allowed) {
      return {
        reply: planCheck.reason === 'monthly_limit'
          ? "Atingimos o limite de atendimentos automáticos do mês. Um atendente humano te responde em breve. 🙏"
          : "No momento o atendimento automático está pausado. Um atendente humano te responde em breve. 🙏",
        actions: [],
        newStage: params.ticketStage,
        needsHuman: true,
      };
    }

    // 2. Coletar RAG / Knowledge Base e Produtos
    const contextContent = await searchContext(text, params.organizationId, params.channelId, 3, params.areaId ?? null);
    const contextText = contextContent.length > 0 ? contextContent.join('\n\n') : "Nenhum documento encontrado na base de RAG.";
    
    const productsText = await this.getProductsContext(params.organizationId);
    let metricsData = "";

    if (isOrchestratorCommand) {
      try {
        // Raio-x completo do negócio (CRM, funil, vendas, estoque, campanhas, agenda).
        metricsData = BusinessContextService.build(params.organizationId);
      } catch (e) {
        metricsData = "Não foi possível carregar o panorama do negócio no momento.";
      }
    }

    // Contexto de CRM do cliente (temperatura, histórico de compra) para o atendimento.
    let profileText = "";
    if (!isOrchestratorCommand && params.contactId) {
      profileText = CustomerProfileService.profileLine(params.organizationId, params.contactId);
    }

    // Encaminhamento Instagram -> WhatsApp: se o canal é Instagram e há um número
    // de WhatsApp configurado, instrui a IA a conduzir o lead para o WhatsApp.
    let forwardText = "";
    if (!isOrchestratorCommand && params.provider === 'instagram') {
      try {
        const o = db.prepare('SELECT forward_whatsapp FROM organization_settings WHERE organization_id = ?').get(params.organizationId) as any;
        if (o?.forward_whatsapp) {
          forwardText = `CANAL ATUAL: Instagram Direct. Sempre que fizer sentido (interesse de compra, dúvida que exige mais detalhes, fechamento), convide o cliente a continuar pelo WhatsApp para um atendimento mais ágil, informando o número: https://wa.me/${o.forward_whatsapp} (ou ${o.forward_whatsapp}). Seja natural, não force em toda mensagem.`;
        } else {
          forwardText = `CANAL ATUAL: Instagram Direct.`;
        }
      } catch (e) { /* noop */ }
    }

    // Negociador: se ligado, injeta as regras de margem para a IA negociar com
    // segurança (nunca abaixo do mínimo, só com gatilho do cliente).
    let negotiatorText = "";
    if (!isOrchestratorCommand) {
      negotiatorText = this.negotiatorContext(params.organizationId);
    }

    // Loja virtual: se a vitrine está publicada, a IA pode mandar o link dela
    // quando o cliente quiser ver os produtos. Só injeta a instrução se houver loja.
    let storefrontText = "";
    if (!isOrchestratorCommand) {
      storefrontText = this.storefrontContext(params.organizationId);
    }

    // Status do pedido/entrega do cliente: para a IA responder "cadê meu pedido?"
    // com dados reais (read-only), sem inventar.
    let orderStatusText = "";
    if (!isOrchestratorCommand && params.contactId) {
      orderStatusText = this.orderStatusContext(params.organizationId, params.contactId);
    }

    // Agenda do Google: horários já ocupados, para a IA não marcar em cima de
    // compromissos e oferecer apenas horários livres (best-effort, cacheado).
    let agendaText = "";
    if (!isOrchestratorCommand) {
      try { agendaText = await GoogleOAuthService.getBusyText(params.organizationId); } catch (e) { /* noop */ }
    }

    // Captura de e-mail: só pedimos o e-mail ao cliente quando o dono ligou as
    // confirmações por e-mail E o Google está conectado. Se o contato já tem
    // e-mail salvo, não pedimos de novo (apenas continuamos capturando se mudar).
    let emailCaptureText = "";
    if (!isOrchestratorCommand && params.contactId) {
      try {
        const s = GoogleAutomationService.getSettings(params.organizationId);
        if ((s.emailAppointments || s.emailOrders) && GoogleOAuthService.getConnection(params.organizationId)) {
          const c = db.prepare("SELECT email FROM contacts WHERE id = ?").get(params.contactId) as any;
          const has = c?.email ? `O e-mail atual do cliente é ${c.email} (use-o; só atualize se ele informar outro).` :
            "Ainda NÃO temos o e-mail deste cliente.";
          const para = s.emailOrders && s.emailAppointments ? "do pedido e do agendamento" : s.emailOrders ? "do pedido" : "do agendamento";
          emailCaptureText = `CAPTURA DE E-MAIL: enviamos a confirmação ${para} por e-mail. ${has}
- Quando o cliente informar um e-mail (a qualquer momento), coloque-o em "customer_email" (apenas o endereço, validado).
- Ao FECHAR um pedido/agendamento, se ainda não tivermos o e-mail, peça-o de forma simpática e OPCIONAL na sua "reply" (ex.: "Quer que eu te envie a confirmação por e-mail? Se sim, me passa seu melhor e-mail 😊"). NÃO insista nem trave a venda se o cliente não quiser informar.`;
        }
      } catch (e) { /* noop */ }
    }

    // Reservas: se a org tem recursos reserváveis, ensina a IA a reservar por
    // período (recurso + datas + unidades) via "reservation_request".
    let reservationText = "";
    if (!isOrchestratorCommand) {
      try {
        const recursos = ReservationService.listResources(params.organizationId);
        if (recursos.length > 0) {
          const unitLabel: Record<string, string> = { night: "diária", day: "dia", hour: "hora", slot: "turno" };
          const lista = recursos.map((r: any) =>
            `- ${r.name} (R$ ${Number(r.price || 0).toFixed(2)}/${unitLabel[r.reservation_unit] || r.reservation_unit}, ${r.capacity} unidade(s))`
          ).join("\n");
          reservationText = `RESERVAS POR PERÍODO — recursos reserváveis disponíveis:\n${lista}
- Quando o cliente quiser RESERVAR (hospedagem, mesa, espaço, equipamento), colete o RECURSO, a DATA/HORA de início e fim e quantas UNIDADES, e preencha "reservation_request" com { "resource": NOME EXATO da lista, "start": ISO 8601 -03:00, "end": ISO 8601 -03:00, "units": número, "guests": número opcional }.
- NÃO confirme a reserva você mesmo nem invente disponibilidade — o sistema checa a vaga e cria a reserva (e cobra o sinal, se houver). Na "reply", seja simpático e diga que está verificando/garantindo a reserva.
- Calcule as datas a partir da DATA ATUAL. Para diárias, use horário de check-in/out plausível (ex.: 14:00 / 12:00) se o cliente não disser.`;
        }
      } catch (e) { /* noop */ }
    }

    // Assinatura/mensalidade do cliente: deixa a IA responder "quanto devo /
    // estou em dia?" com dados reais e reenviar o PIX da fatura em aberto.
    let subscriptionText = "";
    if (!isOrchestratorCommand && params.contactId) {
      try {
        const sub = SubscriptionService.contactSubscription(params.organizationId, params.contactId);
        if (sub) {
          const inv = SubscriptionService.openInvoiceForContact(params.organizationId, params.contactId);
          const brl = (v: any) => `R$ ${Number(v || 0).toFixed(2)}`;
          const next = sub.next_charge_at ? new Date(sub.next_charge_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "a definir";
          let txt = `ASSINATURA DO CLIENTE: plano "${sub.plan_name || "Mensalidade"}" (${brl(sub.amount)}), situação: ${sub.status === "past_due" ? "EM ATRASO" : "em dia/ativa"}. Próxima cobrança: ${next}.`;
          if (inv) {
            const venc = inv.due_date ? new Date(inv.due_date).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—";
            txt += ` Há uma fatura EM ABERTO de ${brl(inv.amount)} (vencimento ${venc}, ${inv.status === "overdue" ? "vencida" : "pendente"}).`;
          } else {
            txt += ` Não há faturas em aberto (está em dia).`;
          }
          txt += `\n- Responda com esses dados reais quando o cliente perguntar sobre mensalidade/pagamento ("quanto devo?", "estou em dia?", "quando vence?"). NÃO invente valores.`;
          if (inv) txt += `\n- Se o cliente pedir para pagar/receber o PIX da mensalidade ("me manda o pix", "quero pagar"), defina "send_subscription_pix": true — o sistema anexa o PIX da fatura em aberto. NÃO escreva o PIX você mesmo.`;
          subscriptionText = txt;
        }
      } catch (e) { /* noop */ }
    }

    const prompt = this.buildPrompt(agentToUse, params, contextText, productsText, metricsData, profileText, forwardText, negotiatorText, storefrontText, orderStatusText, params.areaPersona || "", agendaText, emailCaptureText, reservationText, subscriptionText);

    // 3. Chamar a IA com Schema JSON (OpenAI, modo JSON)
    const rawResponse = await chat(prompt, {
      temperature: agentToUse === "orchestrator_agent" ? 0.2 : 0.4, // Mais rígido para relatórios/orquestração
      json: true,
    });
    let resultJSON = null;

    try {
      const cleanedJson = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
      resultJSON = JSON.parse(cleanedJson);
    } catch(e) {
      console.error("[AI Orchestrator] Falha no parse JSON:", rawResponse);
      resultJSON = {
        reply: "Desculpe, não consegui processar a solicitação no momento. Vou transferir para um humano.",
        agent: agentToUse,
        confidence: 0.1,
        needs_human: true,
        actions: [],
        risk_flags: ["json_parse_error"]
      };
    }

    // 4. Salvar Log da Interação (Mascarando dados sensíveis se necessário)
    this.logInteraction({
       organizationId: params.organizationId,
       agentUsed: resultJSON.agent || agentToUse,
       inputPrompt: "User: " + params.message + "\nContext Length: " + contextText.length,
       outputResponse: JSON.stringify(resultJSON),
       confidence: resultJSON.confidence || 0,
       needsHuman: resultJSON.needs_human ? 1 : 0,
       actions: JSON.stringify(resultJSON.actions || [])
    });

    // 5. TRAVA DE SEGURANÇA: o Orquestrador (modo admin/gestor) é estritamente
    // READ-ONLY. Ele NUNCA pode mover tickets, criar agendamentos/entregas nem
    // executar qualquer ação que altere os dados do negócio — só responde texto.
    // Isso impede que uma injeção de prompt num comando de gestor cause mutações.
    if (isOrchestratorCommand) {
      let reply = resultJSON.reply || "Não foi possível gerar a resposta.";
      // Se o Zapp propôs uma campanha, NÃO dispara: guarda como ação pendente e
      // pede confirmação explícita (trava de segurança contra disparo indevido).
      const ci = resultJSON.campaign_intent;
      if (ci && typeof ci === 'object' && ci.message) {
        const segment = this.normalizeSegment(ci.segment);
        const preview = CampaignService.resolveSegment(params.organizationId, segment);
        if (preview.length === 0) {
          reply = "Não encontrei contatos nesse público no momento. Quer tentar outro público (ex.: inativos há 30 dias)?";
        } else {
          this.savePendingAction(params.organizationId, params.senderId, 'create_campaign', {
            name: ci.name || `Campanha Zapp ${new Date().toLocaleDateString('pt-BR')}`,
            message: ci.message,
            segment,
          });
          reply = `${reply}\n\n📣 *Pronto para enviar* para *${preview.length} contato(s)*.\nMensagem: "${ci.message}"\n\nResponda *SIM* para disparar ou *NÃO* para cancelar.`;
        }
      }
      return {
        reply,
        actions: [],
        newStage: params.ticketStage, // mantém o estágio atual (sem alteração)
        needsHuman: false,
        // PDF: se o gestor pediu "em pdf", o webhook gera o relatório (resumo +
        // panorama) e envia o link. Read-only — não altera nada do negócio.
        exportPdf: /\bpdf\b/i.test(params.message),
        pdfTitle: params.message.replace(/^\s*zap\w*[,:\s]*/i, "").replace(/\b(em|no|formato|gera[r]?|me\s+manda|manda)\b.*pdf.*/i, "").trim().slice(0, 80) || "Relatório do negócio",
        pdfBody: metricsData,
      };
    }

    // 6. Agente de atendimento: só aceitamos ações de uma WHITELIST e validamos
    // cada payload. Tipos desconhecidos são descartados (defesa contra a IA
    // "alucinar" uma ação destrutiva).
    const safeActions = this.sanitizeActions(resultJSON.actions);

    let newStage = params.ticketStage;
    const moveAction = safeActions.find((a: any) => a.type === "MOVE_TICKET");
    if (moveAction?.payload?.stage) {
      newStage = moveAction.payload.stage;
    }

    // PEDIDO proposto pela IA: resolvemos os itens contra o catálogo e validamos
    // o estoque AQUI. Se faltar estoque/produto, NÃO criamos o pedido e trocamos
    // a resposta por uma mensagem honesta (evita "confirmar" uma venda impossível).
    let reply = resultJSON.reply || "Erro interno.";
    let newOrder: { items: any[]; autoClose: boolean } | undefined;
    const orderResolved = this.resolveOrderIntent(params.organizationId, resultJSON.new_order);
    if (orderResolved) {
      if (orderResolved.error) {
        reply = orderResolved.error;
      } else if (orderResolved.items.length > 0) {
        newOrder = { items: orderResolved.items, autoClose: this.autoCloseEnabled(params.organizationId) };
      }
    }

    // CANCELAMENTO: a IA marca cancel_order=true quando o cliente CONFIRMA que
    // quer cancelar. O webhook cancela o pedido ativo do contato (e o estoque
    // volta automaticamente). A IA deve confirmar antes (usa o histórico).
    const cancelOrder = resultJSON.cancel_order === true;

    // COTAÇÃO POR LISTA: o cliente mandou uma lista de itens (texto/áudio). A IA
    // sinaliza quote_request com os itens; aqui montamos a cotação real (preços,
    // estoque, faltantes, total) e ANEXAMOS à resposta. Não cria pedido — o
    // cliente confirma depois (vira new_order). É read-only.
    if (!newOrder && resultJSON.quote_request && Array.isArray(resultJSON.quote_request.items)) {
      const quote = this.buildQuote(params.organizationId, resultJSON.quote_request.items);
      if (quote) reply = `${reply}\n\n${quote}`;
    }

    // VITRINE: a IA pede para mostrar os produtos numa landing page (loja virtual)
    // quando o cliente quer "ver os produtos/fotos/catálogo/loja". Geramos um link
    // exclusivo (vinculado ao contato) e anexamos à resposta. Só se a loja estiver
    // publicada e o link ainda não estiver na mensagem.
    if (resultJSON.send_storefront === true && !/\/loja\//.test(reply)) {
      const storeLink = this.buildStorefrontLink(params.organizationId, params.contactId);
      if (storeLink) {
        reply = `${reply}\n\n🛍️ Dá uma olhada nos nossos produtos e monte seu pedido por aqui:\n${storeLink}`;
      }
    }

    return {
      reply,
      actions: safeActions,
      newStage: newStage,
      needsHuman: !!resultJSON.needs_human,
      newAppointment: this.sanitizeAppointment(resultJSON.new_appointment),
      newDelivery: this.sanitizeDelivery(resultJSON.new_delivery),
      newOrder,
      cancelOrder,
      customerEmail: this.sanitizeEmail(resultJSON.customer_email),
      routeToArea: (typeof resultJSON.route_to_area === "string" && resultJSON.route_to_area.trim())
        ? resultJSON.route_to_area.trim().slice(0, 80) : undefined,
      newReservation: this.sanitizeReservation(resultJSON.reservation_request),
      sendSubscriptionPix: resultJSON.send_subscription_pix === true,
    };
  }

  /**
   * Monta o contexto do NEGOCIADOR para o prompt. Só retorna texto se o dono
   * ligou o recurso. Inclui o desconto máximo permitido, os preços mínimos por
   * produto e as regras (gatilhos), com travas de segurança.
   */
  private static negotiatorContext(orgId: string): string {
    try {
      const o = db.prepare('SELECT negotiator_enabled, negotiator_max_discount, negotiator_rules FROM organization_settings WHERE organization_id = ?').get(orgId) as any;
      if (!o || !o.negotiator_enabled) return "";
      const maxDisc = parseInt(String(o.negotiator_max_discount || 0), 10);

      // Lista os produtos com preço mínimo definido (>0).
      const prods = db.prepare("SELECT name, price, min_price FROM products_services WHERE organization_id = ? AND active = 1 AND min_price IS NOT NULL AND min_price > 0").all(orgId) as any[];
      const minLines = prods.map(p => `- ${p.name}: preço R$ ${Number(p.price || 0).toFixed(2)}, MÍNIMO R$ ${Number(p.min_price).toFixed(2)}`).join('\n');

      let txt = `NEGOCIADOR ATIVO — você pode negociar preço, MAS com regras rígidas:
1. NUNCA ofereça desconto por conta própria. Só negocie se o CLIENTE acionar um gatilho: pedir desconto explicitamente, dizer que está caro, comparar com concorrente, ou demonstrar que vai DESISTIR após saber o preço (abandono).
2. NUNCA baixe o preço abaixo do MÍNIMO de cada produto (listados abaixo). Se não houver mínimo definido para um produto, NÃO dê desconto nele.
3. Desconto máximo permitido: ${maxDisc > 0 ? maxDisc + '%' : 'apenas até o preço mínimo do produto'}. Comece com um desconto pequeno; só chegue perto do limite se o cliente insistir e estiver prestes a fechar.
4. Negocie com elegância: valorize o produto antes de ceder, e peça algo em troca quando possível (ex.: fechar agora, levar mais itens, pagamento à vista).`;
      if (minLines) txt += `\n\nPREÇOS MÍNIMOS (NUNCA furar):\n${minLines}`;
      if (o.negotiator_rules) txt += `\n\nREGRAS DO DONO: ${o.negotiator_rules}`;
      return txt;
    } catch (e) { return ""; }
  }

  /** Lê o interruptor de autonomia de vendas da organização. */
  private static autoCloseEnabled(orgId: string): boolean {
    try {
      const o = db.prepare('SELECT ai_auto_close_sales FROM organization_settings WHERE organization_id = ?').get(orgId) as any;
      return !!(o && o.ai_auto_close_sales);
    } catch (e) { return false; }
  }

  /**
   * Gera o link público da vitrine (loja virtual) JÁ VINCULADO ao contato, via
   * um token de uso na storefront_links. Assim, o pedido feito na landing page
   * nasce ligado a este cliente/conversa. Retorna null se a loja não estiver
   * publicada (ou sem slug) — nesse caso a IA segue só com o catálogo em texto.
   */
  private static buildStorefrontLink(orgId: string, contactId?: string): string | null {
    try {
      const store = db.prepare(
        'SELECT slug, published FROM storefront_settings WHERE organization_id = ?'
      ).get(orgId) as any;
      if (!store || !store.published || !store.slug) return null;

      const token = uuidv4().replace(/-/g, '').slice(0, 16);
      db.prepare(
        `INSERT INTO storefront_links (token, organization_id, contact_id, ticket_id, expires_at)
         VALUES (?, ?, ?, NULL, datetime('now', '+30 days'))`
      ).run(token, orgId, contactId || null);

      const base = (process.env.APP_URL || process.env.CORS_ORIGIN || '').replace(/\/$/, '');
      const path = `/loja/${store.slug}?c=${token}`;
      return base ? `${base}${path}` : path;
    } catch (e) {
      return null;
    }
  }

  /**
   * Instrução de LOJA VIRTUAL para o prompt. Só retorna texto se a vitrine
   * estiver publicada — assim a IA nunca promete um link que não existe.
   */
  private static storefrontContext(orgId: string): string {
    try {
      const store = db.prepare(
        'SELECT published, slug FROM storefront_settings WHERE organization_id = ?'
      ).get(orgId) as any;
      if (!store || !store.published || !store.slug) return "";
      return `LOJA VIRTUAL (vitrine online): temos uma landing page com nossos produtos (fotos, opções de tamanho/peso e carrinho). Quando o cliente quiser VER os produtos, pedir o catálogo/as fotos, ou perguntar "o que vocês têm", defina "send_storefront": true — o sistema anexa automaticamente um link EXCLUSIVO dele à sua resposta (não invente nem escreva o link você mesmo). Na sua "reply", apenas convide de forma simpática (ex.: "Te mando nossa vitrine pra você escolher com calma 😊"). Continue podendo fechar o pedido por aqui também (new_order).`;
    } catch (e) { return ""; }
  }

  /**
   * Resumo do PEDIDO/ENTREGA mais recente do cliente para o prompt. Permite que
   * a IA responda "cadê meu pedido?" com status real (read-only). Retorna "" se
   * o cliente não tem pedidos.
   */
  private static orderStatusContext(orgId: string, contactId: string): string {
    try {
      const order = db.prepare(
        `SELECT id, status, total_amount, created_at FROM orders
          WHERE organization_id = ? AND contact_id = ?
          ORDER BY created_at DESC LIMIT 1`
      ).get(orgId, contactId) as any;
      if (!order) return "";

      const ORDER_LABEL: Record<string, string> = {
        aguardando_pagamento: 'aguardando pagamento', pago: 'pago', em_preparo: 'em preparo',
        entregue: 'entregue', concluido: 'concluído', cancelado: 'cancelado',
        reembolso: 'reembolso', devolucao: 'devolução',
      };
      const items = db.prepare(
        'SELECT name_snapshot, quantity FROM order_items WHERE order_id = ?'
      ).all(order.id) as any[];
      const itemsTxt = items.map(i => `${i.quantity}× ${i.name_snapshot}`).join(', ');
      const date = new Date(order.created_at).toLocaleDateString('pt-BR');

      let txt = `STATUS DO PEDIDO DO CLIENTE (use para responder dúvidas sobre "meu pedido"/"minha entrega"; NÃO invente, use exatamente estes dados):
- Pedido #${String(order.id).slice(0, 8)} de ${date} — status: ${ORDER_LABEL[order.status] || order.status} — total R$ ${Number(order.total_amount || 0).toFixed(2)}${itemsTxt ? ` — itens: ${itemsTxt}` : ''}`;

      const delivery = db.prepare(
        `SELECT status, delivery_window_start, delivery_window_end FROM deliveries
          WHERE organization_id = ? AND contact_id = ?
          ORDER BY created_at DESC LIMIT 1`
      ).get(orgId, contactId) as any;
      if (delivery) {
        const DELIV_LABEL: Record<string, string> = {
          pending: 'a programar', scheduled: 'agendada', out_for_delivery: 'saiu para entrega',
          delivered: 'entregue', failed: 'falhou', cancelled: 'cancelada',
        };
        txt += `\n- Entrega: ${DELIV_LABEL[delivery.status] || delivery.status}`;
      }
      txt += `\nSe o cliente perguntar e o status for "aguardando pagamento", lembre com gentileza como concluir o pagamento.`;
      return txt;
    } catch (e) { return ""; }
  }

  /**
   * Converte o `new_order` proposto pela IA (itens por nome) em itens resolvidos
   * do catálogo, validando estoque vendável. Retorna { error } se algo impede a
   * venda, ou { items } pronto para criar. Retorna null se não há pedido.
   */
  private static resolveOrderIntent(orgId: string, raw: any): { items: any[]; error?: string } | null {
    if (!raw || !Array.isArray(raw.items) || raw.items.length === 0) return null;
    const items: any[] = [];
    for (const it of raw.items) {
      const name = typeof it?.name === 'string' ? it.name.trim() : '';
      const qty = parseInt(String(it?.quantity ?? 0), 10);
      if (!name || !qty || qty <= 0) continue;

      // Casa o produto por nome (case-insensitive) dentro da organização.
      const product = db.prepare(
        'SELECT * FROM products_services WHERE organization_id = ? AND active = 1 AND lower(name) = lower(?)'
      ).get(orgId, name) as any;
      if (!product) {
        return { items: [], error: `Não encontrei "${name}" no nosso catálogo. Pode confirmar o nome do produto? 🙂` };
      }
      if (product.stock_control_enabled) {
        const sellable = InventoryService.sellable(orgId, product.id) ?? 0;
        if (qty > sellable) {
          return { items: [], error: sellable > 0
            ? `Temos só ${sellable} unidade(s) de "${product.name}" no momento. Quer levar ${sellable}, ou prefere outra coisa?`
            : `Poxa, "${product.name}" está sem estoque no momento. Posso te avisar quando repor ou sugerir uma alternativa.` };
        }
      }
      items.push({ productId: product.id, name: product.name, unitPrice: product.price ?? 0, quantity: qty });
    }
    return { items };
  }

  /**
   * Monta uma COTAÇÃO a partir de uma lista de itens (cada um com nome + qtd).
   * Casa por nome exato e, se falhar, por aproximação (LIKE). Para cada item:
   * mostra preço, subtotal e disponibilidade (ajusta qtd se faltar estoque).
   * Lista o que não foi encontrado. Retorna o texto pronto para o WhatsApp.
   */
  private static buildQuote(orgId: string, rawItems: any[]): string | null {
    const reqs = (rawItems || []).map((it: any) => ({
      name: typeof it?.name === 'string' ? it.name.trim() : '',
      qty: Math.max(1, parseInt(String(it?.quantity ?? 1), 10) || 1),
    })).filter(r => r.name);
    if (reqs.length === 0) return null;

    const currency = 'R$';
    const lines: string[] = [];
    const notFound: string[] = [];
    let total = 0;

    for (const r of reqs) {
      // 1) match exato; 2) aproximado (contém).
      let product = db.prepare(
        'SELECT * FROM products_services WHERE organization_id = ? AND active = 1 AND lower(name) = lower(?)'
      ).get(orgId, r.name) as any;
      if (!product) {
        product = db.prepare(
          "SELECT * FROM products_services WHERE organization_id = ? AND active = 1 AND lower(name) LIKE lower(?) ORDER BY length(name) ASC LIMIT 1"
        ).get(orgId, `%${r.name}%`) as any;
      }
      if (!product) { notFound.push(r.name); continue; }

      const price = Number(product.price ?? 0);
      let qty = r.qty;
      let note = '';
      if (product.stock_control_enabled) {
        const sellable = InventoryService.sellable(orgId, product.id) ?? 0;
        if (sellable <= 0) { note = ' — *sem estoque*'; qty = 0; }
        else if (qty > sellable) { note = ` — só temos *${sellable}*`; qty = sellable; }
      }
      const sub = price * qty;
      total += sub;
      if (qty > 0) {
        lines.push(`• ${qty}x ${product.name} — ${currency} ${price.toFixed(2)} = *${currency} ${sub.toFixed(2)}*${note}`);
      } else {
        lines.push(`• ${product.name}${note}`);
      }
    }

    if (lines.length === 0 && notFound.length > 0) {
      return `Não localizei esses itens no catálogo: ${notFound.join(', ')}. Pode me dizer de outro jeito? 🙂`;
    }

    let out = `🧾 *Sua cotação:*\n${lines.join('\n')}\n\n*Total: ${currency} ${total.toFixed(2)}*`;
    if (notFound.length > 0) out += `\n\n⚠️ Não encontrei: ${notFound.join(', ')}.`;
    out += `\n\nQuer que eu *feche o pedido* com esses itens? Posso te passar as formas de pagamento. 👍`;
    return out;
  }

  // Estágios válidos do Kanban (espelha o type Stage do frontend).
  private static readonly VALID_STAGES = new Set([
    "novo_lead", "ia_atendendo", "aguardando_humano", "em_atendimento_humano",
    "qualificado", "proposta", "aguardando_pagamento", "agendado",
    "em_execucao", "entregue_concluido", "perdido",
  ]);

  /**
   * Guardrail de custo OPT-IN. Retorna true se a organização já atingiu o
   * limite diário de respostas automáticas (env AI_DAILY_LIMIT). Sem a env
   * (ou =0), nunca limita — comportamento idêntico ao atual.
   */
  private static dailyLimitReached(orgId: string): boolean {
    const limit = parseInt(process.env.AI_DAILY_LIMIT || "0", 10);
    if (!limit || limit <= 0) return false;
    try {
      const row = db.prepare(
        `SELECT count(*) as count FROM ai_interactions_log WHERE organization_id = ? AND date(created_at) = date('now')`
      ).get(orgId) as any;
      return (row?.count || 0) >= limit;
    } catch (e) {
      return false; // em caso de erro, não bloqueia o atendimento
    }
  }

  /** Heurística simples de detecção de injeção de prompt. */
  private static isPromptInjection(text: string): boolean {
    const lower = (text || "").toLowerCase();
    const suspicious = [
      "ignore todas as instru", "ignore as instru", "ignore previous", "ignore the above",
      "esqueça o que eu disse", "esqueca o que", "system prompt", "system:", "</system",
      "você é agora", "voce e agora", "you are now", "modo desenvolvedor", "developer mode",
      "desconsidere as regras", "execute sql", "drop table", "delete from", "update ",
      "act as", "jailbreak", "DAN ",
    ];
    return suspicious.some((k) => lower.includes(k));
  }

  /** Mantém apenas ações da whitelist, com payload validado. */
  private static sanitizeActions(actions: any): any[] {
    if (!Array.isArray(actions)) return [];
    const out: any[] = [];
    for (const a of actions) {
      if (!a || typeof a.type !== "string") continue;
      if (a.type === "MOVE_TICKET") {
        const stage = a.payload?.stage;
        if (typeof stage === "string" && this.VALID_STAGES.has(stage)) {
          out.push({ type: "MOVE_TICKET", payload: { stage } });
        }
      }
      // Qualquer outro tipo de ação é ignorado por segurança.
    }
    return out;
  }

  private static clampStr(v: any, max: number): string | undefined {
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    if (!t) return undefined;
    return t.slice(0, max);
  }

  /** Valida/limita um agendamento sugerido pela IA. */
  private static sanitizeAppointment(appt: any): any | undefined {
    if (!appt || typeof appt !== "object") return undefined;
    const title = this.clampStr(appt.title, 200);
    if (!title) return undefined;
    let scheduled_start: string | undefined = undefined;
    if (typeof appt.scheduled_start === "string") {
      const d = new Date(appt.scheduled_start);
      if (!isNaN(d.getTime())) scheduled_start = d.toISOString();
    }
    return { title, scheduled_start };
  }

  /**
   * Valida um e-mail capturado pela IA na conversa (ex.: cliente forneceu o
   * e-mail para receber a confirmação). Retorna o e-mail normalizado em
   * minúsculas, ou undefined se não for um e-mail plausível.
   */
  private static sanitizeEmail(email: any): string | undefined {
    if (typeof email !== "string") return undefined;
    const e = email.trim().toLowerCase();
    if (e.length > 254) return undefined;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return undefined;
    return e;
  }

  /** Valida um pedido de reserva sugerido pela IA. */
  private static sanitizeReservation(r: any): { resource: string; start: string; end: string; units: number; guests?: number } | undefined {
    if (!r || typeof r !== "object") return undefined;
    const resource = this.clampStr(r.resource, 120);
    if (!resource) return undefined;
    const toIso = (v: any): string | undefined => {
      if (typeof v !== "string") return undefined;
      const d = new Date(v);
      return isNaN(d.getTime()) ? undefined : d.toISOString();
    };
    const start = toIso(r.start), end = toIso(r.end);
    if (!start || !end || new Date(end) <= new Date(start)) return undefined;
    const units = Math.max(1, Math.min(99, parseInt(String(r.units || 1), 10) || 1));
    const guests = r.guests != null ? Math.max(1, Math.min(999, parseInt(String(r.guests), 10) || 1)) : undefined;
    return { resource, start, end, units, guests };
  }

  /** Valida/limita uma entrega sugerida pela IA. */
  private static sanitizeDelivery(del: any): any | undefined {
    if (!del || typeof del !== "object") return undefined;
    const address = this.clampStr(del.address, 300);
    if (!address) return undefined;
    return { address };
  }

  /**
   * Gera variações plausíveis de um número brasileiro para lidar com a presença
   * ou ausência do 9º dígito (ex.: 5521999998888 <-> 552199998888).
   * Para outros DDIs, retorna apenas o próprio número.
   */
  private static phoneVariants(raw: string): string[] {
    const digits = String(raw || "").replace(/\D/g, "");
    if (!digits) return [];
    const variants = new Set<string>([digits]);

    // Número brasileiro: 55 + DDD(2) + assinante(8 ou 9)
    if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
      const ddd = digits.slice(2, 4);
      const subscriber = digits.slice(4);
      if (subscriber.length === 9 && subscriber.startsWith("9")) {
        // tira o 9 -> versão de 8 dígitos
        variants.add(`55${ddd}${subscriber.slice(1)}`);
      } else if (subscriber.length === 8) {
        // adiciona o 9 -> versão de 9 dígitos
        variants.add(`55${ddd}9${subscriber}`);
      }
    }
    return Array.from(variants);
  }

  /**
   * Busca um gestor autorizado tolerando variações do número (9º dígito BR).
   */
  private static findAuthorizedManager(senderId: string, orgId: string): any {
    // Tentativa exata primeiro (mais rápida e cobre o caso comum)
    const exact = db.prepare('SELECT * FROM authorized_managers WHERE identifier = ? AND organization_id = ?')
      .get(senderId, orgId) as any;
    if (exact) return exact;

    const variants = this.phoneVariants(senderId);
    if (variants.length <= 1) return undefined;

    const placeholders = variants.map(() => '?').join(',');
    return db.prepare(
      `SELECT * FROM authorized_managers WHERE organization_id = ? AND identifier IN (${placeholders})`
    ).get(orgId, ...variants) as any;
  }

  // ---- Ações pendentes do gestor (Zapp dispara com confirmação) ----

  /** Normaliza o segmento sugerido pela IA para o formato do CampaignService. */
  private static normalizeSegment(seg: any): any {
    if (!seg || typeof seg !== 'object') return {};
    const out: any = {};
    if (['quente', 'morno', 'frio'].includes(seg.temperature)) out.temperature = seg.temperature;
    if (seg.tag && typeof seg.tag === 'string') out.tag = seg.tag.slice(0, 40);
    const inactive = parseInt(String(seg.inactiveDays), 10);
    if (inactive > 0) out.inactiveDays = inactive;
    const top = parseInt(String(seg.topBuyers), 10);
    if (top > 0) out.topBuyers = Math.min(top, 100);
    return out;
  }

  private static getPendingAction(orgId: string, identifier: string): any {
    try {
      return db.prepare(`SELECT * FROM pending_manager_actions WHERE organization_id = ? AND identifier = ? ORDER BY created_at DESC LIMIT 1`).get(orgId, identifier);
    } catch (e) { return null; }
  }

  private static savePendingAction(orgId: string, identifier: string, type: string, payload: any) {
    try {
      // Substitui qualquer pendência anterior do mesmo gestor.
      db.prepare(`DELETE FROM pending_manager_actions WHERE organization_id = ? AND identifier = ?`).run(orgId, identifier);
      db.prepare(`INSERT INTO pending_manager_actions (id, organization_id, identifier, action_type, payload_json, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now','+1 hour'))`)
        .run(uuidv4(), orgId, identifier, type, JSON.stringify(payload));
    } catch (e) { /* noop */ }
  }

  private static clearPendingAction(id: string) {
    try { db.prepare(`DELETE FROM pending_manager_actions WHERE id = ?`).run(id); } catch (e) { /* noop */ }
  }

  /** Executa a ação confirmada pelo gestor. Hoje: criar e disparar campanha. */
  private static async executePendingAction(orgId: string, identifier: string, pending: any): Promise<string> {
    this.clearPendingAction(pending.id);
    // Expiração de segurança (1h).
    if (pending.expires_at && new Date(pending.expires_at).getTime() < Date.now()) {
      return "Essa solicitação expirou. Pode pedir de novo que eu preparo na hora. 🙂";
    }
    let payload: any = {};
    try { payload = JSON.parse(pending.payload_json); } catch (e) { return "Não consegui recuperar os detalhes da campanha. Pode pedir de novo?"; }

    if (pending.action_type === 'create_campaign') {
      try {
        const created = CampaignService.createCampaign(orgId, {
          name: payload.name, message: payload.message, segment: payload.segment, createdBy: 'zapp',
        });
        const started = await CampaignService.startCampaign(orgId, created.id, (global as any).io);
        if (!started.started) return `Criei a campanha (${created.total} contatos), mas não consegui iniciar agora: ${started.reason}. Você pode iniciá-la na aba Campanhas.`;
        return `✅ Disparando para *${created.total} contato(s)*! Acompanhe o progresso na aba *Campanhas*. As mensagens saem com intervalo entre elas para proteger seu número.`;
      } catch (e: any) {
        return `Não consegui criar a campanha: ${e?.message || 'erro'}.`;
      }
    }
    return "Ação concluída.";
  }

  private static async getProductsContext(orgId: string): Promise<string> {
     try {
       // Estoque do produto (linha sem variação) — evita duplicar linhas das variações.
       const rows: any[] = db.prepare(`
         SELECT ps.*, inv.quantity_available, inv.quantity_reserved
         FROM products_services ps
         LEFT JOIN inventory_items inv ON inv.product_service_id = ps.id AND inv.variant_id IS NULL
         WHERE ps.organization_id = ? AND ps.active = 1
       `).all(orgId);
       if (!rows.length) return "";
       const variantStmt = db.prepare(`
         SELECT pv.name, pv.price, inv.quantity_available, inv.quantity_reserved
         FROM product_variants pv
         LEFT JOIN inventory_items inv ON inv.variant_id = pv.id
         WHERE pv.organization_id = ? AND pv.product_service_id = ? AND pv.active = 1
       `);
       return "Produtos/Serviços disponíveis (use EXATAMENTE estes nomes ao registrar um pedido):\n" + rows.map(r => {
          const price = (r.price !== null && r.price !== undefined) ? `${r.currency || 'R$'} ${Number(r.price).toFixed(2)}` : "preço sob consulta";
          const desc = r.description ? ` — ${r.description}` : "";
          const dur = r.duration_minutes ? ` [duração: ${r.duration_minutes} min]` : "";

          // Se tem variações, lista o estoque por variação (tamanho/cor/tipo).
          if (r.has_variants) {
            const vs = variantStmt.all(orgId, r.id) as any[];
            const lines = vs.map(v => {
              const vsell = Math.max(0, (v.quantity_available || 0) - (v.quantity_reserved || 0));
              const vprice = (v.price !== null && v.price !== undefined) ? ` R$ ${Number(v.price).toFixed(2)}` : '';
              return `    · ${v.name}${vprice} ${vsell > 0 ? `(estoque: ${vsell})` : '(SEM ESTOQUE)'}`;
            }).join('\n');
            return `- ${r.name} (${r.type}): ${price}${dur}${desc}\n${lines}`;
          }

          let stock = "";
          if (r.stock_control_enabled) {
             const sellable = Math.max(0, (r.quantity_available || 0) - (r.quantity_reserved || 0));
             stock = sellable > 0 ? ` (em estoque: ${sellable})` : " (SEM ESTOQUE no momento)";
          }
          return `- ${r.name} (${r.type}): ${price}${stock}${dur}${desc}`;
       }).join('\n');
     } catch (e) {
       return "";
     }
  }

  // Data/hora atual no fuso de Brasília, para a IA interpretar datas relativas.
  private static currentDateContext(): { human: string; today: string } {
    const now = new Date();
    const tz = process.env.TZ_DISPLAY || "America/Sao_Paulo";
    const human = now.toLocaleString("pt-BR", { timeZone: tz, dateStyle: "full", timeStyle: "short" });
    const today = now.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
    return { human, today };
  }

  private static buildPrompt(agent: string, params: any, contextText: string, productsText: string, metricsData: string = "", profileText: string = "", forwardText: string = "", negotiatorText: string = "", storefrontText: string = "", orderStatusText: string = "", areaPersona: string = "", agendaText: string = "", emailCaptureText: string = "", reservationText: string = "", subscriptionText: string = ""): string {
    if (agent === "orchestrator_agent") {
      const { human: nowHuman } = this.currentDateContext();
      return `Você é o Zapp, o ORQUESTRADOR de IA do negócio — um consultor de vendas e operações que conhece toda a jornada do cliente e coordena os agentes especializados (atendimento/CRM, agenda, estoque, vendas e campanhas).

QUEM ESTÁ FALANDO: um GESTOR AUTORIZADO (${params.contactName || params.senderId}). Data/hora: ${nowHuman}.

O QUE VOCÊ SABE FAZER (e deve usar para orientar o gestor):
- Ler o panorama do negócio abaixo (funil, CRM, vendas, estoque, campanhas, agenda) e traduzir em insights claros e acionáveis.
- Recomendar AÇÕES concretas: quem reativar (inativos +60 dias), qual oferta enviar aos TOP compradores, o que promover (mais vendidos), o que repor (estoque baixo), onde o funil está travando.
- Aplicar estratégia de vendas: transformar leads frios em quentes, sugerir gatilhos mentais honestos (prova social, escassez REAL, reciprocidade), aumentar ticket médio (upsell/cross-sell, combos), e melhorar a experiência.
- Identificar oportunidades: novos públicos, padrões de compra, produtos para destacar, riscos (queda de conversão, estoque parado).

COMO RESPONDER:
- Seja direto, prático e formatado para WhatsApp (frases curtas, emojis com moderação, listas quando ajudar).
- Baseie-se SOMENTE nos dados reais abaixo; se algo não estiver nos dados, diga que precisa de mais informação — não invente números.
- DISPARO DE CAMPANHA: se o gestor PEDIR para enviar/disparar uma campanha (ex.: "reative os inativos com 10% off", "manda uma oferta pros que mais compram"), preencha "campaign_intent" com a mensagem final (pronta para o cliente, use {nome} para personalizar) e o público. NÃO dispare você mesmo — o sistema vai pedir a confirmação do gestor antes de enviar.
- Se o gestor só estiver pedindo análise/sugestão (não um disparo), deixe "campaign_intent" como null.

PÚBLICOS VÁLIDOS para "segment": { "inactiveDays": N } (clientes com compra inativos há N dias), { "temperature": "quente|morno|frio" }, { "topBuyers": N } (os N que mais gastaram), { "tag": "texto" }, ou {} (todos).

PANORAMA ATUAL DO NEGÓCIO (dados reais):
${metricsData}

MENSAGEM DO GESTOR:
"${params.message}"

SUA RESPOSTA OBRIGATORIAMENTE DEVE SER JSON:
{
  "reply": "Sua análise/orientação para o gestor, formatada para WhatsApp.",
  "agent": "orchestrator_agent",
  "confidence": 0.95,
  "needs_human": false,
  "actions": [],
  "campaign_intent": null
}
// Quando for um pedido de disparo, "campaign_intent" deve ser:
// { "name": "nome curto", "message": "Olá {nome}! ...mensagem pronta...", "segment": { "inactiveDays": 60 } }`;
    }

    const { human: nowHuman, today: nowToday } = this.currentDateContext();
    const historyText = Array.isArray(params.history) && params.history.length
      ? params.history.map((h: any) => `${h.role}: ${h.text}`).join('\n')
      : "(início da conversa)";
    return `Você é o Agente de Atendimento e Vendas via WhatsApp/Instagram.
Você está NO MEIO de uma conversa contínua com o mesmo cliente.

DATA E HORA ATUAL (fuso de Brasília, UTC-3): ${nowHuman}.
HOJE é ${nowToday}. Use SEMPRE esta referência para interpretar datas relativas
("hoje", "amanhã", "depois de amanhã", dias da semana, "semana que vem"). NUNCA
invente o ano/mês — calcule a partir da data atual acima.

REGRAS OBRIGATÓRIAS:
0. CONTINUIDADE: leia o HISTÓRICO abaixo e CONTINUE de onde parou. NÃO recomece, NÃO repita saudações ("Olá!", "Como posso ajudar?") se a conversa já começou, e NÃO repita perguntas já respondidas. Se o cliente disse "sim" confirmando algo, AVANCE para o próximo passo (não pergunte de novo).
1. Use o contexto (RAG) e o catálogo quando disponíveis. Não invente preços, prazos ou promoções específicas — se não tiver um dado exato, seja honesto e diga que vai confirmar, mas SIGA ajudando.
2. Responda SEMPRE de forma útil, cordial e objetiva, mesmo sem contexto/documentos. Só marque "needs_human": true quando o cliente PEDIR explicitamente falar com um humano/atendente, ou em caso de reclamação séria. Nos demais casos, mantenha "needs_human": false e continue a conversa.
3. Não fale sobre sistemas internos ou tokens.
4. Mova o lead no kanban se notar intenção de compra ("MOVE_TICKET" para etapa "proposta").
5. Se o cliente concordar com um horário de agendamento, use "new_appointment" e gere "scheduled_start" em ISO 8601 COM o fuso -03:00, calculado a partir da DATA ATUAL acima (ex.: amanhã às 10h = ${nowToday}T10:00:00-03:00, mas ajuste o dia conforme o pedido).
6. Se confirmar o envio ou retirada de um produto físico, pode usar "new_delivery".
7. VENDAS: quando o cliente CONFIRMAR que quer comprar um ou mais itens do catálogo, registre o pedido em "new_order" com os itens (use o NOME EXATO do catálogo e a quantidade). NUNCA registre quantidade maior que o estoque disponível mostrado no catálogo. Se faltar estoque, NÃO registre o pedido: avise com honestidade e ofereça alternativa. Só preencha "new_order" quando houver confirmação clara de compra (não em perguntas/dúvidas).
8. NÃO DUPLIQUE PEDIDOS: se o HISTÓRICO mostra que o pedido já foi confirmado/registrado, NÃO preencha "new_order" de novo. Apenas dê seguimento (confirmar agendamento, tirar dúvidas, etc.).
9. INTELIGÊNCIA DE VENDA: adapte o tom ao PERFIL DO CLIENTE abaixo. Lead "frio" → desperte interesse e descubra a necessidade (sem pressão). "Morno" → mostre valor e conduza para a decisão. "Quente"/recorrente → seja ágil e ofereça um item complementar (cross-sell). Use gatilhos de forma natural e honesta (prova social, escassez REAL de estoque, benefício claro) — nunca invente urgência falsa. Para clientes que já compram, reconheça o relacionamento.
12. CONDUZA A VENDA (não seja apenas reativo): você é VENDEDOR, não um FAQ. Sempre dê o PRÓXIMO PASSO. A cada resposta, avance o cliente no funil: descobrir necessidade → apresentar a solução certa → tratar objeção → FECHAR. Não termine respostas de forma passiva ("qualquer coisa estou à disposição") quando há intenção de compra — termine com um direcionamento.
13. QUALIFICAÇÃO ATIVA: se ainda NÃO entendeu o que o cliente precisa, faça 1 pergunta curta de descoberta por vez (para que/uso, quantidade, prazo, preferência) ANTES de despejar opções. Use o que descobrir para recomendar o item certo do catálogo — não mande o catálogo inteiro.
14. FECHAMENTO PROATIVO (CTA): quando o cliente demonstrar interesse, NÃO espere ele pedir para comprar — convide ao fechamento com uma pergunta de decisão ("Quer que eu já reserve/feche pra você?", "Prefere levar 1 ou 2?", "Posso gerar o seu PIX agora?"). Só registre "new_order" após o "sim", mas SEMPRE ofereça o próximo passo.
15. OBJEÇÕES (além de preço): se o cliente hesitar, descubra o motivo com empatia e responda ao motivo real — "está caro" (mostre valor/benefício antes de qualquer desconto), "vou pensar" (pergunte o que falta decidir e ofereça ajuda), "tenho receio" (use prova social/garantia honesta), "depois" (crie um próximo passo concreto e leve, sem pressão falsa). Nunca invente urgência; use apenas escassez/benefício REAIS.
16. CROSS-SELL / UPSELL: ao confirmar um pedido, ofereça 1 complemento ou upgrade RELEVANTE do catálogo de forma natural ("quem leva X costuma levar Y, quer adicionar?"). Faça no máximo UMA sugestão e nunca empurre — respeite o "não".
17. PÓS-VENDA: depois de fechar/confirmar pagamento, agradeça, confirme o próximo passo (prazo/entrega) e, quando fizer sentido, plante a próxima interação (recompra, novidade, ou um convite gentil de indicação). Não force.
10. CANCELAMENTO: se o cliente pedir para CANCELAR o pedido, primeiro confirme com empatia ("Você confirma o cancelamento do seu pedido?"). Só quando ele CONFIRMAR o cancelamento, defina "cancel_order": true (cancela o pedido ativo e devolve o estoque). Se ele já tiver confirmado no histórico, vá direto. Se o pedido já foi entregue, explique que para devolução/reembolso você vai encaminhar para um atendente (use "needs_human": true).
11. COTAÇÃO POR LISTA: quando o cliente enviar uma LISTA de itens/quantidades para orçar (ex.: "quero 5 pães, 2 leites, 1 café" ou uma lista de mercado por texto/áudio), NÃO calcule preços você mesmo — preencha "quote_request" com os itens (nome aproximado + quantidade). O sistema vai montar a cotação real (preços, estoque, total) e anexar à sua resposta. Na sua "reply", apenas confirme com simpatia que está montando o orçamento (ex.: "Perfeito, já te mando os valores!"). Use "quote_request" para ORÇAR; use "new_order" só quando o cliente CONFIRMAR que quer fechar.

${profileText ? 'CONTEXTO DE CRM — ' + profileText : ''}
${forwardText}
${negotiatorText}
${storefrontText}
${orderStatusText}
${areaPersona}
${agendaText}
${emailCaptureText}
${reservationText}
${subscriptionText}

HISTÓRICO DA CONVERSA (do mais antigo ao mais recente):
${historyText}

DOCUMENTOS (RAG):
${contextText}

CATÁLOGO:
${productsText}

MENSAGEM ATUAL DO CLIENTE (a mais recente, responda a ela continuando o histórico):
"${params.message}"

ESTÁGIO ATUAL DO TICKET: ${params.ticketStage || 'novo_lead'}

SUA RESPOSTA OBRIGATORIAMENTE DEVE SER JSON NESTE FORMATO:
{
  "reply": "Sua resposta enviada ao cliente",
  "agent": "attendance_agent",
  "confidence": 0.85,
  "needs_human": false,
  "risk_flags": [],
  "evidence_ids": [],
  "actions": [
    {
      "type": "MOVE_TICKET",
      "payload": { "stage": "proposta" } // Use estágios: novo_lead, ia_atendendo, aguardando_humano, qualificado, proposta, aguardando_pagamento, agendado, entregue_concluido, pos_venda, perdido
    }
  ],
  "new_appointment": {
    "title": "Anotação do evento",
    "scheduled_start": "${nowToday}T10:00:00-03:00" // ISO 8601 com fuso -03:00, calculado a partir de HOJE
  },
  "new_delivery": {
    "address": "Rua X"
  },
  "new_order": {
    "items": [ { "name": "Nome EXATO do produto no catálogo", "quantity": 2 } ]
  },
  "quote_request": {
    "items": [ { "name": "nome aproximado do item da lista", "quantity": 5 } ]
  },
  "cancel_order": false,
  "send_storefront": false,
  "customer_email": "", // e-mail do cliente, SOMENTE quando ele informar um (senão deixe "")
  "route_to_area": "", // nome EXATO da área de destino, SÓ quando o cliente quiser trocar de área/profissional (senão deixe "")
  "reservation_request": null, // { resource, start, end, units, guests } SÓ quando o cliente quiser reservar um recurso por período (senão null)
  "send_subscription_pix": false // true SÓ quando o cliente pedir para pagar/receber o PIX da mensalidade em aberto
}`;
  }

  private static logInteraction(data: {
    organizationId: string;
    agentUsed: string;
    inputPrompt: string;
    outputResponse: string;
    confidence: number;
    needsHuman: number;
    actions: string;
  }) {
    try {
      db.prepare(`
        INSERT INTO ai_interactions_log (id, organization_id, agent_used, input_prompt, output_response, confidence, needs_human, actions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), data.organizationId, data.agentUsed, data.inputPrompt, data.outputResponse, data.confidence, data.needsHuman, data.actions
      );
    } catch(e) {
      console.error("Falha ao salvar log de IA:", e);
    }
  }
}
