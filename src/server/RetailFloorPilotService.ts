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
import { randomUUID } from "crypto";
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
  // Corretores das pendências do checklist (cada item tem seu comando):
  linkSellers?: Array<{ matricula: string; email: string }>; // vincula login ao vendedor
  responsiblePhone?: string | null; // destinatário do resumo (retail_store_responsibles) — exige storeCode
  responsibleName?: string | null;
  storeWhatsapp?: string | null;    // número da própria loja (fallback do resumo) — exige storeCode
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
    if (!moduleEnabled) checklist.push("Módulo retail_floor DESLIGADO — corrige: --apply");
    if (!settings.calibrationUntil) checklist.push("Sem calibração definida (RN-150-011: sem ela os números valem pra cobrança desde o dia 1) — corrige: --apply --calibration-days 30");
    if (!stores.length) checklist.push("NENHUMA loja ativa cadastrada (retail_stores) — cadastre no app (Operação da Rede) antes do piloto.");
    for (const s of stores) if (!s.hasManager) checklist.push(`Loja ${s.name}${s.code ? ` (${s.code})` : ""} sem manager_user_id — corrige: --apply --store ${s.code || "<code>"} --manager-email <email-do-gerente>`);
    if (Number(sellers?.total || 0) === 0) checklist.push("Nenhum vendedor ativo em retail_sellers — cadastre a equipe no app (matrícula = a do ERP); sem CLI pra isso de propósito (cadastro é operação).");
    else if (Number(sellers?.linked || 0) === 0) checklist.push("Nenhum vendedor com user_id vinculado (sem vínculo, só o gerente opera a fila por eles) — corrige: --apply --link-sellers \"M-01=ana@...,M-02=bia@...\"");
    if (!channel) checklist.push("Sem canal WhatsApp conectado — conecte no app (Configurações › Canais); o resumo diário não tem por onde sair.");
    if (settings.dailyDigestEnabled && stores.every((s) => !s.responsibles && !s.whatsapp)) checklist.push("Resumo diário LIGADO mas nenhuma loja tem destinatário — corrige: --apply --store <code> --responsible <fone> [--responsible-name \"Nome\"]");
    if (!cursor?.t) checklist.push("Conector Alterdata sem sync registrado — configure/teste no app (Configurações › Integrações › Alterdata); conciliação e estoque-rede ficam vazios até o 1º sync.");

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

    // Ações por loja (gerente/responsável/número) exigem a loja-alvo.
    const storeActions = !!(opts.managerEmail || opts.responsiblePhone || opts.storeWhatsapp);
    if (storeActions && !opts.storeCode) throw new Error("Passe --store <code> junto de manager-email/responsible/store-whatsapp.");
    let store: any = null;
    if (opts.storeCode) {
      store = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND code = ? AND active = 1`).get(orgId, String(opts.storeCode)) as any;
      if (!store) throw new Error(`Loja com code=${opts.storeCode} não encontrada/ativa nesta org.`);
    }

    const findUser = (email: string) => {
      const u = db.prepare(`SELECT id, email FROM users WHERE organization_id = ? AND LOWER(email) = ? AND global_status = 'active'`).get(orgId, email.toLowerCase()) as any;
      if (!u) throw new Error(`Usuário ${email} não encontrado/ativo NESTA organização.`);
      return u;
    };

    let managerSet: string | null = null;
    if (opts.managerEmail) {
      const user = findUser(String(opts.managerEmail));
      db.prepare(`UPDATE retail_stores SET manager_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(user.id, orgId, store.id);
      managerSet = `${user.email} → ${store.name}`;
    }

    // Pendência "vendedor sem user_id vinculado": matricula=email, idempotente.
    const sellersLinked: string[] = [];
    for (const link of opts.linkSellers || []) {
      const seller = db.prepare(`SELECT id, matricula FROM retail_sellers WHERE organization_id = ? AND matricula = ? AND active = 1`).get(orgId, String(link.matricula)) as any;
      if (!seller) throw new Error(`Vendedor com matrícula ${link.matricula} não encontrado/ativo nesta org.`);
      const user = findUser(String(link.email));
      db.prepare(`UPDATE retail_sellers SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(user.id, orgId, seller.id);
      sellersLinked.push(`${seller.matricula}→${user.email}`);
    }

    // Pendência "resumo sem destinatário": responsável da loja (dedupe por número).
    let responsibleSet: string | null = null;
    if (opts.responsiblePhone) {
      const phone = String(opts.responsiblePhone).replace(/\D/g, "");
      if (phone.length < 10) throw new Error("responsible deve ser um número WhatsApp válido (DDI+DDD+número).");
      const existing = db.prepare(`SELECT id FROM retail_store_responsibles WHERE organization_id = ? AND store_id = ? AND whatsapp_identifier = ?`).get(orgId, store.id, phone) as any;
      if (existing) db.prepare(`UPDATE retail_store_responsibles SET active = 1, name = COALESCE(?, name), updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(opts.responsibleName || null, existing.id);
      else db.prepare(`INSERT INTO retail_store_responsibles (id, organization_id, store_id, name, whatsapp_identifier) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), orgId, store.id, opts.responsibleName || null, phone);
      responsibleSet = `${phone} → ${store.name}`;
    }
    if (opts.storeWhatsapp) {
      const phone = String(opts.storeWhatsapp).replace(/\D/g, "");
      if (phone.length < 10) throw new Error("store-whatsapp deve ser um número WhatsApp válido.");
      db.prepare(`UPDATE retail_stores SET whatsapp_identifier = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(phone, orgId, store.id);
    }

    try {
      logAuthEvent(orgId, ACTOR, null, "RETAIL_FLOOR_PILOT_APPLY", {
        calibrationDays: days, digest: opts.digest ?? null, digestHour: opts.digestHour ?? null,
        managerSet, sellersLinked, responsibleSet, storeWhatsapp: opts.storeWhatsapp || null,
        moduleWasEnabled: before.moduleEnabled,
      });
    } catch { /* noop */ }
    return this.plan(orgId);
  }
}

export default RetailFloorPilotService;
