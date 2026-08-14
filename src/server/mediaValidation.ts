/**
 * mediaValidation — validação de conteúdo de mídia por MAGIC BYTES (SEC-F10 / achado A9).
 *
 * `saveMediaBase64` gravava bytes confiando na extensão/MIME vindos do cliente. Aqui a extensão
 * é DERIVADA do conteúdo real (sniff dos primeiros bytes), e conteúdo não reconhecido é REJEITADO
 * — nada de arbitrário aterrissa no diretório público de mídia. Sem dependência externa
 * (`file-type` puxaria centenas de KB pra ~4 casos); mesma abordagem do `ClinicAttachmentService`.
 */

export type ImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

const EXT_BY_MIME: Record<ImageMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Detecta o MIME de IMAGEM pelos magic bytes. `null` se não for uma imagem reconhecida. */
export function detectImageMime(buf: Buffer): ImageMime | null {
  if (!buf || buf.length < 4) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // GIF: "GIF87a" / "GIF89a"
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  // WEBP: "RIFF"...."WEBP"
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * Valida um base64 como IMAGEM real e devolve o buffer + extensão DERIVADA do conteúdo.
 * `null` se não decodificar ou não for uma imagem reconhecida (rejeitado — não grava nada).
 */
export function validateImageBase64(base64: string): { buffer: Buffer; ext: string; mime: ImageMime } | null {
  if (!base64) return null;
  let buffer: Buffer;
  try { buffer = Buffer.from(base64, "base64"); } catch { return null; }
  if (!buffer || buffer.length === 0) return null;
  const mime = detectImageMime(buffer);
  if (!mime) return null;
  return { buffer, ext: EXT_BY_MIME[mime], mime };
}
