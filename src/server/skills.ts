import { VERTICALS } from "./verticals.js";
import { ModuleService } from "./ModuleService.js";

/**
 * SKILL REGISTRY (first-party) — fundação do conceito de "capacidades plugáveis".
 *
 * Cada skill é um módulo já existente formalizado como uma capacidade instalável.
 * "Instalado" = está em organization_settings.enabled_modules (ModuleService).
 * A instalação/desinstalação hoje acontece em Configurações › Módulos (toggle) e
 * no Quick-Start; este registry dá o catálogo e prepara o terreno para a "Loja de
 * Skills" e para o Orquestrador descobrir capacidades por organização.
 *
 * NÃO é o marketplace aberto (terceiros) — isso é visão de longo prazo.
 */
export type SkillType = "interna" | "integracao";

export type Skill = {
  key: string;            // = module key (ModuleService)
  name: string;
  description: string;
  type: SkillType;
  icon: string;
};

export const SKILLS: Skill[] = [
  { key: "diretor", name: "Diretor Executivo IA", icon: "🧠", type: "interna", description: "Conselheiro de gestão: pergunte em linguagem natural e receba decisões com dados reais + briefing diário." },
  { key: "reservas", name: "Reservas", icon: "📅", type: "interna", description: "Reservas por período com disponibilidade, hóspedes e sinal (quartos, mesas, espaços)." },
  { key: "eventos", name: "Eventos & Grupos", icon: "🎪", type: "interna", description: "Pipeline de consultas consultivas: casamentos, convenções, day use, corporativo." },
  { key: "orcamentos", name: "Orçamentos", icon: "🧾", type: "interna", description: "Orçamentos rastreáveis (enviado/aceito/recusado) com follow-up automático." },
  { key: "compras", name: "Compras & Reposição", icon: "📦", type: "interna", description: "Reposição inteligente + cotação com fornecedores + rede ZappFlow." },
  { key: "vendas", name: "Vendas", icon: "🛒", type: "interna", description: "Pedidos, conversão e ticket médio no funil de vendas." },
  { key: "catalogo", name: "Catálogo", icon: "🏷️", type: "interna", description: "Produtos e serviços, com estoque opcional." },
  { key: "loja", name: "Loja Virtual", icon: "🏬", type: "interna", description: "Vitrine pública para o cliente montar o pedido." },
  { key: "agenda", name: "Agenda", icon: "🗓️", type: "interna", description: "Agendamentos e lembretes (com Google Calendar)." },
  { key: "assinaturas", name: "Assinaturas", icon: "🔁", type: "interna", description: "Cobrança recorrente (mensalidades, planos, clubes)." },
  { key: "campanhas", name: "Campanhas", icon: "📣", type: "interna", description: "Disparos segmentados + recuperação e reativação automáticas." },
  { key: "cadencias", name: "Cadências", icon: "🧩", type: "interna", description: "Sequências de follow-up por estágio do funil." },
  { key: "areas", name: "Áreas de Atendimento", icon: "👥", type: "interna", description: "Roteamento por setor/profissional com persona da IA." },
  { key: "pagamentos", name: "Pagamentos", icon: "💳", type: "integracao", description: "PIX manual e gateway (Mercado Pago) com confirmação automática." },
  { key: "integracoes", name: "Integrações", icon: "🔌", type: "integracao", description: "Conexões externas (WhatsApp/Evolution, Google, etc.)." },
];

export class SkillRegistry {
  /** Verticais em que cada skill aparece (derivado dos presets de verticals.ts). */
  static verticalsForSkill(key: string): string[] {
    return VERTICALS.filter(v => (v.modules as string[]).includes(key)).map(v => v.key);
  }

  /**
   * Catálogo para a organização: cada skill com flag `installed` (está em
   * enabled_modules) e `recommended` (faz parte do preset da vertical da org).
   */
  static catalog(orgId: string, orgVertical?: string | null): any[] {
    const installed = new Set(ModuleService.enabledModules(orgId) || []);
    const vertical = VERTICALS.find(v => v.key === orgVertical);
    const recommended = new Set<string>((vertical?.modules as string[]) || []);
    return SKILLS.map(s => ({
      ...s,
      installed: installed.has(s.key),
      recommended: recommended.has(s.key),
      verticals: this.verticalsForSkill(s.key),
    }));
  }
}
