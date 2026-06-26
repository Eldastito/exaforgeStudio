import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { ModuleService } from "./ModuleService.js";
import { CadenceService } from "./CadenceService.js";
import { processDocument } from "./geminiRAG.js";

/**
 * Quick-Start por vertical: aplica um pacote pronto (áreas + personas + cadências
 * + automações + FAQ inicial no RAG) em segundos, transformando "configura por
 * uma semana" em "abre, escolhe a vertical e sai vendendo".
 *
 * Idempotente: pode rodar de novo; cria só o que ainda não existe (compara por
 * nome). NÃO altera dados do cliente.
 */

type AreaSeed = { name: string; description: string; persona: string };
type CadenceSeed = {
  name: string;
  triggerStage: string;
  minLeadScore?: number;
  steps: { delayHours: number; message: string }[];
};
type Automations = {
  // Recuperação
  order_expiry_enabled?: number; order_expiry_hours?: number;
  pix_reminder_enabled?: number; pix_reminder_max?: number; pix_reminder_minutes?: number;
  abandoned_cart_enabled?: number; abandoned_cart_hours?: number;
  nps_enabled?: number; nps_delay_hours?: number;
  referral_enabled?: number; referral_reward_percent?: number; referral_welcome_percent?: number;
  // Supply
  procurement_enabled?: number; procurement_target_days?: number;
  // Reservas
  reservation_deposit_percent?: number;
  // Orçamentos
  quote_validity_hours?: number; quote_followup_hours?: number; quote_followup_max?: number;
};

type Pack = {
  vertical: string;
  label: string;
  areas: AreaSeed[];
  cadences: CadenceSeed[];
  automations: Automations;
  faq: { title: string; content: string }[];
};

