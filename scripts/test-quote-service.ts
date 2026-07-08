/**
 * TEST — QuoteService (ADR-063).
 *
 * Orçamento é a "proposta comercial escrita" — em muitos segmentos (eventos,
 * serviços B2B, catering, obra), é o produto do lojista. Um bug em buildAndSave
 * = orçamento com preço/estoque inconsistente; um bug em expire = orçamento
 * "vivo" para sempre; um bug em isolamento = orçamento vaza entre orgs.
 *
 * Cobertura:
 *  - buildAndSave: match exato, match fuzzy (LIKE), estoque insuficiente
 *    trunca qty, sem estoque zera qty, item não encontrado listado como notFound,
 *    cálculo do total, texto humanizado, valid_until conforme config da org.
 *  - Fluxo: sent → accepted, sent → declined, idempotência.
 *  - openForContact: pega o mais recente aberto (sent/viewed).
 *  - Expiração: passFollowupAndExpire só marca 'expired' quem passou de valid_until.
 *  - Isolamento por org em TODOS os queries.
 *
 * Uso: npm run test:quote-service
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-quote-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-quote-1234567890ab";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { QuoteService } = await import("../src/server/QuoteService.js");

  // Setup
  const orgA = `org_A_${randomUUID().slice(0, 6)}`;
  const orgB = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, quote_validity_hours) VALUES (?, ?, ?, 'active', 48)`).run(randomUUID(), orgA, "Loja A");
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgB, "Loja B");

  const chA = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'evolution', 'canal A', 'active')`).run(chA, orgA);
  const contactA = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(contactA, orgA, chA, "Alice", "5511911110000");

  // Produtos: um sem controle de estoque, um com estoque baixo, um esgotado
  const pFree = randomUUID(), pLow = randomUUID(), pOut = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Bolo de Chocolate', 50.00, 1, 0)`).run(pFree, orgA);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Refrigerante 2L', 15.00, 1, 1)`).run(pLow, orgA);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Copo Descartável', 5.00, 1, 1)`).run(pOut, orgA);
  // Estoque: refri tem 3, copo tem 0. Escrevemos direto na tabela inventory_items.
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, quantity_reserved) VALUES (?, ?, ?, 3, 0)`).run(randomUUID(), orgA, pLow);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, quantity_reserved) VALUES (?, ?, ?, 0, 0)`).run(randomUUID(), orgA, pOut);

  // ==== 1. validityHours ====
  console.log("\n=== 1. validityHours ===");
  check("1.1 org com config 48h retorna 48", QuoteService.validityHours(orgA) === 48);
  check("1.2 org sem config retorna default 72", QuoteService.validityHours(orgB) === 72);
  check("1.3 org inexistente cai no default 72", QuoteService.validityHours("nope") === 72);

  // ==== 2. buildAndSave — match exato ====
  console.log("\n=== 2. buildAndSave — match exato ===");
  const q1 = QuoteService.buildAndSave(orgA, [{ name: "Bolo de Chocolate", quantity: 2 }], { contactId: contactA });
  check("2.1 retorna estrutura completa", q1 && typeof q1.id === "string" && q1.total === 100 && q1.itemCount === 1);
  check("2.2 texto humanizado inclui total", q1!.text.includes("R$ 100.00"));
  check("2.3 texto tem prazo em horas", q1!.text.includes("48h"));

  const q1Row = db.prepare(`SELECT * FROM quotes WHERE id = ?`).get(q1!.id) as any;
  check("2.4 persistido com status 'sent'", q1Row.status === "sent");
  check("2.5 valid_until preenchido no futuro", new Date(q1Row.valid_until).getTime() > Date.now());
  check("2.6 items_snapshot é JSON válido", JSON.parse(q1Row.items_snapshot).length === 1);

  // ==== 3. buildAndSave — fuzzy match ====
  console.log("\n=== 3. buildAndSave — fuzzy LIKE ===");
  const qFuzzy = QuoteService.buildAndSave(orgA, [{ name: "Bolo", quantity: 1 }], { contactId: contactA });
  check("3.1 'Bolo' casa com 'Bolo de Chocolate' via LIKE", qFuzzy && qFuzzy.itemCount === 1 && qFuzzy.total === 50);

  // ==== 4. Estoque insuficiente trunca ====
  console.log("\n=== 4. Estoque insuficiente ===");
  const qLow = QuoteService.buildAndSave(orgA, [{ name: "Refrigerante 2L", quantity: 10 }], { contactId: contactA });
  const lowSnap = JSON.parse(db.prepare(`SELECT items_snapshot FROM quotes WHERE id = ?`).get(qLow!.id).items_snapshot);
  check("4.1 qty pedido=10 mas estoque=3 → snap tem qty=3", lowSnap[0].qty === 3);
  check("4.2 total ajustado (3 * 15)", qLow!.total === 45);
  check("4.3 texto informa quantidade disponível", qLow!.text.includes("só temos") || qLow!.text.includes("*3*"));

  // ==== 5. Sem estoque → qty=0 ====
  console.log("\n=== 5. Sem estoque ===");
  const qOut = QuoteService.buildAndSave(orgA, [{ name: "Copo Descartável", quantity: 5 }], { contactId: contactA });
  const outSnap = JSON.parse(db.prepare(`SELECT items_snapshot FROM quotes WHERE id = ?`).get(qOut!.id).items_snapshot);
  check("5.1 snap com qty=0", outSnap[0].qty === 0);
  check("5.2 texto marca 'sem estoque'", qOut!.text.includes("sem estoque"));
  check("5.3 total=0 quando único item está esgotado", qOut!.total === 0);

  // ==== 6. Item não encontrado ====
  console.log("\n=== 6. Item não encontrado ===");
  const qMiss = QuoteService.buildAndSave(orgA, [{ name: "Produto Inexistente 42" }, { name: "Bolo de Chocolate", quantity: 1 }], { contactId: contactA });
  check("6.1 orçamento salvo com item válido", qMiss && qMiss.itemCount === 1);
  check("6.2 texto lista o não-encontrado", qMiss!.text.includes("Produto Inexistente"));

  const qOnlyMiss = QuoteService.buildAndSave(orgA, [{ name: "Produto Inexistente" }], { contactId: contactA });
  check("6.3 tudo não-encontrado NÃO persiste (id vazio)", qOnlyMiss && qOnlyMiss.id === "" && qOnlyMiss.itemCount === 0);

  // ==== 7. Item vazio / lista vazia ====
  console.log("\n=== 7. Guards ===");
  check("7.1 lista vazia retorna null", QuoteService.buildAndSave(orgA, []) === null);
  check("7.2 itens sem name retorna null", QuoteService.buildAndSave(orgA, [{ quantity: 1 } as any]) === null);
  check("7.3 name vazio retorna null", QuoteService.buildAndSave(orgA, [{ name: "  " }]) === null);

  // ==== 8. openForContact ====
  console.log("\n=== 8. openForContact ===");
  const latest = QuoteService.openForContact(orgA, contactA);
  check("8.1 openForContact retorna o mais recente 'sent'", !!latest && latest.status === "sent");

  // Aceita a mais recente
  check("8.2 markAccepted retorna true", QuoteService.markAccepted(orgA, latest.id) === true);
  check("8.3 markAccepted idempotente (2ª chamada retorna false — status já mudou)", QuoteService.markAccepted(orgA, latest.id) === false);

  const acc = db.prepare(`SELECT status, accepted_at FROM quotes WHERE id = ?`).get(latest.id) as any;
  check("8.4 status vira 'accepted' + accepted_at preenchido", acc.status === "accepted" && !!acc.accepted_at);

  // ==== 9. markDeclined ====
  console.log("\n=== 9. markDeclined ===");
  const nextOpen = QuoteService.openForContact(orgA, contactA);
  check("9.1 openForContact devolve OUTRA quote sent/viewed", !!nextOpen && nextOpen.id !== latest.id);
  check("9.2 markDeclined com motivo retorna true", QuoteService.markDeclined(orgA, nextOpen.id, "Cliente achou caro") === true);
  const dec = db.prepare(`SELECT status, declined_at, notes FROM quotes WHERE id = ?`).get(nextOpen.id) as any;
  check("9.3 status vira 'declined' + notes gravada", dec.status === "declined" && dec.notes === "Cliente achou caro");

  // ==== 10. Isolamento por org ====
  console.log("\n=== 10. Isolamento por org ===");
  check("10.1 orgB não vê quote de orgA", QuoteService.openForContact(orgB, contactA) === null);
  check("10.2 orgB não consegue aceitar quote de orgA", QuoteService.markAccepted(orgB, q1!.id) === false);
  check("10.3 orgB não consegue declinar quote de orgA", QuoteService.markDeclined(orgB, q1!.id, "teste") === false);

  // ==== 11. Expiração via passFollowupAndExpire ====
  console.log("\n=== 11. Expiração ===");
  // Força uma quote 'sent' com valid_until no passado
  const expiredQ = randomUUID();
  db.prepare(`INSERT INTO quotes (id, organization_id, contact_id, status, total_amount, valid_until, sent_at) VALUES (?, ?, ?, 'sent', 200, datetime('now', '-1 hour'), datetime('now', '-49 hours'))`)
    .run(expiredQ, orgA, contactA);

  // Quote com valid_until no futuro (não deve expirar)
  const freshQ = randomUUID();
  db.prepare(`INSERT INTO quotes (id, organization_id, contact_id, status, total_amount, valid_until, sent_at) VALUES (?, ?, ?, 'sent', 100, datetime('now', '+1 day'), datetime('now', '-1 hour'))`)
    .run(freshQ, orgA, contactA);

  await QuoteService.passFollowupAndExpire();
  const expiredAfter = db.prepare(`SELECT status FROM quotes WHERE id = ?`).get(expiredQ) as any;
  check("11.1 quote com valid_until no passado vira 'expired'", expiredAfter.status === "expired");
  const freshAfter = db.prepare(`SELECT status FROM quotes WHERE id = ?`).get(freshQ) as any;
  check("11.2 quote com valid_until no futuro permanece 'sent'", freshAfter.status === "sent");

  // Segundo pass: nada a expirar (idempotente)
  const beforeCount = db.prepare(`SELECT COUNT(*) c FROM quotes WHERE status = 'expired' AND organization_id = ?`).get(orgA) as any;
  await QuoteService.passFollowupAndExpire();
  const afterCount = db.prepare(`SELECT COUNT(*) c FROM quotes WHERE status = 'expired' AND organization_id = ?`).get(orgA) as any;
  check("11.3 segundo pass não muda contagem de expiradas", beforeCount.c === afterCount.c);

  // Quote 'accepted' não vira expired (sem regressão)
  const accStill = db.prepare(`SELECT status FROM quotes WHERE id = ?`).get(latest.id) as any;
  check("11.4 quote 'accepted' NÃO é reclassificada para expired", accStill.status === "accepted");

  // ==== 12. list ====
  console.log("\n=== 12. list ===");
  const allList = QuoteService.list(orgA);
  check("12.1 list devolve várias quotes da orgA", allList.length >= 3);
  check("12.2 filtro por status funciona", QuoteService.list(orgA, { status: "accepted" }).length >= 1);
  check("12.3 orgB tem 0 quotes", QuoteService.list(orgB).length === 0);

  // ==== Relatório ====
  console.log("\n=========================================");
  console.log("RELATÓRIO — QuoteService (ADR-063)");
  console.log("=========================================");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  console.log("=========================================");
  console.log(`${results.length - failures}/${results.length} passaram`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.log(`❌ ${failures} falhas`); process.exit(1); }
  console.log("✅ Todos os testes passaram");
  process.exit(0);
}

main().catch((e) => {
  console.error("💥 Teste explodiu:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
