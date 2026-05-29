import { Router } from "express";
import { AnalyticsService } from "../AnalyticsService.js";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import PDFDocument from 'pdfkit';

const router = Router();
const getOrgId = (req: any) => req.organizationId || req.headers['x-organization-id'] || 'default_org';

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
  const { business_name, address, phone, logo_url } = req.body;
  
  try {
    db.prepare(`
      UPDATE organization_settings 
      SET business_name = ?, address = ?, phone = ?, logo_url = ?, onboarding_status = 'completed', updated_at = CURRENT_TIMESTAMP
      WHERE organization_id = ?
    `).run(business_name, address, phone, logo_url, orgId);
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/reports/pdf", (req, res) => {
  const orgId = getOrgId(req);
  const { type, period } = req.body;
  
  try {
    const settings = AnalyticsService.getReportSettings(orgId) as any;
    const businessName = settings?.business_name || 'Relatório';
    const metrics = AnalyticsService.getMetrics(orgId, { period });
    
    // Aesthetic constants
    const primaryColor = settings?.primary_color || '#1e293b';
    const accentColor = '#6366f1';
    const textColor = '#334155';
    const bgHeader = '#f8fafc';
    
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=relatorio_${type}_${Date.now()}.pdf`);
    
    doc.pipe(res);
    
    // Header
    doc.rect(0, 0, 600, 100).fill(bgHeader);
    doc.fillColor(primaryColor).fontSize(24).font('Helvetica-Bold').text(businessName.toUpperCase(), 50, 40);
    doc.fillColor(accentColor).fontSize(12).font('Helvetica-Bold').text(type.charAt(0).toUpperCase() + type.slice(1), 50, 65);
    
    doc.fillColor('#64748b').fontSize(9).font('Helvetica').text(`Gerado em: ${new Date().toLocaleString()}`, 350, 40, { align: 'right', width: 200 });
    doc.text(`Período: ${period}`, 350, 52, { align: 'right', width: 200 });
    
    doc.moveDown(4); // Move below header
    
    // Metrics Section
    doc.fillColor(primaryColor).fontSize(16).font('Helvetica-Bold').text('1. Panorama Estratégico', 50);
    doc.moveDown(1);
    
    const cardWidth = 140;
    const cardHeight = 80;
    const cardGap = 37.5;
    const startY = doc.y;

    const drawCard = (title: string, value: string | number, index: number) => {
        const x = 50 + index * (cardWidth + cardGap);
        doc.roundedRect(x, startY, cardWidth, cardHeight, 8).fill('#ffffff');
        doc.lineWidth(1).strokeColor('#e2e8f0').roundedRect(x, startY, cardWidth, cardHeight, 8).stroke();
        
        doc.fillColor('#64748b').fontSize(8).font('Helvetica-Bold').text(title.toUpperCase(), x + 10, startY + 20, { width: cardWidth - 20, align: 'center' });
        doc.fillColor(primaryColor).fontSize(22).font('Helvetica-Bold').text(value.toString(), x + 10, startY + 40, { width: cardWidth - 20, align: 'center' });
    };
    
    drawCard('Tickets', metrics.totalTickets, 0);
    drawCard('Leads', metrics.newLeadsCount, 1);
    drawCard('Vendas', metrics.salesCount, 2);
    
    doc.y = startY + cardHeight + 40;

    // Detailed Metrics Section
    doc.fillColor(primaryColor).fontSize(16).font('Helvetica-Bold').text('2. Diagnóstico Técnico', 50);
    doc.moveDown(1);
    
    const drawRow = (label: string, value: string | number, isEven: boolean) => {
        const y = doc.y;
        if (isEven) {
          doc.rect(50, y - 2, 495, 25).fill('#f8fafc');
        }
        doc.fillColor(textColor).fontSize(11).font('Helvetica').text(label, 60, y + 5, { width: 300 });
        doc.fillColor(primaryColor).font('Helvetica-Bold').text(value.toString(), 350, y + 5, { width: 180, align: 'right' });
        doc.moveDown(1.2);
    };

    drawRow('Handoffs para Humano', metrics.handoffCount, true);
    drawRow('Agendamentos', metrics.appointmentCount, false);
    drawRow('Respostas IA', metrics.aiResponseCount, true);
    
    // Footer
    doc.fontSize(8).fillColor('#94a3b8').text('Gerado automaticamente pelo sistema de analytics.', 50, 780, { align: 'center', width: 495 });
    if (settings?.report_footer) {
        doc.text(settings.report_footer, 50, 792, { align: 'center', width: 495 });
    }
    
    doc.end();


  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
