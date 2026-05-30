import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { searchContext } from "./geminiRAG.js";
import { AnalyticsService } from "./AnalyticsService.js";
import { chat } from "./llm.js";

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
  }): Promise<{ reply: string, actions: any[], newStage?: string, needsHuman: boolean, newAppointment?: any, newDelivery?: any }> {
    
    // 1. Verificar se é um Gestor Autorizado (com casamento tolerante ao 9º dígito BR)
    const manager = this.findAuthorizedManager(params.senderId, params.organizationId);

    let isManager = !!manager;
    let text = params.message.trim();
    let isOrchestratorCommand = false;

    // Só ativa o Orquestrador (modo admin) se for um GESTOR autorizado e a mensagem
    // começar com "Zapp". Se NÃO for gestor mas usar "Zapp", NÃO revelamos a
    // existência do canal admin (anti-recon): a mensagem é tratada como um cliente
    // comum pelo agente de atendimento.
    if (isManager && text.toLowerCase().startsWith("zapp")) {
      isOrchestratorCommand = true;
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

    // 2. Coletar RAG / Knowledge Base e Produtos
    const contextContent = await searchContext(text, params.organizationId, params.channelId, 3);
    const contextText = contextContent.length > 0 ? contextContent.join('\n\n') : "Nenhum documento encontrado na base de RAG.";
    
    const productsText = await this.getProductsContext(params.organizationId);
    let metricsData = "";

    if (isOrchestratorCommand) {
      try {
        const metrics = AnalyticsService.getMetrics(params.organizationId, { period: "month" });
        metricsData = JSON.stringify(metrics, null, 2);
      } catch (e) {
        metricsData = "Não foi possível carregar as métricas no momento.";
      }
    }

    const prompt = this.buildPrompt(agentToUse, params, contextText, productsText, metricsData);

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
      return {
        reply: resultJSON.reply || "Não foi possível gerar a resposta.",
        actions: [],
        newStage: params.ticketStage, // mantém o estágio atual (sem alteração)
        needsHuman: false,
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

    return {
      reply: resultJSON.reply || "Erro interno.",
      actions: safeActions,
      newStage: newStage,
      needsHuman: !!resultJSON.needs_human,
      newAppointment: this.sanitizeAppointment(resultJSON.new_appointment),
      newDelivery: this.sanitizeDelivery(resultJSON.new_delivery),
    };
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

  private static async getProductsContext(orgId: string): Promise<string> {
     try {
       const rows: any[] = db.prepare(`
         SELECT ps.*, inv.quantity_available
         FROM products_services ps
         LEFT JOIN inventory_items inv ON inv.product_service_id = ps.id
         WHERE ps.organization_id = ? AND ps.active = 1
       `).all(orgId);
       if (!rows.length) return "";
       return "Produtos/Serviços disponíveis:\n" + rows.map(r => {
          const price = (r.price !== null && r.price !== undefined) ? `${r.currency || 'R$'} ${Number(r.price).toFixed(2)}` : "preço sob consulta";
          const desc = r.description ? ` — ${r.description}` : "";
          let stock = "";
          if (r.stock_control_enabled) {
             stock = (r.quantity_available && r.quantity_available > 0) ? ` (em estoque: ${r.quantity_available})` : " (sem estoque no momento)";
          }
          const dur = r.duration_minutes ? ` [duração: ${r.duration_minutes} min]` : "";
          return `- ${r.name} (${r.type}): ${price}${stock}${dur}${desc}`;
       }).join('\n');
     } catch (e) {
       return "";
     }
  }

  private static buildPrompt(agent: string, params: any, contextText: string, productsText: string, metricsData: string = ""): string {
    if (agent === "orchestrator_agent") {
      return `Você é o Zapp, o Agente Orquestrador / Analista de Dados da empresa.
O usuário enviando esta mensagem é um GESTOR AUTORIZADO (${params.contactName || params.senderId}).
Responda ao pedido dele. Você pode fornecer resumos, relatórios gerenciais, explicar métricas, apontar anomalias e sugerir ações de melhoria com base nos DADOS REAIS abaixo:

MÉTRICAS ATUAIS (Últimos 30 dias):
${metricsData}

MENSAGEM DO GESTOR:
"${params.message}"

SUA RESPOSTA OBRIGATORIAMENTE DEVE SER JSON:
{
  "reply": "Sua resposta com a análise para o gestor. Formate o texto de forma agradável para WhatsApp.",
  "agent": "orchestrator_agent",
  "confidence": 0.99,
  "needs_human": false,
  "actions": []
}`;
    }

    return `Você é o Agente de Atendimento e Vendas via WhatsApp/Instagram.
O cliente enviou a mensagem abaixo.

REGRAS OBRIGATÓRIAS:
1. Use o contexto (RAG) e o catálogo quando disponíveis. Não invente preços, prazos ou promoções específicas — se não tiver um dado exato, seja honesto e diga que vai confirmar, mas SIGA ajudando.
2. Responda SEMPRE de forma útil, cordial e objetiva, mesmo sem contexto/documentos. Só marque "needs_human": true quando o cliente PEDIR explicitamente falar com um humano/atendente, ou em caso de reclamação séria. Nos demais casos, mantenha "needs_human": false e continue a conversa.
3. Não fale sobre sistemas internos ou tokens.
4. Mova o lead no kanban se notar intenção de compra ("MOVE_TICKET" para etapa "proposta").
5. Se o cliente concordar com um horário de agendamento de serviço, pode usar "new_appointment".
6. Se confirmar o envio ou retirada de um produto físico, pode usar "new_delivery".

DOCUMENTOS (RAG):
${contextText}

CATÁLOGO:
${productsText}

MENSAGEM DO CLIENTE:
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
      "payload": { "stage": "proposta" } // Use estágios: novo_lead, ia_atendendo, aguardando_humano, qualificado, proposta, aguardando_pagamento, agendado, entregue_concluido
    }
  ],
  "new_appointment": {
    "title": "Anotação do evento",
    "scheduled_start": "2024-12-01T10:00:00Z"
  },
  "new_delivery": {
    "address": "Rua X"
  }
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
