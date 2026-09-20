/**
 * TESTE — F7 do PRD Conexão WhatsApp (20/09/2026): produtores com seletor
 * próprio migrados pro resolvedor canônico (`selectOutboundChannel`).
 * -----------------------------------------------------------------------------
 * Inventário §5 da análise F0 (`docs/prd/ANALISE-PRD-WHATSAPP-vs-CODEBASE.md`):
 * ProspectExecutionService (envio de abordagem + âncora do convertToCrm),
 * SchoolImportService (âncora do contato responsável) e SubscriptionService
 * (link do portal) tinham SQL próprio de "primeiro canal" fora do gate.
 *
 * Prova, offline (provedor mockado):
 *  - binding por finalidade DECIDE o canal em cada produtor;
 *  - sem binding, o comportamento legado se mantém (0-regressão);
 *  - âncora de contato NÃO é envio: org só com canal pausado segue
 *    convertendo/importando (fallback legado preservado);
 *  - finalidade desligada bloqueia o envio de prospecção com erro claro;
 *  - isolamento multi-tenant.
 *
 * Uso: npm run test:channel-producer-binding
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-prodbind-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-prodbind-1234567890";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ChannelBindingService } = await import("../src/server/ChannelBindingService.js");
  const { ProspectService } = await import("../src/server/ProspectService.js");
  const { ProspectExecutionService } = await import("../src/server/ProspectExecutionService.js");
  const { SchoolImportService } = await import("../src/server/SchoolImportService.js");
  const { SubscriptionService } = await import("../src/server/SubscriptionService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");

  // Mock do provedor: captura o canal escolhido, não toca a rede.
  const sends: { channelId: string; to: string }[] = [];
  (MessageProviderService as any).sendMessage = async (channelId: string, to: string) => {
    sends.push({ channelId, to });
    return "wamid.MOCK";
  };

  const mkOrg = (tag: string) => {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgId, `Empresa ${tag}`);
    return orgId;
  };
  const mkCh = (org: string, provider: string, createdAt: string, status = "connected") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, org, provider, `${provider}-ch`, `${provider}-${id.slice(0, 6)}`, status, createdAt);
    return id;
  };

  const A = mkOrg("A");
  // Legado prefere evolution mesmo mais novo; binding aponta pro cloud mais antigo.
  const chCloud = mkCh(A, "whatsapp_cloud", "2026-01-01 10:00:00");
  const chEvo = mkCh(A, "evolution", "2026-02-01 10:00:00");
  const B = mkOrg("B");
  const chB = mkCh(B, "evolution", "2026-01-10 10:00:00");

  // ── 1) Prospecção: envio de abordagem usa o resolvedor. ──
  const camp = ProspectService.createCampaign(A, { name: "Camp F7" }, "u1");
  ProspectService.importRecords(A, { campaignId: camp.id, sourceRef: "csv", records: [{ company: "Alfa", domain: "alfa.com.br", contactName: "C", phone: "5521998887766" }] }, "u1");
  const acc = ProspectService.listAccounts(A)[0];
  const contact = (ProspectService.getAccount(A, acc.id).contacts || [])[0];
  const mkOutreach = () => {
    const id = randomUUID();
    db.prepare(`INSERT INTO prospect_outreach (id, organization_id, campaign_id, prospect_account_id, contact_id, channel, subject, body, evidence_snapshot, status) VALUES (?, ?, ?, ?, ?, 'whatsapp', 'A', 'Olá!', '{}', 'approved')`)
      .run(id, A, camp.id, acc.id, contact.id);
    return id;
  };

  await ProspectExecutionService.sendOutreach(A, mkOutreach(), "u1");
  check("1.1 sem binding: envio segue a seleção legada (evolution-first)", sends.length === 1 && sends[0].channelId === chEvo, JSON.stringify(sends));

  ChannelBindingService.upsert(A, "u1", { channelId: chCloud, featureKey: "prospeccao" });
  await ProspectExecutionService.sendOutreach(A, mkOutreach(), "u1");
  check("1.2 binding de 'prospeccao' DECIDE o canal", sends.length === 2 && sends[1].channelId === chCloud, JSON.stringify(sends[1] || null));

  ChannelBindingService.upsert(A, "u1", { channelId: chCloud, featureKey: "prospeccao", outbound: false });
  let threw = "";
  const sendsBefore = sends.length;
  try { await ProspectExecutionService.sendOutreach(A, mkOutreach(), "u1"); } catch (e: any) { threw = String(e?.message || e); }
  check("1.3 finalidade desligada → envio bloqueado ANTES do provedor", threw.includes("Canais e IA") && sends.length === sendsBefore, threw);
  ChannelBindingService.upsert(A, "u1", { channelId: chCloud, featureKey: "prospeccao", outbound: true });

  // ── 2) convertToCrm: âncora do contato segue o binding de 'atendimento'. ──
  const conv1 = ProspectExecutionService.convertToCrm(A, acc.id, "u1");
  const anchored1 = (db.prepare(`SELECT channel_id FROM contacts WHERE id = ?`).get(conv1.crmContactId) as any)?.channel_id;
  check("2.1 sem binding de atendimento: âncora legada (canal mais antigo)", anchored1 === chCloud, String(anchored1));

  ChannelBindingService.upsert(A, "u1", { channelId: chEvo, featureKey: "atendimento" });
  // Reconversão é idempotente; usa uma org limpa pra provar o binding na âncora.
  const A2 = mkOrg("A2");
  const a2Old = mkCh(A2, "whatsapp_cloud", "2026-01-01 10:00:00");
  const a2New = mkCh(A2, "evolution", "2026-03-01 10:00:00");
  const camp2 = ProspectService.createCampaign(A2, { name: "Camp F7b" }, "u1");
  ProspectService.importRecords(A2, { campaignId: camp2.id, sourceRef: "csv", records: [{ company: "Beta", domain: "beta.com.br", contactName: "D", phone: "5511911112222" }] }, "u1");
  const acc2 = ProspectService.listAccounts(A2)[0];
  ChannelBindingService.upsert(A2, "u1", { channelId: a2New, featureKey: "atendimento" });
  const conv2 = ProspectExecutionService.convertToCrm(A2, acc2.id, "u1");
  const anchored2 = (db.prepare(`SELECT channel_id FROM contacts WHERE id = ?`).get(conv2.crmContactId) as any)?.channel_id;
  check("2.2 binding de 'atendimento' decide a âncora do contato CRM", anchored2 === a2New, String(anchored2));

  // Âncora NÃO é envio: org só com canal pausado segue convertendo (0-regressão).
  const A3 = mkOrg("A3");
  const a3Disabled = mkCh(A3, "evolution", "2026-01-01 10:00:00", "disabled");
  const camp3 = ProspectService.createCampaign(A3, { name: "Camp F7c" }, "u1");
  ProspectService.importRecords(A3, { campaignId: camp3.id, sourceRef: "csv", records: [{ company: "Gama", domain: "gama.com.br", contactName: "E", phone: "5531933334444" }] }, "u1");
  const acc3 = ProspectService.listAccounts(A3)[0];
  const conv3 = ProspectExecutionService.convertToCrm(A3, acc3.id, "u1");
  check("2.3 org só com canal pausado ainda converte (âncora legada)", !!conv3.ticketId, JSON.stringify(conv3));

  // ── 3) Escola: âncora do responsável segue o binding de 'escola'. ──
  const st = { student: { fullName: "Aluno Um", turma: "1A" } };
  SchoolImportService.importStudents(A2, [st.student] as any, "u1");
  ChannelBindingService.upsert(A2, "u1", { channelId: a2Old, featureKey: "escola" });
  SchoolImportService.importGuardians(A2, [{ student: "Aluno Um", name: "Resp", phone: "5511955556666" }] as any, "u1");
  const guardian = db.prepare(`SELECT channel_id FROM contacts WHERE organization_id = ? AND identifier = ?`).get(A2, "5511955556666") as any;
  check("3.1 binding de 'escola' decide a âncora do responsável", guardian?.channel_id === a2Old, String(guardian?.channel_id));

  // Sem binding: seleção legada da escola (prefere não-pausado, mais antigo).
  SchoolImportService.importStudents(A, [{ fullName: "Aluno Dois", turma: "2B" }] as any, "u1");
  SchoolImportService.importGuardians(A, [{ student: "Aluno Dois", name: "Resp2", phone: "5521955557777" }] as any, "u1");
  const guardian2 = db.prepare(`SELECT channel_id FROM contacts WHERE organization_id = ? AND identifier = ?`).get(A, "5521955557777") as any;
  check("3.2 sem binding: âncora legada EXATA da escola (mais antigo não-pausado)", guardian2?.channel_id === chCloud, String(guardian2?.channel_id));

  // ── 4) Assinaturas: link do portal usa o resolvedor de 'cobranca'. ──
  const subContactId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, 'Assinante', '5521944445555')`).run(subContactId, A, chEvo);
  ChannelBindingService.upsert(A, "u1", { channelId: chCloud, featureKey: "cobranca" });
  const sent = await SubscriptionService.sendPortalLink(A, subContactId);
  check("4.1 binding de 'cobranca' decide o canal do link do portal", sent === true && sends[sends.length - 1]?.channelId === chCloud, JSON.stringify(sends[sends.length - 1] || null));

  // ── 5) Isolamento: binding da org A nunca decide pra org B. ──
  const bPick = ChannelBindingService.selectOutboundChannel(B, "prospeccao");
  check("5.1 org B resolve o próprio canal (binding de A não vaza)", bPick?.id === chB, String(bPick?.id));

  console.log("\n=== TEST: F7 — produtores no resolvedor canônico ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
