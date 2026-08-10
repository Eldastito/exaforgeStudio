/**
 * FalaTuReportService — PRD 1 Fase 2.2 (CA6): "Fala Tu entrega arquivo gerado".
 *
 * Compõe três peças CANÔNICAS já existentes, sem duplicar nenhuma:
 *   1. `ContextEngineService.buildForUser` (segurança P1) — o contexto JÁ filtrado
 *      pro papel do usuário (finance não vaza pra vendedor; campos sensíveis
 *      redigidos). O relatório herda a projeção — não reimplementa RBAC.
 *   2. `ReportPdfService.renderSimplePdf` — renderiza o PDF (Buffer).
 *   3. `ArtifactService.create` — registra como artefato canônico (disco privado,
 *      sha256, `origin:'falatu'`, `correlation_id` da interação) e devolve o id.
 * Retorna { artifact, url assinada } — o Fala Tu entrega o LINK, nunca o binário
 * inline nem o path interno. O manifesto (dropped/redacted) explica o recorte (§49).
 */
import { ContextEngineService } from "./ContextEngineService.js";
import { ReportPdfService } from "./ReportPdfService.js";
import { ArtifactService } from "./ArtifactService.js";
import { buildXlsx, XLSX_MIME, CellValue } from "./XlsxService.js";

export type ReportFormat = "pdf" | "xlsx";

export class FalaTuReportService {
  /**
   * Gera o Resumo Executivo do usuário como artefato (PDF ou XLSX) + link
   * assinado. Determinístico (zero IA): o conteúdo é o contexto canônico
   * PROJETADO pro papel (herda a segurança P1 — finance não vaza pra vendedor).
   * §14 (PDF+XLSX lado a lado) / §65 ("me manda em Excel").
   */
  static async executiveSummary(orgId: string, user: any, opts: { correlationId?: string | null; format?: ReportFormat } = {}): Promise<{
    artifact: { id: string; title: string; kind: string; mimeType: string; sizeBytes: number; createdAt: string };
    url: string | null;
    format: ReportFormat;
    droppedDomains: string[];
    redactedPaths: string[];
  }> {
    const userId = user?.userId || user?.id || null;
    const format: ReportFormat = opts.format === "xlsx" ? "xlsx" : "pdf";
    const ctx = ContextEngineService.buildForUser(orgId, user);
    const domains = (ctx.snapshot && ctx.snapshot.domains) || {};

    let content: Buffer;
    let mimeType: string;
    if (format === "xlsx") {
      // Planilha: uma linha por (domínio, métrica, valor). Números viram célula
      // numérica; objetos, texto. Herda a projeção (domínios sem acesso nem entram).
      const rows: CellValue[][] = [["Domínio", "Métrica", "Valor"]];
      for (const [domain, data] of Object.entries(domains)) {
        if (data && typeof data === "object") {
          for (const [k, v] of Object.entries(data as any)) rows.push([domain, k, (typeof v === "number" || typeof v === "string") ? v : JSON.stringify(v)]);
        } else {
          rows.push([domain, "", (typeof data === "number" || typeof data === "string") ? (data as any) : JSON.stringify(data)]);
        }
      }
      if (rows.length === 1) rows.push(["—", "sem dados no período", ""]);
      if (ctx.droppedDomains.length) rows.push([], ["Omitido pelo seu nível de acesso", ctx.droppedDomains.join(", "), ""]);
      content = buildXlsx([{ name: "Resumo", rows }]);
      mimeType = XLSX_MIME;
    } else {
      const sections: Array<{ heading: string; lines: string[] }> = [];
      if (ctx.narrative) sections.push({ heading: "Panorama", lines: ctx.narrative.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 60) });
      const domLines = Object.entries(domains).map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 300)}`);
      if (domLines.length) sections.push({ heading: "Domínios (números do período)", lines: domLines });
      if (!sections.length) sections.push({ heading: "Panorama", lines: ["Sem dados suficientes para o período."] });
      const footer = ctx.droppedDomains.length ? `Alguns domínios foram omitidos conforme seu nível de acesso: ${ctx.droppedDomains.join(", ")}.` : undefined;
      content = await ReportPdfService.renderSimplePdf(orgId, { title: "Resumo Executivo", subtitle: "Contexto do período, no seu nível de acesso.", sections, footer });
      mimeType = "application/pdf";
    }

    const art = ArtifactService.create(orgId, {
      kind: "report", title: "Resumo Executivo", mimeType, content,
      origin: "falatu", createdBy: userId, correlationId: opts.correlationId || null,
    });

    return {
      artifact: { id: art.id, title: art.title, kind: art.kind, mimeType: art.mimeType, sizeBytes: art.sizeBytes, createdAt: art.createdAt },
      url: ArtifactService.signedUrl(orgId, art.id),
      format,
      droppedDomains: ctx.droppedDomains,
      redactedPaths: ctx.redactedPaths,
    };
  }
}
