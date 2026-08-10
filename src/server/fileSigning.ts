/**
 * fileSigning — util COMPARTILHADO de URL assinada (PRD 1, Fase 2 / §16).
 *
 * O padrão de entrega segura por HMAC (segredo derivado por escopo + TTL +
 * timingSafeEqual + guarda de path) estava COPIADO em ClinicDocumentDelivery,
 * ClinicGuideDelivery, ClinicMonthlyReport e FashionLook. Esta é a extração
 * canônica (convenção nº 4 do CLAUDE.md): um `signKey`/`verifyKey` reusável,
 * parametrizado por `scope` (cada consumidor isola suas assinaturas).
 *
 * Propriedades:
 *  - segredo = sha256(`${JWT_SECRET}:${scope}_v1`) — rotacionar o JWT invalida
 *    as URLs antigas (desejado); escopos diferentes NÃO cruzam assinaturas;
 *  - TTL curto default (15min); expiração verificada no `verifyKey`;
 *  - `timingSafeEqual` (guarda de comprimento) contra timing attack;
 *  - `safeStorageKey`: aceita EXATAMENTE `{a}/{b}` de segmentos [A-Za-z0-9._-]
 *    (barra única; recusa `..`, barras extras, basename escondido).
 */
import crypto from "node:crypto";
import path from "node:path";
import { JWT_SECRET } from "./config/secret.js";

export const DEFAULT_SIGNED_TTL_MS = 15 * 60 * 1000; // 15 min

const secretCache = new Map<string, string>();
function scopeSecret(scope: string): string {
  let s = secretCache.get(scope);
  if (!s) {
    s = crypto.createHash("sha256").update(`${JWT_SECRET}:${scope}_v1`).digest("hex");
    secretCache.set(scope, s);
  }
  return s;
}

/** Guarda de path: `{seg}/{seg}` com segmentos [A-Za-z0-9._-] e sem escape. */
export function safeStorageKey(storageKey: string): string {
  const parts = String(storageKey || "").split("/");
  if (parts.length !== 2) throw new Error("Chave de arquivo inválida.");
  for (const seg of parts) {
    // Rejeita `.`/`..` explicitamente (mais estrito que o padrão herdado): um
    // segmento "." ou ".." passa no regex mas `path.join` sairia do diretório.
    if (seg === "." || seg === ".." || !/^[a-zA-Z0-9._-]+$/.test(seg) || path.basename(seg) !== seg) {
      throw new Error("Chave de arquivo inválida.");
    }
  }
  return parts.join("/");
}

/** Assina (scope, key) com validade `ttlMs`. Retorna `{ exp, sig }`. */
export function signKey(scope: string, key: string, ttlMs = DEFAULT_SIGNED_TTL_MS, now = Date.now()): { exp: number; sig: string } {
  const safe = safeStorageKey(key);
  const exp = now + ttlMs;
  const sig = crypto.createHmac("sha256", scopeSecret(scope)).update(`${safe}:${exp}`).digest("hex");
  return { exp, sig };
}

/** Verifica HMAC + expiração. `false` se: key inválida, expirado, ou sig não bate. */
export function verifyKey(scope: string, key: string, exp: string | number, sig: string, now = Date.now()): boolean {
  let safe: string;
  try { safe = safeStorageKey(key); } catch { return false; }
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs < now) return false;
  const expected = crypto.createHmac("sha256", scopeSecret(scope)).update(`${safe}:${expMs}`).digest("hex");
  const a = Buffer.from(String(sig || ""), "utf-8");
  const b = Buffer.from(expected, "utf-8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
