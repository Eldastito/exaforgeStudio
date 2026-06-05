import db from "./db.js";
import { VERTICALS, OPTIONAL_MODULES, getVertical } from "./verticals.js";

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
  };

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
    if (em == null) return true; // sem configuração explícita ⇒ liberado
    return em.includes(moduleKey);
  }

  /** Sanitiza uma lista de módulos para apenas os opcionais conhecidos. */
  static sanitize(modules: any): string[] {
    if (!Array.isArray(modules)) return [];
    const allowed = new Set<string>(OPTIONAL_MODULES as readonly string[]);
    return [...new Set(modules.filter((m: any) => typeof m === "string" && allowed.has(m)))];
  }

  /** Aplica o preset de uma vertical: grava vertical + enabled_modules. */
  static applyVertical(orgId: string, verticalKey: string): void {
    const v = getVertical(verticalKey);
    if (!v) return;
    const modules = this.sanitize(v.modules);
    db.prepare("UPDATE organization_settings SET vertical = ?, enabled_modules = ? WHERE organization_id = ?")
      .run(v.key, JSON.stringify(modules), orgId);
  }

  /** Salva o override manual de módulos (Configurações › Módulos). */
  static setModules(orgId: string, modules: any): string[] {
    const clean = this.sanitize(modules);
    db.prepare("UPDATE organization_settings SET enabled_modules = ? WHERE organization_id = ?")
      .run(JSON.stringify(clean), orgId);
    return clean;
  }

  static catalog() { return VERTICALS; }
}
