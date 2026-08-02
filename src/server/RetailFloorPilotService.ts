/**
 * Retail Floor — Ativação do piloto (ADR-150, operação).
 *
 * O que o CLI de piloto usa pra ligar o módulo numa org REAL (TOULON) e
 * conferir se a loja está pronta pra operar. Idempotente de ponta a ponta:
 * rodar de novo não duplica nada — só re-aplica e re-diagnostica.
 *
 * `plan` NÃO escreve nada (é o dry-run/diagnóstico); `apply` liga o módulo,
 * grava a calibração (RN-150-011) e, opcionalmente, o gerente da loja e o
 * resumo diário — tudo auditado com actor "pilot-cli".
 *
 * RN-150-001: orgId sempre 1º arg; toda query filtra organization_id.
 */
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ModuleService } from "./ModuleService.js";
import { RetailFloorSettingsService } from "./RetailFloorService.js";

const ACTOR = "pilot-cli";
const dayPlus = (days: number) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export interface PilotApplyOpts {
  calibrationDays?: number;         // default 30
  storeCode?: string | null;        // loja piloto (retail_stores.code)
  managerEmail?: string | null;     // vira manager_user_id da loja piloto
  digest?: boolean;                 // liga o resumo diário (Fatia 10)
  digestHour?: number | null;       // hora BRT do resumo
}

export class RetailFloorPilotService {
  /** Busca orgs candidatas pelo nome (pra achar a TOULON sem chutar id). */
  static findOrgs(term: string): any[] {
    return (db.prepare(
      `SELECT organization_id, business_name, vertical, status FROM organization_settings
        WHERE deleted_at IS NULL AND LOWER(COALESCE(business_name, '')) LIKE ? ORDER BY business_name LIMIT 20`
    ).all(`%${String(term || "").toLowerCase()}%`) as any[])
      .map((r) => ({ orgId: r.organization_id, name: r.business_name, vertical: r.vertical || null, status: r.status }));
  }

