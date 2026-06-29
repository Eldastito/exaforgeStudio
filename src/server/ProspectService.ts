import db from "./db.js";
import { randomUUID } from "node:crypto";

/**
 * Prospect AI — Inteligência de Prospecção B2B (Fase 0: fundação).
 * Aqui ficam o ICP (perfil de conta ideal) e as Campanhas em rascunho.
 * Descoberta, enriquecimento, evidências, score e outreach entram nas próximas
 * fases. Determinístico/read-write; nada de IA ainda nesta camada.
 *
 * Princípios do PRD respeitados desde já: nada de scraping; campanha nasce em
 * RASCUNHO; tudo escopado por organização (multi-tenant).
 */
const OBJECTIVES = ["reuniao", "diagnostico", "evento", "proposta"];
const APPROVAL = ["manual", "manager", "auto_rules"];

const onlyDigits = (s: any) => String(s || "").replace(/\D/g, "");
// Domínio normalizado a partir de site OU e-mail (sem protocolo/www/caminho).
function normDomain(...candidates: any[]): string {
  for (const c of candidates) {
    let v = String(c || "").trim().toLowerCase();
    if (!v) continue;
    if (v.includes("@")) v = v.split("@")[1] || "";
    v = v.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0].trim();
    if (v && v.includes(".")) return v;
  }
  return "";
}
// Nome normalizado para deduplicar empresa (sem acento, pontuação e sufixos).
function normName(s: any): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(ltda|me|eireli|s\.?a\.?|epp|cia|company|inc|corp)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function parseCriteria(raw: any): any {
  if (!raw) return {};
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return {}; }
}

export class ProspectService {
  // ── ICP (perfil de conta ideal) ─────────────────────────────────────────
  static listIcps(orgId: string): any[] {
    const rows = db.prepare(
      "SELECT * FROM prospect_icp_profiles WHERE organization_id = ? AND status != 'archived' ORDER BY created_at DESC"
    ).all(orgId) as any[];
    return rows.map(r => ({ ...r, criteria: parseCriteria(r.criteria_json) }));
  }

  static createIcp(orgId: string, input: { name?: string; vertical?: string; criteria?: any }, actorId?: string): any {
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("Dê um nome ao ICP.");
    const id = randomUUID();
    db.prepare(
      "INSERT INTO prospect_icp_profiles (id, organization_id, name, vertical, criteria_json, status, created_by) VALUES (?, ?, ?, ?, ?, 'active', ?)"
    ).run(id, orgId, name, String(input?.vertical || ""), JSON.stringify(input?.criteria || {}), actorId || null);
    return this.getIcp(orgId, id);
  }

