// Catálogo de VERTICAIS (categorias de negócio) e seus presets de módulos.
// Fonte única consumida pelo backend (ModuleService.applyVertical) e exposta ao
// frontend via GET /api/analytics/verticals (cards do onboarding).
//
// Módulos CORE (atendimento, contatos, relatorios, configuracoes) estão sempre
// ligados e NÃO entram nesta lista — aqui ficam só os módulos OPCIONAIS.

export type VerticalKey =
  | "varejo" | "moda" | "food" | "servicos" | "saude" | "educacao" | "hospitalidade" | "outro";

export type Vertical = {
  key: VerticalKey;
  label: string;
  descricao: string;
  icon: string;          // emoji para o card do onboarding
  modules: string[];     // módulos OPCIONAIS habilitados por padrão
  saleMode: string;      // sugestão de modo de venda padrão p/ o catálogo
  consentCategories?: string[]; // categorias de consentimento LGPD pré-populadas (ADR-093 §3)
};

// Categorias de consentimento LGPD sugeridas por vertical (pré-população —
// ADR-093 §3). Saúde inclui `dados_sensiveis` (base legal reforçada).
export const CONSENT_BY_VERTICAL: Record<string, string[]> = {
  varejo: ["marketing", "dados_pessoais", "perfilamento"],
  moda: ["marketing", "dados_pessoais", "perfilamento"],
  food: ["marketing", "dados_pessoais", "comunicacoes"],
  servicos: ["dados_pessoais", "comunicacoes", "marketing"],
  saude: ["dados_pessoais", "dados_sensiveis", "comunicacoes"],
  educacao: ["dados_pessoais", "comunicacoes", "marketing"],
  hospitalidade: ["dados_pessoais", "marketing", "comunicacoes"],
  outro: ["marketing", "dados_pessoais", "perfilamento", "comunicacoes"],
};

// Todos os módulos OPCIONAIS conhecidos (usados por "outro" e validação).
export const OPTIONAL_MODULES = [
  "agenda", "catalogo", "vendas", "loja", "pagamentos",
  "campanhas", "cadencias", "areas", "integracoes", "reservas", "assinaturas",
  "compras", "orcamentos", "eventos", "diretor", "estudio", "rie", "execucao", "prospect",
  "vms", "radar", "clinica", "retail",
] as const;

// "vms" (ZappFlow Vision VMS) é um produto add-on que depende de hardware de
// câmera no site do cliente — não deve ser ligado automaticamente por nenhuma
// vertical (nem "outro"), só por ativação explícita em Configurações › Módulos
// após diagnóstico/piloto (PRD §0.5: feature flags desligadas por padrão).
//
// "radar" (ZappFlow Radar de Execução IA) segue o MESMO princípio, pelo mesmo
// motivo declarado no PRD do módulo (§3, regra 3: feature flag
// `ai_execution_radar_enabled`, desligada por padrão): nenhuma organização
// existente deve "ganhar" o módulo sozinha num deploy — só ativação explícita
// via Configurações › Módulos (ou, no piloto, direto no banco/API) por uma
// organização de cada vez.
//
// "prospect" (ZappFlow Prospect AI) está em Fase 0 — CRUD de ICP + rascunho
// de campanha; descoberta, enriquecimento, scoring e outreach entram nas
// próximas fases. Enquanto isso, é experimental: novas orgs NÃO recebem
// automaticamente (ver ADR-077). Ativação explícita apenas.
// "clinica" (Módulo Clínica, ADR-080) é preset da vertical "saude" (é o módulo
// que dá corpo à operação de clínica), mas não deve ser ligado por "outro" nem
// pelas demais verticais — só saúde ou ativação explícita.
// "retail" (Retail Ops / Retail Network Ops, ADR-083/084) é o add-on de
// OPERAÇÃO DE REDE DE LOJAS (fechamento de loja, cotas, malote, premiação).
// ADR-084 D2: deixa de ser preset automático de "varejo" e passa a ser opt-in
// explícito (como vms/radar/prospect), pois "atuar no varejo" ≠ "operar uma
// rede de lojas a supervisionar". A clínica segue como preset de "saude".
//
// ADDON_MODULES: módulos opcionais que NENHUMA vertical liga automaticamente
// (salvo a clínica, que é o corpo da vertical saúde). São sempre opt-in e, por
// isso, o ModuleService PRESERVA um add-on já habilitado ao (re)aplicar uma
// vertical — o corte do ADR-084 nunca REMOVE de quem já usa (grandfather).
export const ADDON_MODULES = ["vms", "radar", "prospect", "clinica", "retail"] as const;
const OUTRO_MODULES = OPTIONAL_MODULES.filter((m) => !(ADDON_MODULES as readonly string[]).includes(m));

