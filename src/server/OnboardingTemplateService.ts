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

// requiresModule: item do pack que só é semeado se o módulo opcional estiver
// habilitado para a org (ADR-084 D2 — ex.: áreas de Retail Network Ops só
// entram quando o add-on `retail` está ligado, nunca para todo varejo).
type AreaSeed = { name: string; description: string; persona: string; requiresModule?: string };
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
  // Clínica (ADR-080, Fase A)
  clinic_overrun_alert_enabled?: number; clinic_overrun_warning_minutes?: number;
  clinic_authorization_enabled?: number; clinic_authorization_followup_hours?: number;
  clinic_print_agenda_enabled?: number; clinic_professional_portal_enabled?: number;
  // Retail Ops (ADR-083) — fechamento diário, malote, cotas, premiação.
  retail_daily_closing_enabled?: number; retail_daily_closing_due_hour?: number; retail_daily_closing_retry_minutes?: number;
  retail_malote_enabled?: number; retail_scale_reminder_enabled?: number; retail_quota_enabled?: number;
  retail_stock_negative_alert_enabled?: number; retail_commission_enabled?: number; retail_monthly_close_enabled?: number;
  // Beleza & Salões (ADR-169) — liga a Beauty AI (Simulador de Cabelo, F5/F20) e
  // os detectores de autopilot em SHADOW que só PUBLICAM sinais na atenção
  // (nunca enviam mensagem sozinhos): manutenção vencida (F12) e simulação
  // abandonada (F11). O pack é "a opinião do produto" — um salão que aplica o
  // Quick-Start de beleza claramente quer a Beauty AI ligada e a operação
  // proativa; tudo reversível em Configurações › Módulos.
  beauty_hair_simulator_enabled?: number;
  beauty_maintenance_detector_enabled?: number;
  beauty_abandoned_detector_enabled?: number;
};