  static getIcp(orgId: string, id: string): any {
    const r = db.prepare("SELECT * FROM prospect_icp_profiles WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    return r ? { ...r, criteria: parseCriteria(r.criteria_json) } : null;
  }

  static updateIcp(orgId: string, id: string, patch: any): any {
    const cur = db.prepare("SELECT id FROM prospect_icp_profiles WHERE id = ? AND organization_id = ?").get(id, orgId);
    if (!cur) throw new Error("ICP não encontrado.");
    const fields: string[] = [], params: any[] = [];
    if (patch.name !== undefined) { const n = String(patch.name).trim(); if (n) { fields.push("name = ?"); params.push(n); } }
    if (patch.vertical !== undefined) { fields.push("vertical = ?"); params.push(String(patch.vertical || "")); }
    if (patch.criteria !== undefined) { fields.push("criteria_json = ?"); params.push(JSON.stringify(patch.criteria || {})); }
    if (!fields.length) return this.getIcp(orgId, id);
    params.push(id, orgId);
    db.prepare(`UPDATE prospect_icp_profiles SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...params);
    return this.getIcp(orgId, id);
  }

  static archiveIcp(orgId: string, id: string): boolean {
    const r = db.prepare("UPDATE prospect_icp_profiles SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND status != 'archived'").run(id, orgId);
    return r.changes > 0;
  }

  // ── Campanhas (nascem em rascunho) ──────────────────────────────────────
  static listCampaigns(orgId: string): any[] {
    return db.prepare(`
      SELECT c.*, i.name AS icp_name
      FROM prospect_campaigns c
      LEFT JOIN prospect_icp_profiles i ON i.id = c.icp_id
      WHERE c.organization_id = ? AND c.status != 'archived'
      ORDER BY c.created_at DESC
    `).all(orgId) as any[];
  }

  static createCampaign(orgId: string, input: {
    name?: string; icpId?: string; objective?: string; budgetLimit?: number; dailyLimit?: number; approvalMode?: string;
  }, actorId?: string): any {
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("Dê um nome à campanha.");
    if (input?.icpId) {
      const icp = db.prepare("SELECT id FROM prospect_icp_profiles WHERE id = ? AND organization_id = ?").get(input.icpId, orgId);
      if (!icp) throw new Error("ICP selecionado não existe.");
    }
    const objective = OBJECTIVES.includes(String(input?.objective)) ? input.objective : "reuniao";
    const approval = APPROVAL.includes(String(input?.approvalMode)) ? input.approvalMode : "manual";
    const id = randomUUID();
    db.prepare(`
      INSERT INTO prospect_campaigns (id, organization_id, icp_id, name, objective, status, budget_limit_brl, daily_contact_limit, approval_mode, created_by)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(id, orgId, input?.icpId || null, name, objective, Math.max(0, Number(input?.budgetLimit) || 0), Math.max(0, parseInt(String(input?.dailyLimit), 10) || 0), approval, actorId || null);
    return this.getCampaign(orgId, id);
  }

  static getCampaign(orgId: string, id: string): any {
    return db.prepare("SELECT * FROM prospect_campaigns WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
  }

  static updateCampaign(orgId: string, id: string, patch: any): any {
    const cur = db.prepare("SELECT id FROM prospect_campaigns WHERE id = ? AND organization_id = ?").get(id, orgId);
    if (!cur) throw new Error("Campanha não encontrada.");
    const fields: string[] = [], params: any[] = [];
    if (patch.name !== undefined) { const n = String(patch.name).trim(); if (n) { fields.push("name = ?"); params.push(n); } }
    if (patch.objective !== undefined && OBJECTIVES.includes(patch.objective)) { fields.push("objective = ?"); params.push(patch.objective); }
    if (patch.icpId !== undefined) { fields.push("icp_id = ?"); params.push(patch.icpId || null); }
    if (patch.budgetLimit !== undefined) { fields.push("budget_limit_brl = ?"); params.push(Math.max(0, Number(patch.budgetLimit) || 0)); }
    if (patch.dailyLimit !== undefined) { fields.push("daily_contact_limit = ?"); params.push(Math.max(0, parseInt(String(patch.dailyLimit), 10) || 0)); }
    if (patch.approvalMode !== undefined && APPROVAL.includes(patch.approvalMode)) { fields.push("approval_mode = ?"); params.push(patch.approvalMode); }
    // Transições de status (draft → active/paused/...) — somente valores válidos.
    if (patch.status !== undefined && ["draft", "active", "paused", "completed", "archived"].includes(patch.status)) { fields.push("status = ?"); params.push(patch.status); }
    if (!fields.length) return this.getCampaign(orgId, id);
    params.push(id, orgId);
    db.prepare(`UPDATE prospect_campaigns SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...params);
    return this.getCampaign(orgId, id);
  }

  // ── Importação de contas/contatos (CSV) + deduplicação ──────────────────
  /**
   * Importa registros JÁ normalizados (o front faz o parse/mapeamento do CSV).
   * Cada registro: { company, domain, website, city, state, industry, cnpj,
   * contactName, role, email, phone }. Deduplica conta por domínio (ou nome) e
   * contato por e-mail/telefone. Registra a fonte (origem + política).
   */
  static importRecords(orgId: string, input: { campaignId?: string; sourceRef?: string; records: any[] }, _actorId?: string):
    { sourceId: string; accountsCreated: number; accountsMerged: number; contactsCreated: number; contactsSkipped: number; total: number } {
    const records = Array.isArray(input?.records) ? input.records.slice(0, 5000) : [];
    if (!records.length) throw new Error("Nenhum registro para importar.");
    if (input?.campaignId) {
      const c = db.prepare("SELECT id FROM prospect_campaigns WHERE id = ? AND organization_id = ?").get(input.campaignId, orgId);
      if (!c) throw new Error("Campanha não encontrada.");
    }
    const sourceId = randomUUID();
    db.prepare("INSERT INTO prospect_data_sources (id, organization_id, provider, source_reference, terms_profile, retention_policy, confidence) VALUES (?, ?, 'csv_import', ?, 'user_provided', 'tenant_policy', 1.0)")
      .run(sourceId, orgId, String(input?.sourceRef || "importação CSV"));

    let accountsCreated = 0, accountsMerged = 0, contactsCreated = 0, contactsSkipped = 0;
    const findAccount = db.prepare("SELECT id FROM prospect_accounts WHERE organization_id = ? AND dedupe_key = ?");
    const insAccount = db.prepare(`INSERT INTO prospect_accounts (id, organization_id, campaign_id, display_name, domain, website_url, industry, city, state, cnpj, source_id, source, account_status, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'csv_import', 'discovered', ?)`);
    const findContact = db.prepare("SELECT id FROM prospect_contacts WHERE organization_id = ? AND prospect_account_id = ? AND ((email != '' AND email = ?) OR (phone != '' AND phone = ?))");
    const insContact = db.prepare(`INSERT INTO prospect_contacts (id, organization_id, prospect_account_id, full_name, role_title, email, email_status, phone, source_id, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0.6)`);

    const tx = db.transaction(() => {
      for (const r of records) {
        const company = String(r?.company || "").trim();
        const email = String(r?.email || "").trim().toLowerCase();
        const phone = onlyDigits(r?.phone);
        const contactName = String(r?.contactName || "").trim();
        const domain = normDomain(r?.domain, r?.website, email);
        const dedupeKey = domain || normName(company);
        if (!dedupeKey) continue; // linha sem empresa nem domínio → ignora

        const acc = findAccount.get(orgId, dedupeKey) as any;
        let accId: string;
        if (acc) { accId = acc.id; accountsMerged++; }
        else {
          accId = randomUUID();
          insAccount.run(accId, orgId, input?.campaignId || null, company || domain, domain || null,
            String(r?.website || "").trim() || null, String(r?.industry || "").trim() || null,
            String(r?.city || "").trim() || null, String(r?.state || "").trim() || null,
            onlyDigits(r?.cnpj) || null, sourceId, dedupeKey);
          accountsCreated++;
        }

        if (email || phone || contactName) {
          const dup = (email || phone) ? findContact.get(orgId, accId, email, phone) : null;
          if (dup) { contactsSkipped++; }
          else {
            insContact.run(randomUUID(), orgId, accId, contactName || null, String(r?.role || "").trim() || null,
              email || "", email ? "publicly_listed" : "unknown", phone || "", sourceId);
            contactsCreated++;
          }
        }
      }
    });
    tx();
    return { sourceId, accountsCreated, accountsMerged, contactsCreated, contactsSkipped, total: records.length };
  }

  static listAccounts(orgId: string, opts: { campaignId?: string; q?: string } = {}): any[] {
    let sql = `
      SELECT a.*, (SELECT COUNT(*) FROM prospect_contacts c WHERE c.prospect_account_id = a.id) AS contacts_count
      FROM prospect_accounts a WHERE a.organization_id = ?`;
    const params: any[] = [orgId];
    if (opts.campaignId) { sql += " AND a.campaign_id = ?"; params.push(opts.campaignId); }
    if (opts.q) { sql += " AND (a.display_name LIKE ? OR a.domain LIKE ?)"; params.push(`%${opts.q}%`, `%${opts.q}%`); }
    sql += " ORDER BY a.created_at DESC LIMIT 500";
    return db.prepare(sql).all(...params) as any[];
  }

  static getAccount(orgId: string, id: string): any {
    const a = db.prepare("SELECT * FROM prospect_accounts WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!a) return null;
    a.contacts = db.prepare("SELECT * FROM prospect_contacts WHERE prospect_account_id = ? AND organization_id = ? ORDER BY created_at ASC").all(id, orgId) as any[];
    return a;
  }

  static updateAccountStatus(orgId: string, id: string, status: string): boolean {
    if (!["discovered", "researching", "qualified", "disqualified", "contacted", "converted"].includes(status)) throw new Error("Status inválido.");
    const r = db.prepare("UPDATE prospect_accounts SET account_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(status, id, orgId);
    return r.changes > 0;
  }
}