const PACKS: Pack[] = [
  // ===========================================================================
  // HOTELARIA
  // ===========================================================================
  {
    vertical: "hospitalidade",
    label: "Hotelaria",
    areas: [
      {
        name: "Reservas",
        description: "Captura e qualifica pedidos de hospedagem (datas, hóspedes, perfil).",
        persona: "Você é a recepção do hotel. Receba o cliente com calor. Antes de fechar uma reserva, pergunte: datas (check-in/check-out), nº de adultos e crianças, se leva pet, qual ocasião. Confirme preço e condições somente com base no que está no catálogo/base de conhecimento — NUNCA invente diária ou política. Quando o cliente confirmar interesse, ofereça gerar a reserva.",
      },
      {
        name: "Eventos & Grupos",
        description: "Atende consultas consultivas: casamentos, convenções, day use, corporativo.",
        persona: "Você é o time comercial de eventos. Receba o cliente com cuidado consultivo. Pergunte tipo do evento, data desejada, nº de convidados, se quer salões/serviços específicos e expectativa de orçamento. Não prometa valores específicos sem confirmar com humano. Quando capturar os principais campos, sinalize o pedido como uma consulta de evento.",
      },
      {
        name: "Concierge",
        description: "Atende dúvidas do hóspede antes/durante a estadia (check-in, transfer, café, pet, piscina).",
        persona: "Você é o concierge do hotel. Responda dúvidas de hóspede com simpatia e objetividade. SÓ responda com base no que está documentado (políticas, horários, regras). Quando não souber, seja honesto e diga que vai confirmar. Nunca invente regra de pet, horário de check-in, condições de cancelamento ou serviços inclusos.",
      },
    ],
    cadences: [
      {
        name: "Recuperação de orçamento (24h sem resposta)",
        triggerStage: "proposta",
        steps: [
          { delayHours: 24, message: "Oi {nome}! Conseguiu olhar o orçamento que te mandei? Posso ajudar com alguma dúvida? 😊" },
          { delayHours: 48, message: "Oi {nome}! Só passando pra reforçar que estou por aqui. Se quiser ajustar algo do orçamento, é só me dizer." },
        ],
      },
      {
        name: "Aguardando pagamento (sinal da reserva)",
        triggerStage: "aguardando_pagamento",
        steps: [
          { delayHours: 4, message: "Oi {nome}! Tudo bem? Vi que sua reserva está aguardando o pagamento do sinal. Posso te ajudar com alguma dúvida?" },
          { delayHours: 20, message: "Oi {nome}! Pra confirmar sua estadia, só falta o sinal. Quer que eu te reenvie o PIX?" },
        ],
      },
      {
        name: "Pós-estadia (24h depois)",
        triggerStage: "pos_venda",
        steps: [
          { delayHours: 24, message: "Oi {nome}! Foi um prazer receber você. Como foi sua estadia? 🌟" },
        ],
      },
    ],
    automations: {
      order_expiry_enabled: 1, order_expiry_hours: 72,
      pix_reminder_enabled: 1, pix_reminder_max: 3, pix_reminder_minutes: 60,
      abandoned_cart_enabled: 1, abandoned_cart_hours: 6,
      nps_enabled: 1, nps_delay_hours: 24,
      referral_enabled: 1, referral_reward_percent: 10, referral_welcome_percent: 10,
      procurement_enabled: 1, procurement_target_days: 14,
      reservation_deposit_percent: 30,
      quote_validity_hours: 72, quote_followup_hours: 24, quote_followup_max: 2,
    },
    faq: [
      {
        title: "FAQ Hotelaria — base inicial",
        content: `# Perguntas comuns do hóspede

## Check-in / Check-out
- Os horários padrão são: check-in a partir das 14h, check-out até as 12h.
- Para early check-in ou late check-out, deve-se consultar disponibilidade no dia.

## Crianças
- O hotel é family-friendly. Crianças até X anos não pagam quando dividem o quarto com os pais (sob política específica do hotel).

## Pet
- A política de pet é específica do hotel. Confirmar antes de prometer.

## Café da manhã
- Café da manhã incluso por padrão? Depende do plano contratado. Confirmar antes de afirmar.

## Estacionamento
- Confirmar política do hotel (cortesia? pago? coberto?).

## Cancelamento
- A política de cancelamento depende da data e da tarifa. Sempre confirmar.

## ⚠️ IMPORTANTE para a IA
Este FAQ é uma BASE INICIAL. SUBSTITUA cada resposta pelas informações REAIS do hotel.
Enquanto não substituir, responda com honestidade ("vou confirmar com o time").
`,
      },
    ],
  },

  // ===========================================================================
  // COMÉRCIO / VAREJO
  // ===========================================================================
  {
    vertical: "varejo",
    label: "Comércio / Varejo",
    areas: [
      {
        name: "Vendas",
        description: "Atendimento comercial: catálogo, preço, fechamento de pedido.",
        persona: "Você é vendedor da loja. Conduza com naturalidade até o fechamento: descubra a necessidade, recomende o item certo do catálogo, contorne objeções com empatia e ofereça o próximo passo. Nunca invente preço/estoque. Sugira 1 complemento relevante ao confirmar o pedido (cross-sell).",
      },
      {
        name: "Suporte / SAC",
        description: "Pedidos, rastreio, troca, devolução.",
        persona: "Você é o suporte da loja. Receba o cliente com paciência. Confirme o pedido com base nos dados reais. Para dúvida de rastreio/entrega, consulte o status. Para troca/devolução, peça os dados e encaminhe para o time quando necessário.",
      },
    ],
    cadences: [
      {
        name: "Recuperação de pedido pendente",
        triggerStage: "aguardando_pagamento",
        steps: [
          { delayHours: 2, message: "Oi {nome}! Vi que seu pedido está aguardando o pagamento. Posso te ajudar com alguma dúvida?" },
          { delayHours: 22, message: "Oi {nome}! Pra liberar seu pedido, só falta o pagamento. Quer que eu te reenvie o PIX?" },
        ],
      },
      {
        name: "Pós-venda (agradecimento + indicação)",
        triggerStage: "pos_venda",
        steps: [
          { delayHours: 48, message: "Oi {nome}! Tudo certo com seu pedido? 🙏 Se gostou, ficamos felizes! Conhece alguém que também precisa? Te conto sobre nosso programa de indicação." },
        ],
      },
    ],
    automations: {
      order_expiry_enabled: 1, order_expiry_hours: 24,
      pix_reminder_enabled: 1, pix_reminder_max: 3, pix_reminder_minutes: 60,
      abandoned_cart_enabled: 1, abandoned_cart_hours: 4,
      nps_enabled: 1, nps_delay_hours: 48,
      referral_enabled: 1, referral_reward_percent: 10, referral_welcome_percent: 10,
      procurement_enabled: 0,
      quote_validity_hours: 48, quote_followup_hours: 12, quote_followup_max: 2,
    },
    faq: [
      {
        title: "FAQ Comércio — base inicial",
        content: `# Perguntas comuns do cliente

## Formas de pagamento
- Aceitamos PIX (instantâneo), cartão de crédito/débito e dinheiro na retirada.
- Parcelamento e cartão: confirmar com a loja.

## Entrega
- Prazo médio: especificar pela loja.
- Frete: gratuito acima de R$ X? Definir.

## Trocas e devoluções
- Prazo legal: 7 dias para arrependimento (compras à distância).
- Produto com defeito: trocar dentro de 30 dias (não-durável) ou 90 dias (durável).

## ⚠️ Substitua estas respostas pelas regras REAIS da sua loja.
`,
      },
    ],
  },

  // ===========================================================================
  // SAÚDE / CLÍNICA
  // ===========================================================================
  {
    vertical: "saude",
    label: "Saúde / Clínica",
    areas: [
      {
        name: "Recepção",
        description: "Agendamento, remarcação, cancelamento, dúvidas de horário e preparo.",
        persona: "Você é a recepção da clínica. Trate o paciente com acolhimento. Para agendar, peça nome completo, telefone, procedimento desejado e preferência de horário. Confirme disponibilidade somente com base na agenda real. Para preparo de exame, responda APENAS o que está documentado — exames sem instrução documentada vão para confirmação humana.",
      },
      {
        name: "Pós-consulta",
        description: "Lembrete de retorno, satisfação, fidelização.",
        persona: "Você é o time de relacionamento da clínica. Após a consulta/procedimento, confirme se o paciente está bem, ofereça ajuda em qualquer dúvida e, quando apropriado, lembre do retorno.",
      },
    ],
    cadences: [
      {
        name: "Confirmação de consulta",
        triggerStage: "agendado",
        steps: [
          { delayHours: 24, message: "Oi {nome}! Passando pra confirmar seu agendamento. Responda SIM para confirmar ou se precisar remarcar, é só me dizer." },
        ],
      },
      {
        name: "Pós-atendimento",
        triggerStage: "entregue_concluido",
        steps: [
          { delayHours: 24, message: "Oi {nome}! Como foi seu atendimento hoje? Estamos aqui para qualquer dúvida. 💙" },
        ],
      },
    ],
    automations: {
      order_expiry_enabled: 0,
      pix_reminder_enabled: 1, pix_reminder_max: 2, pix_reminder_minutes: 60,
      abandoned_cart_enabled: 1, abandoned_cart_hours: 6,
      nps_enabled: 1, nps_delay_hours: 24,
      referral_enabled: 1, referral_reward_percent: 10, referral_welcome_percent: 10,
      procurement_enabled: 0,
      quote_validity_hours: 168, quote_followup_hours: 48, quote_followup_max: 2,
    },
    faq: [
      {
        title: "FAQ Saúde — base inicial",
        content: `# Perguntas comuns do paciente

## Convênios atendidos
- Listar os convênios aceitos pela clínica.

## Particulares
- Indicar tabela de valores básica.

## Preparo de exames
- Cada exame tem um preparo específico — NÃO inventar. Quando o cliente perguntar, responder apenas se houver instrução documentada.

## Cancelamento / Remarcação
- Prazo: confirmar com X horas de antecedência.

## ⚠️ Saúde é dado SENSÍVEL.
A IA NUNCA dá diagnóstico, conduta clínica ou interpreta exame. Quando perguntada,
sugere consulta com o profissional.
`,
      },
    ],
  },
];

