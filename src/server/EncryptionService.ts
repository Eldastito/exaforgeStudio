import crypto from "crypto";
import db from "./db.js";

/**
 * Criptografia de segredos EM REPOUSO (campo a campo) — AES-256-GCM.
 *
 * - Transparente: `encrypt` produz `enc:v1:<base64>`; `decrypt` reconhece esse
 *   prefixo e, se o valor NÃO estiver criptografado (texto legado), devolve-o
 *   como está. Isso permite migração sem downtime + backfill idempotente.
 * - Chave: env ENCRYPTION_KEY (recomendado). Sem ela, deriva de JWT_SECRET para
 *   não exigir nova env — mas avisa, pois trocar o JWT_SECRET passaria a quebrar
 *   a leitura dos segredos guardados.
 * - GCM garante confidencialidade E integridade (tag de autenticação).
 */
const PREFIX = "enc:v1:";

function resolveKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || "";
  if (!process.env.ENCRYPTION_KEY) {
    if (process.env.NODE_ENV === "production" && raw) {
      console.warn("[SECURITY] ENCRYPTION_KEY não definida — derivando de JWT_SECRET. " +
        "Defina ENCRYPTION_KEY dedicada para não atrelar os segredos ao JWT_SECRET.");
    }
  }
  // 32 bytes determinísticos a partir do material disponível.
  return crypto.createHash("sha256").update(raw || "zappflow-dev-key-fallback").digest();
}

const KEY = resolveKey();

export class EncryptionService {
  static isEncrypted(value: any): boolean {
    return typeof value === "string" && value.startsWith(PREFIX);
  }

  /** SHA-256 hex digest for lookup-by-value columns (never reversible). */
  static hash(plain: string | null | undefined): string | null {
    if (plain == null || plain === "") return null;
    const val = this.isEncrypted(plain) ? this.decrypt(plain) : plain;
    if (!val) return null;
    return crypto.createHash("sha256").update(val).digest("hex");
  }

  /** Cifra um texto. Vazio/nulo passa direto. Idempotente (não recifra). */
  static encrypt(plain: string | null | undefined): string | null {
    if (plain == null || plain === "") return (plain as any) ?? null;
    if (this.isEncrypted(plain)) return plain; // já cifrado
    try {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
      const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
    } catch (e) {
      console.error("[Encryption] Falha ao cifrar:", e);
      return plain; // não perde o dado; fica em texto (melhor que sumir)
    }
  }

  /** Decifra. Texto legado (sem prefixo) volta como está. Falha → null. */
  static decrypt(value: string | null | undefined): string | null {
    if (value == null || value === "") return (value as any) ?? null;
    if (!this.isEncrypted(value)) return value; // texto legado
    try {
      const raw = Buffer.from(value.slice(PREFIX.length), "base64");
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const ct = raw.subarray(28);
      const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch (e) {
      console.error("[Encryption] Falha ao decifrar um segredo (chave trocada?).");
      return null; // degrada com segurança (não devolve cifra como se fosse o segredo)
    }
  }

  /**
   * Backfill idempotente: cifra os segredos que ainda estão em TEXTO no banco.
   * Roda no boot; pula o que já está com prefixo `enc:`. Cobre o token do gateway
   * de pagamento e os tokens do Google (access/refresh).
   */
  static backfillExistingSecrets(): { updated: number } {
    let updated = 0;
    const encCol = (table: string, idCol: string, col: string) => {
      let rows: any[] = [];
      try {
        rows = db.prepare(`SELECT ${idCol} AS id, ${col} AS val FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != '' AND ${col} NOT LIKE 'enc:%'`).all() as any[];
      } catch (e) { return; }
      const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${idCol} = ?`);
      for (const r of rows) {
        const enc = this.encrypt(r.val);
        if (enc && this.isEncrypted(enc)) { try { upd.run(enc, r.id); updated++; } catch (e) { /* noop */ } }
      }
    };
    encCol("organization_settings", "organization_id", "pay_gateway_token");
    encCol("organization_settings", "organization_id", "pay_webhook_secret");
    encCol("organization_settings", "organization_id", "integration_token");
    encCol("oauth_connections", "id", "access_token");
    encCol("oauth_connections", "id", "refresh_token");

    // Backfill hash columns for lookup-by-value secrets.
    const hashCol = (table: string, idCol: string, secretCol: string, hashCol: string) => {
      let rows: any[] = [];
      try {
        rows = db.prepare(`SELECT ${idCol} AS id, ${secretCol} AS val FROM ${table} WHERE ${secretCol} IS NOT NULL AND ${secretCol} != '' AND (${hashCol} IS NULL OR ${hashCol} = '')`).all() as any[];
      } catch (e) { return; }
      const upd = db.prepare(`UPDATE ${table} SET ${hashCol} = ? WHERE ${idCol} = ?`);
      for (const r of rows) {
        const h = this.hash(r.val);
        if (h) { try { upd.run(h, r.id); updated++; } catch (e) { /* noop */ } }
      }
    };
    hashCol("organization_settings", "organization_id", "pay_webhook_secret", "pay_webhook_secret_hash");
    hashCol("organization_settings", "organization_id", "integration_token", "integration_token_hash");

    if (updated) console.log(`[Encryption] Backfill: ${updated} segredo(s) cifrado(s)/hasheado(s) em repouso.`);
    return { updated };
  }
}
