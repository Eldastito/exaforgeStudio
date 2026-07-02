import fs from "fs";
import path from "path";

// Storage plugável para arquivos gerados (PDF de relatório, backup em JSON).
// Padrão (S3_ENABLED != "true"): disco local, comportamento 100% igual ao que
// já existia em ReportPdfService/BackupService — esta classe só entra em cena
// quando alguém explicitamente configura um destino S3-compatível.
//
// Por quê: "backup e PDF em disco local, presos a uma única instância" só é um
// problema de verdade quando o ZappFlow rodar em mais de uma réplica (ou
// quiser trocar de host sem perder arquivos gerados). Até lá, manter o disco
// local como fonte de verdade é mais simples e não arrisca nada — o upload ao
// S3 é sempre um espelho best-effort DEPOIS de já ter escrito localmente,
// nunca no lugar disso, e uma falha no upload nunca derruba quem chamou.
//
// Compatível com qualquer provedor S3-like (AWS S3, Cloudflare R2, Backblaze
// B2, MinIO...) via S3_ENDPOINT + S3_FORCE_PATH_STYLE.

function isEnabled(): boolean {
  return process.env.S3_ENABLED === "true" && !!process.env.S3_BUCKET;
}

let clientPromise: Promise<any> | null = null;
async function getClient(): Promise<any> {
  if (!clientPromise) {
    clientPromise = import("@aws-sdk/client-s3").then(({ S3Client }) => new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: process.env.S3_ACCESS_KEY_ID
        ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "" }
        : undefined, // sem credenciais explícitas: usa a cadeia padrão do SDK (roles/env da nuvem)
    }));
  }
  return clientPromise;
}

function contentTypeFor(key: string): string {
  if (key.endsWith(".pdf")) return "application/pdf";
  if (key.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

export class StorageService {
  static isS3Enabled = isEnabled;

  /**
   * Espelha um arquivo JÁ ESCRITO no disco local para o S3, sob `key`.
   * Nunca lança — falha vira log + `stored: false`, quem chamou continua
   * usando o arquivo local normalmente (o disco local é sempre a fonte de
   * verdade; o S3 é redundância/portabilidade, não substituição).
   */
  static async mirrorToS3(localFilePath: string, key: string): Promise<{ stored: boolean; url?: string }> {
    if (!isEnabled()) return { stored: false };
    try {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const client = await getClient();
      const body = fs.readFileSync(localFilePath);
      await client.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentTypeFor(key),
      }));
      const base = (process.env.S3_PUBLIC_URL_BASE || "").replace(/\/$/, "");
      const url = base
        ? `${base}/${key}`
        : `${(process.env.S3_ENDPOINT || `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION || "us-east-1"}.amazonaws.com`).replace(/\/$/, "")}/${process.env.S3_ENDPOINT ? `${process.env.S3_BUCKET}/` : ""}${key}`;
      return { stored: true, url };
    } catch (e) {
      console.error(`[StorageService] Falha ao espelhar '${path.basename(localFilePath)}' para o S3 (mantendo apenas local):`, e);
      return { stored: false };
    }
  }
}
