import { Router } from "express";
import db from "../db.js";
import { AuthRequest } from "../middleware/auth.js";
import { CustomerProfileService } from "../CustomerProfileService.js";

const router = Router();

// GET /api/contacts — lista contatos com dados de CRM (filtros: temperature, tag, inactiveDays)
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { temperature, tag, inactiveDays, minScore, sort } = req.query as any;
    let sql = `SELECT id, name, identifier, profile_pic_url, lead_temperature, lead_score, purchase_count,
                      total_spent, avg_ticket, last_purchase_at, last_contact_at, tags, notes, created_at,
                      COALESCE(is_supplier,0) AS is_supplier, supplier_categories
               FROM contacts WHERE organization_id = ?`;
    const params: any[] = [orgId];
    if (temperature) { sql += ` AND lead_temperature = ?`; params.push(temperature); }
    if (tag) { sql += ` AND tags LIKE ?`; params.push(`%${tag}%`); }
    if (minScore) { sql += ` AND COALESCE(lead_score,0) >= ?`; params.push(parseInt(String(minScore), 10) || 0); }
    if (inactiveDays) {
      sql += ` AND (last_contact_at IS NULL OR last_contact_at < datetime('now', ?))`;
      params.push(`-${parseInt(String(inactiveDays), 10) || 0} days`);
    }
    // Ordenação: por score (padrão para priorização) ou por valor gasto.
    sql += sort === 'spent'
      ? ` ORDER BY total_spent DESC, last_contact_at DESC`
      : ` ORDER BY COALESCE(lead_score,0) DESC, last_contact_at DESC`;
    res.json(db.prepare(sql).all(...params));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/contacts/segments — contagens úteis para campanhas/CRM
router.get("/segments", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const byTemp = db.prepare(`SELECT lead_temperature as t, count(*) as c FROM contacts WHERE organization_id = ? GROUP BY lead_temperature`).all(orgId) as any[];
    const inactive60 = db.prepare(`SELECT count(*) as c FROM contacts WHERE organization_id = ? AND purchase_count > 0 AND (last_purchase_at IS NULL OR last_purchase_at < datetime('now','-60 days'))`).get(orgId) as any;
    const topBuyers = db.prepare(`SELECT id, name, identifier, purchase_count, total_spent FROM contacts WHERE organization_id = ? AND purchase_count > 0 ORDER BY total_spent DESC LIMIT 10`).all(orgId);
    // Lead Scoring: contagem por faixa + os leads mais quentes para priorizar.
    const score = db.prepare(`
      SELECT
        SUM(CASE WHEN COALESCE(lead_score,0) >= 70 THEN 1 ELSE 0 END) as alto,
        SUM(CASE WHEN COALESCE(lead_score,0) >= 40 AND COALESCE(lead_score,0) < 70 THEN 1 ELSE 0 END) as medio,
        SUM(CASE WHEN COALESCE(lead_score,0) < 40 THEN 1 ELSE 0 END) as baixo
      FROM contacts WHERE organization_id = ?
    `).get(orgId) as any;
    const hotLeads = db.prepare(`SELECT id, name, identifier, lead_score, lead_temperature FROM contacts WHERE organization_id = ? ORDER BY COALESCE(lead_score,0) DESC LIMIT 10`).all(orgId);
    res.json({
      byTemperature: byTemp.reduce((acc: any, r) => { acc[r.t || 'frio'] = r.c; return acc; }, {}),
      inactive60Days: inactive60?.c || 0,
      topBuyers,
      byScore: { alto: score?.alto || 0, medio: score?.medio || 0, baixo: score?.baixo || 0 },
      hotLeads,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/contacts/:id — edita tags/notas (gestão humana)
router.patch("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { tags, notes, name, isSupplier, supplierCategories } = req.body || {};
    const updates: string[] = [];
    const vals: any[] = [];
    if (tags !== undefined) { updates.push("tags = ?"); vals.push(typeof tags === 'string' ? tags : (Array.isArray(tags) ? tags.join(',') : '')); }
    if (notes !== undefined) { updates.push("notes = ?"); vals.push(notes); }
    if (name !== undefined) { updates.push("name = ?"); vals.push(name); }
    if (isSupplier !== undefined) { updates.push("is_supplier = ?"); vals.push(isSupplier ? 1 : 0); }
    if (supplierCategories !== undefined) {
      const csv = Array.isArray(supplierCategories) ? supplierCategories.join(',') : String(supplierCategories || '');
      updates.push("supplier_categories = ?"); vals.push(csv);
    }
    if (!updates.length) return res.json({ success: true });
    db.prepare(`UPDATE contacts SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...vals, req.params.id, orgId);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/contacts/recompute — backfill: recalcula stats/temperatura de todos
router.post("/recompute", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const ids = db.prepare(`SELECT id FROM contacts WHERE organization_id = ?`).all(orgId) as any[];
    for (const r of ids) CustomerProfileService.recomputePurchaseStats(orgId, r.id);
    res.json({ success: true, updated: ids.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/contacts/export.csv — exporta o CRM (com filtros iguais ao GET /)
router.get("/export.csv", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { temperature, tag, inactiveDays, minScore } = req.query as any;
    let sql = `SELECT name, identifier, lead_temperature, lead_score, purchase_count,
                      total_spent, avg_ticket, last_purchase_at, last_contact_at, tags
               FROM contacts WHERE organization_id = ?`;
    const params: any[] = [orgId];
    if (temperature) { sql += ` AND lead_temperature = ?`; params.push(temperature); }
    if (tag) { sql += ` AND tags LIKE ?`; params.push(`%${tag}%`); }
    if (minScore) { sql += ` AND COALESCE(lead_score,0) >= ?`; params.push(parseInt(String(minScore), 10) || 0); }
    if (inactiveDays) {
      sql += ` AND (last_contact_at IS NULL OR last_contact_at < datetime('now', ?))`;
      params.push(`-${parseInt(String(inactiveDays), 10) || 0} days`);
    }
    sql += ` ORDER BY COALESCE(lead_score,0) DESC, total_spent DESC`;
    const rows = db.prepare(sql).all(...params) as any[];

    const esc = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Nome', 'Telefone', 'Temperatura', 'Lead Score', 'Compras', 'Total Gasto', 'Ticket Medio', 'Ultima Compra', 'Ultimo Contato', 'Tags'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.name || '', r.identifier || '', r.lead_temperature || '', r.lead_score || 0,
        r.purchase_count || 0, Number(r.total_spent || 0).toFixed(2), Number(r.avg_ticket || 0).toFixed(2),
        r.last_purchase_at || '', r.last_contact_at || '', r.tags || '',
      ].map(esc).join(','));
    }
    const csv = '﻿' + lines.join('\n'); // BOM p/ Excel abrir acentos corretamente

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=contatos-${Date.now()}.csv`);
    res.send(csv);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
