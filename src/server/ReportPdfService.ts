import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import PDFDocument from "pdfkit";
import db from "./db.js";
import { StorageService } from "./StorageService.js";

const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");
const REPORTS_DIR = path.join(MEDIA_DIR, "reports");

// Gera relatórios em PDF (ex.: para o Zapp gestor entregar pelo WhatsApp). O
// arquivo é salvo em /media/reports e servido publicamente como link.
export class ReportPdfService {
  private static businessName(orgId: string): string {
    try {
      const o = db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      return o?.business_name || "Meu negócio";
    } catch (e) { return "Meu negócio"; }
  }

  /**
   * Cria um PDF com o RESUMO (análise da IA) + o PANORAMA do negócio (texto
   * cru do raio-x). Retorna a URL pública para download.
   */
  static async generateManagerReport(orgId: string, opts: { title?: string; summary?: string; panorama?: string }): Promise<{ url: string } | null> {
    try {
      fs.mkdirSync(REPORTS_DIR, { recursive: true });
      const id = uuidv4();
      const filePath = path.join(REPORTS_DIR, `${id}.pdf`);
      const biz = this.businessName(orgId);
      const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
      const title = (opts.title || "Relatório do negócio").slice(0, 90);

      await new Promise<void>((resolve, reject) => {
        const doc = new PDFDocument({ size: "A4", margin: 48 });
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        // Cabeçalho
        doc.fillColor("#4f46e5").font("Helvetica-Bold").fontSize(20).text(biz, { continued: false });
        doc.moveDown(0.2);
        doc.fillColor("#111827").font("Helvetica-Bold").fontSize(15).text(title);
        doc.fillColor("#6b7280").font("Helvetica").fontSize(9).text(`Gerado em ${now}`);
        doc.moveTo(48, doc.y + 6).lineTo(547, doc.y + 6).strokeColor("#e5e7eb").stroke();
        doc.moveDown(1);

        // Resumo (análise da IA)
        if (opts.summary && opts.summary.trim()) {
          doc.fillColor("#4f46e5").font("Helvetica-Bold").fontSize(12).text("Resumo");
          doc.moveDown(0.3);
          doc.fillColor("#111827").font("Helvetica").fontSize(11).text(opts.summary.trim(), { align: "left", lineGap: 2 });
          doc.moveDown(1);
        }

        // Panorama do negócio (texto cru do raio-x)
        if (opts.panorama && opts.panorama.trim()) {
          doc.fillColor("#4f46e5").font("Helvetica-Bold").fontSize(12).text("Panorama do negócio");
          doc.moveDown(0.3);
          doc.fillColor("#374151").font("Helvetica").fontSize(9.5).text(opts.panorama.trim(), { align: "left", lineGap: 1.5 });
        }

        doc.end();
        stream.on("finish", () => resolve());
        stream.on("error", reject);
      });

      const base = (process.env.APP_URL || "").replace(/\/$/, "");
      const localUrl = `${base}/media/reports/${id}.pdf`;

      // Espelho best-effort no S3 (S3_ENABLED=true): quando configurado, a URL
      // devolvida é a do S3 (portável entre instâncias) em vez da local; o
      // arquivo local continua existindo do mesmo jeito de sempre.
      if (StorageService.isS3Enabled()) {
        const mirror = await StorageService.mirrorToS3(filePath, `reports/${id}.pdf`);
        if (mirror.stored && mirror.url) return { url: mirror.url };
      }

      return { url: localUrl };
    } catch (e) {
      console.error("[ReportPdf] Falha ao gerar PDF:", e);
      return null;
    }
  }

