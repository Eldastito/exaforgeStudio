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
    
    // 1. Verificar se é um Gestor Autorizado
    const manager = db.prepare('SELECT * FROM authorized_managers WHERE identifier = ? AND organization_id = ?')
      .get(params.senderId, params.organizationId) as any;

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
    const contextContent = await searchContext(text, params.channelId, 3);
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

  private static async getProductsContext(orgId: string): Promise<string> {
     try {
       const rows: any[] = db.prepare('SELECT * FROM products_services WHERE organization_id = ? AND active = 1').all(orgId);
       if (!rows.length) return "";
       return "Produtos/Serviços disponíveis:\n" + rows.map(r => `- ${r.name} (${r.type}): R$ ${r.price}`).join('\n');
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
1. Baseie-se APENAS no contexto RAG e nos Produtos Fornecidos. Não invente preços, prazos ou promoções.
2. Se a informação não estiver no contexto, marque "needs_human": true e responda que irá transferir para um especialista.
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
