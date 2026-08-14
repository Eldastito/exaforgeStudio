/**
 * TEST — Encryption fail-closed (SEC-F1 / SEC-01). DB-backed, determinístico.
 *
 * Prova o GUARDRAIL P0: `EncryptionService.encrypt()` NUNCA persiste plaintext. Se a cifra
 * falhar (AES-GCM quebrado), LANÇA `EncryptionUnavailableError` em vez de devolver o texto
 * (o comportamento antigo, achado A1). Round-trip, idempotência, leitura de legado e o
 * backfill resiliente continuam corretos.
 *
 * Uso: npm run test:security-encryption
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sec-enc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-sec-enc-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const crypto = (await import("crypto")).default;
  const { EncryptionService: ENC, EncryptionUnavailableError } = await import("../src/server/EncryptionService.js");

  const SECRET = "super-secret-token-42";

  // ── 1. Round-trip + prefixo + nunca-plaintext + idempotência + vazio ──
  const enc = ENC.encrypt(SECRET)!;
  check("1.1 cifra tem prefixo enc:v1:", ENC.isEncrypted(enc));
  check("1.2 cifra NUNCA é o plaintext", enc !== SECRET && !enc.includes(SECRET));
  check("1.3 round-trip decifra de volta", ENC.decrypt(enc) === SECRET);
  check("1.4 idempotente (não recifra)", ENC.encrypt(enc) === enc);
  check("1.5 vazio/nulo passam direto", ENC.encrypt("") === "" && ENC.encrypt(null) === null);

  // ── 2. Leitura de legado (texto sem prefixo) volta como está ──
  check("2.1 decrypt de texto legado devolve o próprio texto", ENC.decrypt("token-legado-em-texto") === "token-legado-em-texto");

  // ── 3. Ciphertext adulterado → decrypt falha seguro (null, nunca a cifra) ──
  const tampered = enc.slice(0, -4) + "AAAA";
  check("3.1 decrypt adulterado → null (fail-safe)", ENC.decrypt(tampered) === null);

  // ── 4. FAIL-CLOSED (o coração da fatia): cifra quebrada → LANÇA, não devolve plaintext ──
  const realCreate = crypto.createCipheriv;
  (crypto as any).createCipheriv = () => { throw new Error("crypto indisponível (simulado)"); };
  let threw = false; let leaked: any = "SENTINELA";
  try { leaked = ENC.encrypt(SECRET); } catch (e: any) { threw = true; check("4.2 erro é EncryptionUnavailableError", e instanceof EncryptionUnavailableError && e.code === "encryption_unavailable"); }
  check("4.1 cifra falha → LANÇA (não retorna plaintext, A1 fechado)", threw && leaked === "SENTINELA");

  // ── 5. Backfill resiliente sob falha de cifra: plaintext NÃO se perde nem vira update ──
  const org = `org_enc_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
  db.prepare(`UPDATE organization_settings SET pay_gateway_token = ? WHERE organization_id = ?`).run("PLAINTOKEN-999", org);
  let backfillThrew = false;
  try { ENC.backfillExistingSecrets(); } catch { backfillThrew = true; }
  check("5.1 backfill NÃO aborta quando a cifra falha", !backfillThrew);
  const stillPlain = (db.prepare(`SELECT pay_gateway_token AS t FROM organization_settings WHERE organization_id = ?`).get(org) as any).t;
  check("5.2 sob falha, o segredo fica intacto (não perdido, não gravado cifrado errado)", stillPlain === "PLAINTOKEN-999");

  // ── 6. Restaurada a cifra, o backfill cifra o segredo (retentado no próximo boot) ──
  (crypto as any).createCipheriv = realCreate;
  ENC.backfillExistingSecrets();
  const nowEnc = (db.prepare(`SELECT pay_gateway_token AS t FROM organization_settings WHERE organization_id = ?`).get(org) as any).t;
  check("6.1 com a cifra OK, o backfill cifra o segredo", ENC.isEncrypted(nowEnc));
  check("6.2 e o segredo cifrado decifra de volta ao original", ENC.decrypt(nowEnc) === "PLAINTOKEN-999");

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} security-encryption: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
