// Catálogo de VERTICAIS (categorias de negócio) e seus presets de módulos.
// Fonte única consumida pelo backend (ModuleService.applyVertical) e exposta ao
// frontend via GET /api/analytics/verticals (cards do onboarding).
//
// Módulos CORE (atendimento, contatos, relatorios, configuracoes) estão sempre
// ligados e NÃO entram nesta lista — aqui ficam só os módulos OPCIONAIS.

export type VerticalKey =
  | "varejo" | "food" | "servicos" | "saude" | "educacao" | "hospitalidade" | "outro";

export type Vertical = {
  key: VerticalKey;
  label: string;
  descricao: string;
  icon: string;          // emoji para o card do onboarding
  modules: string[];     // módulos OPCIONAIS habilitados por padrão
  saleMode: string;      // sugestão de modo de venda padrão p/ o catálogo
};

// Todos os módulos OPCIONAIS conhecidos (usados por "outro" e validação).
export const OPTIONAL_MODULES = [
  "agenda", "catalogo", "vendas", "loja", "pagamentos",
  "campanhas", "cadencias", "areas", "integracoes", "reservas", "assinaturas",
  "compras", "orcamentos", "eventos", "diretor", "estudio",
] as const;

export const VERTICALS: Vertical[] = [
  {
    key: "varejo", label: "Varejo / Comércio", icon: "🛍️",
    descricao: "Lojas que vendem produtos por unidade (roupas, eletrônicos, pet, etc.).",
    modules: ["catalogo", "vendas", "loja", "pagamentos", "campanhas", "cadencias", "integracoes", "diretor"],
    saleMode: "unit",
  },
  {
    key: "food", label: "Alimentação / Delivery", icon: "🍰",
    descricao: "Bolos, marmitas, pizzas, doces e salgados — inclusive venda por fatia.",
    modules: ["catalogo", "vendas", "loja", "pagamentos", "campanhas", "integracoes", "diretor"],
    saleMode: "slice",
  },
  {
    key: "servicos", label: "Prestadores de Serviço", icon: "🛠️",
    descricao: "Serviços com hora marcada e orçamento (oficinas, técnicos, autônomos).",
    modules: ["agenda", "vendas", "pagamentos", "campanhas", "cadencias", "areas", "integracoes", "reservas", "assinaturas", "diretor"],
    saleMode: "unit",
  },
  {
    key: "saude", label: "Saúde / Bem-estar", icon: "💆",
    descricao: "Clínicas, consultórios, estética e terapias — foco em agendamento.",
    modules: ["agenda", "pagamentos", "cadencias", "areas", "integracoes", "assinaturas", "diretor"],
    saleMode: "unit",
  },
  {
    key: "educacao", label: "Escolas / Cursos", icon: "🎓",
    descricao: "Escolas e cursos: secretaria virtual, aulas, turmas e mensalidades.",
    modules: ["assinaturas", "agenda", "pagamentos", "campanhas", "cadencias", "areas", "integracoes", "diretor"],
    saleMode: "unit",
  },
  {
    key: "hospitalidade", label: "Hotéis / Restaurantes", icon: "🏨",
    descricao: "Hospedagem e restaurantes/pensão: reservas, cardápio e atendimento.",
    modules: ["reservas", "catalogo", "vendas", "loja", "pagamentos", "agenda", "areas", "integracoes", "compras", "orcamentos", "eventos", "diretor"],
    saleMode: "unit",
  },
  {
    key: "outro", label: "Outro / Genérico", icon: "✨",
    descricao: "Liga todos os módulos. Você refina depois em Configurações › Módulos.",
    modules: [...OPTIONAL_MODULES],
    saleMode: "unit",
  },
];

export function getVertical(key?: string | null): Vertical | undefined {
  return VERTICALS.find(v => v.key === key);
}
