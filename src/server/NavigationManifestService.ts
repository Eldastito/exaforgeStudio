/**
 * NavigationManifestService (ADR-163 / PRD 6 §6-§7, §96-§97, F2) — a navegação por
 * NECESSIDADE, derivada por PAPEL + ENTITLEMENT. Materializa a D2: o menu deixa de ser
 * uma lista de MÓDULOS e passa a ser um MANIFESTO — as superfícies-necessidade
 * (Hoje/Fala Tu/Executando/Resultados/Empresa) no 1º nível, e os módulos operacionais
 * no 2º nível ("Explorar"), já FILTRADOS pelo que o usuário pode e deve ver.
 *
 * Sem nav concorrente nem módulo novo (RN-UX-1): é COMPOSIÇÃO read-only sobre a porta
 * única de entitlement (`EntitlementService.overview`) + a projeção por papel embutida
 * nela (RBAC → `visibility`). Guardrails:
 *   - ESCONDER ≠ DESABILITAR (§55-56/D3/CA4): módulo fora do plano/vertical/permissão
 *     NÃO é renderizado — nunca "catálogo de cadeados". Só `active` entra em Explorar;
 *     o que está no plano mas desligado vira uma CONTAGEM (`moreInPlan`), não um item.
 *   - RBAC sempre respeitado (§97/CA14): `visibility='hidden'` (perfil sem acesso) some.
 *   - Determinístico (§91): roda em CI sem IA. Isolado por org (RN-UX-7).
 *
 * O backend SEMPRE computa o manifesto; a flag `simplified_navigation_enabled` só diz ao
 * frontend SE renderiza a nav simplificada (§93/§94 — rollout progressivo, legado intacto).
 */
import db from "./db.js";
import { EntitlementService } from "./EntitlementService.js";
import { ModuleService } from "./ModuleService.js";

// Módulos CORE que pertencem a "Empresa" (config estratégica), não a "Explorar".
const COMPANY_MODULES = new Set(["configuracoes"]);
// Rótulos dos módulos CORE (o MODULE_META cobre os OPTIONAL; estes são os utilitários).
const CORE_LABELS: Record<string, { label: string; desc: string }> = {
  atendimento: { label: "Atendimento", desc: "Conversas e casos dos clientes." },
  contatos: { label: "Contatos", desc: "Clientes e cadastros." },
  relatorios: { label: "Relatórios", desc: "Visões e exportações." },
  configuracoes: { label: "Configurações", desc: "Ajustes da conta." },
};

export interface NavPrimaryItem { key: string; label: string; section: string; available: boolean; }
export interface NavExploreItem { key: string; label: string; desc: string; state: string; }
export interface NavigationManifest {
  generatedAt: string;
  simplifiedNavEnabled: boolean;
  primary: NavPrimaryItem[];
  explore: NavExploreItem[];
  moreInPlan: number;   // recursos DO PLANO ainda desligados — contagem, não itens (§56)
}

export class NavigationManifestService {
  private static labelFor(key: string): { label: string; desc: string } {
    return (ModuleService.MODULE_META as any)?.[key] || CORE_LABELS[key] || { label: key, desc: "" };
  }

  /** Manifesto de navegação do usuário: necessidade-primeiro + Explorar filtrado. */
  static forUser(orgId: string, user: any): NavigationManifest {
    const org = db.prepare(
      `SELECT COALESCE(falatu_enabled,0) falatu, COALESCE(simplified_navigation_enabled,0) simplified FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any || {};

    // ── Superfícies-necessidade (1º nível, §7) ──
    const role = String(user?.role || "");
    const isManager = role === "owner" || role === "admin";
    const primary: NavPrimaryItem[] = [{ key: "hoje", label: "Hoje", section: "today", available: true }];
    if (org.falatu) primary.push({ key: "falatu", label: "Fala Tu", section: "falatu", available: true });
    primary.push({ key: "executando", label: "Executando", section: "executing", available: true });
    primary.push({ key: "resultados", label: "Resultados", section: "results", available: true });
    // "Empresa" = config estratégica (objetivos/autonomia/equipe/integrações) — gestor.
    if (isManager) primary.push({ key: "empresa", label: "Empresa", section: "company", available: true });

    // ── Explorar (2º nível): só o que o usuário PODE e DEVE ver AGORA ──
    const overview = EntitlementService.overview(orgId, user);
    const explore: NavExploreItem[] = [];
    let moreInPlan = 0;
    for (const [key, d] of Object.entries(overview) as Array<[string, any]>) {
      if (COMPANY_MODULES.has(key)) continue;          // vai pra "Empresa"
      if (d?.visibility !== "visible") continue;        // RBAC sem acesso → some (CA14)
      if (d?.state === "active") {
        const meta = this.labelFor(key);
        explore.push({ key, label: meta.label, desc: meta.desc, state: "active" });
      } else if (d?.state === "available_to_enable") {
        moreInPlan++;                                   // no plano, desligado → contagem (§56)
      }
      // available_to_buy / hidden / suspended / deprecated / pilot_only → NÃO renderiza
    }
    explore.sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));

    return {
      generatedAt: new Date().toISOString(),
      simplifiedNavEnabled: !!org.simplified,
      primary,
      explore,
      moreInPlan,
    };
  }
}

export default NavigationManifestService;
