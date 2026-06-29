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
}
