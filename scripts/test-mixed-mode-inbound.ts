/**
 * TEST — F3.3b (RF-04 §10): fiação do modo misto no inbound.
 *
 * Dirige o `processIncomingMessage` real (exportado) com tmp db + fetch stubado
 * + AIOrchestrator.processMessage neutralizado, num canal de ATENDIMENTO:
 *  - flag OFF: gestor no número de atendimento → cria contato+ticket (0-regressão).
 *  - flag ON, sem ticket aberto, sem pendente → NÃO cria ticket, cria pendente,
 *    envia a pergunta "atendimento ou gestão?".
 *  - flag ON, resposta "2" (gestão) → roteia interno, sem ticket, limpa pendente.
 *  - flag ON, resposta "1" (atendimento) → cria ticket.
 *  - flag ON, remetente DESCONHECIDO (cliente) → cria ticket (inalterado).
 *  - flag ON, gestor COM ticket aberto → segue atendimento (sem pendente).
 *
 * Uso: npm run test:mixed-mode-inbound
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mixed-inbound-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mixed-in-1";
process.env.EVOLUTION_API_KEY = "k"; process.env.EVOLUTION_BASE_URL = "https://ev.test";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

let fetchCalls = 0;
function installFetch() {
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, text: async () => "{}", json: async () => ({ key: { id: "mid" } }), headers: { get: () => "application/json" } });
  const orig = (globalThis as any).fetch;
  (globalThis as any).fetch = async (...a: any[]) => { fetchCalls++; return orig(...a); };
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  installFetch();
  // Neutraliza o motor de atendimento (LLM) — o que provamos é a FIAÇÃO, não a IA.
  const aiMod = await import("../src/server/AIOrchestratorService.js");
  (aiMod.AIOrchestratorService as any).processMessage = async () => ({ handled: true });
  const { processIncomingMessage } = await import("../src/server/webhookProcessor.js");
  const { MixedModeInboundService } = await import("../src/server/MixedModeInboundService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mixed_mode_enabled) VALUES (?, ?, 'T', 'active', 0)`).run(randomUUID(), id);
  const setFlag = (org: string, on: number) => db.prepare(`UPDATE organization_settings SET mixed_mode_enabled = ? WHERE organization_id = ?`).run(on, org);
  const mkChannel = (org: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, kind) VALUES (?, ?, 'evolution', 'num', ?, 'connected', 'client')`).run(id, org, `inst_${id.slice(0, 6)}`);
    return db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id) as any;
  };
  const mkUser = (org: string, phone: string, role: string) =>
    db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, 'Dono', ?, ?, ?, 'active')`).run(randomUUID(), org, `${randomUUID()}@t.com`, phone, role);
  const ticketsFor = (org: string, chId: string, sender: string) => db.prepare(
    `SELECT COUNT(*) c FROM tickets t JOIN contacts ct ON ct.id = t.contact_id WHERE t.organization_id = ? AND ct.channel_id = ? AND ct.identifier = ?`,
  ).get(org, chId, sender) as any;
  const inbound = async (ch: any, org: string, sender: string, text: string) => {
    try {
      await processIncomingMessage({ channelId: ch.id, organizationId: org, identifier: ch.identifier, provider: "evolution", senderId: sender, text } as any, null);
    } catch (e) { /* passos pós-CRM podem lançar sem IA; o ticket já foi (ou não) criado */ }
  };

  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const mgr = "5511987654321"; mkUser(A, mgr, "owner");

  // ── 1. Flag OFF: gestor no atendimento vira ticket (0-regressão) ──
  const ch1 = mkChannel(A);
  await inbound(ch1, A, mgr, "quanto vendi hoje?");
  check("1.1 flag OFF: ticket criado pro gestor (0-regressão)", Number(ticketsFor(A, ch1.id, mgr).c) === 1);

  // ── 2. Flag ON, sem contexto de cliente → ask_which (sem ticket) ──
  setFlag(A, 1);
  const ch2 = mkChannel(A);
  fetchCalls = 0;
  await inbound(ch2, A, mgr, "e aí, como tá o caixa?");
  check("2.1 flag ON: NÃO cria ticket no caso ambíguo", Number(ticketsFor(A, ch2.id, mgr).c) === 0);
  check("2.2 criou pendente de escolha", MixedModeInboundService.hasPendingChoice(A, ch2.id, mgr) === true);
  check("2.3 enviou a pergunta (fetch>0)", fetchCalls > 0);

  // ── 3. Resposta "2" (gestão) → roteia interno, sem ticket, limpa pendente ──
  await inbound(ch2, A, mgr, "2");
  check("3.1 gestão: continua sem ticket", Number(ticketsFor(A, ch2.id, mgr).c) === 0);
  check("3.2 pendente limpo", MixedModeInboundService.hasPendingChoice(A, ch2.id, mgr) === false);

  // ── 4. Resposta "1" (atendimento) → cria ticket ──
  const ch4 = mkChannel(A);
  await inbound(ch4, A, mgr, "oi"); // ask_which → pendente
  await inbound(ch4, A, mgr, "1"); // escolhe atendimento
  check("4.1 escolha atendimento → ticket criado", Number(ticketsFor(A, ch4.id, mgr).c) === 1);
  check("4.2 pendente limpo após escolha", MixedModeInboundService.hasPendingChoice(A, ch4.id, mgr) === false);

  // ── 5. Flag ON, remetente DESCONHECIDO (cliente) → ticket (inalterado) ──
  const ch5 = mkChannel(A);
  const cliente = "5521911112222";
  await inbound(ch5, A, cliente, "quero comprar");
  check("5.1 cliente desconhecido → ticket criado", Number(ticketsFor(A, ch5.id, cliente).c) === 1);
  check("5.2 cliente não gera pendente de escolha", MixedModeInboundService.hasPendingChoice(A, ch5.id, cliente) === false);

  // ── 6. Flag ON, gestor COM ticket aberto → segue atendimento (sem pendente) ──
  const ch6 = mkChannel(A);
  // cria um ticket aberto pro gestor neste canal
  const cId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, 'Dono', ?)`).run(cId, A, ch6.id, mgr);
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage, ai_paused) VALUES (?, ?, ?, 'open', 'novo_lead', 0)`).run(randomUUID(), A, cId);
  await inbound(ch6, A, mgr, "tem a peça tamanho M?");
  check("6.1 gestor com atendimento em curso → sem pendente (segue atendimento)", MixedModeInboundService.hasPendingChoice(A, ch6.id, mgr) === false);
  check("6.2 mensagem entrou no atendimento existente (1 ticket)", Number(ticketsFor(A, ch6.id, mgr).c) === 1);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mixed-mode-inbound: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
