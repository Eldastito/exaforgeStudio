// Cifra em repouso para segredos que o VISION-CLOUD precisa (o segredo de
// assinatura de um webhook de saída, ver webhooks.ts) — reimplementação
// deliberada, NÃO um import de src/server/EncryptionService.ts, pelo mesmo
// motivo de auth.ts reimplementar a checagem de JWT em vez de importar a do
// core (ver comentário no topo de auth.ts): este processo não deve acoplar
// no código do core (ADR-001). Mesmo algoritmo (AES-256-GCM) e mesma chave
// (ENCRYPTION_KEY, com fallback para JWT_SECRET) por consistência de operação
// — os dois processos já compartilham essas envs.
import crypto from "crypto";

const PREFIX = "enc:v1:";

function resolveKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || "";
  return crypto.createHash("sha256").update(raw || "vision-cloud-dev-key-fallback").digest();
}
const KEY = resolveKey();

export function isEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** Cifra um segredo (ex.: chave de assinatura de webhook). Idempotente. */
export function encryptSecret(plain: string): string {
  if (isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Decifra um segredo. Lança se o valor não puder ser decifrado. */
export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value;
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
