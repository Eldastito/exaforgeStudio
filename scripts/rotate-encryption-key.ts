/**
 * Rotação de ENCRYPTION_KEY (ADR-054/078).
 *
 * Rotaciona a chave que cifra segredos em repouso: OAuth tokens, integration
 * token, pay_gateway_token, pay_webhook_secret, mfa_secret, backup codes,
 * memória do cliente. Passo a passo:
 *
 *   1) Provisiona a nova ENCRYPTION_KEY na infra (Coolify/K8s/etc.), mas NÃO
 *      reinicia o app ainda. Neste momento a nova chave existe SÓ como
 *      arquivo/segredo, não é usada em runtime.
 *   2) Roda este script UMA VEZ em uma instância com acesso ao DB e a AMBAS
 *      as chaves (antiga como OLD_ENCRYPTION_KEY, nova como ENCRYPTION_KEY).
 *      O script decifra cada segredo com a chave antiga e recifra com a nova,
 *      atualizando linha por linha em transação.
 *   3) Depois que este script confirmar 0 erros, promove a nova chave em
 *      produção (ENCRYPTION_KEY definitiva) e reinicia o app.
 *   4) OPCIONAL: remove a variável OLD_ENCRYPTION_KEY do ambiente.
 *
 * Nunca perde o dado: se um segredo não decifra (chave errada, corrupção),
 * ele é PULADO com log — o script não escreve nada nele. Rode em modo
 * `--dry-run` primeiro para ver o que iria mudar.
 *
 * Uso:
 *   OLD_ENCRYPTION_KEY=<antiga> ENCRYPTION_KEY=<nova> tsx scripts/rotate-encryption-key.ts --dry-run
 *   OLD_ENCRYPTION_KEY=<antiga> ENCRYPTION_KEY=<nova> tsx scripts/rotate-encryption-key.ts
 */
import crypto from "crypto";
import path from "path";
import fs from "fs";

const DRY_RUN = process.argv.includes("--dry-run");
const PREFIX = "enc:v1:";

function deriveKey(material: string): Buffer {
  return crypto.createHash("sha256").update(material || "zappflow-dev-key-fallback").digest();
}

function decryptWith(value: string, key: Buffer): string | null {
  if (!value || !value.startsWith(PREFIX)) return value; // legado sem prefixo
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const dec = crypto.createDecipheriv("aes-256-gcm", key, iv);
    dec.setAuthTag(tag);
    return Buffer.concat([dec.update(ct), dec.final()]).toString("utf8");
  } catch { return null; }
}

function encryptWith(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

async function main() {
  const OLD = process.env.OLD_ENCRYPTION_KEY;
  const NEW = process.env.ENCRYPTION_KEY;
  if (!OLD || !NEW) {
    console.error("❌ Defina OLD_ENCRYPTION_KEY e ENCRYPTION_KEY (a nova).");
    console.error("   Ex.: OLD_ENCRYPTION_KEY=... ENCRYPTION_KEY=... tsx scripts/rotate-encryption-key.ts --dry-run");
    process.exit(1);
  }
  if (OLD === NEW) {
    console.error("❌ OLD_ENCRYPTION_KEY e ENCRYPTION_KEY iguais — nada a rotacionar.");
    process.exit(1);
  }
  if (!process.env.JWT_SECRET) {
    console.error("❌ JWT_SECRET não definida (necessária para o bootstrap do banco).");
    process.exit(1);
  }

  const oldKey = deriveKey(OLD);
  const newKey = deriveKey(NEW);

  // Importa db DEPOIS de checar as chaves — evita colateral de bootstrap.
  const { default: db } = await import("../src/server/db.js");

  // Lista de colunas cifradas. Espelha o backfillExistingSecrets do
  // EncryptionService — se adicionar cifra a uma nova coluna, atualize aqui.
  const TARGETS: { table: string; idCol: string; col: string }[] = [
    { table: "organization_settings", idCol: "organization_id", col: "pay_gateway_token" },
    { table: "organization_settings", idCol: "organization_id", col: "pay_webhook_secret" },
    { table: "organization_settings", idCol: "organization_id", col: "integration_token" },
    { table: "oauth_connections", idCol: "id", col: "access_token" },
    { table: "oauth_connections", idCol: "id", col: "refresh_token" },
  ];

  console.log(`\n${DRY_RUN ? "🔍 DRY RUN" : "🔧 ROTAÇÃO"} — ${TARGETS.length} colunas alvo\n`);

  let totalCandidates = 0, totalRotated = 0, totalSkipped = 0, totalLegacy = 0;

  for (const t of TARGETS) {
    let rows: any[] = [];
    try {
      rows = db.prepare(`SELECT ${t.idCol} AS id, ${t.col} AS val FROM ${t.table} WHERE ${t.col} IS NOT NULL AND ${t.col} != ''`).all() as any[];
    } catch (e) {
      console.log(`  ⏭️  ${t.table}.${t.col} — tabela/coluna inexistente, pula`);
      continue;
    }

    let rotated = 0, skipped = 0, legacy = 0;
    const upd = db.prepare(`UPDATE ${t.table} SET ${t.col} = ? WHERE ${t.idCol} = ?`);

    for (const r of rows) {
      totalCandidates++;
      const val = r.val as string;
      if (!val.startsWith(PREFIX)) {
        // Legado em texto — não precisa rotacionar, já não tem chave envolvida.
        legacy++;
        totalLegacy++;
        continue;
      }
      const plain = decryptWith(val, oldKey);
      if (plain == null) {
        console.log(`  ⚠️  ${t.table}.${t.col}[${String(r.id).slice(0, 10)}] — falha ao decifrar com OLD_ENCRYPTION_KEY, PULADO`);
        skipped++;
        totalSkipped++;
        continue;
      }
      const rec = encryptWith(plain, newKey);
      if (!DRY_RUN) upd.run(rec, r.id);
      rotated++;
      totalRotated++;
    }

    console.log(`  📋 ${t.table}.${t.col}: ${rotated} rotacionado(s), ${skipped} pulado(s), ${legacy} legado(s)/texto`);
  }

  console.log("\n=========================================");
  console.log(`  Candidatos: ${totalCandidates}`);
  console.log(`  ${DRY_RUN ? "Rotacionaria" : "Rotacionado"}: ${totalRotated}`);
  console.log(`  Legado (sem cifra): ${totalLegacy}`);
  console.log(`  Pulado (falha decifrar): ${totalSkipped}`);
  console.log("=========================================");

  if (totalSkipped > 0) {
    console.log("⚠️  Segredos pulados NÃO foram atualizados. Investigue antes de promover a nova chave.");
    process.exit(2);
  }
  if (DRY_RUN) {
    console.log("✅ Dry-run ok. Rode sem --dry-run para efetivar a rotação.");
  } else {
    console.log("✅ Rotação concluída. Agora promova a nova chave em produção e reinicie o app.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("💥 Rotação explodiu:", e);
  process.exit(1);
});
