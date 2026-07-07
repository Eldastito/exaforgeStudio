/**
 * TEST — Tier 2 (Carlos Domingos, ADR-046): Radar de Oportunidades Disfarçadas +
 * Journal de Frustrações.
 *
 * Cobre:
 *  1. OpportunityRadarService: 5 detectores (stock_out, service_complaint,
 *     product_gap, cancellation_reason, delay_pattern), dedupe (upsert),
 *     lista com filtros, updateStatus.
 *  2. FrustrationJournalService: record com classificação automática, list,
 *     delete, digest agregado.
 *
 * Uso: npm run test:tier2-escuta-ativa
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-tier2-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-tier2-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OpportunityRadarService } = await import("../src/server/OpportunityRadarService.js");
  const { FrustrationJournalService } = await import("../src/server/FrustrationJournalService.js");

  const seedOrg = (tag: string) => {
    const id = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), id, `Loja ${tag}`);
    return id;
  };
  const seedChannel = (orgId: string) => {
    const id = `ch_${randomUUID().slice(0, 8)}`;
    try { db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'whatsapp', 'C', 'active')`).run(id, orgId); } catch {}
    return id;
  };
  const seedContact = (orgId: string, ch: string, name = "João") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(id, orgId, ch, name, `55${id.slice(0, 8)}`);
    return id;
  };
  const seedTicket = (orgId: string, contactId: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage) VALUES (?, ?, ?, 'open', 'novo_lead')`).run(id, orgId, contactId);
    return id;
  };
  const seedMsg = (orgId: string, ticketId: string, sender: string, content: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content) VALUES (?, ?, ?, ?, ?)`).run(id, orgId, ticketId, sender, content);
    return id;
  };

  // ==== PART 1: OpportunityRadarService ====
  console.log("\n=== 1. Radar detecta reclamações ===");
  const orgA = seedOrg("radA");
  const chA = seedChannel(orgA);
  const ct1 = seedContact(orgA, chA, "Ana"), ct2 = seedContact(orgA, chA, "Bia"), ct3 = seedContact(orgA, chA, "Cris");
  const tk1 = seedTicket(orgA, ct1), tk2 = seedTicket(orgA, ct2), tk3 = seedTicket(orgA, ct3);
  seedMsg(orgA, tk1, "contact", "Oi, o serviço tá muito ruim, demorou dias pra chegar");
  seedMsg(orgA, tk2, "contact", "Vim reclamar do problema do meu pedido, prazo estourou, quero cancelar isso já");
  seedMsg(orgA, tk3, "contact", "Péssimo atendimento, demorou muito e quebrou tudo");

  OpportunityRadarService.scan(orgA);
  const opps1 = OpportunityRadarService.list(orgA);
  const complaint = opps1.find((o) => o.category === "service_complaint");
  check("1.1 Detecta reclamação (service_complaint)", !!complaint);
  check("1.2 Menciona quantidade de sinais", complaint?.description?.includes("3") ?? false);
  check("1.3 Traz amostras de evidência", (complaint?.sampleEvidences?.length || 0) === 3);
  const delay = opps1.find((o) => o.category === "delay_pattern");
  check("1.4 Detecta padrão de demora em paralelo", !!delay);

  console.log("\n=== 2. Radar detecta gap de catálogo ===");
  const orgB = seedOrg("radB");
  const chB = seedChannel(orgB);
  const ct4 = seedContact(orgB, chB), ct5 = seedContact(orgB, chB), ct6 = seedContact(orgB, chB);
  const tkB1 = seedTicket(orgB, ct4), tkB2 = seedTicket(orgB, ct5), tkB3 = seedTicket(orgB, ct6);
  seedMsg(orgB, tkB1, "bot", "Infelizmente não temos esse produto no catálogo");
  seedMsg(orgB, tkB2, "bot", "Nao trabalhamos com essa categoria");
  seedMsg(orgB, tkB3, "bot", "Não temos essa opção no momento");
  OpportunityRadarService.scan(orgB);
  const gap = OpportunityRadarService.list(orgB).find((o) => o.category === "product_gap");
  check("2.1 Detecta product_gap por 'não temos' recorrente", !!gap);
  check("2.2 Sugestão orienta a mapear itens pedidos", gap?.suggestedAction?.toLowerCase().includes("catálogo") ?? false);

  console.log("\n=== 3. Radar detecta cancelamentos ===");
  const orgC = seedOrg("radC");
  const chC = seedChannel(orgC);
  const ctC = seedContact(orgC, chC);
  for (let i = 0; i < 4; i++) {
    db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount) VALUES (?, ?, ?, 'cancelado', 200)`).run(randomUUID(), orgC, ctC);
  }
  OpportunityRadarService.scan(orgC);
  const cancels = OpportunityRadarService.list(orgC).find((o) => o.category === "cancellation_reason");
  check("3.1 Detecta cancelamentos acima do limiar", !!cancels && cancels.evidenceCount === 4);

  console.log("\n=== 4. Radar dedupe (upsert) ===");
  const before = OpportunityRadarService.list(orgA, { status: "all" }).length;
  OpportunityRadarService.scan(orgA);
  const after = OpportunityRadarService.list(orgA, { status: "all" }).length;
  check("4.1 Segunda passada NÃO duplica linhas", before === after);
  // Adiciona 2 novas reclamações e reroda: contagem sobe na oportunidade existente
  const ct7 = seedContact(orgA, chA), ct8 = seedContact(orgA, chA);
  const tkX = seedTicket(orgA, ct7), tkY = seedTicket(orgA, ct8);
  seedMsg(orgA, tkX, "contact", "atrasou de novo, tá muito ruim");
  seedMsg(orgA, tkY, "contact", "problema no pagamento, péssimo");
  OpportunityRadarService.scan(orgA);
  const updatedComplaint = OpportunityRadarService.list(orgA).find((o) => o.category === "service_complaint");
  check("4.2 evidence_count sobe no upsert", (updatedComplaint?.evidenceCount || 0) >= 5);

  console.log("\n=== 5. Radar: updateStatus e list com filtros ===");
  const anyOpp = OpportunityRadarService.list(orgA)[0];
  const ok = OpportunityRadarService.updateStatus(orgA, anyOpp.id, "acknowledged", "user-1");
  check("5.1 updateStatus devolve true", ok);
  const ackList = OpportunityRadarService.list(orgA, { status: "acknowledged" });
  check("5.2 Filtro por status='acknowledged' funciona", ackList.some((o) => o.id === anyOpp.id));
  const cross = OpportunityRadarService.updateStatus(seedOrg("outra"), anyOpp.id, "dismissed");
  check("5.3 Update de outra org é bloqueado", cross === false);

  // ==== PART 6: FrustrationJournalService ====
  console.log("\n=== 6. Journal de Frustrações — record + classify ===");
  const orgF = seedOrg("frust");
  const f1 = FrustrationJournalService.record(orgF, "user-1", "Sistema travou de novo, perdi 40min de trabalho");
  check("6.1 record devolve linha", typeof f1.id === "string" && f1.text.startsWith("Sistema travou"));
  check("6.2 classify → ferramenta", f1.category === "ferramenta");
  const f2 = FrustrationJournalService.record(orgF, "user-1", "Cliente reclamou de novo hoje, não entendeu o combinado");
  check("6.3 classify → cliente", f2.category === "cliente");
  const f3 = FrustrationJournalService.record(orgF, "user-1", "Custo do fornecedor subiu 15%, margem apertou");
  check("6.4 classify → financeiro", f3.category === "financeiro");
  const f4 = FrustrationJournalService.record(orgF, "user-1", "Sem palavras-chave conhecidas aqui");
  check("6.5 sem match → outro", f4.category === "outro");

  let threw = false;
  try { FrustrationJournalService.record(orgF, "user-1", "   "); } catch { threw = true; }
  check("6.6 Texto vazio lança erro", threw);

  console.log("\n=== 7. Journal — list e digest ===");
  const listF = FrustrationJournalService.list(orgF);
  check("7.1 list devolve todas na ordem DESC", listF.length === 4 && listF[0].id === f4.id);
  const digest = FrustrationJournalService.digest(orgF);
  check("7.2 digest.total conta as 4", digest.total === 4);
  check("7.3 digest.byCategory tem entradas", (digest.byCategory.ferramenta || 0) === 1 && (digest.byCategory.cliente || 0) === 1);
  check("7.4 digest.topCategory bate empate no primeiro", ["ferramenta", "cliente", "financeiro", "outro"].includes(digest.topCategory || ""));

  console.log("\n=== 8. Journal — delete e isolamento ===");
  const del = FrustrationJournalService.delete(orgF, f1.id);
  check("8.1 delete devolve true", del === true);
  check("8.2 delete de outra org NÃO afeta", FrustrationJournalService.delete(seedOrg("outra2"), f2.id) === false);
  const listAfter = FrustrationJournalService.list(orgF);
  check("8.3 f1 removido; sobram 3", listAfter.length === 3 && !listAfter.some((r) => r.id === f1.id));

  // Isolamento entre orgs
  const orgOther = seedOrg("frOther");
  check("8.4 Outra org NÃO enxerga frustrações", FrustrationJournalService.list(orgOther).length === 0);

  console.log("\n──── Resultados ────");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` [${r.detail}]` : ""}`);
  console.log(`\n${results.length} verificações, ${failures} falha(s).`);
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
