/**
 * TEST — EncryptionService (ADR-054).
 *
 * Cobre os invioláveis do serviço que guarda TODOS os segredos da org em repouso:
 *  - Round-trip encrypt/decrypt (unicode, vazio, null, undefined).
 *  - Idempotência: encrypt(encrypt(x)) === encrypt(x) (não recifra).
 *  - Detecção de adulteração: mexer no ciphertext → decrypt retorna null.
 *  - Compat com legado: texto sem prefixo continua legível (migração no-downtime).
 *  - Hash: SHA-256 hex determinístico p/ lookup por valor.
 *  - Backfill idempotente: rodar 2x, a segunda não altera nada.
 *
 * Regressão que este teste protege: se alguém trocar GCM por CBC (perde
 * integridade), ou remover o prefixo (quebra idempotência), ou trocar o
 * algoritmo do hash (quebra lookup em prod), o CI vira vermelho.
 *
 * Uso: npm run test:encryption-service
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-encryption-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-encryption-1234567890ab";
process.env.ENCRYPTION_KEY = "test-encryption-key-dedicated-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");
  const E = EncryptionService;

  // ==== 1. Round-trip ====
  console.log("\n=== 1. Round-trip encrypt/decrypt ===");
  const plain = "meu-segredo-super-importante";
  const cipher = E.encrypt(plain);
  check("1.1 encrypt produz string não-vazia com prefixo enc:v1:", typeof cipher === "string" && cipher!.startsWith("enc:v1:"));
  check("1.2 decrypt recupera o texto original", E.decrypt(cipher) === plain);

  // Unicode
  const unicode = "café ☕ 中文 🚀 — nice";
  check("1.3 unicode preserva bytes", E.decrypt(E.encrypt(unicode)) === unicode);

  // Vazio, null, undefined
  check("1.4 encrypt(\"\") retorna \"\" (não gera cifra)", E.encrypt("") === "");
  check("1.5 encrypt(null) retorna null", E.encrypt(null) === null);
  check("1.6 encrypt(undefined) retorna null", E.encrypt(undefined) === null);
  check("1.7 decrypt(\"\") retorna \"\"", E.decrypt("") === "");
  check("1.8 decrypt(null) retorna null", E.decrypt(null) === null);

  // ==== 2. Idempotência ====
  console.log("\n=== 2. Idempotência ===");
  const once = E.encrypt("abc")!;
  const twice = E.encrypt(once)!;
  check("2.1 encrypt(encrypt(x)) === encrypt(x) (não recifra)", once === twice);
  check("2.2 isEncrypted reconhece cifra", E.isEncrypted(once) === true);
  check("2.3 isEncrypted rejeita texto puro", E.isEncrypted("abc") === false);
  check("2.4 isEncrypted rejeita não-string", E.isEncrypted(42 as any) === false);

  // ==== 3. Adulteração ====
  console.log("\n=== 3. Detecção de adulteração ===");
  const c = E.encrypt("original")!;
  // Corrompe um byte no meio do base64
  const rawB64 = c.slice("enc:v1:".length);
  const mid = Math.floor(rawB64.length / 2);
  const tampered = "enc:v1:" + rawB64.slice(0, mid) + (rawB64[mid] === "A" ? "B" : "A") + rawB64.slice(mid + 1);
  check("3.1 cipher adulterado → decrypt retorna null", E.decrypt(tampered) === null);

  // Base64 completamente lixo
  check("3.2 base64 inválido → decrypt retorna null", E.decrypt("enc:v1:!!!not-base64!!!") === null);

  // ==== 4. Compat com legado (texto sem prefixo) ====
  console.log("\n=== 4. Compat com legado (texto sem prefixo) ===");
  check("4.1 decrypt de texto sem prefixo devolve como está", E.decrypt("legado-em-texto") === "legado-em-texto");
  check("4.2 encrypt não altera valor já cifrado", E.encrypt(c) === c);

  // ==== 5. Hash ====
  console.log("\n=== 5. Hash (SHA-256 hex determinístico) ===");
  const h1 = E.hash("mesmo-valor");
  const h2 = E.hash("mesmo-valor");
  check("5.1 hash determinístico (mesmo valor → mesmo hash)", h1 === h2 && h1 !== null);
  check("5.2 hash tem 64 chars hex (SHA-256)", h1?.length === 64 && /^[0-9a-f]{64}$/.test(h1!));
  check("5.3 valores diferentes geram hashes diferentes", E.hash("a") !== E.hash("b"));
  check("5.4 hash(null) retorna null", E.hash(null) === null);
  check("5.5 hash(\"\") retorna null", E.hash("") === null);

  // hash de valor já cifrado deve decifrar antes de hashear (mesmo hash do texto original)
  const hashPlain = E.hash("secret-token");
  const hashCipher = E.hash(E.encrypt("secret-token"));
  check("5.6 hash de cifra é IGUAL ao hash do plaintext (decifra antes)", hashPlain === hashCipher);

  // ==== 6. Backfill idempotente ====
  console.log("\n=== 6. Backfill idempotente ===");
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, pay_webhook_secret, integration_token) VALUES (?, ?, ?, 'active', ?, ?)`)
    .run(randomUUID(), orgId, "Teste", "webhook-secret-plaintext", "zf_integration-plaintext");

  const before = db.prepare(`SELECT pay_webhook_secret, integration_token, pay_webhook_secret_hash, integration_token_hash FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  check("6.1 pré-backfill: secrets estão em texto puro", !E.isEncrypted(before.pay_webhook_secret) && !E.isEncrypted(before.integration_token));

  const first = E.backfillExistingSecrets();
  check("6.2 primeiro backfill atualiza pelo menos 1 registro", first.updated >= 2);

  const after = db.prepare(`SELECT pay_webhook_secret, integration_token, pay_webhook_secret_hash, integration_token_hash FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  check("6.3 pós-backfill: webhook secret cifrado", E.isEncrypted(after.pay_webhook_secret));
  check("6.4 pós-backfill: integration token cifrado", E.isEncrypted(after.integration_token));
  check("6.5 pós-backfill: colunas *_hash preenchidas", !!after.pay_webhook_secret_hash && !!after.integration_token_hash);
  check("6.6 decifra dos valores corresponde ao plaintext original", E.decrypt(after.pay_webhook_secret) === "webhook-secret-plaintext" && E.decrypt(after.integration_token) === "zf_integration-plaintext");

  // Segunda passada: nada a fazer (idempotente)
  const second = E.backfillExistingSecrets();
  check("6.7 segundo backfill não altera nada (idempotente)", second.updated === 0);

  // Confirma que colunas continuam com a mesma cifra (não recifrou)
  const stable = db.prepare(`SELECT pay_webhook_secret FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  check("6.8 cifra não muda entre backfills sucessivos", stable.pay_webhook_secret === after.pay_webhook_secret);

  // ==== 7. IV único por operação (não determinístico) ====
  console.log("\n=== 7. IV único (mesma entrada → cifras diferentes) ===");
  const a = E.encrypt("mesma-entrada");
  const b = E.encrypt("mesma-entrada");
  check("7.1 mesma entrada → cifras diferentes (IV aleatório)", a !== b);
  check("7.2 ambas decifram para o mesmo texto", E.decrypt(a) === E.decrypt(b) && E.decrypt(a) === "mesma-entrada");

  // ==== Relatório ====
  console.log("\n=========================================");
  console.log("RELATÓRIO — EncryptionService (ADR-054)");
  console.log("=========================================");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  console.log("=========================================");
  console.log(`${results.length - failures}/${results.length} passaram`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.log(`❌ ${failures} falhas`); process.exit(1); }
  console.log("✅ Todos os testes passaram");
  process.exit(0);
}

main().catch((e) => {
  console.error("💥 Teste explodiu:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
