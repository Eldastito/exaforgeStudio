/**
 * VideoUploadService — vídeo próprio do usuário entra no mesmo pipeline do Estúdio (ADR-207 F13b.3).
 *
 * NÃO cria 2º sistema de mídia: o arquivo vira uma criação do Estúdio (`studio_creations`, kind video, `source='uploaded'`)
 * gravada em MEDIA_DIR como qualquer outra — o render (F13b) não distingue gerado × enviado. O `source` existe pra que
 * enviar/editar NÃO consuma a cota mensal de GERAÇÃO por IA (`PlanService.studioUsage` só conta `source` gerado).
 *
 * Validação do arquivo REAL (não confia em extensão/MIME do navegador): MIME na lista + `FfmpegService.probe` precisa achar
 * stream de vídeo, duração dentro do limite. Nome do usuário NUNCA vira caminho nem argumento — o arquivo salvo é
 * `studio_<uuid>.<ext>` (ext vem do MIME aceito); só uma versão higienizada do nome vai para o rótulo. Sem normalização
 * no upload: o render já reencoda para H.264/AAC, então codecs variados são tratados lá (sem gastar CPU à toa aqui).
 * Original imutável; tudo por organização.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { FfmpegService, FfmpegError, MediaInfo } from "./FfmpegService.js";

const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch { /* noop */ }

export const VIDEO_MIME_EXT: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
export const MAX_UPLOAD_BYTES = Number(process.env.VIDEO_UPLOAD_MAX_BYTES) || 200 * 1024 * 1024;
export const MAX_UPLOAD_SECONDS = Number(process.env.VIDEO_UPLOAD_MAX_SECONDS) || 600;

const MESSAGES: Record<string, string> = {
  bad_type: "Formato não aceito. Envie um vídeo MP4, MOV ou WEBM.",
  too_large: "O vídeo é grande demais para enviar.",
  too_long: "O vídeo é longo demais para editar aqui.",
  no_video: "Esse arquivo não tem imagem de vídeo.",
  invalid: "Não consegui ler esse vídeo. Ele pode estar corrompido.",
  unavailable: "O processamento de vídeo não está disponível neste servidor no momento.",
};
export class VideoUploadError extends Error { constructor(public code: string) { super(MESSAGES[code] || MESSAGES.invalid); this.name = "VideoUploadError"; } }

function cleanLabel(name: string): string {
  const base = path.basename(String(name || "video")).replace(/\.[a-z0-9]{1,5}$/i, "");
  return base.replace(/[\u0000-\u001f\u007f<>"'`$;|&\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "video";
}

export interface UploadedVideo { creationId: string; mediaUrl: string; label: string; metadata: MediaInfo; sizeBytes: number }

export class VideoUploadService {
  /** `tmpPath` é o arquivo recebido (pasta temporária) — SEMPRE removido ao final, com sucesso ou erro. */
  static async ingest(orgId: string, file: { tmpPath: string; originalName: string; mime: string; size: number }): Promise<UploadedVideo> {
    try {
      const ext = VIDEO_MIME_EXT[String(file.mime || "").toLowerCase()];
      if (!ext) throw new VideoUploadError("bad_type");
      let size = file.size;
      try { size = fs.statSync(file.tmpPath).size; } catch { throw new VideoUploadError("invalid"); }
      if (size > MAX_UPLOAD_BYTES) throw new VideoUploadError("too_large");
      if (size <= 0) throw new VideoUploadError("invalid");

      let meta: MediaInfo;
      try { meta = await FfmpegService.probe(file.tmpPath); }
      catch (e: any) {
        if (e instanceof FfmpegError && e.code === "ffmpeg_unavailable") throw new VideoUploadError("unavailable");
        throw new VideoUploadError("invalid");
      }
      if (!meta.hasVideo) throw new VideoUploadError("no_video");
      if (meta.durationMs <= 0) throw new VideoUploadError("invalid");
      if (meta.durationMs > MAX_UPLOAD_SECONDS * 1000) throw new VideoUploadError("too_long");

      const name = `studio_${randomUUID()}.${ext}`;
      fs.copyFileSync(file.tmpPath, path.join(MEDIA_DIR, name));
      const id = randomUUID();
      const label = cleanLabel(file.originalName);
      db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status, source) VALUES (?, ?, 'video', ?, ?, 'done', 'uploaded')")
        .run(id, orgId, `vídeo enviado: ${label}`, `/media/${name}`);
      return { creationId: id, mediaUrl: `/media/${name}`, label, metadata: meta, sizeBytes: size };
    } finally {
      try { fs.rmSync(file.tmpPath, { force: true }); } catch { /* noop */ }
    }
  }
}

export default VideoUploadService;
