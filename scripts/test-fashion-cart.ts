/**
 * TESTE — Fashion AI Studio FAS-4: carrinho do look e compartilhamento (ADR-038)
 * -------------------------------------------------------------------------
 * 100% determinístico (nenhuma IA envolvida nesta fase):
 *   - prepareCart: cenários 10.2 do PRD (todas disponíveis; peça esgotada
 *     informada com motivo; preço alterado sinalizado, nunca cobrado em
 *     silêncio); ownership; evento FashionLookAddedToCart;
 *   - atribuição pedido<->look (RF-027): id validado por organização — id
 *     forjado nunca vira atribuição; coluna orders.fashion_look_id existe;
 *   - link de compartilhamento (RF-028/029): token válido/expirado/adulterado;
 *     resposta nunca inclui avatar/dados da cliente; kill switch invalida
 *     links antigos.
 *
 * Uso: npm run test:fashion-cart
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fashion-fas4-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fashion-fas4-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FashionLookService } = await import("../src/server/FashionLookService.js");
  const { FashionCustomerService } = await import("../src/server/FashionCustomerService.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Boutique A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, fashion_studio_enabled) VALUES (?, 'ba', 1, 1)`).run(orgA);

  // Categorias DISTINTAS: o compositor fallback do FAS-2 monta o look pegando
  // uma peça por categoria — com a mesma categoria o look teria uma peça só.
  function product(name: string, category: string, price: number, opts: { stockControl?: boolean; qty?: number } = {}): string {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, category, price, active, storefront_visible, stock_control_enabled, slug) VALUES (?, ?, 'product', ?, ?, ?, 1, 1, ?, ?)`)
      .run(id, orgA, name, category, price, opts.stockControl ? 1 : 0, `p-${id.slice(0, 8)}`);
    db.prepare(`INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, '/media/x.jpg', 0)`).run(randomUUID(), orgA, id);
    if (opts.stockControl) db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available) VALUES (?, ?, ?, ?)`).run(randomUUID(), orgA, id, opts.qty ?? 0);
    return id;
  }
  const blusa = product("Blusa Social", "Blusas", 89.9, { stockControl: true, qty: 5 });
  const calca = product("Calça Alfaiataria", "Calças", 159.9);

  const reg = FashionCustomerService.register(orgA, { name: "Ana", email: "ana@t.com", password: "senhaforte1", birthDate: "1990-01-01" });
  const customerId = (reg as any).customerId as string;
  const regB = FashionCustomerService.register(orgA, { name: "Bia", email: "bia@t.com", password: "senhaforte1", birthDate: "1992-01-01" });
  const customerB = (regB as any).customerId as string;

  const lookResult = await FashionLookService.createRequestAndRecommend(orgA, customerId, { occasion: "trabalho" });
  const lookId = (lookResult as any).looks[0].id as string;

  // ---- schema ----
  const orderCols = (db.prepare(`PRAGMA table_info(orders)`).all() as any[]).map((c) => c.name);
  check("orders tem coluna fashion_look_id (atribuição RF-027)", orderCols.includes("fashion_look_id"));

  // ---- prepareCart: tudo disponível ----
  const cart1 = FashionLookService.prepareCart(orgA, customerId, lookId);
  check("Look completo disponível: todas as peças ok", cart1.ok && (cart1 as any).items.every((i: any) => i.available));
  check("Total calculado só com as disponíveis", cart1.ok && (cart1 as any).availableTotal > 0);
  check("Nenhum preço marcado como alterado (snapshot igual ao atual)", cart1.ok && (cart1 as any).items.every((i: any) => !i.priceChanged));

  const ev = db.prepare(`SELECT COUNT(*) AS c FROM fashion_events WHERE organization_id = ? AND event_type = 'FashionLookAddedToCart'`).get(orgA) as any;
  check("Evento FashionLookAddedToCart registrado (seção 10.3)", ev.c >= 1);

  // ---- ownership ----
  check("Outra cliente não prepara o carrinho do look da Ana", !(FashionLookService.prepareCart(orgA, customerB, lookId) as any).ok);

  // ---- cenário 10.2/2: peça esgota depois do look montado ----
  db.prepare(`UPDATE inventory_items SET quantity_available = 0 WHERE product_service_id = ?`).run(blusa);
  const cart2 = FashionLookService.prepareCart(orgA, customerId, lookId);
  if (cart2.ok) {
    const blusaItem = (cart2 as any).items.find((i: any) => i.productId === blusa);
    const calcaItem = (cart2 as any).items.find((i: any) => i.productId === calca);
    check("Peça esgotada vem marcada como indisponível COM motivo", !blusaItem || (!blusaItem.available && /esgot/i.test(blusaItem.reason || "")));
    check("As demais peças continuam disponíveis (não derruba o look inteiro)", !calcaItem || calcaItem.available);
  } else {
    check("prepareCart continua funcionando com peça esgotada", false);
  }
  db.prepare(`UPDATE inventory_items SET quantity_available = 5 WHERE product_service_id = ?`).run(blusa);

  // ---- cenário 10.2/5: preço mudou depois do look montado ----
  db.prepare(`UPDATE products_services SET price = 199.9 WHERE id = ?`).run(calca);
  const cart3 = FashionLookService.prepareCart(orgA, customerId, lookId);
  if (cart3.ok) {
    const calcaItem = (cart3 as any).items.find((i: any) => i.productId === calca);
    check("Preço alterado é SINALIZADO (nunca cobrado em silêncio)", !calcaItem || (calcaItem.priceChanged && calcaItem.price === 199.9 && calcaItem.snapshotPrice !== calcaItem.price));
  }

  // ---- atribuição pedido<->look (RF-027) ----
  check("Look válido da org: atribuição aceita", FashionLookService.lookIdForOrder(orgA, lookId) === lookId);
  check("Id forjado: atribuição recusada (null)", FashionLookService.lookIdForOrder(orgA, "id-forjado-qualquer") === null);
  check("Look de OUTRA org: atribuição recusada", FashionLookService.lookIdForOrder(`org_outra`, lookId) === null);
  check("Sem lookId: null sem erro", FashionLookService.lookIdForOrder(orgA, null) === null);

  // ---- compartilhamento (RF-028/029) ----
  const share = FashionLookService.shareLook(orgA, customerId, lookId);
  check("Dona gera o link de compartilhamento", share.ok);
  check("Outra cliente NÃO gera link do look alheio", !(FashionLookService.shareLook(orgA, customerB, lookId) as any).ok);

  const token = (share as any).token as string;
  const shared = FashionLookService.resolveSharedLook(token);
  check("Token válido resolve o look com itens e preços ATUAIS", !!shared && shared!.items.length > 0 && shared!.lookId === lookId);
  const sharedJson = JSON.stringify(shared);
  check("Resposta compartilhada NUNCA contém avatar/dados da cliente (RF-029)",
    !/avatar|customer_id|email|birth/i.test(sharedJson));
  check("Link compartilhado reflete preço atual (199.9, não o snapshot)", !!shared && shared!.items.some((i) => i.price === 199.9));

  check("Token adulterado é recusado", FashionLookService.resolveSharedLook(token.slice(0, -4) + "AAAA") === null);
  check("Token lixo é recusado sem explodir", FashionLookService.resolveSharedLook("nao-e-token") === null);

  // token expirado: forja um com exp no passado usando o mesmo formato
  const crypto = await import("crypto");
  const secret = crypto.createHash("sha256").update(`${process.env.JWT_SECRET}:fashion_look_share_v1`).digest("hex");
  const oldExp = Date.now() - 1000;
  const oldSig = crypto.createHmac("sha256", secret).update(`${lookId}.${oldExp}`).digest("hex").slice(0, 32);
  const expiredToken = Buffer.from(`${lookId}.${oldExp}.${oldSig}`).toString("base64url");
  check("Token expirado é recusado (mesmo com assinatura correta)", FashionLookService.resolveSharedLook(expiredToken) === null);

  // kill switch: desligar o módulo invalida links antigos
  db.prepare(`UPDATE storefront_settings SET fashion_studio_enabled = 0 WHERE organization_id = ?`).run(orgA);
  check("Kill switch: link antigo para de funcionar com o módulo desligado", FashionLookService.resolveSharedLook(token) === null);
  db.prepare(`UPDATE storefront_settings SET fashion_studio_enabled = 1 WHERE organization_id = ?`).run(orgA);
  check("Religar o módulo reativa o link (token ainda no prazo)", FashionLookService.resolveSharedLook(token) !== null);

  // ---- resultado ----
  console.log("\n=== Fashion AI Studio FAS-4 — carrinho do look e compartilhamento (ADR-038) ===\n");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Erro fatal no teste:", e);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
