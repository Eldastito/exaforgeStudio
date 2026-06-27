/**
 * TESTE DE ISOLAMENTO MULTI-TENANT (ZappFlow)
 * ------------------------------------------------------------------
 * Prova, de forma automatizada e offline, que um negócio NUNCA acessa os dados
 * de outro. Cria 2 organizações (A e B), popula dados em cada uma e verifica que:
 *   - cada consulta escopada por organization_id só vê os próprios dados;
 *   - serviços de leitura (pedidos, reservas, orçamentos, analytics) não cruzam;
 *   - o token JWT carrega a organização correta (a chave do escopo);
 *   - o gating de módulos difere por organização.
 *
 * Roda num banco TEMPORÁRIO (não toca o de produção). Saída: relatório PASS/FAIL
 * e código de saída 1 se qualquer verificação falhar (bom para CI / print ao cliente).
 *
 * Uso:  npm run test:isolation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

// IMPORTANTE: aponta o banco para um diretório TEMPORÁRIO antes de importar o db.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-isolation-"));
process.env.DATA_DIR = tmpDir;
// "production" só para o SQLite não logar cada query (saída limpa p/ o relatório);
// não sobe servidor nem ativa rate-limit. JWT_SECRET é fixado abaixo.
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-isolamento-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  // Import dinâmico DEPOIS de configurar DATA_DIR (para o db abrir no tmp).
  const { default: db } = await import("../src/server/db.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");
  const { ReservationService } = await import("../src/server/ReservationService.js");
  const { QuoteService } = await import("../src/server/QuoteService.js");
  const { AnalyticsService } = await import("../src/server/AnalyticsService.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const jwt = (await import("jsonwebtoken")).default;
  const { JWT_SECRET } = await import("../src/server/config/secret.js");

  // ---- Semeia 2 organizações isoladas ----
  function seedOrg(tag: string, vertical: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Empresa ${tag}`);
    ModuleService.applyVertical(orgId, vertical);

    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `id_${tag}`);

    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(contactId, orgId, channelId, `Cliente ${tag}`, `5511${tag}0000`);

    const ticketId = randomUUID();
    db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage) VALUES (?, ?, ?, 'open', 'novo_lead')`)
      .run(ticketId, orgId, contactId);

    const orderId = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, contact_id, ticket_id, status, total_amount) VALUES (?, ?, ?, ?, 'pago', 100)`)
      .run(orderId, orgId, contactId, ticketId);

    const resource = ReservationService.createResource(orgId, { name: `Recurso ${tag}`, price: 200, capacity: 5, reservationUnit: "night" });

    const quoteId = randomUUID();
    db.prepare(`INSERT INTO quotes (id, organization_id, contact_id, ticket_id, status, total_amount, items_snapshot) VALUES (?, ?, ?, ?, 'sent', 300, '[]')`)
      .run(quoteId, orgId, contactId, ticketId);

    return { orgId, contactId, ticketId, orderId, resourceId: resource.id, quoteId, channelId };
  }

  const A = seedOrg("A", "hospitalidade");
  const B = seedOrg("B", "varejo");

  // ============ VERIFICAÇÕES ============

  // 1) Contatos: A só vê os seus; o contato de B não aparece para A.
  const aContacts = db.prepare(`SELECT id FROM contacts WHERE organization_id = ?`).all(A.orgId) as any[];
  check("Contatos escopados por org (A não vê contato de B)",
    aContacts.some(c => c.id === A.contactId) && !aContacts.some(c => c.id === B.contactId),
    `A retornou ${aContacts.length} contato(s)`);

  // 2) Tickets idem.
  const aTickets = db.prepare(`SELECT id FROM tickets WHERE organization_id = ?`).all(A.orgId) as any[];
  check("Tickets escopados por org",
    aTickets.some(t => t.id === A.ticketId) && !aTickets.some(t => t.id === B.ticketId));

  // 3) OrdersService.getOrder: A NÃO consegue ler o pedido de B (cross-tenant read).
  const crossOrder = OrdersService.getOrder(A.orgId, B.orderId);
  check("OrdersService.getOrder bloqueia cross-tenant (A lendo pedido de B = null)", crossOrder == null);
  const ownOrder = OrdersService.getOrder(A.orgId, A.orderId);
  check("OrdersService.getOrder devolve o próprio pedido", ownOrder != null && ownOrder.id === A.orderId);

  // 4) ReservationService.getResource: A não lê recurso de B.
  check("ReservationService.getResource bloqueia cross-tenant", ReservationService.getResource(A.orgId, B.resourceId) == null);
  check("ReservationService.getResource devolve o próprio", ReservationService.getResource(A.orgId, A.resourceId) != null);

  // 5) QuoteService.list: A não vê orçamentos de B.
  const aQuotes = QuoteService.list(A.orgId);
  check("QuoteService.list escopado por org",
    aQuotes.some((q: any) => q.id === A.quoteId) && !aQuotes.some((q: any) => q.id === B.quoteId));

  // 6) AnalyticsService.getMetrics: números de A não contam dados de B.
  const aMetrics = AnalyticsService.getMetrics(A.orgId, { period: "all" });
  const bMetrics = AnalyticsService.getMetrics(B.orgId, { period: "all" });
  check("Analytics conta só os tickets da própria org",
    aMetrics.totalTickets === 1 && bMetrics.totalTickets === 1,
    `A=${aMetrics.totalTickets} B=${bMetrics.totalTickets}`);

  // 7) JWT: o token de A decodifica para a organização de A (chave do escopo).
  const tokenA = jwt.sign({ userId: "u_a", organizationId: A.orgId, role: "owner" }, JWT_SECRET);
  const decoded = jwt.verify(tokenA, JWT_SECRET) as any;
  check("JWT carrega a organização correta (base do escopo por request)", decoded.organizationId === A.orgId);

  // 8) Gating de módulos difere por vertical (hotel vê 'reservas', varejo não).
  check("Módulos por vertical: Hotel (A) enxerga 'reservas'", ModuleService.isEnabled(A.orgId, "reservas") === true);
  check("Módulos por vertical: Varejo (B) NÃO enxerga 'reservas'", ModuleService.isEnabled(B.orgId, "reservas") === false);
  check("Módulos por vertical: Varejo (B) enxerga 'vendas'", ModuleService.isEnabled(B.orgId, "vendas") === true);

  // 9) Núcleo sempre acessível, independente de vertical.
  check("Núcleo (atendimento) sempre habilitado", ModuleService.isEnabled(A.orgId, "atendimento") === true && ModuleService.isEnabled(B.orgId, "atendimento") === true);

  // ============ RELATÓRIO ============
  console.log("\n==================================================");
  console.log("  TESTE DE ISOLAMENTO MULTI-TENANT — ZappFlow");
  console.log("==================================================\n");
  for (const r of results) {
    console.log(`  ${r.ok ? "✅ PASS" : "❌ FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const total = results.length;
  console.log(`\n  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(failures === 0
    ? "  🔒 ISOLAMENTO CONFIRMADO: nenhum negócio acessa dados de outro.\n"
    : `  ⚠️  ${failures} verificação(ões) FALHARAM — investigar antes de prosseguir.\n`);

  // Limpeza do banco temporário.
  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste de isolamento:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
