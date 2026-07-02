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
}
