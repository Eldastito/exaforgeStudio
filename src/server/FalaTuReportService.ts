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

export class FalaTuReportService {
  /**
   * Gera o Resumo Executivo do usuário como artefato PDF + link assinado.
   * Determinístico (zero IA): o conteúdo é o contexto canônico projetado.
   */
  static async executiveSummary(orgId: string, user: any, correlationId?: string | null): Promise<{
    artifact: { id: string; title: string; kind: string; mimeType: string; sizeBytes: number; createdAt: string };
    url: string | null;
    droppedDomains: string[];
    redactedPaths: string[];
  }> {
    const userId = user?.userId || user?.id || null;
    const ctx = ContextEngineService.buildForUser(orgId, user);

    const sections: Array<{ heading: string; lines: string[] }> = [];
    if (ctx.narrative) {
      sections.push({ heading: "Panorama", lines: ctx.narrative.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 60) });
    }
    const domains = (ctx.snapshot && ctx.snapshot.domains) || {};
    const domLines = Object.entries(domains).map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 300)}`);
    if (domLines.length) sections.push({ heading: "Domínios (números do período)", lines: domLines });
    if (!sections.length) sections.push({ heading: "Panorama", lines: ["Sem dados suficientes para o período."] });

    const footer = ctx.droppedDomains.length
      ? `Alguns domínios foram omitidos conforme seu nível de acesso: ${ctx.droppedDomains.join(", ")}.`
      : undefined;

    const buf = await ReportPdfService.renderSimplePdf(orgId, {
      title: "Resumo Executivo",
      subtitle: "Contexto do período, no seu nível de acesso.",
      sections,
      footer,
    });

    const art = ArtifactService.create(orgId, {
      kind: "report",
      title: "Resumo Executivo",
      mimeType: "application/pdf",
      content: buf,
      origin: "falatu",
      createdBy: userId,
      correlationId: correlationId || null,
    });

    return {
      artifact: { id: art.id, title: art.title, kind: art.kind, mimeType: art.mimeType, sizeBytes: art.sizeBytes, createdAt: art.createdAt },
      url: ArtifactService.signedUrl(orgId, art.id),
      droppedDomains: ctx.droppedDomains,
      redactedPaths: ctx.redactedPaths,
    };
  }
}
