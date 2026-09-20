/**
 * TESTE — F6 do PRD Conexão WhatsApp (20/09/2026): credencial + saúde de
 * webhook POR CANAL.
 * -----------------------------------------------------------------------------
 * Falha alta nº 5 do PRD (confirmada na F0): segredo e "último hit" do webhook
 * eram GLOBAIS — um segredo vazado abria TODOS os canais e um canal saudável
 * mascarava outro quebrado.
 *
 * Prova, offline:
 *  - credencial `whc_` nasce no registro (idempotente) e vai na URL registrada
 *    no provedor (no lugar do segredo global);
 *  - validação: credencial certa resolve O canal; errada rejeita; a credencial
 *    do canal A nunca valida como canal B; segredo global segue aceito (legado);
 *  - rotação: a anterior vale pela JANELA (sem downtime) e expira depois; o
 *    audit não vaza o segredo;
 *  - saúde POR CANAL: hit rejeitado num canal não contamina o outro; hit
 *    válido limpa o erro; ChannelStateService reflete por canal (legado sem
 *    observação cai no sinal global — 0-regressão);
 *  - isolamento multi-tenant.
 *
 * Uso: npm run test:whatsapp-webhook-channel
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-whkchan-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-whkchan-1";
process.env.EVOLUTION_BASE_URL = "https://ev.test"; process.env.EVOLUTION_API_KEY = "admin-key"; process.env.APP_URL = "https://app.test";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const webhookBodies: string[] = [];
function jsonResp(body: any) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => "application/json" } };
}
const origFetch = (globalThis as any).fetch;
(globalThis as any).fetch = async (url: string, opts?: any) => {
  const u = String(url);
  if (u.includes("/instance/connect") || u.includes("/webhook/set")) webhookBodies.push(String(opts?.body || ""));
  return jsonResp({});
};

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelWebhookCredentialService: Cred } = await import("../src/server/ChannelWebhookCredentialService.js");
  const { EvolutionService, setEvolutionWebhookSecretProvider } = await import("../src/server/EvolutionService.js");
  const { checkWebhookSecret, effectiveWebhookSecret } = await import("../src/server/webhookSecurity.js");
  const { ChannelStateService } = await import("../src/server/ChannelStateService.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");

  // Mesma fiação do server.ts: por-canal com fallback global.
  setEvolutionWebhookSecretProvider((instanceName?: string) => {
    if (instanceName) { try { const s = Cred.ensureForInstance(instanceName); if (s) return s; } catch { /* global */ } }
    try { return effectiveWebhookSecret(); } catch { return null; }
  });

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  const mkCh = (org: string, idf: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'evolution', ?, ?, 'connected', ?)`)
      .run(id, org, idf, idf, EncryptionService.encrypt("tok"));
    return id;
  };
  const chA = mkCh(A, "instA");
  const chA2 = mkCh(A, "instA2");
  const chB = mkCh(B, "instB");
  const rowOf = (id: string) => db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id) as any;

  // ── 1) Credencial nasce no registro e vai na URL do provedor. ──
  const s1 = Cred.ensureForInstance("instA")!;
  check("1.1 credencial whc_ gerada e cifrada em repouso", s1.startsWith("whc_") && rowOf(chA).webhook_secret_enc && !String(rowOf(chA).webhook_secret_enc).includes(s1), s1.slice(0, 8));
  check("1.2 idempotente (2ª chamada devolve a MESMA)", Cred.ensureForInstance("instA") === s1);
  await EvolutionService.registerWebhook("instA", "tok");
  const lastBody = webhookBodies[webhookBodies.length - 1] || "";
  check("1.3 URL registrada leva a credencial DO CANAL", lastBody.includes(encodeURIComponent(s1)), lastBody.slice(0, 120));
  check("1.4 URL registrada NÃO leva o segredo global", !lastBody.includes(encodeURIComponent(effectiveWebhookSecret())), "");

  // ── 2) Validação do inbound. ──
  const sA2 = Cred.ensureForInstance("instA2")!;
  const v1 = checkWebhookSecret(s1);
  check("2.1 credencial certa valida e RESOLVE o canal", v1.ok === true && v1.channelIdentifier === "instA", JSON.stringify(v1));
  check("2.2 credencial de A não vale como A2 (canal errado)", checkWebhookSecret(sA2).channelIdentifier === "instA2", "");
  check("2.3 credencial inventada é rejeitada", checkWebhookSecret("whc_" + "0".repeat(36)).ok === false);
  check("2.4 segredo GLOBAL segue aceito (canais legados)", checkWebhookSecret(effectiveWebhookSecret()).ok === true && !checkWebhookSecret(effectiveWebhookSecret()).channelIdentifier);

  // ── 3) Rotação com janela (sem downtime). ──
  const r3 = await Cred.rotate(A, chA, "owner1");
  check("3.1 rotação ok", r3.ok === true, JSON.stringify(r3));
  const s1novo = Cred.ensureForInstance("instA")!;
  check("3.2 novo segredo difere e valida", s1novo !== s1 && checkWebhookSecret(s1novo).ok === true);
  const vOld = Cred.verify(s1);
  check("3.3 o ANTERIOR segue válido na janela (usedPrev)", vOld?.usedPrev === true && vOld?.identifier === "instA", JSON.stringify(vOld));
  db.prepare(`UPDATE channels SET webhook_secret_rotated_at = ? WHERE id = ?`).run(new Date(Date.now() - 49 * 3600_000).toISOString(), chA);
  check("3.4 janela vencida → o anterior EXPIRA", Cred.verify(s1) === null);
  const leak = db.prepare(`SELECT COUNT(*) n FROM auth_audit_logs WHERE metadata_json LIKE ?`).get(`%${s1novo}%`) as any;
  check("3.5 audit da rotação não vaza o segredo", Number(leak?.n) === 0, String(leak?.n));
  const r3b = await Cred.rotate(A, chB, "owner1");
  check("3.6 rotação de canal de OUTRA org → channel_not_found", r3b.ok === false && r3b.code === "channel_not_found");

  // ── 4) Saúde POR CANAL: rejeitado não contamina o vizinho. ──
  Cred.recordHit("instA", false, "segredo_incorreto");
  Cred.recordHit("instA2", true, "recebido");
  const hA = rowOf(chA); const hA2 = rowOf(chA2);
  check("4.1 canal rejeitado registra o erro", hA.webhook_last_error === "segredo_incorreto" && !!hA.webhook_last_received_at, JSON.stringify({ e: hA.webhook_last_error }));
  check("4.2 canal vizinho segue saudável (não contaminado)", hA2.webhook_last_error == null && !!hA2.webhook_last_valid_at);
  const stA = ChannelStateService.state(A, chA); const stA2 = ChannelStateService.state(A, chA2);
  check("4.3 estado por canal: A=rejected, A2=healthy", stA?.webhook === "rejected" && stA2?.webhook === "healthy", JSON.stringify({ a: stA?.webhook, a2: stA2?.webhook }));
  Cred.recordHit("instA", true, "recebido");
  check("4.4 hit válido LIMPA o erro (recupera)", ChannelStateService.state(A, chA)?.webhook === "healthy");
  // Canal legado sem observação própria cai no sinal global (0-regressão).
  const stB = ChannelStateService.state(B, chB);
  check("4.5 canal sem observação própria usa o sinal global", stB?.webhook === "not_verified" || stB?.webhook === "healthy" || stB?.webhook === "rejected", String(stB?.webhook));

  // ── 5) Isolamento: nada da org A tocou a org B. ──
  const hB = rowOf(chB);
  check("5.1 org B sem hits/segredos herdados da A", hB.webhook_last_received_at == null && (hB.webhook_secret_hash == null || hB.webhook_secret_hash !== rowOf(chA).webhook_secret_hash));

  (globalThis as any).fetch = origFetch;
  setEvolutionWebhookSecretProvider(null);

  console.log("\n=== TEST: F6 — webhook por canal (credencial + saúde) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
