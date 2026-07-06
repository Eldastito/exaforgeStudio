/**
 * TEST — Batch: EAN por foto + Radar consultoria (CRM) + Google Sheets live
 * sync + SLA por prioridade/segmento.
 * -----------------------------------------------------------------------
 * Cobre:
 *   1. Validação de EAN/GTIN pelo dígito verificador (eanUtil)
 *   2. Google Sheets live sync — buildLiveSheetData (abas Vendas/Estoque/Resumo)
 *   3. Radar request-consultation — lead + tarefa + notificação + list/update
 *   4. SLA por prioridade/segmento — config, resolução, monitor de breach
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:sla-barcode-consult-sheets
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID, createHash } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-batch-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-batch-1234567890abcdef";
process.env.APP_URL = "https://example.com";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { isValidGtin, sanitizeGtin } = await import("../src/server/eanUtil.js");
  const { GoogleAutomationService } = await import("../src/server/GoogleAutomationService.js");
  const { TicketSlaService } = await import("../src/server/TicketSlaService.js");
  const { RadarPublicService } = await import("../src/server/RadarPublicService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Empresa ${tag}`);
    return orgId;
  }
  function seedChannel(orgId: string) {
    const id = `ch_${randomUUID().slice(0, 8)}`;
    try { db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'whatsapp', 'Canal', 'active')`).run(id, orgId); } catch { /* noop */ }
    return id;
  }

  // ==== PART 1: EAN checksum ====
  console.log("\n=== PART 1: EAN/GTIN checksum ===");
  check("1.1 EAN-13 válido aceito", isValidGtin("4006381333931") === true);
  check("1.2 EAN-13 com checksum errado rejeitado", isValidGtin("4006381333930") === false);
  check("1.3 EAN-8 válido aceito", isValidGtin("73513537") === true);
  check("1.4 UPC-A (12) válido aceito", isValidGtin("036000291452") === true);
  check("1.5 Tamanho inválido (11 díg) rejeitado", isValidGtin("12345678901") === false);
  check("1.6 Com letras rejeitado", isValidGtin("40063813339A1") === false);
  check("1.7 sanitizeGtin remove não-dígitos e valida", sanitizeGtin("7891000315507") === "7891000315507");
  check("1.8 sanitizeGtin devolve null p/ inválido", sanitizeGtin("1234567890123") === null);
  check("1.9 sanitizeGtin de null é null", sanitizeGtin(null) === null);
  check("1.10 sanitizeGtin com espaços/hífens", sanitizeGtin("789 1000-315507") === "7891000315507");

  // ==== PART 2: Google Sheets live sync ====
  console.log("\n=== PART 2: Google Sheets live sync ===");
  const orgS = seedOrg("sheets");

  // Toggle
  check("2.1 syncEnabled default off", GoogleAutomationService.getSettings(orgS).syncEnabled === false);
  GoogleAutomationService.setLiveSync(orgS, true);
  check("2.2 setLiveSync liga", GoogleAutomationService.getSettings(orgS).syncEnabled === true);

  // Seed produtos + estoque + pedidos
  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Camiseta', 100, 1)`).run(prod, orgS);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, sku, quantity_available, quantity_reserved) VALUES (?, ?, ?, 'SKU-1', 7, 2)`).run(randomUUID(), orgS, prod);
  const chS = seedChannel(orgS);
  const ct = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, 'João', '5511900000000')`).run(ct, orgS, chS);
  const ord = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, payment_status, total_amount, created_at) VALUES (?, ?, ?, 'pago', 'pago', 150.5, datetime('now','-1 day'))`).run(ord, orgS, ct);

  const data = GoogleAutomationService.buildLiveSheetData(orgS);
  check("2.3 Aba Vendas tem cabeçalho + 1 pedido", data.vendas.length === 2 && data.vendas[0][0] === "Data");
  check("2.4 Venda reflete status/pagamento atuais", data.vendas[1][2] === "pago" && data.vendas[1][3] === "pago");
  check("2.5 Venda mostra cliente e total", data.vendas[1][1] === "João" && data.vendas[1][4] === "150.50");
  check("2.6 Aba Estoque tem cabeçalho + 1 item", data.estoque.length === 2 && data.estoque[0][2] === "Disponível");
  check("2.7 Estoque mostra disponível/reservado", data.estoque[1][2] === 7 && data.estoque[1][3] === 2);
  const resumoMap = new Map(data.resumo.map((r: any[]) => [r[0], r[1]]));
  check("2.8 Resumo conta pedidos pagos", resumoMap.get("Pedidos pagos") === 1);
  check("2.9 Resumo soma faturamento pago", resumoMap.get("Faturamento pago (R$)") === "150.50");
  check("2.10 Resumo soma unidades em estoque", resumoMap.get("Unidades em estoque") === 7);
  check("2.11 counts refletem os dados", data.counts.vendas === 1 && data.counts.estoque === 1);

  // ==== PART 3: Radar request-consultation (CRM) ====
  console.log("\n=== PART 3: Radar consultoria (CRM) ===");
  const leadsOrg = seedOrg("leads");
  process.env.RADAR_LEADS_ORGANIZATION_ID = leadsOrg;

  // Sessão pública concluída (organization_id NULL) + token
  const rawToken = `tkn_${randomUUID()}`;
  const sessionId = randomUUID();
  const templateId = randomUUID();
  db.prepare(`INSERT INTO radar_templates (id, name) VALUES (?, 'T')`).run(templateId);
  db.prepare(`
    INSERT INTO radar_sessions (id, organization_id, template_id, status, source, company_name, contact_name, overall_maturity_score, maturity_level, public_token_hash, public_token_expires_at)
    VALUES (?, NULL, ?, 'completed', 'landing', 'ACME Ltda', 'Maria', 62, 'em_evolucao', ?, datetime('now', '+7 days'))
  `).run(sessionId, templateId, hashToken(rawToken));

  const out = RadarPublicService.requestConsultation(rawToken, { name: "Maria", email: "maria@acme.com", phone: "11999998888", message: "Quero ajuda com automação." });
  check("3.1 requestConsultation retorna sucesso", out.success === true && !!out.requestId);

  const reqRow = db.prepare(`SELECT * FROM radar_consultation_requests WHERE id = ?`).get(out.requestId) as any;
  check("3.2 Score anexado ao pedido", reqRow.overall_score === 62 && reqRow.maturity_level === "em_evolucao");
  check("3.3 Pedido ligado à org de destino", reqRow.organization_id === leadsOrg);
  check("3.4 Mensagem do lead preservada", reqRow.message === "Quero ajuda com automação.");
  check("3.5 Tarefa de follow-up criada e vinculada", !!reqRow.task_id);

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(reqRow.task_id) as any;
  check("3.6 Tarefa pertence à org de destino", task && task.organization_id === leadsOrg);
  check("3.7 Tarefa tem prioridade alta e fonte radar", task && task.priority === "alta" && task.source === "radar");
  check("3.8 Tarefa cita o score no corpo", task && /62/.test(task.description || ""));

  const notif = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE organization_id = ? AND title LIKE '%consultoria%'`).get(leadsOrg) as any;
  check("3.9 Notificação criada p/ o consultor", notif.c >= 1);

  // Duplicidade barrada
  let dupBlocked = false;
  try { RadarPublicService.requestConsultation(rawToken, { name: "Maria", email: "maria@acme.com" }); } catch { dupBlocked = true; }
  check("3.10 Segunda solicitação é barrada", dupBlocked);

  // Listagem + transição de status
  const list = RadarPublicService.listConsultationRequests(leadsOrg);
  check("3.11 Listagem mostra o pedido p/ a org", list.length === 1 && list[0].id === out.requestId);
  RadarPublicService.updateConsultationRequest(leadsOrg, out.requestId, "contacted", "user-1");
  const afterUpd = db.prepare(`SELECT status, handled_at, handled_by FROM radar_consultation_requests WHERE id = ?`).get(out.requestId) as any;
  check("3.12 Status vira 'contacted' com handled_at", afterUpd.status === "contacted" && afterUpd.handled_at !== null && afterUpd.handled_by === "user-1");
  check("3.13 Filtro por status funciona", RadarPublicService.listConsultationRequests(leadsOrg, "pending").length === 0);

  // Isolamento: outra org não vê o pedido
  const otherOrg = seedOrg("other");
  check("3.14 Outra org não enxerga o pedido", RadarPublicService.listConsultationRequests(otherOrg).length === 0);
  let crossBlocked = false;
  try { RadarPublicService.updateConsultationRequest(otherOrg, out.requestId, "closed"); } catch { crossBlocked = true; }
  check("3.15 Outra org não pode alterar o pedido", crossBlocked);

  // ==== PART 4: SLA por prioridade/segmento ====
  console.log("\n=== PART 4: SLA por prioridade/segmento ===");
  const orgSla = seedOrg("sla");

  // Config default + save
  const def = TicketSlaService.config(orgSla);
  check("4.1 Monitor default desligado", def.enabled === false);
  check("4.2 Defaults por prioridade (alta 1800s)", def.prioritySeconds.alta === 1800 && def.prioritySeconds.media === 14400);
  const saved = TicketSlaService.saveConfig(orgSla, { enabled: true, alta: 600, vipSeconds: 300, vipMinSpent: 1000 });
  check("4.3 saveConfig liga e persiste", saved.enabled === true && saved.prioritySeconds.alta === 600 && saved.vipSeconds === 300);
  check("4.4 saveConfig recarrega igual", TicketSlaService.config(orgSla).prioritySeconds.alta === 600);
  check("4.5 saveConfig clampa valor absurdo", TicketSlaService.saveConfig(orgSla, { media: 5 }).prioritySeconds.media === 14400 /* 5s < 30s → mantém anterior */);

  // Segmento e resolução (mais apertada vence)
  check("4.6 VIP acima do limiar", TicketSlaService.segmentForSpent(1500, 1000) === "vip");
  check("4.7 Regular abaixo do limiar", TicketSlaService.segmentForSpent(500, 1000) === "regular");
  check("4.8 Limiar 0 desliga VIP", TicketSlaService.segmentForSpent(99999, 0) === "regular");
  const cfg = TicketSlaService.config(orgSla); // alta=600, media=14400, vip=300
  check("4.9 Regular alta = meta da prioridade", TicketSlaService.effectiveSeconds(cfg, "alta", "regular") === 600);
  check("4.10 VIP média = mais apertada (VIP 300 < média 14400)", TicketSlaService.effectiveSeconds(cfg, "media", "vip") === 300);
  check("4.11 VIP alta = mais apertada (VIP 300 < alta 600)", TicketSlaService.effectiveSeconds(cfg, "alta", "vip") === 300);

  // Monitor: 1 ticket estourado sem resposta, 1 respondido no prazo, 1 dentro do prazo
  const chSla = seedChannel(orgSla);
  const mkContact = (spent: number) => { const id = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, total_spent) VALUES (?, ?, ?, ?, ?, ?)`).run(id, orgSla, chSla, `C${spent}`, `55${id.slice(0, 6)}`, spent); return id; };
  const mkTicket = (contactId: string, priority: string) => { const id = randomUUID(); db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, priority) VALUES (?, ?, ?, 'open', ?)`).run(id, orgSla, contactId, priority); return id; };
  const mkMsg = (ticketId: string, sender: string, minsAgo: number) => db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, ?, 'x', datetime('now', ?))`).run(randomUUID(), orgSla, ticketId, sender, `-${minsAgo} minutes`);

  // Ticket A: regular, prioridade alta (meta 600s=10min), contato há 30min, sem resposta → breach
  const tA = mkTicket(mkContact(100), "alta");
  mkMsg(tA, "contact", 30);
  // Ticket B: respondido dentro do prazo (contato há 30min, resposta há 28min = 2min depois) → ok
  const tB = mkTicket(mkContact(100), "alta");
  mkMsg(tB, "contact", 30); mkMsg(tB, "agent", 28);
  // Ticket C: VIP (gasto 5000 >= 1000, meta VIP 300s=5min), contato há 2min, sem resposta → ainda no prazo
  const tC = mkTicket(mkContact(5000), "media");
  mkMsg(tC, "contact", 2);

  const evalRes = TicketSlaService.evaluateOrg(orgSla);
  check("4.12 evaluateOrg avaliou 3 tickets", evalRes.evaluated === 3);
  check("4.13 1 estourado detectado", evalRes.breached === 1);
  check("4.14 1 notificação enviada", evalRes.notified === 1);

  const rowA = db.prepare(`SELECT sla_breached, sla_first_response_at, sla_segment FROM tickets WHERE id = ?`).get(tA) as any;
  check("4.15 Ticket A marcado estourado, sem resposta", rowA.sla_breached === 1 && rowA.sla_first_response_at === null);
  const rowB = db.prepare(`SELECT sla_breached, sla_first_response_at FROM tickets WHERE id = ?`).get(tB) as any;
  check("4.16 Ticket B respondido no prazo (não estourado)", rowB.sla_breached === 0 && rowB.sla_first_response_at !== null);
  const rowC = db.prepare(`SELECT sla_breached, sla_segment FROM tickets WHERE id = ?`).get(tC) as any;
  check("4.17 Ticket C VIP ainda no prazo", rowC.sla_breached === 0 && rowC.sla_segment === "vip");

  // Idempotência da notificação: rodar de novo não re-notifica o A
  const evalRes2 = TicketSlaService.evaluateOrg(orgSla);
  check("4.18 Segunda passada não re-notifica", evalRes2.notified === 0);

  // displayState ao vivo
  const nowMs = Date.now();
  const dueBreached = new Date(nowMs - 60000).toISOString();
  check("4.19 displayState breached (venceu, sem resposta)", TicketSlaService.displayState({ sla_due_at: dueBreached, sla_first_response_at: null, sla_breached: 1 }, nowMs) === "breached");
  const dueSoon = new Date(nowMs + 10 * 60000).toISOString();
  check("4.20 displayState at_risk (vence em 10min)", TicketSlaService.displayState({ sla_due_at: dueSoon, sla_first_response_at: null }, nowMs) === "at_risk");
  const dueFar = new Date(nowMs + 120 * 60000).toISOString();
  check("4.21 displayState ok (folga grande)", TicketSlaService.displayState({ sla_due_at: dueFar, sla_first_response_at: null }, nowMs) === "ok");
  check("4.22 displayState null sem due", TicketSlaService.displayState({ sla_due_at: null }, nowMs) === null);

  // Monitor desligado não avalia nada
  const orgOff = seedOrg("slaoff");
  check("4.23 Monitor desligado retorna 0", TicketSlaService.evaluateOrg(orgOff).evaluated === 0);

  // ---- Summary ----
  console.log("\n──── Resultados ────");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` [${r.detail}]` : ""}`);
  }
  console.log(`\n${results.length} verificações, ${failures} falha(s).`);
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
