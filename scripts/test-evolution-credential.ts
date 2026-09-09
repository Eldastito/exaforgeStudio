/**
 * TEST — F1.1: credencial Evolution resolvida no ponto único, token do CANAL
 * primeiro (PRD WhatsApp Unificado — RF-02/INV-01, achado A6).
 *
 * Antes o envio fazia `process.env.EVOLUTION_API_KEY || channel.token_encrypted`
 * — a chave GLOBAL do deploy sobrescrevia o token da instância de TODO canal
 * (quebra isolamento multi-tenant). Agora é `channel.token_encrypted || env`.
 *
 * Prova, offline (fetch stubado, zero rede):
 *  - canal COM token → o header apikey enviado é o token do CANAL (não a env).
 *  - canal SEM token → cai na env (0-regressão do deploy single-tenant).
 *  - vale pra sendMessage E sendDocument (mesma resolução central).
 *  - dois canais/orgs distintos usam cada um o SEU token (isolamento).
 *
 * Uso: npm run test:evolution-credential
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ev-cred-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ev-cred-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Captura os headers da última chamada de envio (apikey).
let lastHeaders: any = null;
function installFetch() {
  const orig = (globalThis as any).fetch;
  (globalThis as any).fetch = async (_url: string, opts?: any) => {
    lastHeaders = opts?.headers || null;
    return { ok: true, status: 200, text: async () => "{}", json: async () => ({ key: { id: "mid" } }), headers: { get: () => "application/json" } };
  };
  return () => { (globalThis as any).fetch = orig; };
}

async function main() {
  const db = (await import("../src/server/db.js")).default;

  const mkOrg = () => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(o);
    return o;
  };
  const mkChannel = (org: string, token: string | null) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'evolution_go', 'Ev', 'inst_name', 'connected', ?)`)
      .run(id, org, token);
    return id;
  };

  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");
  const restore = installFetch();

  // ── 1. canal COM token → apikey = token do canal (não a env) ──
  process.env.EVOLUTION_API_KEY = "GLOBAL_ENV_KEY";
  const A = mkOrg();
  const chWithToken = mkChannel(A, "CHANNEL_TOKEN_A");
  await MessageProviderService.sendMessage(chWithToken, "5521999", "oi");
  check("1.1 sendMessage usa o token do CANAL", lastHeaders?.apikey === "CHANNEL_TOKEN_A");
  check("1.2 NÃO usa a env quando o canal tem token", lastHeaders?.apikey !== "GLOBAL_ENV_KEY");

  // ── 2. canal SEM token → cai na env (0-regressão) ──
  const chNoToken = mkChannel(A, null);
  await MessageProviderService.sendMessage(chNoToken, "5521999", "oi");
  check("2.1 sendMessage cai na env quando o canal não tem token", lastHeaders?.apikey === "GLOBAL_ENV_KEY");

  // ── 3. sendDocument usa a MESMA resolução (token do canal) ──
  lastHeaders = null;
  await MessageProviderService.sendDocument(chWithToken, "5521999", "https://app.test/a.pdf", "a.pdf");
  check("3.1 sendDocument usa o token do CANAL", lastHeaders?.apikey === "CHANNEL_TOKEN_A");

  // ── 4. isolamento: outra org com outro token ──
  const B = mkOrg();
  const chB = mkChannel(B, "CHANNEL_TOKEN_B");
  await MessageProviderService.sendMessage(chB, "5521888", "oi");
  check("4.1 org B usa o SEU token (isolamento)", lastHeaders?.apikey === "CHANNEL_TOKEN_B");

  // ── 5. sem token no canal E sem env → string vazia (não vaza outra credencial) ──
  delete process.env.EVOLUTION_API_KEY;
  const C = mkOrg();
  const chC = mkChannel(C, null);
  lastHeaders = null;
  await MessageProviderService.sendMessage(chC, "5521777", "oi");
  check("5.1 sem token e sem env → apikey vazio", lastHeaders?.apikey === "");

  restore();
  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} evolution-credential: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
