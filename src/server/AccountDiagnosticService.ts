import db from "./db.js";
import { ModuleService } from "./ModuleService.js";
import { getVertical } from "./verticals.js";
import { MASTER_ADMIN_EMAIL } from "./config/secret.js";

/**
 * Diagnóstico de conta (go-live) — um "está tudo certo?" por organização.
 *
 * Reúne, num JSON só: quem é a conta (plano/vertical), o nível de acesso do
 * usuário (é operador da plataforma? é dono?), o RECORTE de módulos (a conta
 * está restrita à vertical ou "vê tudo"?) e os sinais operacionais do go-live
 * (canais, catálogo, loja publicada, usuários...). Não expõe segredo nem dado de
 * outra org — é sempre escopado por organization_id.
 */

interface DiagUser { email?: string | null; role?: string | null; }

export class AccountDiagnosticService {
  private static count(sql: string, ...params: any[]): number {
    try { return (db.prepare(sql).get(...params) as any)?.c || 0; } catch { return 0; }
  }

  static report(orgId: string, user: DiagUser): any {
    const org = db.prepare(
      `SELECT business_name, status, plan_id, vertical FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any || {};
    const plan = org.plan_id ? (db.prepare(`SELECT name FROM plans WHERE id = ?`).get(org.plan_id) as any) : null;

    // ---- acesso ----
    const isMasterAdmin = !!(user?.email && user.email === MASTER_ADMIN_EMAIL);
    const role = user?.role || "agent";

    // ---- recorte de módulos (o ponto do "vê tudo") ----
    const enabled = ModuleService.enabledModules(orgId); // null = tudo ligado (legado)
    const restricted = Array.isArray(enabled);
    const modaExpected: string[] = getVertical("moda")?.modules || [];
    const modaEnabled = modaExpected.filter((m) => ModuleService.isEnabled(orgId, m));
    const modaMissing = modaExpected.filter((m) => !ModuleService.isEnabled(orgId, m));
    // Módulos ligados que NÃO fazem parte da moda (o "excesso" que polui o menu).
    const extraBeyondModa = restricted ? (enabled as string[]).filter((m) => !modaExpected.includes(m)) : null;

    // ---- sinais operacionais do go-live ----
    const channelsConnected = this.count(`SELECT COUNT(*) c FROM channels WHERE organization_id = ? AND status = 'connected'`, orgId);
    const whatsappConnected = this.count(`SELECT COUNT(*) c FROM channels WHERE organization_id = ? AND status = 'connected' AND LOWER(provider) LIKE '%whats%'`, orgId) > 0;
    const catalogProducts = this.count(`SELECT COUNT(*) c FROM products_services WHERE organization_id = ? AND type = 'product' AND active = 1`, orgId);
    const catalogPublished = this.count(`SELECT COUNT(*) c FROM products_services WHERE organization_id = ? AND type = 'product' AND active = 1 AND COALESCE(storefront_visible,1) = 1 AND price > 0`, orgId);
    const store = db.prepare(`SELECT slug, published, fashion_studio_enabled FROM storefront_settings WHERE organization_id = ?`).get(orgId) as any;
    const presetAvatars = this.count(`SELECT COUNT(*) c FROM fashion_preset_avatars WHERE organization_id = ? AND active = 1`, orgId);
    const usersCount = this.count(`SELECT COUNT(*) c FROM users WHERE organization_id = ?`, orgId);

    // ---- recomendações acionáveis ----
    const recommendations: string[] = [];
    if (!restricted) recommendations.push("A conta mostra TODOS os módulos (sem recorte). Aplique a vertical moda para o menu ficar só com o que a loja usa.");
    else if (org.vertical !== "moda") recommendations.push(`A vertical atual é "${org.vertical || "não definida"}". Considere aplicar a vertical moda.`);
    if (modaMissing.length) recommendations.push(`Módulos da moda ainda desligados: ${modaMissing.join(", ")}.`);
    if (!whatsappConnected) recommendations.push("Conecte o WhatsApp oficial (Canais e IA).");
    if (catalogProducts === 0) recommendations.push("Cadastre produtos no catálogo (foto no WhatsApp, import ou manual).");
    else if (catalogPublished === 0) recommendations.push("Nenhum produto publicado na vitrine (defina preço + visível).");
    if (!store?.published) recommendations.push("Publique a Loja Virtual (Configurações da Loja).");
    if (usersCount <= 1) recommendations.push("Crie os usuários da equipe (perfis RBAC: vendedor/estoquista/gerente).");

    return {
      account: {
        organizationId: orgId,
        businessName: org.business_name || null,
        status: org.status || null,
        planId: org.plan_id || null,
        planName: plan?.name || null,
        vertical: org.vertical || null,
      },
      access: {
        role,
        isOwner: role === "owner",
        isMasterAdmin,               // operador da PLATAFORMA (não deve ser a TOULON)
        seesOnlyOwnOrg: !isMasterAdmin, // conta comum é isolada por organization_id
      },
      modules: {
        restricted,                  // false = "vê tudo" (enabled_modules NULL/legado)
        vertical: org.vertical || null,
        modaExpected,
        modaEnabled,
        modaMissing,
        extraBeyondModa,             // módulos ligados fora da moda (null se não restrito)
        enabledCount: restricted ? (enabled as string[]).length : "todos",
      },
      goLive: {
        whatsappConnected,
        channelsConnected,
        catalogProducts,
        catalogPublished,
        storefrontSlug: store?.slug || null,
        storefrontPublished: !!store?.published,
        fashionStudioEnabled: !!store?.fashion_studio_enabled,
        presetAvatars,
        usersCount,
      },
      recommendations,
    };
  }
}
