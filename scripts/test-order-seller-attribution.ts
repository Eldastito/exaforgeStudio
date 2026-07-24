/**
 * TESTE — Atribuição automática do vendedor na venda (comissão por vendedor).
 *
 * Prova que OrdersService.createOrder carimba o vendedor:
 *   - do atendente do ticket (tickets.assigned_to) quando não vem explícito;
 *   - sem atendente humano → sem vendedor (venda 100% IA não comissiona);
 *   - atendente inexistente é ignorado (guard de usuário válido);
 *   - vendedor explícito tem prioridade; explícito inválido cai no do ticket.
 *
 * Uso:  npm run test:order-seller-attribution
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seller-attr-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-seller-attr-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const U1 = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Ana', ?)`).run(U1, A, `ana_${U1.slice(0, 6)}@x.com`);
  const P = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Camisa', 100, 1, 0)`).run(P, A);
  const chan = randomUUID(), contact = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, name, provider, identifier, status) VALUES (?, ?, 'C', 'evolution_go', 'x', 'active')`).run(chan, A);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, 'Cliente', '551199')`).run(contact, A, chan);

  const mkTicket = (assignedTo: string | null) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, assigned_to) VALUES (?, ?, ?, 'open', ?)`).run(id, A, contact, assignedTo);
    return id;
  };
  const T1 = mkTicket(U1);        // atribuído à Ana
  const T2 = mkTicket(null);      // sem atendente (só IA)
  const T3 = mkTicket("ghost");   // atendente inexistente

  const sellerOf = (orderId: string) => (db.prepare(`SELECT seller_user_id FROM orders WHERE id=?`).get(orderId) as any)?.seller_user_id ?? null;
  const buy = (opts: { ticketId?: string; sellerUserId?: string }) =>
    OrdersService.createOrder(A, { items: [{ productId: P, name: "Camisa", unitPrice: 0, quantity: 1 }], autoClose: true, ...opts });

  // 1) Ticket com atendente → vendedor = atendente.
  check("ticket do atendente → vendedor = atendente", sellerOf(buy({ ticketId: T1 }).id) === U1);
  // 2) Ticket sem atendente → sem vendedor.
  check("ticket sem atendente → sem vendedor", sellerOf(buy({ ticketId: T2 }).id) === null);
  // 3) Atendente inexistente → ignorado.
  check("atendente inexistente → sem vendedor", sellerOf(buy({ ticketId: T3 }).id) === null);
  // 4) Explícito tem prioridade sobre o do ticket.
  check("vendedor explícito tem prioridade", sellerOf(buy({ ticketId: T2, sellerUserId: U1 }).id) === U1);
  // 5) Explícito inválido cai no do ticket.
  check("explícito inválido → cai no atendente do ticket", sellerOf(buy({ ticketId: T1, sellerUserId: "ghost" }).id) === U1);
  // 6) Sem ticket e sem explícito → sem vendedor.
  check("sem ticket e sem explícito → sem vendedor", sellerOf(buy({}).id) === null);

  // 7) resolveSeller direto.
  check("resolveSeller(ticket T1) = U1", OrdersService.resolveSeller(A, undefined, T1) === U1);
  check("resolveSeller(explicit U1) = U1", OrdersService.resolveSeller(A, U1, undefined) === U1);
  check("resolveSeller(nada) = null", OrdersService.resolveSeller(A, undefined, undefined) === null);

  console.log("\n=== Atribuição automática do vendedor ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
