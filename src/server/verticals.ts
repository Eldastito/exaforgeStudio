// Catálogo de VERTICAIS (categorias de negócio) e seus presets de módulos.
// Fonte única consumida pelo backend (ModuleService.applyVertical) e exposta ao
// frontend via GET /api/analytics/verticals (cards do onboarding).
//
// Módulos CORE (atendimento, contatos, relatorios, configuracoes) estão sempre
// ligados e NÃO entram nesta lista — aqui ficam só os módulos OPCIONAIS.

export type VerticalKey =
  | "varejo" | "moda" | "food" | "servicos" | "saude" | "educacao" | "hospitalidade" | "beleza" | "petshop" | "outro";

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
  // ADR-169 (Vertical Beleza & Salões, PRD 12). Salão/barbearia/estética/nail
  // designer: agenda + cadências + comunicações + marketing são o dia-a-dia
  // (lembrete 24h, retorno de manutenção, oportunidade de vaga). O consent para
  // FOTO do Simulador de Cabelo é um escopo separado (hair_simulation), semeado
  // apenas quando F5 (Beauty AI) for ativada — nunca implícito no cadastro.
  // "use_in_marketing" (publicar antes/depois) é OUTRO consent separado
  // (RN-BS-04). Aqui só o essencial pra operação.
  beleza: ["dados_pessoais", "comunicacoes", "marketing"],
  // Petshop: dado do TUTOR (pessoa) + comunicações (lembrete de vacina/retorno) +
  // marketing. A ficha clínica é do ANIMAL, não é dado sensível de pessoa natural
  // (LGPD Art.11), então NÃO entra `dados_sensiveis` (diferente de 'saude' humana).
  petshop: ["dados_pessoais", "comunicacoes", "marketing"],
  outro: ["marketing", "dados_pessoais", "perfilamento", "comunicacoes"],
};

// Todos os módulos OPCIONAIS conhecidos (usados por "outro" e validação).
export const OPTIONAL_MODULES = [
  "agenda", "catalogo", "vendas", "loja", "pagamentos",
  "campanhas", "cadencias", "areas", "integracoes", "reservas", "assinaturas",
  "compras", "orcamentos", "eventos", "diretor", "estudio", "rie", "execucao", "prospect",
  "vms", "radar", "clinica", "retail", "copiloto", "escola", "retail_floor",
  // ADR-151 F2: falatu virou módulo opcional multi-tenant (ligado por org via
  // organization_settings.falatu_enabled + RBAC). ADR-154 F2.1 formaliza como
  // módulo conhecido pra poder aparecer em blueprint.requiredModules
  // (falatu_solo_v1) sem quebrar a validação `assertValidModules`.
  "falatu",
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
// "escola" (Módulo Escola, ADR-144) é o corpo da vertical "educacao" — mesmo
// papel que "clinica" tem para "saude": preset dessa vertical, mas nunca ligado
// por "outro" nem pelas demais (só educação ou ativação explícita), e preservado
// (grandfather) ao (re)aplicar uma vertical.
// "retail_floor" (Atendimento de Loja / Lista da Vez, ADR-150) segue o mesmo
// racional do "retail": operação de loja física supervisionada é opt-in
// explícito do dono — nenhuma vertical liga sozinha.
export const ADDON_MODULES = ["vms", "radar", "prospect", "clinica", "retail", "escola", "retail_floor"] as const;

// PLAN_FREE_ADDONS: subconjunto dos add-ons que o DONO pode ligar em
// Configurações › Módulos independentemente do teto do plano (billing mockado).
// Hoje só o Retail Ops — operacional da vertical moda, pedido explicitamente
// como ligável. Os demais add-ons (radar/prospect/clinica/vms) continuam presos
// ao plano (ADR-091): habilitá-los em enabled_modules NÃO fura o teto; para valer
// exigem que o plano os inclua ou uma assinatura de add-on (org_addons).
export const PLAN_FREE_ADDONS = ["retail", "retail_floor"] as const;
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
    // ADR-144: "escola" é o corpo da vertical — conecta a escola à família (resumo
    // diário ao responsável no WhatsApp), como "clinica" é o corpo de "saude".
    modules: ["escola", "assinaturas", "agenda", "pagamentos", "campanhas", "cadencias", "areas", "integracoes", "diretor", "rie", "execucao"],
    saleMode: "unit",
  },
  {
    key: "hospitalidade", label: "Hotéis / Restaurantes", icon: "🏨",
    descricao: "Hospedagem e restaurantes/pensão: reservas, cardápio e atendimento.",
    modules: ["reservas", "catalogo", "vendas", "loja", "pagamentos", "agenda", "areas", "integracoes", "compras", "orcamentos", "eventos", "diretor", "rie", "execucao"],
    saleMode: "unit",
  },
  {
    // ADR-169 / PRD 12 — Beleza & Salões. Já previsto em ADR-092 §60 como
    // vertical futura represada até o Bloco A do Autônomo (que fechou). Preset
    // combina agenda (o coração operacional — reusando a agenda profissional/
    // sala/especialidade da Clínica sem ligar o módulo `clinica`), vendas +
    // pagamentos (comissão e revenda de produto), campanhas + cadências
    // (recuperação de cliente, lembrete de manutenção), assinaturas (pacote
    // de 10 escovas etc.), estudio (antes/depois no Instagram) e as
    // superfícies transversais (diretor, rie, execucao). O Simulador de
    // Cabelo (Beauty AI) é opt-in por flag (F5+ do ADR-169) — não entra no
    // preset porque é sub-feature separada.
    key: "beleza", label: "Beleza & Salões", icon: "💇",
    descricao: "Salão, barbearia, estética, nail designer — agenda, retorno de manutenção e simulador de visual.",
    modules: ["agenda", "vendas", "pagamentos", "campanhas", "cadencias", "areas", "integracoes", "assinaturas", "estudio", "diretor", "rie", "execucao"],
    saleMode: "unit",
  },
  {
    key: "petshop", label: "Petshop / Veterinário", icon: "🐾",
    descricao: "Loja + clínica veterinária num só negócio: produtos, consultas, cirurgia, internação e banho & tosa.",
    // Petshop = VAREJO (produtos) + CLÍNICA (vet/cirurgia/internação) + SERVIÇOS
    // (banho & tosa). Compõe módulos que já existem, sem motor novo: 'clinica' dá
    // corpo à parte veterinária (prontuário/agenda clínica/portal); 'agenda'+'areas'
    // organizam serviços e vários profissionais/salas; 'compras' cuida do estoque;
    // 'assinaturas'+'cadencias' cobrem plano de saúde pet e retorno de vacina/vermífugo.
    // A adaptação de terminologia (pet/tutor) e campos pet-específicos (espécie, raça,
    // carteira de vacina) são fatias seguintes — aqui é o preset que torna a vertical
    // selecionável no onboarding e liga os módulos certos.
    modules: ["catalogo", "vendas", "loja", "pagamentos", "compras", "agenda", "clinica", "areas", "cadencias", "assinaturas", "campanhas", "integracoes", "diretor", "rie", "execucao"],
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
