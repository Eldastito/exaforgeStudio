/**
 * TEST — Comigo/Mesa-QR pay-first (ADR-119 / ADR-088 D4).
 *
 * Uso: npm run test:comigo-mesa
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-mesa-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-mesa-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoMesaService: M } = await import("../src/server/ComigoMesaService.js");
  const { ComigoPixService: Pix } = await import("../src/server/ComigoPixService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);
  const galeto = randomUUID(), refri = randomUUID(), inativo = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Galeto', 45, 1)`).run(galeto, orgId);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Refri', 5, 1)`).run(refri, orgId);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Fora de linha', 9, 0)`).run(inativo, orgId);

  // ===== 1. Token resolve a org =====
  const token = M.ensureToken(orgId);
  check("ensureToken gera token", !!token && token.startsWith("mesa_"));
  check("ensureToken é idempotente", M.ensureToken(orgId) === token);
  check("orgByToken resolve a org", M.orgByToken(token) === orgId);
  check("token inválido não resolve", M.orgByToken("mesa_xxx") === null);

  // ===== 2. Cardápio só com ativos e preço do servidor =====
  const menu = M.menu(orgId);
  check("cardápio traz os ativos", menu.length === 2);
  check("cardápio NÃO traz produto inativo", !menu.some((m) => m.id === inativo));

  // ===== 3. placeOrder: preço do SERVIDOR, cria pedido mesa + cobrança =====
  const placed = M.placeOrder(orgId, { items: [{ productId: galeto, qty: 1 }, { productId: refri, qty: 2 }], sessionAlias: "Mesa 3", consumo: "local" }) as any;
  check("pedido criado", placed.ok === true && !!placed.orderId);
  check("total usa preço do servidor (45 + 2×5 = 55)", near(placed.total, 55));
  check("gerou cobrança Pix (txid)", !!placed.txid && !!placed.qrPayload);
  check("pedido é source='mesa'", (db.prepare("SELECT source FROM comigo_orders WHERE id=?").get(placed.orderId) as any).source === "mesa");

  // ===== 3b. Cliente não consegue forjar preço (só manda productId+qty) =====
  const placed2 = M.placeOrder(orgId, { items: [{ productId: galeto, qty: 1 } as any] }) as any;
  check("2º pedido também precifica pelo servidor (45)", near(placed2.total, 45));

  // ===== 3c. Item inválido/inativo é ignorado; carrinho vazio falha =====
  const onlyInvalid = M.placeOrder(orgId, { items: [{ productId: inativo, qty: 1 }, { productId: "nao_existe", qty: 1 }] }) as any;
  check("pedido só com itens inválidos falha", onlyInvalid.ok === false);
  check("carrinho vazio falha", (M.placeOrder(orgId, { items: [] }) as any).ok === false);

  // ===== 4. PAY-FIRST: não entra na fila de preparo até pagar =====
  check("antes de pagar: fora da fila de preparo", M.prepQueue(orgId).length === 0);
  check("status do cliente: não pago", M.orderStatus(orgId, placed.orderId).paid === false);

  // ===== 5. Confirmado o Pix → entra na fila =====
  Pix.confirmByTxid(orgId, placed.txid);
  const queue = M.prepQueue(orgId);
  check("após pagar: aparece na fila de preparo", queue.length === 1 && queue[0].id === placed.orderId);
  check("fila traz os itens do pedido", (queue[0].items || []).length === 2);
  check("status do cliente: pago", M.orderStatus(orgId, placed.orderId).paid === true);

  // ===== 6. markFulfilled tira da fila =====
  check("markFulfilled ok", M.markFulfilled(orgId, placed.orderId) === true);
  check("após entregar: sai da fila", M.prepQueue(orgId).length === 0);
  check("marcar entregue de novo não faz nada", M.markFulfilled(orgId, placed.orderId) === false);

  // ===== 7. Imagem no cardápio (ADR-124) =====
  db.prepare(`INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, 'https://img/galeto.jpg', 0)`).run(randomUUID(), orgId, galeto);
  const menuImg = M.menu(orgId).find((m) => m.id === galeto);
  check("cardápio traz a imagem do produto", menuImg?.image === "https://img/galeto.jpg");
  check("produto sem imagem retorna image null", (M.menu(orgId).find((m) => m.id === refri) as any)?.image === null);

  // ===== 7b. Marca do dono (ADR-124): fallback na org, override na loja =====
  db.prepare("UPDATE organization_settings SET business_name = 'Galeto do Zé', logo_url = 'https://img/logo.png' WHERE organization_id = ?").run(orgId);
  const b1 = M.brand(orgId);
  check("brand: nome vem da organização", b1.name === "Galeto do Zé" && b1.logo === "https://img/logo.png");
  db.prepare("INSERT INTO storefront_settings (organization_id, title, subtitle, logo_url, banner_url, accent_color) VALUES (?, 'Galeto Premium', 'o melhor da praça', 'https://img/sf.png', 'https://img/banner.jpg', '#ec4899')").run(orgId);
  const b2 = M.brand(orgId);
  check("brand: loja sobrepõe (título/subtítulo/banner/cor)", b2.name === "Galeto Premium" && b2.subtitle === "o melhor da praça" && b2.banner === "https://img/banner.jpg" && b2.accent === "#ec4899");

  // ===== 8. Fiado autorizado (ADR-124): só cadastrado + liberado + no limite =====
  const { BalcaoService: B } = await import("../src/server/BalcaoService.js");
  const cid = B.ensureFiadoContact(orgId, "Cliente Fiel", "5511977776666");
  // Ainda não liberado na loja → não elegível.
  check("não liberado: fiado indisponível", M.fiadoEligibility(orgId, "5511977776666", 50).authorized === false);
  // Dono libera + define limite.
  B.setCreditLimit(orgId, cid, 100);
  B.setStoreFiado(orgId, cid, true);
  const elig = M.fiadoEligibility(orgId, "5511977776666", 50) as any;
  check("liberado + no limite: elegível", elig.authorized === true && elig.fits === true && elig.available === 100);
  check("acima do limite: não cabe", M.fiadoEligibility(orgId, "5511977776666", 150).fits === false);
  // Lista negra tira a elegibilidade.
  B.setBlacklist(orgId, cid, true, "teste");
  check("lista negra: fiado indisponível", M.fiadoEligibility(orgId, "5511977776666", 50).authorized === false);
  B.setBlacklist(orgId, cid, false);

  // placeOrder no fiado: grava dívida e entra na fila de preparo.
  const fiadoOrder = M.placeOrder(orgId, { items: [{ productId: galeto, qty: 1 }], payment: "fiado", customer: { phone: "5511977776666" } }) as any;
  check("pedido no fiado criado", fiadoOrder.ok === true && fiadoOrder.fiado === true);
  check("fiado registrou dívida (saldo 45)", (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE contact_id=? AND kind='debt'").get(cid) as any).s === 45);
  check("pedido fiado entra na fila de preparo", M.prepQueue(orgId).some((o: any) => o.id === fiadoOrder.orderId));
  // Cliente não cadastrado não fecha no fiado.
  check("telefone desconhecido: fiado negado", (M.placeOrder(orgId, { items: [{ productId: galeto, qty: 1 }], payment: "fiado", customer: { phone: "5511900000000" } }) as any).error === "fiado_not_authorized");
  // Estourar o limite é negado.
  check("fiado acima do limite negado", (M.placeOrder(orgId, { items: [{ productId: galeto, qty: 3 }, { productId: galeto, qty: 3 }], payment: "fiado", customer: { phone: "5511977776666" } }) as any).error !== undefined);

  // ===== 9. Isolamento =====
  const other = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), other);
  check("isolamento: outra org não vê o pedido", M.orderStatus(other, placed.orderId).found === false);
  check("isolamento: fiado não vaza p/ outra org", M.fiadoEligibility(other, "5511977776666", 50).authorized === false);

  // --- Relatório ---
  console.log("\n=== TEST: Comigo — Mesa/QR pay-first (ADR-119) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Mesa/QR pay-first OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
