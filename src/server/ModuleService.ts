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
    procurement: "compras",
    quotes: "orcamentos",
    events: "eventos",
    executive: "diretor",
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
    // Sem configuração explícita ⇒ só o NÚCLEO (módulos opcionais ficam ocultos
    // até a org escolher a vertical no onboarding / Quick-Start). O backfill
    // (backfillNullModules) torna explícito o que as orgs existentes já tinham,
    // então esse caso só ocorre na janela curta antes do onboarding.
    if (em == null) return false;
    return em.includes(moduleKey);
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
