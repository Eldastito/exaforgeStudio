/**
 * TESTE — Sincronizar canais com a VERDADE do provedor (17/09/2026).
 *
 * O caso real: instância "Conectado" (open) no manager do Evolution GO, canais
 * presos em awaiting_qr no ZapFlow e NENHUMA mensagem fluindo — o webhook de
 * conexão nunca chegou (não registrado / URL sem secret / APP_URL errada).
 * O syncFromProvider deve: adotar o estado do provedor, atualizar o token do
 * canal e RE-REGISTRAR o webhook (com o secret na URL) sem re-parear.
 *
 * Uso:  npm run test:channel-sync-provider
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-chsync-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-chsync-1";
process.env.EVOLUTION_BASE_URL = "https://ev.test"; process.env.EVOLUTION_API_KEY = "admin-key"; process.env.APP_URL = "https://app.test";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

// Instâncias "no provedor" + registro das chamadas de webhook feitas.
let providerInstances: Array<{ name: string; token?: string; id?: string; status?: string }> = [];
const webhookCalls: Array<{ url: string; body: string }> = [];
function jsonResp(body: any) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => "application/json" } };
}
function installFetch() {
  const orig = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string, opts?: any) => {
    const u = String(url);
    if (u.includes("/instance/all")) return jsonResp({ data: providerInstances });
    if (u.includes("/instance/connect") || u.includes("/webhook/set")) {
      webhookCalls.push({ url: u, body: String(opts?.body || "") });
      return jsonResp({ ok: true });
    }
    return jsonResp({});
  };
  return () => { (globalThis as any).fetch = orig; };
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelProvisioningService } = await import("../src/server/ChannelProvisioningService.js");
  const { EvolutionService, setEvolutionWebhookSecretProvider } = await import("../src/server/EvolutionService.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");
  // O server injeta o secret no boot — o teste simula a MESMA fiação.
  setEvolutionWebhookSecretProvider(() => "whk_test_secret");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkCh = (org: string, idf: string, status: string, token?: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'evolution', ?, ?, ?, ?)`)
      .run(id, org, `WhatsApp (${idf})`, idf, status, token ? EncryptionService.encrypt(token) : null);
    return id;
  };
  const chOf = (org: string, idf: string) => db.prepare(`SELECT id, status, token_encrypted FROM channels WHERE organization_id = ? AND identifier = ?`).get(org, idf) as any;

  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  const restore = installFetch();

  // ===== 0. getConfig injeta o secret na URL do webhook =====
  const cfg = EvolutionService.getConfig();
  check("0.1 webhookUrl leva o ?secret= (senão a exigência ligada rejeita tudo)", !!cfg?.webhookUrl.includes("secret=whk_test_secret"), cfg?.webhookUrl);

  // ===== 1. O caso do relato: open no provedor, awaiting_qr aqui =====
  // Provedor: instância pareada com token NOVO (a recriação troca o token).
  providerInstances = [{ name: "zapflow_org_x", token: "tok-novo", id: "id1", status: "open" }];
  mkCh(A, "zapflow_org_x", "awaiting_qr", "tok-velho");
  // Canais fantasma: instâncias que NÃO existem mais no provedor.
  mkCh(A, "ExaForge", "awaiting_qr");
  mkCh(A, "TOULON", "connected");
  // 'disabled' (pausa administrativa) nunca é tocado.
  mkCh(A, "Pausado", "disabled");
  // Org B isolada.
  mkCh(B, "zapflow_org_x_b", "awaiting_qr");

  const r1 = await ChannelProvisioningService.syncFromProvider(A, "u1");
  check("1.1 sync ok e provedor alcançável", r1.ok === true && r1.providerReachable === true);
  check("1.2 canal pareado vira connected", chOf(A, "zapflow_org_x")?.status === "connected", chOf(A, "zapflow_org_x")?.status);
  check("1.3 token do canal atualizado pro do provedor", EncryptionService.decrypt(chOf(A, "zapflow_org_x")?.token_encrypted) === "tok-novo");
  check("1.4 webhook RE-REGISTRADO na instância pareada", webhookCalls.length >= 1, `${webhookCalls.length}`);
  check("1.5 re-registro usa a URL COM secret", webhookCalls.some((c) => c.body.includes("secret=whk_test_secret")), webhookCalls[0]?.body?.slice(0, 120));
  check("1.6 instância inexistente → canal fantasma vira disconnected", chOf(A, "ExaForge")?.status === "disconnected" && chOf(A, "TOULON")?.status === "disconnected");
  check("1.7 'disabled' não é tocado", chOf(A, "Pausado")?.status === "disabled");
  check("1.8 isolamento: canal da org B intacto", chOf(B, "zapflow_org_x_b")?.status === "awaiting_qr");
  const rep1 = r1.channels.find((c) => c.instanceName === "zapflow_org_x");
  check("1.9 relatório: before/after/providerState/webhook", rep1?.before === "awaiting_qr" && rep1?.after === "connected" && rep1?.providerState === "open" && rep1?.webhookRegistered === true && rep1?.tokenUpdated === true, JSON.stringify(rep1));

  // ===== 2. Provedor diz que a sessão CAIU → rebaixa com evidência =====
  providerInstances = [{ name: "zapflow_org_x", token: "tok-novo", id: "id1", status: "close" }];
  await ChannelProvisioningService.syncFromProvider(A, "u1");
  check("2.1 connected + provedor 'close' → disconnected", chOf(A, "zapflow_org_x")?.status === "disconnected");

  // ===== 3. Idempotência: rodar de novo não muda nada =====
  providerInstances = [{ name: "zapflow_org_x", token: "tok-novo", id: "id1", status: "open" }];
  await ChannelProvisioningService.syncFromProvider(A, "u1");
  const r3 = await ChannelProvisioningService.syncFromProvider(A, "u1");
  const rep3 = r3.channels.find((c) => c.instanceName === "zapflow_org_x");
  check("3.1 já connected: segue connected, token não re-gravado", rep3?.before === "connected" && rep3?.after === "connected" && rep3?.tokenUpdated === false, JSON.stringify(rep3));

  // ===== 4. Provedor inacessível → erro honesto, nada muda =====
  (globalThis as any).fetch = async () => { throw new Error("ECONNREFUSED"); };
  const r4 = await ChannelProvisioningService.syncFromProvider(A, "u1");
  check("4.1 inacessível → ok:false, providerReachable:false", r4.ok === false && r4.providerReachable === false);
  check("4.2 nada mudou nos canais", chOf(A, "zapflow_org_x")?.status === "connected");

  restore();
  setEvolutionWebhookSecretProvider(null);
  console.log("\n=== TEST: Sync de canais com o provedor ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
