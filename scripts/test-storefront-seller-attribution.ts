/**
 * TESTE — Vendedor da venda por LINK da loja virtual (ADR-083 Fase G).
 *
 * Sobe o router público e prova a atribuição de comissão na jornada
 * "IA manda o link → cliente compra sozinho":
 *   - link ligado a uma conversa COM dono → herda o atendente;
 *   - conversa SEM dono (100% IA) e sem vendedor padrão → sem vendedor;
 *   - com vendedor padrão definido → vai para ele (fallback);
 *   - link sem ticket → também cai no vendedor padrão.
 *
 * Uso:  npm run test:storefront-seller-attribution
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-store-seller-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-store-seller-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const storefrontPublic = (await import("../src/server/routes/storefrontPublic.js")).default;
  const { RetailOnlineReserveService } = await import("../src/server/RetailOnlineReserveService.js");

  const orgId = randomUUID(), productId = randomUUID(), U1 = randomUUID(), chan = randomUUID(), contact = randomUUID();
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'TOULON', 'active')`).run(orgId);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, title) VALUES (?, 'toulon', 1, 'Loja')`).run(orgId);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Camisa', 100, 1)`).run(productId, orgId);
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Ana', ?)`).run(U1, orgId, `ana_${U1.slice(0, 6)}@x.com`);
  db.prepare(`INSERT INTO channels (id, organization_id, name, provider, identifier, status) VALUES (?, ?, 'C', 'evolution_go', 'x', 'active')`).run(chan, orgId);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, 'Cliente', '5511')`).run(contact, orgId, chan);

  const mkTicket = (owner: string | null) => { const id = randomUUID(); db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, assigned_to) VALUES (?, ?, ?, 'open', ?)`).run(id, orgId, contact, owner); return id; };
  const Towned = mkTicket(U1), Theadless = mkTicket(null);
  const mkLink = (ticketId: string | null) => { const t = "tok_" + randomUUID().replace(/-/g, "").slice(0, 16); db.prepare(`INSERT INTO storefront_links (token, organization_id, contact_id, ticket_id, expires_at) VALUES (?, ?, ?, ?, datetime('now','+30 days'))`).run(t, orgId, contact, ticketId); return t; };
  const tokOwned = mkLink(Towned), tokHeadless = mkLink(Theadless), tokNoTicket = mkLink(null);

  const app = express(); app.use(express.json()); app.use("/api/public", storefrontPublic);
  const server = await new Promise<any>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as any).port;
  const buy = async (token: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/public/store/toulon/order`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, items: [{ productId, quantity: 1 }] }) });
    const j = await r.json().catch(() => ({})) as any;
    return (db.prepare(`SELECT seller_user_id FROM orders WHERE id=?`).get(j.orderId) as any)?.seller_user_id ?? null;
  };

  // 1) Link de conversa COM dono → herda o atendente.
  check("link de conversa com dono → vendedor = atendente", (await buy(tokOwned)) === U1);
  // 2) Conversa 100% IA (sem dono) + sem vendedor padrão → sem vendedor.
  check("headless sem padrão → sem vendedor", (await buy(tokHeadless)) === null);
  // 3) Define vendedor padrão → headless cai nele.
  RetailOnlineReserveService.setDefaultOnlineSeller(orgId, U1);
  check("headless com padrão → vai p/ o padrão", (await buy(tokHeadless)) === U1);
  // 4) Link sem ticket + padrão definido → vendedor padrão.
  check("link sem ticket → vendedor padrão", (await buy(tokNoTicket)) === U1);
  // 5) Sem padrão de novo → headless volta a ficar sem vendedor.
  RetailOnlineReserveService.setDefaultOnlineSeller(orgId, null);
  check("removeu o padrão → headless sem vendedor", (await buy(tokHeadless)) === null);
  // 6) Dono da conversa tem prioridade mesmo com padrão definido.
  RetailOnlineReserveService.setDefaultOnlineSeller(orgId, U1);
  check("dono da conversa tem prioridade sobre o padrão", (await buy(tokOwned)) === U1);

  server.close();
  console.log("\n=== Vendedor da venda por link da loja virtual ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
