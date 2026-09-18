/**
 * TEST — F3.3b (RF-04 §10) + decisão do dono (17/09/2026): fiação do modo
 * misto no inbound SEM a pergunta "atendimento ou gestão?".
 *
 * A pergunta de escolha (§10.7) revelava a existência do canal de gestão a
 * quem observa a conversa. Contrato NOVO:
 *  - flag OFF: gestor no número de atendimento → cria contato+ticket (0-regressão).
 *  - flag ON, gestor SEM contexto → segue como CLIENTE (ticket criado), SEM
 *    pendente e SEM pergunta — a IA nunca menciona "gestão".
 *  - pendente LEGADO (criado antes do deploy) + mensagem comum → atendimento,
 *    nenhuma pergunta reenviada.
 *  - comando do Zapp (gestor autorizado + prefixo "zap") NÃO cai no menu de
 *    áreas de atendimento — chega ao AIOrchestrator (Diretor IA responde).
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

let fetchCalls = 0; const fetchBodies: string[] = [];
function installFetch() {
  (globalThis as any).fetch = async (_u: any, opts?: any) => {
    fetchCalls++; fetchBodies.push(String(opts?.body || ""));
    return { ok: true, status: 200, text: async () => "{}", json: async () => ({ key: { id: "mid" } }), headers: { get: () => "application/json" } };
  };
}
// A pergunta suprimida — NENHUM envio pode conter este texto.
const askedChoice = () => fetchBodies.some((b) => b.includes("para gest"));

async function main() {
  const db = (await import("../src/server/db.js")).default;
  installFetch();
  // Neutraliza o motor de atendimento (LLM) e REGISTRA as chamadas — o que
  // provamos é a FIAÇÃO (o Zapp CHEGAR ao Orquestrador), não a IA.
  const aiMod = await import("../src/server/AIOrchestratorService.js");
  const aiCalls: any[] = [];
  (aiMod.AIOrchestratorService as any).processMessage = async (p: any) => { aiCalls.push(p); return { reply: "", actions: [], needsHuman: false }; };
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

  // ── 2. Flag ON, gestor sem contexto → segue como CLIENTE, sem pergunta ──
  setFlag(A, 1);
  const ch2 = mkChannel(A);
  await inbound(ch2, A, mgr, "e aí, como tá o caixa?");
  check("2.1 flag ON: ticket criado (papel duplo default = atendimento)", Number(ticketsFor(A, ch2.id, mgr).c) === 1);
  check("2.2 NÃO criou pendente de escolha", MixedModeInboundService.hasPendingChoice(A, ch2.id, mgr) === false);
  check("2.3 NENHUM envio menciona a opção de gestão", askedChoice() === false);

  // ── 3. Pendente LEGADO (pré-deploy) + mensagem comum → atendimento, sem repergunta ──
  const ch3 = mkChannel(A);
  MixedModeInboundService.setPending(A, ch3.id, mgr);
  await inbound(ch3, A, mgr, "oi, tudo bem?");
  check("3.1 pendente legado não repergunta: ticket criado", Number(ticketsFor(A, ch3.id, mgr).c) === 1);
  check("3.2 nenhuma pergunta de escolha foi enviada", askedChoice() === false);

  // ── 4. Zapp fura o menu de áreas: comando chega ao Orquestrador ──
  const zorg = `org_Z_${randomUUID().slice(0, 6)}`; mkOrg(zorg); setFlag(zorg, 1);
  const zmgr = "5521999947477";
  db.prepare(`INSERT INTO authorized_managers (id, organization_id, identifier, name) VALUES (?, ?, ?, 'Dono')`).run(randomUUID(), zorg, zmgr);
  db.prepare(`INSERT INTO service_areas (id, organization_id, name, active, position) VALUES (?, ?, 'Vendas', 1, 0)`).run(randomUUID(), zorg);
  db.prepare(`INSERT INTO service_areas (id, organization_id, name, active, position) VALUES (?, ?, 'Suporte', 1, 1)`).run(randomUUID(), zorg);
  const chz = mkChannel(zorg);
  // Controle: mensagem SEM prefixo cai no menu de áreas (IA não é chamada).
  aiCalls.length = 0;
  await inbound(chz, zorg, zmgr, "oi");
  check("4.1 controle: sem prefixo, menu de áreas intercepta (IA não chamada)", aiCalls.length === 0);
  // Comando do Zapp: fura o menu e chega ao Orquestrador.
  await inbound(chz, zorg, zmgr, "Zapp, como estão as vendas hoje?");
  check("4.2 'Zapp …' chega ao Orquestrador (não cai no menu de áreas)", aiCalls.length === 1 && String(aiCalls[0]?.message || "").startsWith("Zapp"));

  // ── 5. Flag ON, remetente DESCONHECIDO (cliente) → ticket (inalterado) ──
  const ch5 = mkChannel(A);
  const cliente = "5521911112222";
  await inbound(ch5, A, cliente, "quero comprar");
  check("5.1 cliente desconhecido → ticket criado", Number(ticketsFor(A, ch5.id, cliente).c) === 1);
  check("5.2 cliente não gera pendente de escolha", MixedModeInboundService.hasPendingChoice(A, ch5.id, cliente) === false);

  // ── 6. Flag ON, gestor COM ticket aberto → segue atendimento (sem pendente) ──
  const ch6 = mkChannel(A);
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