export const VERTICALS: Vertical[] = [
  {
    key: "varejo", label: "Varejo / Comércio", icon: "🛍️",
    descricao: "Pet shop, eletrônicos, papelaria, utilidades — venda por unidade.",
    // ADR-092: varejo genérico sem cadências no preset (moda é vertical própria).
    modules: ["catalogo", "vendas", "loja", "pagamentos", "campanhas", "integracoes", "diretor", "rie", "execucao"],
    saleMode: "unit",
  },
  {
    key: "moda", label: "Moda / Vestuário", icon: "👗",
    descricao: "Roupas, calçados e acessórios — com provador virtual e estúdio de peça.",
    // ADR-092: moda separada do varejo; Estúdio de Criação já vem no preset.
    modules: ["catalogo", "vendas", "loja", "pagamentos", "campanhas", "integracoes", "estudio", "diretor", "rie", "execucao"],
    saleMode: "unit",
  },
  {
    key: "food", label: "Alimentação / Delivery", icon: "🍰",
    descricao: "Bolos, marmitas, pizzas, doces e salgados — inclusive venda por fatia.",
    modules: ["catalogo", "vendas", "loja", "pagamentos", "campanhas", "integracoes", "diretor", "rie", "execucao"],
    saleMode: "slice",
  },
  {
    key: "servicos", label: "Prestadores de Serviço", icon: "🛠️",
    descricao: "Serviços com hora marcada e orçamento (oficinas, técnicos, autônomos).",
    // ADR-092: reservas vira opt-in (nem todo prestador trabalha por período).
    modules: ["agenda", "vendas", "pagamentos", "campanhas", "cadencias", "areas", "integracoes", "assinaturas", "diretor", "rie", "execucao"],
    saleMode: "unit",
  },
  {
    key: "saude", label: "Saúde / Bem-estar", icon: "💆",
    descricao: "Clínicas, consultórios, estética e terapias — foco em agendamento.",
    modules: ["agenda", "clinica", "pagamentos", "cadencias", "areas", "integracoes", "assinaturas", "diretor", "rie", "execucao"],
    saleMode: "unit",
  },
  {
    key: "educacao", label: "Escolas / Cursos", icon: "🎓",
    descricao: "Escolas e cursos: secretaria virtual, aulas, turmas e mensalidades.",
    modules: ["assinaturas", "agenda", "pagamentos", "campanhas", "cadencias", "areas", "integracoes", "diretor", "rie", "execucao"],
    saleMode: "unit",
  },
  {
    key: "hospitalidade", label: "Hotéis / Restaurantes", icon: "🏨",
    descricao: "Hospedagem e restaurantes/pensão: reservas, cardápio e atendimento.",
    modules: ["reservas", "catalogo", "vendas", "loja", "pagamentos", "agenda", "areas", "integracoes", "compras", "orcamentos", "eventos", "diretor", "rie", "execucao"],
    saleMode: "unit",
  },
  {
    key: "outro", label: "Outro / Genérico", icon: "✨",
    descricao: "Liga todos os módulos. Você refina depois em Configurações › Módulos.",
    modules: [...OUTRO_MODULES],
    saleMode: "unit",
  },
];

export function getVertical(key?: string | null): Vertical | undefined {
  return VERTICALS.find(v => v.key === key);
}
