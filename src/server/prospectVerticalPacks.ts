import { VERTICALS } from "./verticals.js";

/**
 * F4 (GAP-CLOSURE-03) — VERTICAL PACKS de ICP para o Prospect.
 *
 * O Prospect já tem ICP editável por-org (`prospect_icp_profiles` + `createIcp` +
 * `computeScore`), mas o tenant partia do ZERO: sem um ponto de partida curado por
 * nicho. Este é o gap "sem vertical packs" do audit. Um pack é um TEMPLATE curado
 * (dor/oferta/segmento/sinais) que o tenant ADOTA — vira um ICP normal, editável,
 * via o `createIcp` existente (não duplica armazenamento nem motor de score).
 *
 * Conteúdo em CÓDIGO (padrão `verticals.ts`/`prospectCategories.ts`), GLOBAL/curado,
 * não tabela nova. O `segmento` usa o vocabulário PT que o `PT_CATEGORY_MAP` reconhece
 * (para o `expectedSegments` derivar o encaixe no `computeScore`). Chaves alinhadas a
 * `VERTICALS` (fonte única de verticais — não inventa nicho). Aditivo/reversível.
 * NÃO é verdade: é ponto de partida; o tenant edita livremente após adotar.
 */

export interface ProspectVerticalPack {
  vertical: string;   // chave de VERTICALS
  label: string;      // rótulo de VERTICALS
  icpName: string;    // nome sugerido do ICP ao adotar
  criteria: {
    dor: string;       // dor central do nicho (grounded na tese do ZappFlow: dependência operacional)
    oferta: string;    // como o ZappFlow endereça
    segmento: string;  // termos PT reconhecidos por PT_CATEGORY_MAP (dirige o encaixe/score)
    sinais: string[];  // sinais observáveis de que a conta tem a dor (humano-legível)
  };
}

function labelOf(vertical: string): string { return VERTICALS.find((v) => v.key === vertical)?.label || vertical; }

// Packs curados só para os nichos com dor/segmento claros. Nichos sem template
// honesto (ex.: "outro") ficam de fora — o tenant cria o ICP do zero como antes.
const PACKS_RAW: Record<string, { icpName: string; dor: string; oferta: string; segmento: string; sinais: string[] }> = {
  saude: {
    icpName: "Clínicas e consultórios",
    dor: "Administração manual (agenda, retorno, cobrança) roubando tempo do cuidado com o paciente.",
    oferta: "Menos trabalho manual na recepção e mais atenção ao paciente, com execução acompanhada.",
    segmento: "clinica, consultorio, dentista, laboratorio",
    sinais: ["agenda cheia com faltas/remarcações", "retorno de paciente depende de alguém lembrar", "cobrança de convênio/particular manual"],
  },
  petshop: {
    icpName: "Petshops e clínicas veterinárias",
    dor: "Acompanhar a operação (loja + banho & tosa + clínica) enquanto se cuida do atendimento.",
    oferta: "Operação acompanhada e recompra (vacina/retorno) sem depender da memória da equipe.",
    segmento: "petshop, veterinaria",
    sinais: ["clientes que somem entre banhos", "lembrete de vacina/retorno manual", "estoque de ração/insumo vira prioridade só na falta"],
  },
  moda: {
    icpName: "Lojas de moda e vestuário",
    dor: "Não saber em tempo real o que acontece nas lojas sem perguntar; venda que esfria no atendimento.",
    oferta: "Visão da operação das lojas e follow-up de venda sem depender do dono perguntar.",
    segmento: "loja",
    sinais: ["conversa de venda no WhatsApp sem retorno", "ruptura de estoque na loja", "dono precisa ligar pra saber o dia"],
  },
  varejo: {
    icpName: "Comércio e varejo",
    dor: "Pedido por mensagem vira operação no improviso; ruptura de estoque aparece tarde.",
    oferta: "Atendimento, pedido, follow-up e reposição num fluxo único acompanhado.",
    segmento: "loja, mercado, supermercado",
    sinais: ["pedido por WhatsApp sem processo", "reposição reativa", "sem visão de execução do dia"],
  },
  advocacia: {
    icpName: "Escritórios de advocacia",
    dor: "Informações, clientes e prazos presos na memória da equipe.",
    oferta: "Clientes, atividades e prazos organizados sem depender só da memória de quem atende.",
    segmento: "advogado, escritorio",
    sinais: ["prazo controlado em planilha/cabeça", "cliente sem retorno", "andamento depende de uma pessoa"],
  },
  beleza: {
    icpName: "Salões e estética",
    dor: "Cliente que some entre atendimentos e agenda com faltas.",
    oferta: "Recompra e agenda acompanhadas, com lembrete e retorno sem trabalho manual.",
    segmento: "salao, barbearia, estetica",
    sinais: ["cadeira ociosa em horário morto", "cliente sem reagendar", "confirmação de horário manual"],
  },
  food: {
    icpName: "Alimentação e delivery",
    dor: "Pedido disperso entre canais; recompra depende de promoção pontual.",
    oferta: "Pedidos e recompra num fluxo único, com follow-up sem depender de campanha manual.",
    segmento: "restaurante, lanchonete, cafe, padaria",
    sinais: ["pedido em vários canais sem consolidação", "cliente compra uma vez e some", "sem visão do movimento do dia"],
  },
  hospitalidade: {
    icpName: "Hotéis e pousadas",
    dor: "Reservas que morrem no WhatsApp e demanda dispersa.",
    oferta: "Reservas e demandas organizadas até a próxima ação, sem oportunidade perdida no caminho.",
    segmento: "hotel, pousada, restaurante",
    sinais: ["reserva sem retorno", "demanda dispersa entre canais", "sem acompanhamento da oportunidade"],
  },
  educacao: {
    icpName: "Escolas e cursos",
    dor: "Matrícula e retorno de interessado dependem de alguém lembrar.",
    oferta: "Interessados e matrículas acompanhados até a decisão, sem depender da memória da equipe.",
    segmento: "escola, autoescola",
    sinais: ["lead de matrícula sem follow-up", "retorno manual", "sem visão do funil de matrícula"],
  },
  servicos: {
    icpName: "Prestadores de serviço",
    dor: "Demanda dispersa entre canais e pessoas, sem responsável nem prazo.",
    oferta: "Solicitações, responsáveis e prazos centralizados com acompanhamento.",
    segmento: "escritorio, oficina",
    sinais: ["solicitação sem responsável", "orçamento sem retorno", "sem visão de execução"],
  },
};

/** Lista os packs disponíveis (conteúdo curado, global). Read-only. */
export function listProspectVerticalPacks(): ProspectVerticalPack[] {
  return Object.keys(PACKS_RAW).map((vertical) => ({
    vertical, label: labelOf(vertical), icpName: PACKS_RAW[vertical].icpName, criteria: {
      dor: PACKS_RAW[vertical].dor, oferta: PACKS_RAW[vertical].oferta,
      segmento: PACKS_RAW[vertical].segmento, sinais: [...PACKS_RAW[vertical].sinais],
    },
  }));
}

/** Um pack por vertical, ou null se não há template curado (não inventa). */
export function getProspectVerticalPack(vertical: string): ProspectVerticalPack | null {
  const p = PACKS_RAW[String(vertical || "")];
  if (!p) return null;
  return { vertical, label: labelOf(vertical), icpName: p.icpName, criteria: { dor: p.dor, oferta: p.oferta, segmento: p.segmento, sinais: [...p.sinais] } };
}
