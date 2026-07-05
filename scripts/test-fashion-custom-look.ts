/**
 * TESTE — Fashion AI Studio: Look Builder MANUAL (ADR-040)
 * -------------------------------------------------------------------------
 * A cliente escolhe as peças na vitrine e pede "ver as peças selecionadas em
 * mim". createCustomLook monta um look customer_selected com a MESMA rede de
 * segurança da recomendação por IA. Cobertura 100% determinística (sem IA):
 *   - só IDs do catálogo ELEGÍVEL (FAS-0) entram; injeção/ID de outra org é
 *     descartada; sem duplicata; no máximo 5 peças;
 *   - seleção vazia / só de itens inválidos é recusada com mensagem amigável;
 *   - o look nasce customer_selected e é encontrado pelo pipeline de try-on
 *     apenas para a DONA (ownership/isolamento entre clientes e orgs).
 *
 * Uso: npm run test:fashion-custom-look
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fashion-custom-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fashion-custom-1234567890";
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
  const { FashionTryOnService } = await import("../src/server/FashionTryOnService.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  const orgB = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Boutique A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Boutique B', 'active')`).run(randomUUID(), orgB);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, fashion_studio_enabled) VALUES (?, 'ba', 1, 1)`).run(orgA);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, fashion_studio_enabled) VALUES (?, 'bb', 1, 1)`).run(orgB);

  function product(orgId: string, name: string, category: string, price: number): string {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, category, price, active, storefront_visible, slug) VALUES (?, ?, 'product', ?, ?, ?, 1, 1, ?)`)
      .run(id, orgId, name, category, price, `p-${id.slice(0, 8)}`);
    db.prepare(`INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, '/media/x.jpg', 0)`).run(randomUUID(), orgId, id);
    return id;
  }

  const blusa = product(orgA, "Blusa Social Branca", "Blusas", 89.9);
  const saia = product(orgA, "Saia Midi Preta", "Saias", 129.9);
  const blazer = product(orgA, "Blazer Cinza", "Blazers", 249.9);
  const p4 = product(orgA, "Sapato Scarpin", "Calçados", 199.9);
  const p5 = product(orgA, "Bolsa Estruturada", "Bolsas", 159.9);
  const p6 = product(orgA, "Cinto de Couro", "Acessórios", 59.9);
  // INELEGÍVEL: estoque zerado com controle — nunca pode entrar no look.
  const esgotado = (() => {
    const id = product(orgA, "Calça Esgotada", "Calças", 159.9);
    db.prepare(`UPDATE products_services SET stock_control_enabled = 1 WHERE id = ?`).run(id);
    db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available) VALUES (?, ?, ?, 0)`).run(randomUUID(), orgA, id);
    return id;
  })();
  const produtoOrgB = product(orgB, "Camisa da Outra Loja", "Camisas", 79.9);

  const reg = FashionCustomerService.register(orgA, { name: "Ana", email: "ana@t.com", password: "senhaforte1", birthDate: "1990-01-01" });
  const customerId = (reg as any).customerId as string;
  const regB = FashionCustomerService.register(orgB, { name: "Bia", email: "bia@t.com", password: "senhaforte1", birthDate: "1992-01-01" });
  const customerB = (regB as any).customerId as string;

  // ---- seleção válida com várias peças ----
  const ok = FashionLookService.createCustomLook(orgA, customerId, [blusa, saia, blazer]);
  check("Compõe look com as peças selecionadas", ok.ok);
  if (ok.ok) {
    check("Look nasce como customer_selected", ok.look.source === "customer_selected");
    check("Todas as peças selecionadas entraram", ok.look.items.length === 3);
    check("Total soma o preço das peças", Math.abs(ok.look.total - (89.9 + 129.9 + 249.9)) < 0.01);
    const row = db.prepare(`SELECT source, status FROM fashion_looks WHERE id = ?`).get(ok.look.id) as any;
    check("Persistido com source customer_selected", row?.source === "customer_selected");
    const reqRow = db.prepare(`SELECT customer_id, occasion FROM fashion_look_requests WHERE id = ?`).get(ok.requestId) as any;
    check("Request pertence à cliente (isolamento por dona)", reqRow?.customer_id === customerId && reqRow?.occasion === "Seleção manual");
    const itemRows = db.prepare(`SELECT price_snapshot FROM fashion_look_items WHERE look_id = ?`).all(ok.look.id) as any[];
    check("Itens gravados com snapshot de preço", itemRows.length === 3 && itemRows.every((r) => r.price_snapshot > 0));

    // ---- o look manual entra no pipeline de try-on só para a DONA ----
    const genOwner = FashionTryOnService.requestGeneration(orgA, customerId, ok.look.id);
    // Sem avatar aprovado, o erro esperado é sobre a foto — prova que o look FOI encontrado.
    check("Try-on encontra o look manual da dona (pede a foto, não 'look não encontrado')",
      !genOwner.ok && /foto/i.test((genOwner as any).error));
    const genOther = FashionTryOnService.requestGeneration(orgA, customerB, ok.look.id);
    check("Try-on de outro cliente NÃO acha o look manual da Ana", !genOther.ok && /não encontrado/i.test((genOther as any).error));
  }

  // ---- rede de segurança: IDs inválidos descartados ----
  const mixed = FashionLookService.createCustomLook(orgA, customerId, [blusa, "id-injetado", esgotado, produtoOrgB, saia]);
  check("Seleção mista mantém só os elegíveis", mixed.ok && (mixed as any).look.items.length === 2);
  if (mixed.ok) {
    const ids = mixed.look.items.map((i) => i.productId);
    check("ID injetado (fora do catálogo) descartado", !ids.includes("id-injetado"));
    check("Produto esgotado (inelegível) descartado", !ids.includes(esgotado));
    check("Produto de outra organização descartado", !ids.includes(produtoOrgB));
  }

  // ---- dedupe ----
  const dup = FashionLookService.createCustomLook(orgA, customerId, [blusa, blusa, blusa]);
  check("Peça repetida entra uma única vez", dup.ok && (dup as any).look.items.length === 1);

  // ---- cap de 5 peças ----
  const many = FashionLookService.createCustomLook(orgA, customerId, [blusa, saia, blazer, p4, p5, p6]);
  check("No máximo 5 peças por look", many.ok && (many as any).look.items.length === 5);

  // ---- seleção vazia / só inválidos ----
  const empty = FashionLookService.createCustomLook(orgA, customerId, []);
  check("Seleção vazia é recusada com mensagem amigável", !empty.ok && /selecione/i.test((empty as any).error));
  const allBad = FashionLookService.createCustomLook(orgA, customerId, ["x", produtoOrgB]);
  check("Seleção só com inválidos é recusada", !allBad.ok);

  // ---- resultado ----
  console.log("\n=== Fashion AI Studio — Look Builder MANUAL (ADR-040) ===\n");
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
