import db from "./db.js";
import { VERTICALS, OPTIONAL_MODULES, ADDON_MODULES, PLAN_FREE_ADDONS, getVertical } from "./verticals.js";
import { PlanService } from "./PlanService.js";
import { LgpdService } from "./LgpdService.js";

// Gating de MÓDULOS por organização. Define quais módulos opcionais cada org
// enxerga/usa, a partir da vertical escolhida (com override manual depois).
//
// Compatibilidade: enabled_modules = NULL ⇒ "tudo ligado" (comportamento antigo).
// O gate só restringe quando há uma lista não-nula. Módulos CORE nunca bloqueiam.
export class ModuleService {
  // Sempre disponíveis (todo negócio atende, tem contatos, relatórios e config).
  static CORE = ["atendimento", "contatos", "relatorios", "configuracoes"];

  // 1º segmento da rota (/api/<seg>/...) -> módulo opcional. Rotas fora do mapa
  // são consideradas core/infra e nunca são bloqueadas.
  static MODULE_BY_ROUTE: Record<string, string> = {
    products: "catalogo",
    orders: "vendas",
    storefront: "loja",
    payments: "pagamentos",
    appointments: "agenda",
    campaigns: "campanhas",
    cadences: "cadencias",
    areas: "areas",
    integrations: "integracoes",
    reservations: "reservas",
    subscriptions: "assinaturas",
    procurement: "compras",
    quotes: "orcamentos",
    events: "eventos",
    executive: "diretor",
    studio: "estudio",
    tasks: "execucao",
    prospect: "prospect",
    clinic: "clinica",
    vision: "vms",
    radar: "radar",
    retailops: "retail",
  };

  // Rótulos + descrição de cada módulo opcional (fonte única p/ a tela de Módulos).
  static MODULE_META: Record<string, { label: string; desc: string }> = {
    agenda: { label: "Agenda", desc: "Agendamentos e horários (Google Calendar)." },
    catalogo: { label: "Catálogo", desc: "Produtos e serviços." },
    vendas: { label: "Vendas", desc: "Pedidos e fechamento de vendas." },
    loja: { label: "Loja Virtual", desc: "Vitrine online para o cliente comprar." },
    pagamentos: { label: "Pagamentos", desc: "Recebimento por PIX / gateway (cartão, boleto)." },
    campanhas: { label: "Campanhas", desc: "Disparos segmentados." },
    cadencias: { label: "Cadências", desc: "Sequências de follow-up automático." },
    areas: { label: "Áreas de Atendimento", desc: "Vários profissionais num número." },
    integracoes: { label: "Integrações", desc: "Google Workspace e outras conexões." },
    reservas: { label: "Reservas", desc: "Reservas por período com controle de disponibilidade (quartos, mesas, aluguéis)." },
    assinaturas: { label: "Assinaturas", desc: "Cobrança recorrente (mensalidades, planos, clubes)." },
    compras: { label: "Compras", desc: "Reposição inteligente: a IA detecta estoque crítico e gera lista de compra." },
    orcamentos: { label: "Orçamentos", desc: "Orçamento como objeto rastreável: enviado/aceito/recusado + follow-up até a validade." },
    eventos: { label: "Eventos & Grupos", desc: "Pipeline de consultas consultivas (casamento, convenção, corporativo)." },
    diretor: { label: "Diretor Executivo IA", desc: "Conselheiro de gestão com dados reais + briefing diário." },
    estudio: { label: "Estúdio de Criação", desc: "IA gera imagens e vídeos de campanha com a identidade da marca." },
    rie: { label: "Revenue Intelligence", desc: "Onde você perde e recupera receita: índice, drivers e plano de ação." },
    execucao: { label: "Execução / Tarefas", desc: "Delegação de tarefas com o Coordenador IA e alocação de recursos." },
    prospect: { label: "Prospect AI", desc: "Prospecção B2B ativa: ICP, evidências, hipóteses de dor, abordagem com IA." },
    vms: { label: "Vision VMS", desc: "Monitoramento de câmeras (add-on que depende de hardware no site)." },
    radar: { label: "Radar de Execução IA", desc: "Diagnóstico de maturidade em IA (7 pilares) + Índice de Velocidade de Conversão." },
    clinica: { label: "Clínica", desc: "Fluxo de saúde: prontuário, agenda clínica, portal do paciente." },
    retail: { label: "Retail Ops", desc: "Operação de rede de lojas: fechamento, cotas, malote, premiação." },
  };

