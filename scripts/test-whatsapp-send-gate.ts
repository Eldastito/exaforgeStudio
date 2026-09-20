/**
 * TESTE — F1 do PRD Conexão WhatsApp (20/09/2026): DESCONECTADO NÃO ENVIA.
 * -----------------------------------------------------------------------------
 * Falha crítica nº 2 do PRD (confirmada na F0): o gate de envio só barrava
 * `status='disabled'` — canal `disconnected` (pelo dono ou por logout no
 * celular) continuava elegível e o envio "sumia" no provedor. E o disconnect
 * fazia o logout REMOTO antes do bloqueio local (provedor lento atrasava o
 * bloqueio; processo caindo no meio deixava o canal enviável).
 *
 * Prova, offline (fetch global stubado):
 *  - sink (sendMessage/sendDocument/sendImage) barra 'disconnected' SEM tocar
 *    a rede; 'disabled' mantém o erro antigo (0-regressão);
 *  - canal conectado passa o gate e envia (fetch chamado);
 *  - disconnect marca 'disconnected' ANTES do logout remoto (ordem provada
 *    lendo o banco DE DENTRO do logout) e falha remota NÃO reabre o canal;
 *  - binding pra canal desconectado deixa de resolver — cai pro fallback;
 *  - isolamento multi-tenant.
 *
 * Uso: npm run test:whatsapp-send-gate
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-send-gate-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-send-gate-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
delete process.env.EVOLUTION_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");
  const { ChannelProvisioningService } = await import("../src/server/ChannelProvisioningService.js");
  const { ChannelBindingService } = await import("../src/server/ChannelBindingService.js");
  const { EvolutionService } = await import("../src/server/EvolutionService.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  const mkCh = (org: string, identifier: string, status: string, provider = "evolution") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, org, provider, identifier, identifier, status, EncryptionService.encrypt("tok-teste"));
    return id;
  };
  // Ordem de criação importa: o desconectado nasce PRIMEIRO (a seleção legada
  // é created_at ASC — sem o fix do channelUsable, o binding devolveria ele).
  const chDisc = mkCh(A, "instDesconectada", "disconnected");
  const chConn = mkCh(A, "instConectada", "connected");
  const chDisabled = mkCh(A, "instDesabilitada", "disabled");
  const chB = mkCh(B, "instOrgB", "connected");

  // fetch global stubado: conta chamadas e responde sucesso genérico.
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    fetchCalls++;
    return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}), text: async () => "{}" };
  };

  const errOf = async (p: Promise<any>): Promise<string> => { try { await p; return ""; } catch (e: any) { return String(e?.message || e); } };

  // ── 1) Sink barra canal DESCONECTADO sem tocar a rede. ──
  let e1 = await errOf(MessageProviderService.sendMessage(chDisc, "5521999990000", "oi"));
  check("1.1 sendMessage em canal desconectado é BLOQUEADO", e1.includes("desconectado"), e1);
  check("1.2 nenhuma chamada de rede feita", fetchCalls === 0, String(fetchCalls));
  e1 = await errOf(MessageProviderService.sendDocument(chDisc, "5521999990000", "http://x/f.pdf", "f.pdf"));
  check("1.3 sendDocument bloqueado igual", e1.includes("desconectado"), e1);
  e1 = await errOf(MessageProviderService.sendImage(chDisc, "5521999990000", "http://x/i.png"));
  check("1.4 sendImage (casca do sendDocument) bloqueado igual", e1.includes("desconectado"), e1);
  check("1.5 rede segue intocada", fetchCalls === 0, String(fetchCalls));

  // ── 2) 0-regressão: 'disabled' mantém o erro antigo; conectado ENVIA. ──
  const e2 = await errOf(MessageProviderService.sendMessage(chDisabled, "5521999990000", "oi"));
  check("2.1 'disabled' mantém o erro antigo", e2.includes("desabilitado"), e2);
  const e3 = await errOf(MessageProviderService.sendMessage(chConn, "5521999990000", "oi"));
  check("2.2 canal conectado passa o gate (sem erro de bloqueio)", !e3.includes("desconectado") && !e3.includes("desabilitado"), e3);
  check("2.3 envio do conectado chegou na rede", fetchCalls > 0, String(fetchCalls));

  // ── 3) Disconnect: bloqueio LOCAL primeiro; falha remota não reabre. ──
  // Prova de ORDEM: o logout remoto (monkey-patch) lê o banco no momento em
  // que é chamado — o canal já precisa estar 'disconnected'.
  const statusAtLogout: string[] = [];
  const realLogout = EvolutionService.logoutInstance;
  (EvolutionService as any).logoutInstance = async (identifier: string) => {
    const row = db.prepare(`SELECT status FROM channels WHERE identifier = ? AND organization_id = ?`).get(identifier, A) as any;
    statusAtLogout.push(`${identifier}:${row?.status}`);
    throw new Error("provedor fora do ar"); // logout remoto FALHA
  };
  const r3 = await ChannelProvisioningService.disconnect(A, "owner1");
  (EvolutionService as any).logoutInstance = realLogout;
  check("3.1 disconnect ok (2 canais não-disabled da org)", r3.ok === true && r3.disconnected === 2, JSON.stringify(r3));
  check("3.2 BLOQUEIO LOCAL ANTES do logout remoto (banco já 'disconnected' na chamada)", statusAtLogout.length === 2 && statusAtLogout.every((s) => s.endsWith(":disconnected")), JSON.stringify(statusAtLogout));
  const rowConn = db.prepare(`SELECT status FROM channels WHERE id = ?`).get(chConn) as any;
  check("3.3 falha do logout remoto NÃO reabre o canal", rowConn?.status === "disconnected", rowConn?.status);
  check("3.4 providerLogout honesto (false — remoto falhou)", r3.providerLogout === false);
  const e4 = await errOf(MessageProviderService.sendMessage(chConn, "5521999990000", "oi"));
  check("3.5 envio após disconnect é bloqueado NA HORA (jobs incluídos — mesmo sink)", e4.includes("desconectado"), e4);

  // ── 4) Binding pra canal desconectado deixa de resolver → fallback. ──
  const up = ChannelBindingService.upsert(B, "owner1", { channelId: chDisc, featureKey: "cobranca", outbound: true });
  check("4.1 binding cruzando org é recusado (canal de A na org B)", up.ok === false, JSON.stringify(up));
  // Na org B: canal desconectado próprio + conectado próprio; binding pro
  // desconectado com fallback pro conectado — o fallback deve vencer.
  const chBDisc = mkCh(B, "bDesconectada", "disconnected");
  const up2 = ChannelBindingService.upsert(B, "owner1", { channelId: chBDisc, featureKey: "cobranca", outbound: true, fallbackChannelId: chB });
  check("4.2 binding gravado", up2.ok === true, JSON.stringify(up2));
  const d = ChannelBindingService.resolve(B, "cobranca", { direction: "outbound" });
  check("4.3 canal desconectado NÃO resolve — fallback conectado assume", d.ok === true && d.channelId === chB && d.scope === "fallback", JSON.stringify(d));

  // ── 5) Isolamento: org B intocada pelo disconnect da org A. ──
  const rowB = db.prepare(`SELECT status FROM channels WHERE id = ?`).get(chB) as any;
  check("5.1 canal da org B segue conectado", rowB?.status === "connected", rowB?.status);

  (globalThis as any).fetch = realFetch;

  console.log("\n=== TEST: F1 — gate de envio (desconectado não envia) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
