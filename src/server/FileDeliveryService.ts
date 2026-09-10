/**
 * FileDeliveryService — PRD WhatsApp Unificado F5.3 (RF-07 §13.3/§13.4): conecta a
 * GERAÇÃO/LOCALIZAÇÃO do arquivo (F5.1/F5.2) à ENTREGA pela conexão de WhatsApp,
 * com MIME tipado e URL assinada ABSOLUTA — e como JOB durável (a geração pesada
 * não bloqueia a resposta ao usuário; §13.3).
 *
 * O que muda em relação ao envio de PDF legado:
 *   - MIME tipado: `sendDocument` deixou de fixar `application/pdf` (F5.3) — aqui
 *     passamos o MIME certo por formato (pdf/xlsx/docx), senão XLSX/DOCX sairiam
 *     rotulados como PDF e não abririam.
 *   - URL absoluta: o provedor baixa o arquivo server-to-server; o link do
 *     `ArtifactService` é relativo, então usamos `absoluteSignedUrlForUser` (que
 *     também REVALIDA a autorização na entrega — §13.4; revogação bloqueia).
 *   - Fallback declarado: se o anexo nativo falhar, manda o LINK identificado como
 *     link (nunca finge "arquivo anexado", §13.4).
 *   - Job durável: `enqueue` roda em background pela `JobQueueService` (mesmo
 *     mecanismo do `generate_manager_pdf`); retomável, sem 2ª fila.
 *
 * NÃO reimplementa geração nem RBAC: reusa `FalaTuReportService` (que herda a
 * projeção por papel) e o `ArtifactService` (assinatura + classificação).
 */
import { JobQueueService } from "./JobQueueService.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { ArtifactService } from "./ArtifactService.js";
import { FalaTuReportService, ReportFormat } from "./FalaTuReportService.js";
import { XLSX_MIME } from "./XlsxService.js";
import { DOCX_MIME } from "./DocxService.js";

const MIME_BY_FORMAT: Record<ReportFormat, string> = {
  pdf: "application/pdf",
  xlsx: XLSX_MIME,
  docx: DOCX_MIME,
};

export interface FileDeliveryInput {
  channelId: string;
  toIdentifier: string;
  user: any;
  format: ReportFormat;
  /** Entrada do catálogo a GERAR (hoje: executive_summary). */
  catalogKey?: string;
  /** OU um artefato JÁ existente a entregar (localização, F5.1 existing_artifact). */
  artifactId?: string;
  caption?: string;
  correlationId?: string | null;
}

export type FileDeliveryResult =
  | { sent: true; native: boolean; url: string; artifactId: string }
  | { sent: false; reason: string };

export class FileDeliveryService {
  static mimeForFormat(format: ReportFormat): string {
    return MIME_BY_FORMAT[format] || "application/pdf";
  }

  /** Enfileira a preparação+entrega como job durável (não bloqueia a conversa). */
  static enqueue(orgId: string, input: FileDeliveryInput): string {
    return JobQueueService.enqueue("deliver_file", { orgId, ...input }, { organizationId: orgId });
  }

  /**
   * Gera/localiza o arquivo e entrega pela conexão — MIME tipado + URL absoluta +
   * fallback de link declarado. Revalida a autorização na entrega (§13.4).
   */
  static async deliverNow(orgId: string, input: FileDeliveryInput): Promise<FileDeliveryResult> {
    const { user, format, channelId, toIdentifier } = input;

    // 1. Resolver o artefato (localizar existente OU gerar o do catálogo).
    let artifactId = input.artifactId || null;
    let mimeType = this.mimeForFormat(format);
    let title = "Arquivo";
    if (artifactId) {
      const art = ArtifactService.getForUser(orgId, user, artifactId); // revalida acesso
      if (!art) return { sent: false, reason: "not_authorized" };
      mimeType = art.mimeType || mimeType;
      title = art.title || title;
    } else if (input.catalogKey === "executive_summary") {
      const r = await FalaTuReportService.executiveSummary(orgId, user, { format, correlationId: input.correlationId || null });
      artifactId = r.artifact.id;
      mimeType = r.artifact.mimeType || mimeType;
      title = r.artifact.title || title;
    } else {
      // Consulta de domínio ainda não plugada (F5.1) — nada a gerar. Honesto.
      return { sent: false, reason: "pending_domain_query" };
    }

    // 2. URL assinada ABSOLUTA (revalida acesso; null sem APP_URL ou sem permissão).
    const url = ArtifactService.absoluteSignedUrlForUser(orgId, user, artifactId!);
    if (!url) return { sent: false, reason: process.env.APP_URL ? "not_authorized" : "no_public_base" };

    const ext = format;
    const fileName = `${String(title).replace(/[^\w\sÀ-ÿ.-]/g, "").trim().slice(0, 60) || "arquivo"}.${ext}`;

    // 3. Entrega nativa com MIME tipado; fallback declarado pro LINK (§13.4).
    // Finalidade "gestao" (F6.1): relatório/documento é uso de GESTÃO — o gate de
    // finalidade se aplica. ("falatu" não era finalidade válida → gate no-op.)
    try {
      await MessageProviderService.sendDocument(channelId, toIdentifier, url, fileName, input.caption, { mimeType, feature: "gestao" });
      return { sent: true, native: true, url, artifactId: artifactId! };
    } catch (e: any) {
      // Uso desativado pelo gate NÃO vira link — pausar é a decisão de política
      // (§14); mandar o link burlaria o gate. Só cai pro link em falha de anexo.
      if (e?.code === "outbound_blocked:feature_disabled") return { sent: false, reason: "feature_disabled" };
      await MessageProviderService.sendMessage(channelId, toIdentifier, `📎 Seu arquivo (link seguro, expira em minutos): ${url}`, { feature: "gestao" });
      return { sent: true, native: false, url, artifactId: artifactId! };
    }
  }
}

// Registra o handler do job no boot (side-effect), à moda do generate_manager_pdf.
JobQueueService.registerHandler("deliver_file", async (p: any) => {
  return FileDeliveryService.deliverNow(p.orgId, p as FileDeliveryInput);
});