  /**
   * Visão da tela de Módulos (ADR-092/093): agrupa os módulos opcionais em
   *  - recommended: no preset da vertical E dentro do teto do plano (ligados por padrão)
   *  - available:   dentro do teto do plano, mas fora do preset (dono liga se quiser)
   *  - upgrade:     acima do teto do plano (requer plano superior; CTA de upgrade)
   * `recommended` (flag) marca os que a vertical pressupõe, mesmo na seção upgrade.
   */
  static overview(orgId: string) {
    const o = db.prepare("SELECT vertical, plan_id FROM organization_settings WHERE organization_id = ?").get(orgId) as any || {};
    const preset = new Set(getVertical(o.vertical)?.modules || []);
    const planMods = PlanService.modulesForPlan(orgId); // null = sem teto
    const enabled = this.enabledModules(orgId);         // null = tudo ligado (legado)
    const items = (OPTIONAL_MODULES as readonly string[]).map((key) => {
      const meta = this.MODULE_META[key] || { label: key, desc: "" };
      const inPlan = planMods == null || planMods.includes(key);
      const inPreset = preset.has(key);
      const isEnabled = enabled == null ? true : enabled.includes(key);
      const isAddon = (ADDON_MODULES as readonly string[]).includes(key);
      const isFreeAddon = (PLAN_FREE_ADDONS as readonly string[]).includes(key);
      // Só os add-ons OPERACIONAIS (PLAN_FREE_ADDONS — hoje Retail Ops) ficam
      // sempre ligáveis pelo dono, independente do teto do plano (billing mockado).
      // Os demais add-ons acima do plano (radar/prospect/clinica/vms) vão para
      // "upgrade": a tela os mostra com cadeado + CTA, NÃO um toggle que engana —
      // espelha o gating real do isEnabled (ADR-091). Add-on DENTRO do plano
      // (ex.: radar no Scale) segue ligável normalmente.
      const section = isFreeAddon ? "available" : (!inPlan ? "upgrade" : (inPreset ? "recommended" : "available"));
      return { key, label: meta.label, desc: meta.desc, section, enabled: isEnabled, recommended: inPreset, addon: isAddon };
    });
    return { vertical: o.vertical || null, planId: o.plan_id || null, items };
  }

