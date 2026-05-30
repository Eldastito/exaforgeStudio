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

    // Se é gestor e começa com Zapp, ativa o orchestrator
    if (isManager && text.toLowerCase().startsWith("zapp")) {
      isOrchestratorCommand = true;
    } else if (!isManager && text.toLowerCase().startsWith("zapp")) {
      // Bloqueio de acesso para quem não é gestor
      return {
        reply: "Desculpe, este é um canal de comandos administrativos e seu número não está autorizado.",
        actions: [],
        needsHuman: false
      };
    }

    let agentToUse = isOrchestratorCommand ? "orchestrator_agent" : "attendance_agent";
    
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

    let newStage = params.ticketStage;
    if (resultJSON.actions && Array.isArray(resultJSON.actions)) {
       const moveAction = resultJSON.actions.find((a: any) => a.type === "MOVE_TICKET");
       if (moveAction && moveAction.payload && moveAction.payload.stage) {
          newStage = moveAction.payload.stage;
       }
    }

    return {
      reply: resultJSON.reply || "Erro interno.",
      actions: resultJSON.actions || [],
      newStage: newStage,
      needsHuman: !!resultJSON.needs_human,
      newAppointment: resultJSON.new_appointment,
      newDelivery: resultJSON.new_delivery
    };
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
