/**
 * FalaTuFileIntakeService — PRD 1 Fase 2.4 (CA7 / §17-18): o Fala Tu RECEBE
 * documentos. Fecha o ciclo entrada↔saída de arquivos (a saída veio em 2.2/2.3).
 *
 * Fluxo determinístico do §17:
 *   1. valida tamanho;
 *   2. detecta o formato REAL por magic-byte (`detectMime`, reusado do Clinic —
 *      NUNCA confia no Content-Type declarado, RN de segurança H4);
 *   3. persiste como ARTEFATO canônico (origin 'intake', disco privado, sha256);
 *   4. classifica DETERMINISTICAMENTE (mime → kind + domínio provável) e sugere
 *      o próximo passo sem inventar (§27: só sugere, não decide).
 *
 * NÃO duplica a "conferência de compras" (nota × lista) que já vive no
 * FalaTuPurchaseService — aqui é o intake GENÉRICO que torna qualquer arquivo
 * recebido um artefato de primeira classe, referenciável pelo resto do sistema.
 * A extração por IA (ler a nota) é hook opcional; o intake em si é sem IA.
 */
import { detectMime, MAX_BYTES } from "./ClinicAttachmentService.js";
import { ArtifactService } from "./ArtifactService.js";
import { logAuthEvent } from "./auditLog.js";

// Classificação determinística por mime REAL. `suggestion` é o próximo passo
// oferecido (nunca executado sozinho, §27) — texto fixo, não IA.
const INTAKE_CLASS: Record<string, { kind: string; likelyDomain: string | null; suggestion: string }> = {
  "application/pdf": { kind: "document", likelyDomain: "procurement", suggestion: "Recebi um PDF. Se for nota/comprovante, posso conferir contra uma lista de compras." },
  "image/png": { kind: "image", likelyDomain: "procurement", suggestion: "Recebi uma imagem. Se for nota/comprovante, posso conferir contra uma lista de compras." },
  "image/jpeg": { kind: "image", likelyDomain: "procurement", suggestion: "Recebi uma imagem. Se for nota/comprovante, posso conferir contra uma lista de compras." },
  "image/webp": { kind: "image", likelyDomain: "procurement", suggestion: "Recebi uma imagem. Se for nota/comprovante, posso conferir contra uma lista de compras." },
};

export class FalaTuFileIntakeService {
  static intake(orgId: string, userId: string, input: { filename?: string | null; buffer: Buffer; correlationId?: string | null; classification?: string }): {
    artifact: { id: string; kind: string; title: string; mimeType: string; sizeBytes: number; createdAt: string };
    url: string | null;
    mime: string;
    likelyDomain: string | null;
    suggestion: string;
  } {
    if (!input.buffer || !input.buffer.length) throw new Error("Arquivo vazio.");
    if (input.buffer.length > MAX_BYTES) throw new Error("Arquivo muito grande (máx 15MB).");
    // Segurança H4: confia no CONTEÚDO real, nunca no tipo declarado pelo cliente.
    const mime = detectMime(input.buffer);
    if (!mime) throw new Error("Formato não suportado (use PNG, JPG, WEBP ou PDF).");
    const cls = INTAKE_CLASS[mime] || { kind: "document", likelyDomain: null, suggestion: "Recebi o arquivo e guardei." };

    const art = ArtifactService.create(orgId, {
      kind: cls.kind,
      title: (input.filename && String(input.filename).trim()) || "Arquivo recebido",
      mimeType: mime,
      content: input.buffer,
      origin: "intake",
      classification: input.classification || "internal",
      createdBy: userId,
      correlationId: input.correlationId || null,
    });
    logAuthEvent(orgId, userId, art.id, "FALATU_FILE_INTAKE", { mime, kind: cls.kind, size: input.buffer.length, correlationId: input.correlationId || null });

    return {
      artifact: { id: art.id, kind: art.kind, title: art.title, mimeType: art.mimeType, sizeBytes: art.sizeBytes, createdAt: art.createdAt },
      url: ArtifactService.signedUrl(orgId, art.id),
      mime,
      likelyDomain: cls.likelyDomain,
      suggestion: cls.suggestion,
    };
  }
}