  /** Diagnóstico SEM escrita: o que está pronto e o que falta pro piloto. */
  static plan(orgId: string): any {
    const org = db.prepare(`SELECT organization_id, business_name, vertical, status FROM organization_settings WHERE organization_id = ? AND deleted_at IS NULL`).get(orgId) as any;
    if (!org) throw new Error("Organização não encontrada (ou removida).");

    const moduleEnabled = ModuleService.isEnabled(orgId, "retail_floor");
    const settings = RetailFloorSettingsService.get(orgId);

    const stores = (db.prepare(
      `SELECT s.id, s.name, s.code, s.manager_user_id, s.whatsapp_identifier,
              (SELECT COUNT(*) FROM retail_store_responsibles r WHERE r.organization_id = s.organization_id AND r.store_id = s.id AND r.active = 1) AS responsibles,
              u.email AS manager_email
         FROM retail_stores s
         LEFT JOIN users u ON u.id = s.manager_user_id
        WHERE s.organization_id = ? AND s.active = 1 ORDER BY s.name`
    ).all(orgId) as any[]).map((s) => ({
      id: s.id, name: s.name, code: s.code || null,
      managerEmail: s.manager_email || null,
      hasManager: !!s.manager_user_id,
      whatsapp: s.whatsapp_identifier || null,
      responsibles: Number(s.responsibles),
    }));

    const sellers = db.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN user_id IS NOT NULL AND user_id != '' THEN 1 ELSE 0 END) AS linked
         FROM retail_sellers WHERE organization_id = ? AND active = 1`
    ).get(orgId) as any;

    const channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' LIMIT 1`).get(orgId) as any;
    const cursor = db.prepare(`SELECT MAX(last_synced_at) AS t FROM alterdata_sync_cursors WHERE organization_id = ?`).get(orgId) as any;

    const checklist: string[] = [];
    if (!moduleEnabled) checklist.push("Módulo retail_floor DESLIGADO — o apply liga.");
    if (!settings.calibrationUntil) checklist.push("Sem calibração definida — o apply grava (RN-150-011: sem ela os números valem pra cobrança desde o dia 1).");
    if (!stores.length) checklist.push("NENHUMA loja ativa cadastrada (retail_stores) — cadastre antes do piloto.");
    for (const s of stores) if (!s.hasManager) checklist.push(`Loja ${s.name}${s.code ? ` (${s.code})` : ""} sem manager_user_id — o gerente não terá o escopo de gestão.`);
    if (Number(sellers?.total || 0) === 0) checklist.push("Nenhum vendedor ativo em retail_sellers — cadastre a equipe (matrícula = a do ERP).");
    else if (Number(sellers?.linked || 0) === 0) checklist.push("Nenhum vendedor com user_id vinculado — sem vínculo, só o gerente opera a fila por eles.");
    if (!channel) checklist.push("Sem canal WhatsApp conectado — o resumo diário (opt-in) não terá por onde sair.");
    if (settings.dailyDigestEnabled && stores.every((s) => !s.responsibles && !s.whatsapp)) checklist.push("Resumo diário LIGADO mas nenhuma loja tem responsável (ADR-108) nem número — não haverá destinatário.");
    if (!cursor?.t) checklist.push("Conector Alterdata sem sync registrado — conciliação e estoque-rede ficam vazios até o primeiro sync.");

    return {
      org: { orgId: org.organization_id, name: org.business_name, vertical: org.vertical || null, status: org.status },
      moduleEnabled, settings, stores,
      sellers: { total: Number(sellers?.total || 0), linkedToUser: Number(sellers?.linked || 0) },
      channelConnected: !!channel,
      alterdataLastSync: cursor?.t || null,
      readiness: checklist.length === 0 ? "PRONTO" : "PENDÊNCIAS",
      checklist,
    };
  }

  /** Aplica o piloto (idempotente, auditado). Retorna o plan() pós-aplicação. */
  static apply(orgId: string, opts: PilotApplyOpts = {}): any {
    const before = this.plan(orgId); // valida a org e serve de baseline no audit

    ModuleService.enableModule(orgId, "retail_floor");
    const days = Math.trunc(Number(opts.calibrationDays ?? 30));
    if (!Number.isFinite(days) || days < 0 || days > 365) throw new Error("calibrationDays deve estar entre 0 e 365.");
    const patch: any = { calibrationUntil: days === 0 ? null : dayPlus(days) };
    if (opts.digest != null) patch.dailyDigestEnabled = !!opts.digest;
    if (opts.digestHour != null) patch.digestHour = opts.digestHour;
    RetailFloorSettingsService.update(orgId, patch, ACTOR);

    let managerSet: string | null = null;
    if (opts.storeCode && opts.managerEmail) {
      const store = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND code = ? AND active = 1`).get(orgId, String(opts.storeCode)) as any;
      if (!store) throw new Error(`Loja com code=${opts.storeCode} não encontrada/ativa nesta org.`);
      const user = db.prepare(`SELECT id, email FROM users WHERE organization_id = ? AND LOWER(email) = ? AND global_status = 'active'`).get(orgId, String(opts.managerEmail).toLowerCase()) as any;
      if (!user) throw new Error(`Usuário ${opts.managerEmail} não encontrado/ativo NESTA organização.`);
      db.prepare(`UPDATE retail_stores SET manager_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(user.id, orgId, store.id);
      managerSet = `${user.email} → ${store.name}`;
    } else if (opts.storeCode || opts.managerEmail) {
      throw new Error("Pra definir o gerente, passe storeCode E managerEmail juntos.");
    }

    try {
      logAuthEvent(orgId, ACTOR, null, "RETAIL_FLOOR_PILOT_APPLY", {
        calibrationDays: days, digest: opts.digest ?? null, digestHour: opts.digestHour ?? null,
        managerSet, moduleWasEnabled: before.moduleEnabled,
      });
    } catch { /* noop */ }
    return this.plan(orgId);
  }
}

export default RetailFloorPilotService;