export class OnboardingTemplateService {
  /** Lista os packs disponíveis (para a UI). */
  static availablePacks() {
    return PACKS.map(p => ({
      vertical: p.vertical,
      label: p.label,
      summary: {
        areas: p.areas.length,
        cadences: p.cadences.length,
        automations: Object.keys(p.automations).filter(k => (p.automations as any)[k] === 1).length,
        faq: p.faq.length,
      },
    }));
  }

  /**
   * Aplica o pack na organização. Idempotente: itens que já existem (mesmo nome)
   * não são duplicados. Retorna um relatório do que foi criado.
   */
  static async applyPack(orgId: string, vertical: string, opts: { skipFaq?: boolean } = {}): Promise<{
    areas: { created: number; skipped: number };
    cadences: { created: number; skipped: number };
    automations: { applied: number };
    faq: { created: number; skipped: number };
  }> {
    const pack = PACKS.find(p => p.vertical === vertical);
    if (!pack) throw new Error(`Vertical "${vertical}" não tem pack quick-start.`);

    const report = {
      areas: { created: 0, skipped: 0 },
      cadences: { created: 0, skipped: 0 },
      automations: { applied: 0 },
      faq: { created: 0, skipped: 0 },
    };

    // 1) ÁREAS (idempotente por nome).
    const insArea = db.prepare(`INSERT INTO service_areas (id, organization_id, name, description, persona, position, active) VALUES (?, ?, ?, ?, ?, ?, 1)`);
    pack.areas.forEach((a, i) => {
      const exists = db.prepare(`SELECT 1 FROM service_areas WHERE organization_id = ? AND lower(name) = lower(?)`).get(orgId, a.name);
      if (exists) { report.areas.skipped++; return; }
      try { insArea.run(uuidv4(), orgId, a.name, a.description, a.persona, i + 1); report.areas.created++; }
      catch (e) { console.error('[QuickStart] Falha ao criar área', a.name, e); }
    });

    // 2) CADÊNCIAS (idempotente por nome).
    for (const c of pack.cadences) {
      const exists = db.prepare(`SELECT 1 FROM cadences WHERE organization_id = ? AND lower(name) = lower(?)`).get(orgId, c.name);
      if (exists) { report.cadences.skipped++; continue; }
      try {
        CadenceService.create(orgId, c);
        report.cadences.created++;
      } catch (e) { console.error('[QuickStart] Falha ao criar cadência', c.name, e); }
    }

    // 3) AUTOMAÇÕES (sobrescreve as configs — é a opinião do pack).
    const entries = Object.entries(pack.automations).filter(([_, v]) => v != null);
    if (entries.length) {
      try {
        const cols = entries.map(([k]) => `${k} = ?`).join(', ');
        const vals = entries.map(([_, v]) => v);
        db.prepare(`UPDATE organization_settings SET ${cols} WHERE organization_id = ?`).run(...vals, orgId);
        report.automations.applied = entries.length;
      } catch (e) { console.error('[QuickStart] Falha ao aplicar automações', e); }
    }

    // 4) FAQ (idempotente por título; opcional). Reusa o pipeline do RAG real,
    // que faz chunking + embeddings.
    if (!opts.skipFaq) {
      for (const d of pack.faq) {
        const exists = db.prepare(`SELECT 1 FROM knowledge_documents WHERE organization_id = ? AND title = ?`).get(orgId, d.title);
        if (exists) { report.faq.skipped++; continue; }
        try {
          await processDocument(Buffer.from(d.content, 'utf-8'), d.title, orgId, 'global', null);
          report.faq.created++;
        } catch (e) { console.error('[QuickStart] Falha ao indexar FAQ', d.title, e); }
      }
    }

    // 5) Garante que os módulos do vertical estão habilitados (sem mexer se a
    // org já refinou manualmente).
    try { ModuleService.applyVertical(orgId, pack.vertical); } catch (e) { /* noop */ }

    return report;
  }
}