  /**
   * PDF do diagnóstico do Radar de Execução IA (Fase 4, ADR-016): score geral,
   * nível de maturidade, os 7 pilares e as recomendações priorizadas, com a
   * narrativa em texto opcional (null quando IA não está configurada ou falhou
   * — o PDF sai igual, só sem essa seção).
   */
  static async generateRadarReport(orgId: string, opts: {
    companyName: string | null;
    overallScore: number | null;
    maturityLevel: string | null;
    confidenceScore: number | null;
    pillarScores: { pillar: string; label: string; score: number | null }[];
    recommendations: { use_case_name: string; priority_band: string }[];
    narrative: string | null;
  }): Promise<{ url: string } | null> {
    try {
      fs.mkdirSync(REPORTS_DIR, { recursive: true });
      const id = uuidv4();
      const filePath = path.join(REPORTS_DIR, `${id}.pdf`);
      const biz = this.businessName(orgId);
      const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

      await new Promise<void>((resolve, reject) => {
        const doc = new PDFDocument({ size: "A4", margin: 48 });
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        doc.fillColor("#0d9488").font("Helvetica-Bold").fontSize(20).text("Radar de Execução IA");
        doc.moveDown(0.2);
        doc.fillColor("#111827").font("Helvetica-Bold").fontSize(15).text(opts.companyName || biz);
        doc.fillColor("#6b7280").font("Helvetica").fontSize(9).text(`Gerado em ${now}`);
        doc.moveTo(48, doc.y + 6).lineTo(547, doc.y + 6).strokeColor("#e5e7eb").stroke();
        doc.moveDown(1);

        doc.fillColor("#0d9488").font("Helvetica-Bold").fontSize(28).text(opts.overallScore != null ? String(Math.round(opts.overallScore)) : "—", { continued: true });
        doc.fillColor("#374151").font("Helvetica").fontSize(11).text(`   /100 — ${opts.maturityLevel || "sem dados suficientes"}`);
        if (opts.confidenceScore != null) {
          doc.fillColor("#6b7280").font("Helvetica").fontSize(9).text(`Confiança das respostas: ${Math.round(opts.confidenceScore * 100)}%`);
        }
        doc.moveDown(1);

        if (opts.narrative) {
          doc.fillColor("#0d9488").font("Helvetica-Bold").fontSize(12).text("Resumo executivo");
          doc.moveDown(0.3);
          doc.fillColor("#111827").font("Helvetica").fontSize(10.5).text(opts.narrative, { align: "left", lineGap: 2 });
          doc.moveDown(1);
        }

        doc.fillColor("#0d9488").font("Helvetica-Bold").fontSize(12).text("Os 7 pilares");
        doc.moveDown(0.3);
        for (const p of opts.pillarScores) {
          const scoreLabel = p.score != null ? `${Math.round(p.score)}/100` : "sem dados";
          doc.fillColor("#374151").font("Helvetica").fontSize(10).text(`${p.label}: ${scoreLabel}`);
          const barWidth = 300, barHeight = 6, x = doc.x, y = doc.y + 2;
          doc.rect(x, y, barWidth, barHeight).fillColor("#e5e7eb").fill();
          if (p.score != null) doc.rect(x, y, (barWidth * Math.max(0, Math.min(100, p.score))) / 100, barHeight).fillColor("#0d9488").fill();
          doc.moveDown(0.9);
        }
        doc.moveDown(0.5);

        if (opts.recommendations.length) {
          doc.fillColor("#0d9488").font("Helvetica-Bold").fontSize(12).text("Recomendações priorizadas");
          doc.moveDown(0.3);
          for (const r of opts.recommendations) {
            doc.fillColor("#374151").font("Helvetica").fontSize(10).text(`• ${r.use_case_name} (prioridade ${r.priority_band})`);
          }
        }

        doc.moveDown(1.5);
        doc.fillColor("#9ca3af").font("Helvetica").fontSize(8).text(
          "Este diagnóstico é uma análise orientativa baseada nas respostas informadas. Scores e estimativas não constituem garantia de resultado."
        );

        doc.end();
        stream.on("finish", () => resolve());
        stream.on("error", reject);
      });

      const base = (process.env.APP_URL || "").replace(/\/$/, "");
      const localUrl = `${base}/media/reports/${id}.pdf`;

      if (StorageService.isS3Enabled()) {
        const mirror = await StorageService.mirrorToS3(filePath, `reports/${id}.pdf`);
        if (mirror.stored && mirror.url) return { url: mirror.url };
      }

      return { url: localUrl };
    } catch (e) {
      console.error("[ReportPdf] Falha ao gerar PDF do Radar:", e);
      return null;
    }
  }
}
