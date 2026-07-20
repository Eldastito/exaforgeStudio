/**
 * TEST — Checkout sem atrito da loja (ADR-096).
 * Verifica: com token pula o formulário (não exige nome/e-mail); e-mail nunca
 * é obrigatório; CPF na nota é opcional e vai pras notas do pedido.
 * Uso: npm run test:store-checkout-frictionless
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-checkout-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-checkout-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const storefrontPublic = (await import("../src/server/routes/storefrontPublic.js")).default;

  // Seed: org + loja publicada + produto + contato + link com token.
  const orgId = randomUUID(), productId = randomUUID(), contactId = randomUUID(), channelId = randomUUID();
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'TOULON', 'active')`).run(orgId);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, title) VALUES (?, 'toulon', 1, 'Loja TOULON')`).run(orgId);
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, active) VALUES (?, ?, 'Camisa Polo', 'product', 120, 1)`).run(productId, orgId);
  db.prepare(`INSERT INTO channels (id, organization_id, name, provider, identifier, status) VALUES (?, ?, 'C', 'evolution_go', 'x', 'active')`).run(channelId, orgId);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, 'Emerson', '5511999998888')`).run(contactId, orgId, channelId);
  const token = "tok_" + randomUUID().replace(/-/g, "");
  db.prepare(`INSERT INTO storefront_links (token, organization_id, contact_id) VALUES (?, ?, ?)`).run(token, orgId, contactId);

  const app = express();
  app.use(express.json());
  app.use("/api/public", storefrontPublic);
  const server = await new Promise<any>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as any).port;
  const post = async (body: any) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/public/store/toulon/order`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const orderNotes = (id: string) => (db.prepare(`SELECT notes FROM orders WHERE id = ?`).get(id) as any)?.notes || "";
  const orderContact = (id: string) => (db.prepare(`SELECT contact_id FROM orders WHERE id = ?`).get(id) as any)?.contact_id;

  try {
    // 1. Com token, SEM nome/e-mail/telefone -> cria o pedido e vincula o contato.
    const r1 = await post({ token, items: [{ productId, quantity: 1 }] });
    check("1.1 checkout com token responde ok", r1.status === 200 && !!r1.json.orderId);
    check("1.2 pedido vinculado ao contato do token", orderContact(r1.json.orderId) === contactId);
    check("1.3 não exigiu nome nem e-mail", r1.status === 200);

    // 2. E-mail NUNCA obrigatório — anônimo sem e-mail também fecha.
    const r2 = await post({ customer: { name: "Cliente Balcão" }, items: [{ productId, quantity: 2 }] });
    check("2.1 anônimo sem e-mail fecha o pedido", r2.status === 200 && !!r2.json.orderId);
    check("2.2 nota guarda o nome informado", orderNotes(r2.json.orderId).includes("Cliente Balcão"));

    // 3. CPF na nota — opcional, vai pras notas (só dígitos).
    const r3 = await post({ token, customer: { cpf: "123.456.789-09" }, items: [{ productId, quantity: 1 }] });
    check("3.1 pedido com CPF ok", r3.status === 200);
    check("3.2 CPF gravado só com dígitos na nota", orderNotes(r3.json.orderId).includes("CPF na nota: 12345678909"));

    // 4. Sem CPF -> nota não menciona CPF.
    const r4 = await post({ token, items: [{ productId, quantity: 1 }] });
    check("4.1 sem CPF a nota não cita CPF", !orderNotes(r4.json.orderId).includes("CPF"));

    // 5. Carrinho vazio -> 400.
    const r5 = await post({ token, items: [] });
    check("5.1 carrinho vazio recusado", r5.status === 400);
  } finally {
    server.close();
  }

  console.log("\n=== test:store-checkout-frictionless ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s).`); process.exit(1); }
  console.log("\n✅ Checkout sem atrito OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