  /** Lista de módulos opcionais habilitados; null = todos (legado/sem vertical). */
  static enabledModules(orgId: string): string[] | null {
    try {
      const o = db.prepare("SELECT enabled_modules FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      if (!o || o.enabled_modules == null || o.enabled_modules === "") return null;
      const arr = JSON.parse(o.enabled_modules);
      return Array.isArray(arr) ? arr : null;
    } catch (e) { return null; }
  }

  static isEnabled(orgId: string, moduleKey: string): boolean {
    if (this.CORE.includes(moduleKey)) return true;
    const em = this.enabledModules(orgId);
    if (em == null) return false;
    if (!em.includes(moduleKey)) return false;
    // Add-on OPERACIONAL ligado explicitamente vale independente do teto do plano
    // (opt-in do dono; billing mockado). Hoje só Retail Ops (PLAN_FREE_ADDONS).
    // Os demais add-ons (radar/prospect/clinica/vms) continuam presos ao plano —
    // habilitá-los em enabled_modules não fura o teto (ADR-091 §5; teste 1.7).
    if ((PLAN_FREE_ADDONS as readonly string[]).includes(moduleKey)) return true;
    const planModules = PlanService.modulesForPlan(orgId);
    if (planModules != null && !planModules.includes(moduleKey)) return false;
    return true;
  }

  /**
   * Backfill idempotente: torna EXPLÍCITO o conjunto de módulos das orgs que
   * estavam com enabled_modules nulo. Org COM vertical recebe o preset da
   * vertical; org SEM vertical recebe o preset "outro" (todos) — preservando o
   * que ela já enxergava (sem surpresa), porém agora explícito e refinável.
   */
  static backfillNullModules(): { updated: number } {
    let rows: any[] = [];
    try {
      rows = db.prepare(
        "SELECT organization_id, vertical FROM organization_settings WHERE enabled_modules IS NULL OR enabled_modules = ''"
      ).all() as any[];
    } catch (e) { return { updated: 0 }; }
    let updated = 0;
    const upd = db.prepare("UPDATE organization_settings SET enabled_modules = ? WHERE organization_id = ?");
    for (const r of rows) {
      const v = getVertical(r.vertical) || getVertical("outro");
      if (!v) continue;
      try { upd.run(JSON.stringify(this.sanitize(v.modules)), r.organization_id); updated++; } catch (e) { /* noop */ }
    }
    if (updated) console.log(`[Modules] Backfill: ${updated} organização(ões) com módulos explícitos.`);
    return { updated };
  }

  /** Sanitiza uma lista de módulos para apenas os opcionais conhecidos. */
  static sanitize(modules: any): string[] {
    if (!Array.isArray(modules)) return [];
    const allowed = new Set<string>(OPTIONAL_MODULES as readonly string[]);
    return [...new Set(modules.filter((m: any) => typeof m === "string" && allowed.has(m)))];
  }

  /**
   * Aplica o preset de uma vertical: grava vertical + enabled_modules.
   *
   * GRANDFATHER (ADR-084 D2): preserva os add-ons opt-in (ADDON_MODULES —
   * retail/clinica/vms/radar/prospect) que a org JÁ tinha habilitados, mesmo
   * que não estejam no preset da vertical. Assim, o corte que tirou `retail` do
   * preset de "varejo" — ou o backfill — NUNCA remove um add-on de quem já usa
   * (ex.: a TOULON mantém o Retail Network Ops ao re-aplicar o Quick-Start).
   */
  static applyVertical(orgId: string, verticalKey: string): void {
    const v = getVertical(verticalKey);
    if (!v) return;
    // ADR-092: vertical = wishlist, plano = teto. Liga por padrão só a interseção
    // (preset ∩ módulos do plano) — os "recomendados". O que a vertical sugere mas
    // o plano não entrega fica como "requer upgrade" na tela de Módulos (não é
    // pré-ligado). Sem plano (modulesForPlan == null) = sem teto = preset inteiro.
    let modules = this.sanitize(v.modules);
    const planModules = PlanService.modulesForPlan(orgId);
    if (planModules != null) modules = modules.filter((m) => planModules.includes(m));
    // Grandfather: um add-on JÁ ligado é preservado ao re-aplicar a vertical
    // (o corte de preset nunca remove de quem já usa — ADR-084).
    const current = this.enabledModules(orgId);
    if (Array.isArray(current)) {
      const addons = new Set<string>(ADDON_MODULES as readonly string[]);
      const keep = current.filter((m) => addons.has(m) && !modules.includes(m));
      if (keep.length) modules = this.sanitize([...modules, ...keep]);
    }
    db.prepare("UPDATE organization_settings SET vertical = ?, enabled_modules = ? WHERE organization_id = ?")
      .run(v.key, JSON.stringify(modules), orgId);
    // Pré-popula o consentimento LGPD conforme a vertical (ADR-093 §3) — só se
    // ainda não configurado (não sobrescreve ajuste do dono).
    try { LgpdService.seedConsentForVertical(orgId, v.key); } catch (e) { /* noop */ }
  }

  /** Salva o override manual de módulos (Configurações › Módulos). */
  static setModules(orgId: string, modules: any): string[] {
    const clean = this.sanitize(modules);
    db.prepare("UPDATE organization_settings SET enabled_modules = ? WHERE organization_id = ?")
      .run(JSON.stringify(clean), orgId);
    return clean;
  }

  /**
   * Habilita UM módulo opcional para a org (idempotente), sem remover os demais.
   * Se `enabled_modules` estava nulo (legado = "tudo ligado"), torna o conjunto
   * EXPLÍCITO a partir do preset da vertical (ou "outro") antes de adicionar —
   * assim ligar um add-on nunca restringe silenciosamente a org ao módulo novo.
   * Usado pelo opt-in de add-ons como o Retail Network Ops (ADR-084 D2).
   */
  static enableModule(orgId: string, moduleKey: string): string[] {
    let mods = this.enabledModules(orgId);
    if (!Array.isArray(mods)) {
      const o = db.prepare("SELECT vertical FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      const v = getVertical(o?.vertical) || getVertical("outro");
      mods = v ? [...v.modules] : [];
    }
    if (!mods.includes(moduleKey)) mods = [...mods, moduleKey];
    return this.setModules(orgId, mods);
  }

  static catalog() { return VERTICALS; }
}
