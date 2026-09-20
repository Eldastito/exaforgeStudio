/**
 * TESTE — F2 do PRD Conexão WhatsApp (20/09/2026): operações por channelId.
 * -----------------------------------------------------------------------------
 * Falha alta nº 4 do PRD (confirmada na F0): disconnect derrubava TODOS os
 * canais da org e o reset escolhia a instância implicitamente
 * (reusableInstanceFor) — com 2 números, a ação atingia o canal errado.
 *
 * Prova, offline (fetch global stubado):
 *  - disconnect/reset SEM channelId com 2+ canais ativos → recusa clara
 *    (channel_required), NADA alterado; com 1 canal → segue como antes (compat);
 *  - com channelId → afeta SÓ o alvo (o outro canal segue intacto);
 *  - channelId de outra org / inexistente → channel_not_found (mesma resposta,
 *    sem revelar tenant), sem efeito;
 *  - canal 'disabled' (pausa administrativa) nunca vira 'disconnected';
 *  - sync com channelId FILTRA a reconciliação; id inválido nem toca o provedor;
 *  - isolamento multi-tenant.
 *
 * Uso: npm run test:whatsapp-channel-scope
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-chscope-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-chscope-1";
process.env.EVOLUTION_BASE_URL = "https://ev.test"; process.env.EVOLUTION_API_KEY = "admin-key"; process.env.APP_URL = "https://app.test";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

let providerInstances: Array<{ name: string; token?: string; id?: string; connected?: boolean }> = [];
let fetchCalls = 0;
let failAll = false; // modo "provedor quebrado" (500 em tudo) pros testes de reset
function jsonResp(body: any, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => "application/json" } };
}
const origFetch = (globalThis as any).fetch;
(globalThis as any).fetch = async (url: string) => {
  fetchCalls++;
  if (failAll) return jsonResp({ error: "boom" }, false, 500);
  const u = String(url);
  if (u.includes("/instance/all")) return jsonResp({ data: providerInstances });
  return jsonResp({});
};

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelProvisioningService: Svc } = await import("../src/server/ChannelProvisioningService.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkCh = (org: string, idf: string, status: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'evolution', ?, ?, ?, ?)`)
      .run(id, org, `WhatsApp (${idf})`, idf, status, EncryptionService.encrypt("tok"));
    return id;
  };
  const statusOf = (id: string) => (db.prepare(`SELECT status FROM channels WHERE id = ?`).get(id) as any)?.status;

  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  const ch1 = mkCh(A, "instLoja1", "connected");
  const ch2 = mkCh(A, "instLoja2", "connected");
  const chPaused = mkCh(A, "instPausada", "disabled");
  const chB = mkCh(B, "instOrgB", "connected");

  // ── 1) SYNC: channelId é filtro; id inválido nem toca o provedor. ──
  providerInstances = [{ name: "instLoja1", id: "i1", connected: true }, { name: "instLoja2", id: "i2", connected: true }];
  const s1 = await Svc.syncFromProvider(A, "u1");
  check("1.1 sync sem filtro reconcilia os 2 canais", s1.ok === true && s1.channels.length === 2, JSON.stringify(s1.channels?.map((c: any) => c.instanceName)));
  const s2 = await Svc.syncFromProvider(A, "u1", ch1);
  check("1.2 sync com channelId reconcilia SÓ o alvo", s2.ok === true && s2.channels.length === 1 && s2.channels[0].instanceName === "instLoja1", JSON.stringify(s2.channels));
  const callsBefore = fetchCalls;
  const s3 = await Svc.syncFromProvider(A, "u1", chB); // canal de OUTRA org
  check("1.3 channelId de outra org → channel_not_found", s3.ok === false && s3.code === "channel_not_found", JSON.stringify(s3));
  check("1.4 id inválido nem toca o provedor", fetchCalls === callsBefore, `${fetchCalls - callsBefore}`);

  // ── 2) RESET: sem alvo com 2 canais é recusado; com alvo mira certo. ──
  failAll = true; // provedor "quebrado" — o reset falha DEPOIS de escolher o alvo
  const r1 = await Svc.reset(A, "u1");
  check("2.1 reset sem channelId com 2 canais → channel_required", r1.ok === false && r1.code === "channel_required", JSON.stringify(r1));
  const r2 = await Svc.reset(A, "u1", ch2);
  check("2.2 reset com channelId mira o alvo certo (instLoja2)", r2.instanceName === "instLoja2" && r2.channelId === ch2, JSON.stringify({ inst: r2.instanceName, ch: r2.channelId }));
  const r3 = await Svc.reset(A, "u1", chB);
  check("2.3 reset em canal de outra org → channel_not_found", r3.ok === false && r3.code === "channel_not_found", JSON.stringify(r3));

  // ── 3) DISCONNECT: ambiguidade recusada; alvo explícito só derruba o alvo. ──
  const d1 = await Svc.disconnect(A, "u1");
  check("3.1 disconnect sem channelId com 2 ativos → channel_required", d1.ok === false && d1.code === "channel_required", JSON.stringify(d1));
  check("3.2 NADA foi alterado na recusa", statusOf(ch1) === "connected" && statusOf(ch2) === "connected", `${statusOf(ch1)}/${statusOf(ch2)}`);
  const d2 = await Svc.disconnect(A, "u1", ch1);
  check("3.3 disconnect com channelId derruba SÓ o alvo", d2.ok === true && d2.disconnected === 1 && statusOf(ch1) === "disconnected", JSON.stringify(d2));
  check("3.4 o outro canal segue conectado", statusOf(ch2) === "connected", statusOf(ch2));
  // Compat: agora só resta 1 canal ACIONÁVEL — sem channelId volta a funcionar.
  const d3 = await Svc.disconnect(A, "u1");
  check("3.5 com 1 acionável, sem channelId segue funcionando (compat)", d3.ok === true && statusOf(ch2) === "disconnected", JSON.stringify(d3));
  const d4 = await Svc.disconnect(A, "u1", chB);
  check("3.6 canal de outra org → channel_not_found, sem efeito", d4.ok === false && d4.code === "channel_not_found" && statusOf(chB) === "connected", JSON.stringify(d4));
  const d5 = await Svc.disconnect(A, "u1", chPaused);
  check("3.7 canal 'disabled' (pausa administrativa) não vira disconnected", d5.ok === true && d5.disconnected === 0 && statusOf(chPaused) === "disabled", JSON.stringify(d5));

  // ── 4) Isolamento: org B intocada por tudo acima. ──
  check("4.1 org B segue conectada", statusOf(chB) === "connected", statusOf(chB));

  (globalThis as any).fetch = origFetch;

  console.log("\n=== TEST: F2 — operações de canal por channelId ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