type Pack = {
  vertical: string;
  label: string;
  areas: AreaSeed[];
  cadences: CadenceSeed[];
  automations: Automations;
  faq: { title: string; content: string; requiresModule?: string }[];
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
      // Retail Ops / Retail Network Ops (ADR-083/084) — áreas de OPERAÇÃO DE REDE.
      // Só semeadas quando o add-on `retail` está habilitado (ADR-084 D2): uma
      // loja de varejo comum não recebe as personas de fechamento/malote/etc.
      {
        name: "Fechamento de Loja",
        description: "Recebe e valida o fechamento diário enviado pela equipe.",
        persona: "Você é o assistente de fechamento de loja. Sua função é receber o fechamento diário enviado pela equipe, validar se os campos obrigatórios foram preenchidos, extrair valores de texto, foto ou documento, calcular total vendido, comparar com a cota do dia, apontar desvio e registrar divergências. Nunca invente valores. Se não conseguir ler algum campo, peça reenvio ou revisão humana.",
        requiresModule: "retail",
      },
      {
        name: "Malote e Escalas",
        description: "Cobra o envio de folha de malote, fechamento e escalas no prazo.",
        persona: "Você é o assistente operacional de malote e escalas. Sua função é cobrar o envio da folha de malote, fechamento e escalas no prazo combinado. Se a loja não enviar, cobre novamente com educação e registre atraso. Quando receber, confirme recebimento e marque a tarefa como concluída.",
        requiresModule: "retail",
      },
      {
        name: "Auditoria de Estoque",
        description: "Identifica estoque negativo, divergências e produtos sem giro.",
        persona: "Você é o auditor de estoque da operação. Sua função é identificar produtos com estoque negativo, divergências entre venda e estoque, produtos sem movimentação, produtos mais vendidos e possíveis erros de lançamento. Sempre explique a divergência com base nos dados disponíveis.",
        requiresModule: "retail",
      },
      {
        name: "Premiação e Comissão",
        description: "Calcula prévia de premiação/comissão; nunca paga sem aprovação.",
        persona: "Você é o assistente de premiação. Sua função é calcular premiação e comissão com base nas regras cadastradas, fechamento das lojas e metas do período. Nunca altere pagamento automaticamente; gere prévia, destaque divergências e peça aprovação do gestor.",
        requiresModule: "retail",
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
      // ADR-084 D2: as automações `retail_*` (fechamento/malote/escala/cotas/
      // premiação) NÃO são mais ligadas pelo pack base de varejo — Retail Network
      // Ops é opt-in. Ficam no default off e são ativadas na configuração do
      // Retail Ops (ou preservadas em quem já usava, como a TOULON).
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
      {
        title: "FAQ Operacional — Retail Ops",
        requiresModule: "retail",
        content: `# Operação diária das lojas (Retail Ops)

## Fechamento diário
- Cada loja envia o fechamento do dia por aqui: pode ser **foto/PDF** da folha ou os valores em texto.
- Informe, no mínimo: dinheiro, pix, crédito, débito e total.
- A IA lê e mostra os valores para **conferência**; confirme ou corrija antes de encerrar.

## Cota e desvio
- Cada loja tem uma **cota diária**. Ao fechar, o sistema compara realizado × cota e mostra o desvio.

## Malote e escalas
- Nos dias combinados, envie a **folha de malote** e a **escala** por aqui.
- Se não enviar até o horário, o sistema **cobra automaticamente** e, persistindo, avisa o gestor.

## Divergência com o sistema
- Quando houver a planilha/export do sistema, o fechamento informado é comparado com o do sistema; diferenças viram **divergência** para revisão.

## ⚠️ Ajuste horários, cotas e responsáveis pelas lojas em Configurações › Retail Ops.
`,
      },
    ],
  },

  // ===========================================================================
  // PRESTADORES DE SERVIÇO
  // ===========================================================================
  {
    vertical: "servicos",
    label: "Prestadores de Serviço",
    areas: [
      {
        name: "Orçamentos",
        description: "Entende o serviço pedido e monta o orçamento (mão de obra + material).",
        persona: "Você atende quem procura um serviço (oficina, técnico, chaveiro, autônomo). Acolha e entenda o problema: o que precisa, onde é (no local do cliente ou na oficina), há quanto tempo, e a urgência. Monte o orçamento SOMENTE com base na tabela de preços/serviços e no valor da hora cadastrados — NUNCA invente preço, prazo ou taxa de deslocamento. Se faltar dado para orçar (ex.: precisa ver a peça), diga que é preciso uma visita/avaliação e ofereça agendar. Ao confirmar, ofereça gerar o orçamento formal.",
      },
      {
        name: "Agendamento",
        description: "Marca a visita ou o atendimento com base na agenda real.",
        persona: "Você cuida da agenda do prestador. Para marcar, pergunte endereço (se for no local do cliente), a janela de horário preferida e confirme o serviço a ser feito. Confirme disponibilidade APENAS com base na agenda real — nunca prometa um horário que não existe. Se o profissional é móvel, considere o deslocamento entre atendimentos. Ao fechar, confirme data, hora e endereço com o cliente.",
      },
      {
        name: "Ordem de Serviço / Suporte",
        description: "Status do serviço, garantia e dúvidas sobre a OS.",
        persona: "Você é o suporte do prestador. Responda sobre o andamento da ordem de serviço, prazo e garantia SOMENTE com base no que está registrado e documentado. Para garantia, informe o prazo cadastrado e o que cobre; não prometa cobertura fora do documentado. Quando não souber, seja honesto e encaminhe para o profissional.",
      },
      {
        name: "Pós-serviço / Retorno",
        description: "Confirma satisfação, lembra de garantia/manutenção e pede indicação.",
        persona: "Você é o relacionamento do prestador. Depois do serviço, confirme se ficou tudo certo, relembre o prazo de garantia e, quando fizer sentido, lembre da próxima manutenção. Peça uma avaliação e ofereça o programa de indicação. Não dê orientação técnica além do documentado.",
      },
    ],
    cadences: [
      {
        name: "Recuperação de orçamento (sem resposta)",
        triggerStage: "proposta",
        steps: [
          { delayHours: 24, message: "Oi {nome}! Conseguiu ver o orçamento que te mandei? Qualquer dúvida sobre o serviço, é só falar. 😊" },
          { delayHours: 48, message: "Oi {nome}! Ainda dá pra encaixar seu serviço na agenda. Quer que eu ajuste algo no orçamento ou já agendamos?" },
        ],
      },
      {
        name: "Confirmação de atendimento agendado",
        triggerStage: "agendado",
        steps: [
          { delayHours: 24, message: "Oi {nome}! Passando pra confirmar seu atendimento em {quando}. Responda SIM pra confirmar ou REMARCAR se precisar. 🔧" },
        ],
      },
      {
        name: "Pós-serviço (garantia + indicação)",
        triggerStage: "pos_venda",
        steps: [
          { delayHours: 48, message: "Oi {nome}! O serviço ficou como esperava? 🙏 Lembrando que você tem garantia. Se conhece alguém precisando, te conto do nosso programa de indicação." },
        ],
      },
    ],
    automations: {
      // Serviço é orientado a ORÇAMENTO/agenda, não a carrinho — sem expiração de
      // pedido nem carrinho abandonado; o follow-up vive nas cadências e no quote.
      order_expiry_enabled: 0,
      pix_reminder_enabled: 1, pix_reminder_max: 2, pix_reminder_minutes: 60,
      abandoned_cart_enabled: 0,
      nps_enabled: 1, nps_delay_hours: 24,
      referral_enabled: 1, referral_reward_percent: 10, referral_welcome_percent: 10,
      procurement_enabled: 0,
      quote_validity_hours: 168, quote_followup_hours: 24, quote_followup_max: 2,
    },
    faq: [
      {
        title: "FAQ Prestadores de Serviço — base inicial",
        content: `# Perguntas comuns do cliente

## Como funciona o orçamento
- O orçamento é feito com base no serviço pedido. Alguns casos precisam de uma visita/avaliação antes de fechar o valor.
- O orçamento tem validade (preencher o prazo real).

## Taxa de visita / deslocamento
- Há taxa de deslocamento? Quanto? A partir de qual região? (preencher com o real).
- Em muitos casos a taxa é abatida se o serviço for fechado.

## Formas de pagamento
- Aceitamos PIX, cartão e dinheiro. Sinal para agendar? (definir).

## Prazo
- O prazo depende do serviço e da agenda. Confirmamos ao agendar — não prometemos prazo sem confirmar.

## Garantia
- Os serviços têm garantia de X dias (preencher). Descrever o que a garantia cobre e o que não cobre.

## Atendimento no local
- Atendemos no endereço do cliente? Em qual raio/região? (preencher).

## Cancelamento e remarcação
- Avisar com X horas de antecedência (preencher).

## ⚠️ Substitua estas respostas pelas regras REAIS do seu negócio.
Enquanto não substituir, a IA responde com honestidade ("vou confirmar") em vez de inventar preço, prazo ou taxa.
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
    // Pack Saúde 2.0 (ADR-080, Fase A): setup operacional de clínica. As áreas,
    // cadências e FAQ preparam recepção, convênios, retorno e financeiro; as
    // flags clinic_* ligam a Agenda Clínica/portal/autorização (fases C–E).
    areas: [
      {
        name: "Recepção Clínica",
        description: "Agendamento, remarcação, cancelamento, coleta de dados do paciente e confirmação de preparo documentado.",
        persona: "Você é a recepção da clínica. Trate o paciente com acolhimento. Para agendar, peça nome completo, telefone, procedimento desejado e preferência de horário. Confirme disponibilidade somente com base na agenda real. Para preparo de exame, responda APENAS o que está documentado — exames sem instrução documentada vão para confirmação humana. Você NUNCA dá diagnóstico, conduta clínica ou interpreta exame.",
      },
      {
        name: "Convênios e Autorizações",
        description: "Verificar convênio/plano, conferir carteirinha, solicitar documentos, montar pedido de autorização, acompanhar protocolo e avisar pendências.",
        persona: "Você cuida de convênios e autorizações da clínica. Responda sobre convênio APENAS com base no cadastro da clínica e no status real da autorização. Você pode coletar dados, explicar quais documentos são necessários, apontar pendências e informar que a solicitação está em análise. Você NUNCA promete cobertura ou autorização, NUNCA diz que o plano cobre sem confirmação, NUNCA inventa código TUSS e NUNCA envia uma solicitação sem revisão humana. Quando faltar informação, encaminhe para a recepção.",
      },
      {
        name: "Pós-consulta / Retorno",
        description: "Satisfação, retorno, orientação administrativa, pedido de avaliação e reagendamento.",
        persona: "Você é o time de relacionamento da clínica. Após a consulta/procedimento, confirme se o paciente está bem, ofereça ajuda em dúvidas administrativas e, quando apropriado, lembre do retorno/continuidade. Você não dá conduta clínica; dúvidas de saúde vão para o profissional.",
      },
      {
        name: "Financeiro / Particular",
        description: "Valores particulares, PIX, sinal, pacote de sessões, mensalidade e pendência de pagamento.",
        persona: "Você cuida do financeiro da clínica para atendimentos particulares. Informe valores, formas de pagamento (PIX/sinal/pacote/mensalidade) e pendências APENAS com base no que está cadastrado — nunca invente preço. Para convênio, encaminhe para a área de Convênios e Autorizações.",
      },
      {
        name: "Coordenação de Agenda",
        description: "Organiza pacientes, profissionais, salas, horários, permanência e atrasos.",
        persona: "Você é a coordenação de agenda da clínica. Sua função é organizar pacientes, profissionais, salas, horários, permanência e atrasos. NUNCA apague paciente por tempo excedido. Quando um atendimento estiver próximo do fim previsto ou o exceder, alerte a recepção e pergunte se o paciente continuará, será finalizado ou remarcado. Ao agendar, sempre vincule paciente, profissional, procedimento, plano/convênio, sala quando houver, início e fim previsto.",
      },
    ],
    cadences: [
      {
        name: "Confirmação de consulta",
        triggerStage: "agendado",
        steps: [
          { delayHours: 24, message: "Oi {nome}! Passando para confirmar seu agendamento em {quando}. Responda SIM para confirmar ou REMARCAR se precisar alterar. 💙" },
        ],
      },
      {
        name: "Documentos pendentes",
        triggerStage: "documentacao_pendente",
        steps: [
          { delayHours: 2, message: "Oi {nome}! Para avançarmos com seu atendimento, ainda precisamos de: {pendencias}. Pode nos enviar por aqui?" },
        ],
      },
      {
        name: "Autorização pendente",
        triggerStage: "autorizacao_pendente",
        steps: [
          { delayHours: 24, message: "Oi {nome}! Sua solicitação ao convênio está em análise. Assim que houver retorno, avisamos por aqui." },
        ],
      },
      {
        name: "Autorização aprovada",
        triggerStage: "autorizacao_aprovada",
        steps: [
          { delayHours: 1, message: "Oi {nome}! Sua autorização foi liberada. Podemos confirmar o procedimento para {quando}?" },
        ],
      },
      {
        name: "Autorização negada / pendência do plano",
        triggerStage: "autorizacao_negada",
        steps: [
          { delayHours: 1, message: "Oi {nome}, tivemos retorno do convênio e há uma pendência na autorização. Vamos te explicar o próximo passo com cuidado." },
        ],
      },
      {
        name: "Pós-atendimento",
        triggerStage: "entregue_concluido",
        steps: [
          { delayHours: 24, message: "Oi {nome}! Como foi seu atendimento hoje? Estamos à disposição para qualquer dúvida administrativa. 💙" },
        ],
      },
      {
        name: "Retorno / continuidade",
        triggerStage: "retorno_recomendado",
        steps: [
          { delayHours: 24, message: "Oi {nome}! Está na hora de programar seu retorno/continuidade. Quer que eu veja os próximos horários disponíveis?" },
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
      // Clínica (ADR-080): alertas de permanência, autorização, impressão e portal.
      clinic_overrun_alert_enabled: 1, clinic_overrun_warning_minutes: 15,
      clinic_authorization_enabled: 1, clinic_authorization_followup_hours: 24,
      clinic_print_agenda_enabled: 1, clinic_professional_portal_enabled: 1,
    },
    faq: [
      {
        title: "FAQ Saúde — base inicial",
        content: `# Perguntas comuns do paciente

## Convênios aceitos
- Listar os convênios/planos aceitos pela clínica (preencher com os reais).

## Documentos necessários
- Documento com foto, carteirinha do convênio e, quando o procedimento exigir, pedido médico.

## Carteirinha do plano
- Confirmar número da carteirinha e validade antes do atendimento por convênio.

## Autorização de procedimento
- Alguns procedimentos exigem autorização prévia do convênio. A clínica prepara a solicitação; a liberação depende do retorno do plano.

## Prazos de autorização
- O prazo varia por operadora e procedimento. Avisamos assim que houver retorno — não há garantia de liberação imediata.

## Procedimentos particulares
- Indicar tabela de valores básica (preencher com os reais).

## Pacotes de sessões
- Quando houver, descrever pacotes/mensalidades e condições de pagamento.

## Preparo de exames/procedimentos
- Cada exame tem preparo específico — NÃO inventar. Responder apenas se houver instrução documentada; caso contrário, confirmar com a equipe.

## Cancelamento e remarcação
- Prazo: confirmar com X horas de antecedência (preencher).

## ⚠️ O que a IA não pode responder
Saúde é dado SENSÍVEL. A IA NUNCA dá diagnóstico, conduta clínica ou interpreta exame,
e NUNCA promete cobertura/autorização sem retorno do convênio. Quando perguntada sobre
saúde, sugere consulta com o profissional; quando perguntada sobre cobertura, informa o
status real da autorização ou que está em análise.
`,
      },
    ],
  },

  // ===========================================================================
  // BELEZA & SALÕES (ADR-169)
  // ===========================================================================
  {
    vertical: "beleza",
    label: "Beleza & Salões",
    // Pack Beleza (ADR-169): setup operacional de salão/barbearia/estética. As
    // áreas preparam recepção + consultoria de visual (Beauty AI) + fidelização;
    // as cadências cobrem confirmação de horário, sinal, pós-atendimento e
    // retorno de manutenção; as automações ligam a Beauty AI (Simulador de
    // Cabelo) + os detectores proativos (manutenção vencida / simulação
    // abandonada). Guardrails RN-BS embutidos nas personas: a IA NUNCA julga
    // aparência (RN-BS-03 — fala de POSSIBILIDADES, nunca de "ficaria mais
    // bonita") e NUNCA inventa serviço/preço/promoção fora do catálogo do
    // salão (RN-BS-11).
    areas: [
      {
        name: "Recepção do Salão",
        description: "Agendamento, remarcação, cancelamento, coleta de dados da cliente e confirmação de horário com a profissional certa.",
        persona: "Você é a recepção do salão. Receba a cliente com simpatia e acolhimento. Para agendar, pergunte: qual serviço deseja (corte, coloração, escova, manicure, etc.), se tem preferência de profissional, e qual dia/horário prefere. Confirme preço, duração e disponibilidade SOMENTE com base no catálogo e na agenda reais — NUNCA invente valor, promoção ou horário. Se a cliente pedir um serviço que não está no catálogo, seja honesta e diga que vai confirmar com a equipe. Quando a cliente confirmar, ofereça agendar. Você não decide manutenção nem dá alta de tratamento — isso é da profissional.",
      },
      {
        name: "Consultoria de Visual (Beauty AI)",
        description: "Quando a cliente quer mudar o visual mas está insegura, apresenta a consulta visual com foto (Beauty AI) e convida a agendar.",
        persona: "Você apresenta a consulta visual do salão. Quando a cliente demonstrar que quer mudar o visual (cor, corte) mas está em dúvida, explique com entusiasmo que o salão tem uma ferramenta que simula o resultado a partir de uma foto, para ela ver antes de decidir. Convide-a a passar no salão para a consulta visual (a foto é tirada na recepção, com o consentimento dela). REGRA IMPORTANTE: você fala de POSSIBILIDADES e de EFEITO das mudanças (contraste, luminosidade, destaque) — você NUNCA julga a aparência da pessoa, NUNCA diz que ela ficaria 'mais bonita', 'mais jovem' ou 'melhor', e NUNCA compara clientes. Só sugira serviços que existem no catálogo do salão. O objetivo é ajudar a cliente a decidir com confiança, nunca criar insegurança.",
      },
      {
        name: "Pós-atendimento e Fidelização",
        description: "Satisfação após o serviço, lembrete de retorno de manutenção, programa de indicação e recuperação de clientes.",
        persona: "Você é o relacionamento do salão. Depois do atendimento, pergunte se a cliente gostou do resultado e ofereça ajuda. Quando fizer sentido, lembre com carinho que alguns serviços (coloração, mecha, progressiva) pedem manutenção periódica — pergunte se ela quer já deixar o retorno agendado. Convide clientes satisfeitas a indicarem amigas (programa de indicação). Você nunca pressiona; é um convite gentil. Nunca invente prazo de manutenção nem desconto — use apenas o que está configurado.",
      },
    ],
    cadences: [
      {
        name: "Confirmação de horário (24h antes)",
        triggerStage: "agendado",
        steps: [
          { delayHours: 24, message: "Oi {nome}! Passando pra confirmar seu horário no salão em {quando}. Responda SIM pra confirmar ou REMARCAR se precisar mudar. 💇✨" },
        ],
      },
      {
        name: "Aguardando sinal do agendamento",
        triggerStage: "aguardando_pagamento",
        steps: [
          { delayHours: 4, message: "Oi {nome}! Pra garantir seu horário, falta só o sinal. Quer que eu te reenvie o PIX?" },
          { delayHours: 20, message: "Oi {nome}! Seu horário ainda está reservado aguardando o sinal. Posso confirmar pra você?" },
        ],
      },
      {
        name: "Pós-atendimento (satisfação)",
        triggerStage: "entregue_concluido",
        steps: [
          { delayHours: 3, message: "Oi {nome}! Como você ficou com o resultado de hoje? Adoraríamos saber o que achou. ⭐ Se puder deixar uma avaliação, ajuda muito o salão!" },
        ],
      },
      {
        name: "Retorno de manutenção",
        triggerStage: "retorno_recomendado",
        steps: [
          { delayHours: 24, message: "Oi {nome}! Já faz um tempinho do seu último {servico} — costuma ser a época de dar aquele retoque pra manter o visual lindo. Quer que eu veja os próximos horários?" },
        ],
      },
    ],
    automations: {
      // Salão típico trabalha com sinal/PIX pra reduzir no-show, NPS pós-serviço
      // e indicação (o boca a boca é o motor de crescimento do setor).
      order_expiry_enabled: 0,
      pix_reminder_enabled: 1, pix_reminder_max: 2, pix_reminder_minutes: 60,
      abandoned_cart_enabled: 0,
      nps_enabled: 1, nps_delay_hours: 3,
      referral_enabled: 1, referral_reward_percent: 10, referral_welcome_percent: 10,
      procurement_enabled: 0,
      quote_validity_hours: 72, quote_followup_hours: 24, quote_followup_max: 2,
      // Beleza (ADR-169): liga a Beauty AI + os detectores proativos em SHADOW.
      beauty_hair_simulator_enabled: 1,
      beauty_maintenance_detector_enabled: 1,
      beauty_abandoned_detector_enabled: 1,
    },
    faq: [
      {
        title: "FAQ Beleza & Salões — base inicial",
        content: `# Perguntas comuns da cliente

## Serviços oferecidos
- Liste os serviços do salão com preço e duração (preencher com os reais no Catálogo).
- A IA só oferece serviços que estão no catálogo — nunca inventa serviço ou promoção.

## Consulta visual (Beauty AI)
- O salão oferece uma simulação de visual: a partir de uma foto, a cliente vê como ficaria com uma nova cor ou corte ANTES de decidir.
- A foto é tirada no salão com o consentimento da cliente (termo de uso da imagem). A foto é privada e guardada com segurança; a cliente pode pedir a exclusão a qualquer momento (LGPD).
- A ferramenta descreve POSSIBILIDADES (contraste, luminosidade, destaque) — nunca julga a aparência da pessoa.

## Preços e formas de pagamento
- Indicar a tabela de preços real (preencher). Aceitamos PIX, cartão e dinheiro.
- Alguns serviços pedem sinal para reservar o horário (definir valor/percentual).

## Manutenção
- Coloração, mecha e progressiva pedem retoque periódico. Preencher o intervalo real de cada serviço (ex.: coloração a cada 4 semanas).
- A cliente recebe um lembrete gentil quando chega a época — nunca é cobrança, é um convite.

## Cancelamento e remarcação
- Pedimos aviso com X horas de antecedência (preencher).

## Higiene e produtos
- Descrever os cuidados de higiene do salão e as marcas de produtos usadas (preencher).

## Programa de indicação
- Indicou uma amiga que fechou serviço? Ganhe X% de desconto no próximo (definir a regra real).

## ⚠️ O que a IA nunca faz
A IA NUNCA julga a aparência de ninguém (não diz "ficaria mais bonita/jovem"), NUNCA
inventa preço, serviço ou promoção fora do catálogo, e NUNCA decide manutenção ou dá
"alta" de tratamento — isso é sempre da profissional. Quando não souber, é honesta e diz
que vai confirmar com a equipe.

## ⚠️ Substitua estas respostas pelas regras REAIS do seu salão.
Enquanto não substituir, a IA responde com honestidade em vez de inventar preço, prazo ou promoção.
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

    // 1) ÁREAS (idempotente por nome). Itens com requiresModule só entram se o
    // add-on estiver habilitado para a org (ADR-084 D2).
    const insArea = db.prepare(`INSERT INTO service_areas (id, organization_id, name, description, persona, position, active) VALUES (?, ?, ?, ?, ?, ?, 1)`);
    pack.areas.forEach((a, i) => {
      if (a.requiresModule && !ModuleService.isEnabled(orgId, a.requiresModule)) { report.areas.skipped++; return; }
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
        if (d.requiresModule && !ModuleService.isEnabled(orgId, d.requiresModule)) { report.faq.skipped++; continue; }
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

    // 6) Marca o Quick-Start como aplicado (ADR-093 §1) — o card do Dashboard some.
    try { db.prepare(`UPDATE organization_settings SET quickstart_applied = 1 WHERE organization_id = ?`).run(orgId); } catch (e) { /* noop */ }

    return report;
  }
}
