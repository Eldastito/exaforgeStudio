import crypto from "crypto";

/**
 * TOTP (RFC 6238) compatível com Google Authenticator / Authy / 1Password.
 * Implementado com crypto nativo — sem dependência externa.
 */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str: string): Buffer {
  const clean = (str || "").toUpperCase().replace(/=+$/g, "").replace(/\s/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export class TOTPService {
  /** Gera um segredo base32 (20 bytes = 160 bits). */
  static generateSecret(): string {
    return base32Encode(crypto.randomBytes(20));
  }

  /** URL otpauth:// para QR code (issuer = ZappFlow). */
  static otpauthURL(secret: string, accountLabel: string, issuer = "ZappFlow"): string {
    const label = encodeURIComponent(`${issuer}:${accountLabel}`);
    const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
    return `otpauth://totp/${label}?${params.toString()}`;
  }

  /** Código de 6 dígitos para um passo de tempo. */
  private static codeForCounter(secret: string, counter: number): string {
    const key = base32Decode(secret);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac("sha1", key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return String(bin % 1_000_000).padStart(6, "0");
  }

  /**
   * Verifica um token de 6 dígitos com janela de tolerância (±1 passo = ±30s),
   * comparando em tempo constante.
   */
  static verify(secret: string, token: string, window = 1): boolean {
    const t = (token || "").replace(/\s/g, "");
    if (!/^\d{6}$/.test(t)) return false;
    const counter = Math.floor(Date.now() / 1000 / 30);
    for (let i = -window; i <= window; i++) {
      const expected = this.codeForCounter(secret, counter + i);
      const a = Buffer.from(expected), b = Buffer.from(t);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
    return false;
  }

  /** Gera N códigos de backup (8 dígitos). Mostrados uma vez ao usuário. */
  static generateBackupCodes(n = 8): string[] {
    return Array.from({ length: n }, () =>
      String(crypto.randomInt(0, 100_000_000)).padStart(8, "0")
    );
  }
}
