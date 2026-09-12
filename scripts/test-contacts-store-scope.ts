/**
 * TEST — escopo de loja no CRM (Contatos & CRM). A loja do contato é DERIVADA da
 * loja de compra (orders.store_id). Política INCLUSIVA: gerente restrito vê os
 * contatos que compraram na SUA loja + os SEM loja atribuída (lead sem compra /
 * pedido sem loja); esconde só quem comprou em OUTRA loja. Owner/sem-atribuição
 * vê tudo (0-regressão).
 *
 * Usa o MESMO predicado da rota (contactsStoreScope) — sem drift.
 * Uso: npm run test:contacts-store-scope
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-crmscope-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-crmscope-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { RetailStoreScopeService } = await import("../src/server/RetailStoreScopeService.js");
  const { contactsStoreScope } = await import("../src/server/routes/contacts.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  const mkStore = (name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, 1)`).run(id, A, name, code); return id; };
  const L1 = mkStore("Nova Iguaçu", "NI"), L2 = mkStore("Carioca", "CA");

  const mkContact = (name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'wa', ?, ?)`).run(id, A, name, `${id.slice(0,6)}`); return id; };
  const mkOrder = (contactId: string, storeId: string | null) => db.prepare(`INSERT INTO orders (id, organization_id, contact_id, store_id, status, total_amount) VALUES (?, ?, ?, ?, 'pago', 100)`).run(randomUUID(), A, contactId, storeId);

  const cL1 = mkContact("Comprou na L1"); mkOrder(cL1, L1);
  const cL2 = mkContact("Comprou na L2"); mkOrder(cL2, L2);
  const cLead = mkContact("Lead sem compra"); // nenhum pedido
  const cNoStore = mkContact("Pedido sem loja"); mkOrder(cNoStore, null);
  const cBoth = mkContact("Comprou nas duas"); mkOrder(cBoth, L1); mkOrder(cBoth, L2);

  const listFor = (user: any): string[] => {
    const s = contactsStoreScope(A, user);
    return (db.prepare(`SELECT id FROM contacts WHERE organization_id = ?${s.clause}`).all(A, ...s.args) as any[]).map(r => r.id);
  };

  // ── owner / sem atribuição → vê tudo ──
  const owner = { userId: randomUUID(), role: "owner" };
  check("owner vê todos os 5 contatos", listFor(owner).length === 5);
  const adminSemLoja = { userId: randomUUID(), role: "admin" };
  check("admin SEM atribuição vê tudo (0-regressão)", listFor(adminSemLoja).length === 5);

  // ── gerente (admin) atribuído à L1 → inclusivo ──
  const ger = { userId: randomUUID(), role: "admin" };
  RetailStoreScopeService.setForUser(A, ger.userId, [L1], owner.userId);
  const seen = new Set(listFor(ger));
  check("gerente L1 vê quem comprou na L1", seen.has(cL1));
  check("gerente L1 vê lead sem compra (inclusivo)", seen.has(cLead));
  check("gerente L1 vê contato de pedido sem loja (inclusivo)", seen.has(cNoStore));
  check("gerente L1 vê quem comprou nas DUAS (tem compra na L1)", seen.has(cBoth));
  check("gerente L1 NÃO vê quem comprou só na L2", !seen.has(cL2));
  check("gerente L1 vê 4 de 5 (esconde só o exclusivo de L2)", seen.size === 4);

  // ── gerente atribuído à L2 → espelho ──
  const ger2 = { userId: randomUUID(), role: "admin" };
  RetailStoreScopeService.setForUser(A, ger2.userId, [L2], owner.userId);
  const seen2 = new Set(listFor(ger2));
  check("gerente L2 vê L2 + neutros, esconde só o exclusivo de L1", seen2.has(cL2) && seen2.has(cLead) && seen2.has(cNoStore) && seen2.has(cBoth) && !seen2.has(cL1));

  console.log("\n=== escopo de loja no CRM (Contatos & CRM) ===");
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} contacts-store-scope: ${results.length - failures}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
