/**
 * TEST — X1 (SEC): token de canal CIFRADO em repouso.
 *
 * `channels.token_encrypted` era TEXTO PURO apesar do nome. Esta fatia pluga a
 * coluna na mesma máquina do EncryptionService (AES-256-GCM, prefixo enc:v1:,
 * transparente pra legado). Prova, offline (tmp db, fetch stubado — sem rede):
 *  - ESCRITA cifra (o helper de escrita produz enc:v1:, nunca plaintext);
 *  - LEITURA decifra nos consumidores reais (Evolution via header do provedor,
 *    Instagram e Facebook via getChannel) — o token usado é o CLARO, nunca o enc:;
 *  - LEGADO em texto puro segue funcionando (0-regressão, transparente);
 *  - BACKFILL de boot cifra os tokens existentes em repouso;
 *  - o valor em repouso NUNCA é o segredo em claro após o backfill.
 *
 * Uso: npm run test:security-channel-token
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ch-token-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ch-token-1"; process.env.ENCRYPTION_KEY = "dedicated-key-ch-token-xyz";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { EncryptionService: ENC } = await import("../src/server/EncryptionService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");
  const { InstagramService } = await import("../src/server/InstagramService.js");
  const { FacebookService } = await import("../src/server/FacebookService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkCh = (org: string, provider: string, token: string | null, name = "n") => { const id = randomUUID(); db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, ?, ?, 'id1', 'connected', ?)`).run(id, org, provider, name, token); return id; };
  const rawToken = (id: string) => (db.prepare(`SELECT token_encrypted FROM channels WHERE id = ?`).get(id) as any).token_encrypted;

  // ── 1. escrita cifra ──
  const enc = ENC.encrypt("EVO_REAL");
  check("1.1 helper de escrita produz enc:v1: (nunca plaintext)", typeof enc === "string" && enc!.startsWith("enc:v1:") && enc !== "EVO_REAL");
  check("1.2 roundtrip decifra pro claro", ENC.decrypt(enc) === "EVO_REAL");

  // ── 2. leitura decifra: Evolution (via header do provedor) ──
  let lastHeaders: any = null;
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (_url: string, opts: any) => { lastHeaders = opts?.headers || null; return { ok: true, status: 200, text: async () => "{}", json: async () => ({ key: { id: "mid" } }), headers: { get: () => "application/json" } }; };

  const orgA = `org_${randomUUID().slice(0, 6)}`; mkOrg(orgA);
  const chEvo = mkCh(orgA, "evolution_go", ENC.encrypt("EVO_REAL"));
  await MessageProviderService.sendMessage(chEvo, "5521999", "oi");
  check("2.1 Evolution: header usa o token CLARO (decifrado)", lastHeaders?.apikey === "EVO_REAL");
  check("2.2 Evolution: o enc:v1: NUNCA vai pro provedor", !JSON.stringify(lastHeaders).includes("enc:v1:"));

  // ── 3. leitura decifra: Instagram + Facebook ──
  const orgIG = `org_${randomUUID().slice(0, 6)}`; mkOrg(orgIG); mkCh(orgIG, "instagram", ENC.encrypt("IG_REAL"), "Instagram @loja");
  check("3.1 Instagram getChannel devolve token claro", InstagramService.getChannel(orgIG)?.token === "IG_REAL");
  const orgFB = `org_${randomUUID().slice(0, 6)}`; mkOrg(orgFB); mkCh(orgFB, "facebook", ENC.encrypt("FB_REAL"), "Página");
  check("3.2 Facebook getChannel devolve token claro", FacebookService.getChannel(orgFB)?.token === "FB_REAL");

  // ── 4. legado em texto puro (0-regressão) ──
  const orgL = `org_${randomUUID().slice(0, 6)}`; mkOrg(orgL);
  const chLegacy = mkCh(orgL, "evolution_go", "PLAIN_LEGACY");
  lastHeaders = null;
  await MessageProviderService.sendMessage(chLegacy, "5521999", "oi");
  check("4.1 legado plaintext segue funcionando (transparente)", lastHeaders?.apikey === "PLAIN_LEGACY");

  // ── 5. backfill cifra os tokens existentes em repouso ──
  check("5.1 antes do backfill o legado está em TEXTO", rawToken(chLegacy) === "PLAIN_LEGACY");
  ENC.backfillExistingSecrets();
  check("5.2 depois do backfill o valor em repouso é enc:v1:", ENC.isEncrypted(rawToken(chLegacy)));
  check("5.3 backfill NÃO deixa o segredo em claro no banco", rawToken(chLegacy) !== "PLAIN_LEGACY");
  check("5.4 e decifra de volta pro original", ENC.decrypt(rawToken(chLegacy)) === "PLAIN_LEGACY");
  // idempotente: rodar de novo não re-cifra o que já está cifrado
  const before = rawToken(chEvo); ENC.backfillExistingSecrets();
  check("5.5 backfill idempotente (não re-cifra)", rawToken(chEvo) === before);
  (globalThis as any).fetch = origFetch;

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} security-channel-token: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
