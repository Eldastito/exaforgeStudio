/**
 * TEST — F1.2d (RF-02 §8 / CA-02): estados lógicos da conexão.
 *
 * Prova, offline (tmp db), que o read model deriva as 4 DIMENSÕES do enum plano
 * `channels.status` respeitando a CA-02:
 *  - webhook: não inferir saúde da criação da URL — sem hit = not_verified; hit
 *    rejeitado = rejected (nunca "healthy"); hit OK = healthy;
 *  - sessão 'connected' NÃO é rebaixada por ausência de QR;
 *  - pausar local ('disabled') = administração=paused, sessão NÃO vira
 *    disconnected (pausar ≠ logout remoto);
 *  - operação derivada: pronto só quando conectado + webhook não-rejeitado;
 *  - token-safe (nenhum segredo na saída); isolamento por org.
 *
 * Uso: npm run test:channel-state-machine
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ch-state-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ch-state-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelStateService: CS } = await import("../src/server/ChannelStateService.js");
  const { recordWebhookHit } = await import("../src/server/webhookSecurity.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkCh = (org: string, status: string, token = "tok") => { const id = randomUUID(); db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'evolution_go', 'n', ?, ?, ?)`).run(id, org, `id_${randomUUID().slice(0,4)}`, status, token); return id; };

  const A = `org_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const chConn = mkCh(A, "connected");
  const chQr = mkCh(A, "awaiting_qr");
  const chDisabled = mkCh(A, "disabled");
  const chDown = mkCh(A, "disconnected");

  // ── 1. webhook: sem hit → not_verified (não inferir saúde da URL) ──
  check("1.1 sem hit de webhook → not_verified", CS.state(A, chConn)?.webhook === "not_verified");
  check("1.2 conectado + webhook não-rejeitado → operação ready", CS.state(A, chConn)?.operation === "ready");

  // ── 2. sessão 'connected' NÃO é rebaixada por ausência de QR (CA-02) ──
  check("2.1 conectado → sessão 'connected' (QR ausente não desconecta)", CS.state(A, chConn)?.session === "connected");

  // ── 3. webhook rejeitado → nunca 'healthy' nem operação 'ready' ──
  recordWebhookHit(false, "segredo_incorreto");
  check("3.1 hit rejeitado → webhook 'rejected'", CS.state(A, chConn)?.webhook === "rejected");
  check("3.2 webhook rejeitado → operação NÃO 'ready' (não finge saudável)", CS.state(A, chConn)?.operation === "pending_validation");

  // ── 4. webhook OK → healthy → operação ready ──
  recordWebhookHit(true, "recebido");
  check("4.1 hit OK → webhook 'healthy'", CS.state(A, chConn)?.webhook === "healthy");
  check("4.2 conectado + healthy → operação 'ready'", CS.state(A, chConn)?.operation === "ready");

  // ── 5. pausar local (disabled) = administração=paused, sessão NÃO desconecta ──
  const dis = CS.state(A, chDisabled);
  check("5.1 disabled → administração 'paused'", dis?.administration === "paused");
  check("5.2 pausar ≠ logout: sessão segue 'connected'", dis?.session === "connected");
  check("5.3 pausado → operação 'unavailable' (uso local parado)", dis?.operation === "unavailable");

  // ── 6. awaiting_qr → aguardando pareamento; disconnected → indisponível ──
  check("6.1 awaiting_qr → sessão 'awaiting_pairing' + operação pending", CS.state(A, chQr)?.session === "awaiting_pairing" && CS.state(A, chQr)?.operation === "pending_validation");
  check("6.2 disconnected → sessão 'disconnected' + operação unavailable", CS.state(A, chDown)?.session === "disconnected" && CS.state(A, chDown)?.operation === "unavailable");

  // ── 7. token-safe + isolamento ──
  check("7.1 saída NÃO contém segredo/token", !JSON.stringify(CS.list(A)).includes("tok"));
  const B = `org_${randomUUID().slice(0, 6)}`; mkOrg(B);
  check("7.2 canal de A não é visível em B", CS.state(B, chConn) === null && CS.list(B).length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} channel-state-machine: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
