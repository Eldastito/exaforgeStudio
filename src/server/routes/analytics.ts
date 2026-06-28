import { Router } from "express";
import { AnalyticsService } from "../AnalyticsService.js";
import { ReportsService } from "../ReportsService.js";
import { ModuleService } from "../ModuleService.js";
import { RevenueIntelligenceService } from "../RevenueIntelligenceService.js";
import { RevenueAuditService } from "../RevenueAuditService.js";
import { RevenueSimulatorService } from "../RevenueSimulatorService.js";
import { ExecutiveAdvisorService } from "../ExecutiveAdvisorService.js";
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

// ===== Revenue Intelligence Center (RIC) =====
// Snapshot completo do IQR + 3 drivers + Perda Estimada + IRR + RRI no período.
router.get("/revenue-intelligence", (req, res) => {
  const orgId = getOrgId(req);
  const period = (req.query.period as any) || "month";
  try {
    res.json(RevenueIntelligenceService.getSnapshot(orgId, period));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Status da auditoria-trial de 14 dias (GTM): not_started/active/completed,
// dia X de 14, dias restantes e %. Início = conexão do 1º canal.
router.get("/revenue-intelligence/trial", (req, res) => {
  const orgId = getOrgId(req);
  try {
    res.json(RevenueIntelligenceService.getTrialStatus(orgId));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Configuração por organização: probabilidades, janelas, pesos do IQR e
// ticket médio override. Tudo opt-in/editável — o cliente nunca vê um número
// "duro" sem ter a chance de calibrar a fórmula.
router.get("/revenue-intelligence/config", (req, res) => {
  const orgId = getOrgId(req);
  try {
    res.json(RevenueIntelligenceService.getConfig(orgId));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/revenue-intelligence/config", (req, res) => {
  const orgId = getOrgId(req);
  try {
    const saved = RevenueIntelligenceService.saveConfig(orgId, req.body || {});
    res.json({ success: true, config: saved });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Auditoria estruturada (10 seções) — fonte JSON do relatório.
router.get("/revenue-intelligence/audit", (req, res) => {
  const orgId = getOrgId(req);
  const period = (req.query.period as any) || "month";
  try {
    res.json(RevenueAuditService.build(orgId, period));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Simulador leve do RIC — 2 alavancas (tempo de resposta, follow-up) com
// guardrail de credibilidade: usa curva histórica do tenant quando há amostra;
// senão, cai em premissas DEFAULT editáveis. Body:
//   { lever: "response_time" | "followup", params: {...}, assumptions?: {...} }
router.post("/revenue-intelligence/simulate", (req, res) => {
  const orgId = getOrgId(req);
  const { lever, params, assumptions } = req.body || {};
  try {
    if (lever !== "response_time" && lever !== "followup") {
      return res.status(400).json({ error: "lever inválido. Use 'response_time' ou 'followup'." });
    }
    res.json(RevenueSimulatorService.simulate(orgId, lever, params || {}, assumptions || {}));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Plano 30/60/90 — narrativa do Diretor IA sobre a auditoria. Cobra LLM,
// então não vai junto com o GET /audit para não estourar custo a cada refresh.
router.get("/revenue-intelligence/plan", async (req, res) => {
  const orgId = getOrgId(req);
  try {
    const text = await ExecutiveAdvisorService.auditPlan(orgId);
    res.json({ plan: text, generatedAt: new Date().toISOString() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PDF da auditoria — entregável central do GTM trial-14d. Layout premium no
// mesmo padrão do /reports/pdf existente: faixa gradiente, cards, seções com
// "headline" curto + métricas chave + notas. Plano 30/60/90 opcional no fim.
router.post("/revenue-intelligence/audit-pdf", async (req, res) => {
  const orgId = getOrgId(req);
  const period = (req.body?.period as any) || "month";
  const includePlan = req.body?.includePlan !== false; // default: incluir

  try {
    const report = RevenueAuditService.build(orgId, period);
    const plan = includePlan ? await ExecutiveAdvisorService.auditPlan(orgId).catch(() => "") : "";

    // Paleta (igual ao /reports/pdf, para identidade visual consistente).
    const C = {
      ink: '#0f172a', body: '#334155', muted: '#64748b', faint: '#94a3b8',
      line: '#e2e8f0', card: '#ffffff', soft: '#f8fafc',
      indigo: '#6366f1', violet: '#8b5cf6', emerald: '#10b981',
      amber: '#f59e0b', rose: '#f43f5e', sky: '#0ea5e9',
    };
    const TONE: Record<string, string> = {
      good: C.emerald, warn: C.amber, bad: C.rose, info: C.indigo,
    };

    const M = 48;
    const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
    const W = doc.page.width;
    const H = doc.page.height;
    const CW = W - M * 2;
    const businessName = report.meta.businessName;
    const initial = (businessName.trim()[0] || 'E').toUpperCase();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=auditoria-receita-${period}-${Date.now()}.pdf`);
    doc.pipe(res);

    // ---------- HEADER (faixa gradiente) ----------
    const drawHeader = () => {
      const headH = 132;
      const grad = doc.linearGradient(0, 0, W, headH);
      grad.stop(0, '#4f46e5').stop(0.55, '#6d28d9').stop(1, '#7c3aed');
      doc.rect(0, 0, W, headH).fill(grad);

      doc.roundedRect(M, 34, 44, 44, 10).fillOpacity(0.18).fill('#ffffff').fillOpacity(1);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text(initial, M, 46, { width: 44, align: 'center' });

      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text(businessName, M + 60, 38, { width: CW - 220 });
      doc.fillColor('#e9d5ff').font('Helvetica').fontSize(10).text('Auditoria de Receita · Revenue Intelligence Center', M + 60, 64, { width: CW - 220 });

      const boxW = 170, boxX = W - M - boxW;
      doc.roundedRect(boxX, 38, boxW, 56, 8).fillOpacity(0.14).fill('#ffffff').fillOpacity(1);
      doc.fillColor('#ede9fe').font('Helvetica').fontSize(8).text('PERÍODO', boxX + 12, 48);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12).text(report.meta.periodLabel, boxX + 12, 59, { width: boxW - 24 });
      doc.fillColor('#ddd6fe').font('Helvetica').fontSize(7.5).text(
        'Gerado em ' + new Date(report.meta.generatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }),
        boxX + 12, 78, { width: boxW - 24 }
      );
      return headH;
    };

    const drawFooter = () => {
      const footY = H - 38;
      doc.moveTo(M, footY).lineTo(W - M, footY).strokeColor(C.line).stroke();
      doc.fillColor(C.faint).font('Helvetica').fontSize(7.5).text(
        `${businessName} · Auditoria gerada automaticamente pelo Revenue Intelligence Center`,
        M, footY + 8, { width: CW / 2 }
      );
      doc.fillColor(C.faint).font('Helvetica').fontSize(7.5).text(
        'ZappFlow.ai — onde está o dinheiro que sua empresa está deixando na mesa.',
        M + CW / 2, footY + 8, { width: CW / 2, align: 'right' }
      );
    };

    let y = drawHeader() + 28;

    // Garante espaço; quebra página se necessário.
    const ensureSpace = (need: number) => {
      if (y + need > H - 70) {
        drawFooter();
        doc.addPage();
        y = drawHeader() + 28;
      }
    };

    const sectionTitle = (label: string, accent: string) => {
      ensureSpace(40);
      doc.roundedRect(M, y + 1, 4, 14, 2).fill(accent);
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(13).text(label, M + 14, y);
      y += 24;
    };

    // ---------- HERO (IQR + R$) ----------
    sectionTitle('Painel Mestre', C.indigo);
    const heroH = 110;
    ensureSpace(heroH + 20);
    doc.roundedRect(M, y, CW, heroH, 12).fillAndStroke(C.soft, C.line);

    // Bloco esquerdo: IQR grande
    doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text('IQR — ÍNDICE DE QUALIDADE DA RECEITA', M + 22, y + 20);
    const iqrColor = report.headline.iqr >= 80 ? C.emerald : report.headline.iqr >= 60 ? C.amber : C.rose;
    doc.fillColor(iqrColor).font('Helvetica-Bold').fontSize(40).text(`${report.headline.iqr}`, M + 22, y + 32);
    doc.fillColor(C.faint).font('Helvetica').fontSize(9).text(`/100 · driver mais fraco: ${report.headline.weakestDriver}`, M + 22, y + 78);

    // Divisor + 3 colunas de dinheiro (Potencial / IRR / RRI) à direita.
    const brl = (v: number) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    const rx = M + CW * 0.45;
    doc.moveTo(rx - 14, y + 14).lineTo(rx - 14, y + heroH - 14).strokeColor(C.line).stroke();
    const colW = (M + CW - rx) / 3;
    const cols: { label: string; val: string; color: string }[] = [
      { label: 'POTENCIAL EM RISCO', val: brl(report.headline.estimatedLoss), color: C.rose },
      { label: 'RECUPERÁVEL (IRR)', val: brl(report.headline.recoverable), color: C.amber },
      { label: 'RECUPERADO (RRI)', val: brl(report.headline.recovered), color: C.emerald },
    ];
    cols.forEach((c, i) => {
      const x = rx + colW * i;
      doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(7.5).text(c.label, x, y + 22, { width: colW - 6 });
      doc.fillColor(c.color).font('Helvetica-Bold').fontSize(15).text(c.val, x, y + 38, { width: colW - 6 });
    });
    doc.fillColor(C.faint).font('Helvetica').fontSize(7.5).text(
      `Premissa de ticket: ${brl(report.headline.ticket.value)} (${report.headline.ticket.source})`,
      rx, y + heroH - 22, { width: CW - (rx - M) - 12 }
    );

    y += heroH + 22;

    // ---------- 10 SEÇÕES ----------
    const ACCENTS = [C.indigo, C.violet, C.sky, C.amber, C.rose, C.amber, C.emerald, C.rose, C.sky, C.violet];

    report.sections.forEach((s, i) => {
      sectionTitle(`${i + 1}. ${s.title}`, ACCENTS[i] || C.indigo);

      // Headline curto (1 linha) em destaque
      ensureSpace(40);
      doc.fillColor(C.body).font('Helvetica-Bold').fontSize(10).text(s.headline, M, y, { width: CW });
      y += doc.heightOfString(s.headline, { width: CW, lineGap: 1 }) + 10;

      // Tabela de métricas (2 colunas alternadas)
      if (s.metrics?.length) {
        s.metrics.forEach((mt, j) => {
          ensureSpace(28);
          if (j % 2 === 0) doc.roundedRect(M, y, CW, 24, 4).fill(C.soft);
          doc.fillColor(C.body).font('Helvetica').fontSize(9.5).text(mt.label, M + 14, y + 7, { width: CW * 0.65 });
          const valColor = mt.tone ? TONE[mt.tone] : C.ink;
          doc.fillColor(valColor).font('Helvetica-Bold').fontSize(10).text(mt.value, M, y + 7, { width: CW - 14, align: 'right' });
          y += 24;
        });
      }

      // Linhas adicionais (ex.: velocidade por estágio)
      if (s.rows?.length) {
        y += 6;
        s.rows.forEach(r => {
          ensureSpace(18);
          doc.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(`• ${r.label}: ${r.value}`, M + 4, y, { width: CW - 8 });
          y += 14;
        });
      }

      // Notas (porquês)
      if (s.notes?.length) {
        y += 6;
        s.notes.forEach(n => {
          ensureSpace(20);
          doc.fillColor(C.faint).font('Helvetica-Oblique').fontSize(8.5).text(n, M, y, { width: CW });
          y += doc.heightOfString(n, { width: CW, lineGap: 1 }) + 4;
        });
      }

      y += 14;
    });

    // ---------- PLANO 30 / 60 / 90 ----------
    if (plan && plan.trim()) {
      ensureSpace(80);
      sectionTitle('Plano de Ação 30 / 60 / 90 — gerado pelo Diretor Executivo IA', C.emerald);
      ensureSpace(40);
      doc.fillColor(C.body).font('Helvetica').fontSize(10).text(plan, M, y, { width: CW, lineGap: 2 });
      y += doc.heightOfString(plan, { width: CW, lineGap: 2 }) + 8;
      doc.fillColor(C.faint).font('Helvetica-Oblique').fontSize(8).text(
        'Plano gerado a partir dos números da auditoria acima — sem inventar dado. Use como ponto de partida; ajuste com o time.',
        M, y, { width: CW }
      );
    }

    drawFooter();
    doc.end();
  } catch (error: any) {
    console.error('[RIC PDF] erro', error);
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
    // Aplica o preset da vertical escolhida (módulos habilitados). Se nenhuma
    // vertical vier, cai em "outro" para que enabled_modules NUNCA fique nulo
    // após o onboarding (evita o padrão antigo de "mostrar tudo").
    try { ModuleService.applyVertical(orgId, String(vertical || 'outro')); } catch (e) { /* noop */ }

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
