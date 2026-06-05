import { Router } from "express";
import { AnalyticsService } from "../AnalyticsService.js";
import { ReportsService } from "../ReportsService.js";
import { ModuleService } from "../ModuleService.js";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import PDFDocument from 'pdfkit';

const router = Router();
const getOrgId = (req: any) => req.organizationId;

// Resumo de vendas para o painel de Relatórios (30 dias x total geral).
router.get("/sales-summary", (req, res) => {
  const orgId = getOrgId(req);
  try {
    res.json(ReportsService.salesSummary(orgId));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/metrics", (req, res) => {
  const orgId = getOrgId(req);
  const period = (req.query.period as any) || "month";

  try {
    const metrics = AnalyticsService.getMetrics(orgId, { period });
    res.json(metrics);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Relatório de lucro/margem do período
router.get("/profit", (req, res) => {
  const orgId = getOrgId(req);
  const period = (req.query.period as any) || "month";
  try {
    res.json(AnalyticsService.getProfit(orgId, { period }));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/settings", (req, res) => {
  const orgId = getOrgId(req);
  try {
    const settings = AnalyticsService.getReportSettings(orgId);
    res.json(settings || {});
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/settings", (req, res) => {
  const orgId = getOrgId(req);
  const { business_name, legal_name, cnpj_cpf, address, phone, email, logo_url, primary_color, report_footer } = req.body;
  
  try {
    const existing = db.prepare('SELECT id FROM organization_settings WHERE organization_id = ?').get(orgId);
    
    if (existing) {
      db.prepare(`
        UPDATE organization_settings 
        SET business_name = ?, legal_name = ?, cnpj_cpf = ?, address = ?, phone = ?, email = ?, logo_url = ?, primary_color = ?, report_footer = ?, updated_at = CURRENT_TIMESTAMP
        WHERE organization_id = ?
      `).run(business_name, legal_name, cnpj_cpf, address, phone, email, logo_url, primary_color, report_footer, orgId);
    } else {
      db.prepare(`
        INSERT INTO organization_settings (id, organization_id, business_name, legal_name, cnpj_cpf, address, phone, email, logo_url, primary_color, report_footer)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), orgId, business_name, legal_name, cnpj_cpf, address, phone, email, logo_url, primary_color, report_footer);
    }
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/settings/onboarding", (req, res) => {
  const orgId = getOrgId(req);
  const { business_name, address, phone, logo_url, vertical } = req.body;

  try {
    db.prepare(`
      UPDATE organization_settings
      SET business_name = ?, address = ?, phone = ?, logo_url = ?, onboarding_status = 'completed', updated_at = CURRENT_TIMESTAMP
      WHERE organization_id = ?
    `).run(business_name, address, phone, logo_url, orgId);
    // Aplica o preset da vertical escolhida (módulos habilitados).
    if (vertical) { try { ModuleService.applyVertical(orgId, String(vertical)); } catch (e) { /* noop */ } }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analytics/verticals — catálogo de categorias p/ os cards do onboarding.
router.get("/verticals", (_req, res) => {
  res.json(ModuleService.catalog());
});

// POST /api/analytics/settings/modules { enabled_modules: string[] }
// Override manual dos módulos opcionais (Configurações › Módulos).
router.post("/settings/modules", (req, res) => {
  const orgId = getOrgId(req);
  try {
    const saved = ModuleService.setModules(orgId, req.body?.enabled_modules);
    res.json({ success: true, enabled_modules: saved });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analytics/setup-checklist — status de configuração inicial (self-service).
router.get("/setup-checklist", (req, res) => {
  const orgId = getOrgId(req);
  try {
    const count = (sql: string): number => {
      try { return (db.prepare(sql).get(orgId) as any)?.c || 0; } catch (e) { return 0; }
    };
    const settings = db.prepare(
      'SELECT business_name, phone FROM organization_settings WHERE organization_id = ?'
    ).get(orgId) as any;

    const channels = count(`SELECT COUNT(*) as c FROM channels WHERE organization_id = ? AND status NOT IN ('disabled','disconnected')`);
    const products = count(`SELECT COUNT(*) as c FROM products_services WHERE organization_id = ? AND active = 1`);
    const aiOn = count(`SELECT COUNT(*) as c FROM channels WHERE organization_id = ? AND ai_enabled = 1`);
    const rag = count(`SELECT COUNT(*) as c FROM knowledge_documents WHERE organization_id = ?`);
    const users = count(`SELECT COUNT(*) as c FROM users WHERE organization_id = ?`);
    const managers = count(`SELECT COUNT(*) as c FROM authorized_managers WHERE organization_id = ?`);

    const items = [
      { key: 'business', label: 'Preencher os dados da empresa', done: !!(settings?.business_name && settings?.phone), view: 'settings' },
      { key: 'channel', label: 'Conectar um canal (WhatsApp/Instagram)', done: channels > 0, view: 'channels' },
      { key: 'ai', label: 'Ativar a IA em um canal', done: aiOn > 0, view: 'channels' },
      { key: 'catalog', label: 'Cadastrar produtos/serviços', done: products > 0, view: 'catalog' },
      { key: 'rag', label: 'Adicionar base de conhecimento (RAG)', done: rag > 0, view: 'channels' },
      { key: 'manager', label: 'Cadastrar um gestor (comandos Zapp)', done: managers > 0, view: 'channels' },
      { key: 'team', label: 'Convidar a equipe', done: users > 1, view: 'settings' },
    ];
    const completed = items.filter(i => i.done).length;
    res.json({ items, completed, total: items.length, pct: Math.round((completed / items.length) * 100) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/reports/pdf", (req, res) => {
  const orgId = getOrgId(req);
  const { period } = req.body;

  try {
    const settings = AnalyticsService.getReportSettings(orgId) as any;
    const businessName = settings?.business_name || 'Sua Empresa';
    const metrics = AnalyticsService.getMetrics(orgId, { period });
    const profit = AnalyticsService.getProfit(orgId, { period });

    // ===== Paleta e helpers (premium) =====
    const C = {
      ink: '#0f172a', body: '#334155', muted: '#64748b', faint: '#94a3b8',
      line: '#e2e8f0', card: '#ffffff', soft: '#f8fafc',
      indigo: '#6366f1', violet: '#8b5cf6', emerald: '#10b981', amber: '#f59e0b', rose: '#f43f5e', sky: '#0ea5e9',
    };
    const PERIOD_LABEL: Record<string, string> = { today: 'Hoje', week: 'Últimos 7 dias', month: 'Últimos 30 dias', all: 'Todo o período' };
    const periodLabel = PERIOD_LABEL[period] || period;
    const brl = (v: number) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    const conversion = metrics.totalTickets ? Math.round((metrics.salesCount / metrics.totalTickets) * 100) : 0;

    const M = 48;
    const doc = new PDFDocument({ margin: 0, size: 'A4' });
    const W = doc.page.width;
    const CW = W - M * 2;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=relatorio-${period}-${Date.now()}.pdf`);
    doc.pipe(res);

    const initial = (businessName.trim()[0] || 'E').toUpperCase();

    // ---------- CABEÇALHO (faixa com gradiente) ----------
    const headH = 132;
    const grad = doc.linearGradient(0, 0, W, headH);
    grad.stop(0, '#4f46e5').stop(0.55, '#6d28d9').stop(1, '#7c3aed');
    doc.rect(0, 0, W, headH).fill(grad);

    doc.roundedRect(M, 34, 44, 44, 10).fillOpacity(0.18).fill('#ffffff').fillOpacity(1);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text(initial, M, 46, { width: 44, align: 'center' });

    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text(businessName, M + 60, 40, { width: CW - 200 });
    doc.fillColor('#e9d5ff').font('Helvetica').fontSize(10.5).text('Relatório de Performance · ZappFlow.ai', M + 60, 68, { width: CW - 200 });

    const boxW = 150, boxX = W - M - boxW;
    doc.roundedRect(boxX, 38, boxW, 56, 8).fillOpacity(0.14).fill('#ffffff').fillOpacity(1);
    doc.fillColor('#ede9fe').font('Helvetica').fontSize(8).text('PERÍODO', boxX + 12, 48);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12).text(periodLabel, boxX + 12, 59, { width: boxW - 24 });
    doc.fillColor('#ddd6fe').font('Helvetica').fontSize(7.5).text(
      'Gerado em ' + new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }),
      boxX + 12, 78, { width: boxW - 24 }
    );

    let y = headH + 30;

    const sectionTitle = (label: string, accent: string) => {
      doc.roundedRect(M, y + 1, 4, 14, 2).fill(accent);
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(13).text(label, M + 14, y);
      y += 26;
    };

    // ---------- KPI cards ----------
    sectionTitle('Panorama Geral', C.indigo);
    const kpis = [
      { label: 'TICKETS', value: String(metrics.totalTickets), sub: `${metrics.newLeadsCount} novos leads`, accent: C.indigo },
      { label: 'VENDAS', value: String(metrics.salesCount), sub: `${conversion}% de conversão`, accent: C.emerald },
      { label: 'RESPOSTAS IA', value: String(metrics.aiResponseCount), sub: `${metrics.resolutionRateAI}% resolvido por IA`, accent: C.violet },
      { label: 'AGENDAMENTOS', value: String(metrics.appointmentCount), sub: `${metrics.handoffCount} p/ humano`, accent: C.amber },
    ];
    const gap = 14;
    const cardW = (CW - gap * 3) / 4;
    const cardH = 92;
    kpis.forEach((k, i) => {
      const x = M + i * (cardW + gap);
      doc.roundedRect(x, y, cardW, cardH, 10).fillAndStroke(C.card, C.line);
      doc.roundedRect(x, y, cardW, 3.5, 2).fill(k.accent);
      doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(7.5).text(k.label, x + 12, y + 16, { width: cardW - 24, characterSpacing: 0.5 });
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(26).text(k.value, x + 12, y + 30, { width: cardW - 24 });
      doc.fillColor(C.faint).font('Helvetica').fontSize(7.5).text(k.sub, x + 12, y + 66, { width: cardW - 24 });
    });
    y += cardH + 30;

    // ---------- Resultado Financeiro ----------
    sectionTitle('Resultado Financeiro', C.emerald);
    const finH = 96;
    doc.roundedRect(M, y, CW, finH, 12).fillAndStroke(C.soft, C.line);
    doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text('LUCRO NO PERÍODO', M + 20, y + 18);
    doc.fillColor(C.emerald).font('Helvetica-Bold').fontSize(30).text(brl(profit.profit), M + 20, y + 32);
    doc.fillColor(C.faint).font('Helvetica').fontSize(8).text(
      profit.hasCostData ? `Margem de ${profit.margin}% · ${profit.orders} pedido(s) faturado(s)` : 'Cadastre o custo no estoque para ver o lucro real',
      M + 20, y + 70
    );
    const rightX = M + CW * 0.62;
    doc.moveTo(rightX - 16, y + 16).lineTo(rightX - 16, y + finH - 16).strokeColor(C.line).stroke();
    doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text('RECEITA', rightX, y + 22);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(15).text(brl(profit.revenue), rightX, y + 34);
    doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text('CUSTO', rightX + (CW * 0.38) / 2, y + 22);
    doc.fillColor(C.rose).font('Helvetica-Bold').fontSize(15).text(brl(profit.cost), rightX + (CW * 0.38) / 2, y + 34);
    y += finH + 30;

    // ---------- Funil de Vendas ----------
    sectionTitle('Funil de Vendas', C.sky);
    const funnel = [
      { label: 'Leads recebidos', value: metrics.newLeadsCount || metrics.totalTickets, color: C.sky },
      { label: 'Em atendimento', value: metrics.totalTickets, color: C.indigo },
      { label: 'Agendamentos', value: metrics.appointmentCount, color: C.amber },
      { label: 'Vendas concretizadas', value: metrics.salesCount, color: C.emerald },
    ];
    const fMax = Math.max(1, ...funnel.map(f => f.value));
    funnel.forEach((f) => {
      doc.fillColor(C.body).font('Helvetica').fontSize(9.5).text(f.label, M, y, { width: 200 });
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9.5).text(String(f.value), M + CW - 40, y, { width: 40, align: 'right' });
      const barY = y + 15, barW = CW;
      doc.roundedRect(M, barY, barW, 7, 3.5).fill('#eef2f7');
      const w = Math.max(6, (f.value / fMax) * barW);
      doc.roundedRect(M, barY, w, 7, 3.5).fill(f.color);
      y += 30;
    });
    y += 8;

    // ---------- Eficiência do Atendimento ----------
    sectionTitle('Eficiência do Atendimento', C.violet);
    const rows: [string, string][] = [
      ['Respostas automáticas da IA', String(metrics.aiResponseCount)],
      ['Taxa de resolução pela IA', `${metrics.resolutionRateAI}%`],
      ['Tempo médio de 1ª resposta', `${metrics.averageFirstResponseTime}s`],
      ['Repasses para humano', String(metrics.handoffCount)],
    ];
    rows.forEach((r, i) => {
      const rowY = y;
      if (i % 2 === 0) doc.roundedRect(M, rowY, CW, 26, 5).fill(C.soft);
      doc.fillColor(C.body).font('Helvetica').fontSize(10).text(r[0], M + 14, rowY + 8);
      doc.fillColor(C.indigo).font('Helvetica-Bold').fontSize(10).text(r[1], M, rowY + 8, { width: CW - 14, align: 'right' });
      y += 26;
    });

    // ---------- Rodapé ----------
    const footY = doc.page.height - 50;
    doc.moveTo(M, footY).lineTo(W - M, footY).strokeColor(C.line).stroke();
    doc.fillColor(C.faint).font('Helvetica').fontSize(8).text(`${businessName} · Relatório gerado automaticamente`, M, footY + 10, { width: CW / 2 });
    doc.fillColor(C.faint).font('Helvetica').fontSize(8).text(settings?.report_footer || 'ZappFlow.ai', M + CW / 2, footY + 10, { width: CW / 2, align: 'right' });

    doc.end();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
