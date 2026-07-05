/**
 * TESTE — Fashion AI Studio: classificação VESTÍVEL (ADR-041)
 * -------------------------------------------------------------------------
 * O provador só pode conter roupa/calçado/acessório de moda — a loja pode
 * vender qualquer outra coisa (caneca, eletrônico, decoração...). Cobertura
 * determinística (sem IA):
 *   - heurística por palavras (nome + categoria, normalizados, por prefixo);
 *   - eligibleItems grava a heurística e EXCLUI não-vestível e não-classificado
 *     (conservador: nunca arriscar vestir uma caneca);
 *   - ensureWearableClassified persiste a heurística e deixa o ambíguo
 *     pendente quando não há IA;
 *   - override manual do lojista vence (inclui e exclui) e nunca é sobrescrito;
 *   - createCustomLook e fallbackCompose nunca aceitam item não-vestível.
 *
 * Uso: npm run test:fashion-wearable
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fashion-wear-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fashion-wearable-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FashionStudioService } = await import("../src/server/FashionStudioService.js");
  const { FashionLookService } = await import("../src/server/FashionLookService.js");
  const { FashionCustomerService } = await import("../src/server/FashionCustomerService.js");

  const org = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja Mista', 'active')`).run(randomUUID(), org);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, fashion_studio_enabled) VALUES (?, 'mista', 1, 1)`).run(org);

  function product(name: string, category: string | null, price = 99.9): string {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, category, price, active, storefront_visible, slug) VALUES (?, ?, 'product', ?, ?, ?, 1, 1, ?)`)
      .run(id, org, name, category, price, `p-${id.slice(0, 8)}`);
    db.prepare(`INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, '/media/x.jpg', 0)`).run(randomUUID(), org, id);
    return id;
  }

  // ---- heurística pura ----
  const h = (n: string, c: string | null = null) => FashionStudioService.classifyWearableHeuristic(n, c);
  check("'Vestido Midi Floral' é vestível", h("Vestido Midi Floral") === 1);
  check("'Calças de alfaiataria' (plural via prefixo) é vestível", h("Calças de alfaiataria") === 1);
  check("'TÊNIS Runner' (acento/caixa) é vestível", h("TÊNIS Runner") === 1);
  check("'Caneca do Papai' NÃO é vestível", h("Caneca do Papai") === 0);
  check("'Fone Bluetooth' NÃO é vestível", h("Fone Bluetooth") === 0);
  check("'Kit Surpresa' é indecidível (vai para a IA)", h("Kit Surpresa") === null);
  check("Categoria decide quando o nome não diz ('Conjunto Azul' em 'Vestidos')", h("Conjunto Azul", "Vestidos") === 1);
  check("Conflito entre listas não decide ('Caneca estampa de vestido')", h("Caneca estampa de vestido") === null);

  // ---- eligibleItems: grava heurística e filtra ----
  const vestido = product("Vestido Longo Preto", "Vestidos", 199.9);
  const bolsa = product("Bolsa de Couro", "Acessórios", 149.9);
  const caneca = product("Caneca Personalizada", "Presentes", 39.9);
  const fone = product("Fone de Ouvido", "Eletrônicos", 89.9);
  const kit = product("Kit Presente Especial", null, 59.9); // ambíguo: sem IA fica pendente

  const eligible = FashionStudioService.eligibleItems(org);
  const ids = new Set(eligible.map((e) => e.id));
  check("Vestido entra no provador", ids.has(vestido));
  check("Bolsa (acessório) entra no provador", ids.has(bolsa));
  check("Caneca NUNCA entra no provador", !ids.has(caneca));
  check("Eletrônico NUNCA entra no provador", !ids.has(fone));
  check("Ambíguo sem classificação fica FORA (conservador)", !ids.has(kit));

  const rowCaneca = db.prepare(`SELECT fashion_wearable, fashion_wearable_source FROM products_services WHERE id = ?`).get(caneca) as any;
  check("Heurística gravada (caneca = 0, source heuristic)", rowCaneca?.fashion_wearable === 0 && rowCaneca?.fashion_wearable_source === "heuristic");
  const rowKit = db.prepare(`SELECT fashion_wearable FROM products_services WHERE id = ?`).get(kit) as any;
  check("Ambíguo segue pendente (NULL) aguardando IA/lojista", rowKit?.fashion_wearable === null);

  // ---- ensureWearableClassified sem IA: idempotente, não inventa ----
  await FashionStudioService.ensureWearableClassified(org);
  const rowKit2 = db.prepare(`SELECT fashion_wearable FROM products_services WHERE id = ?`).get(kit) as any;
  check("Sem IA, ensure não força classificação do ambíguo", rowKit2?.fashion_wearable === null);

  // ---- override manual do lojista vence nos dois sentidos ----
  db.prepare(`UPDATE products_services SET fashion_wearable = 1, fashion_wearable_source = 'manual' WHERE id = ?`).run(kit);
  check("Lojista marca o kit como vestível: entra no provador", FashionStudioService.eligibleItems(org).some((e) => e.id === kit));
  db.prepare(`UPDATE products_services SET fashion_wearable = 0, fashion_wearable_source = 'manual' WHERE id = ?`).run(vestido);
  check("Lojista exclui o vestido do provador: sai mesmo sendo roupa", !FashionStudioService.eligibleItems(org).some((e) => e.id === vestido));
  await FashionStudioService.ensureWearableClassified(org);
  const rowVestido = db.prepare(`SELECT fashion_wearable, fashion_wearable_source FROM products_services WHERE id = ?`).get(vestido) as any;
  check("ensure nunca sobrescreve decisão manual", rowVestido?.fashion_wearable === 0 && rowVestido?.fashion_wearable_source === "manual");
  db.prepare(`UPDATE products_services SET fashion_wearable = 1, fashion_wearable_source = 'heuristic' WHERE id = ?`).run(vestido); // restaura

  // ---- look manual e fallback nunca aceitam não-vestível ----
  const reg = FashionCustomerService.register(org, { name: "Ana", email: "ana@w.com", password: "senhaforte1", birthDate: "1990-01-01" });
  const customerId = (reg as any).customerId as string;
  const custom = FashionLookService.createCustomLook(org, customerId, [vestido, caneca, fone, bolsa]);
  check("Look manual mantém só os vestíveis (caneca/fone descartados)", custom.ok && (custom as any).look.items.length === 2);
  if (custom.ok) {
    const lookIds = custom.look.items.map((i) => i.productId);
    check("Caneca não aparece no look manual", !lookIds.includes(caneca));
  }

  const composed = FashionLookService.fallbackCompose(
    FashionStudioService.eligibleItems(org).map((e) => ({ id: e.id, name: e.name, category: e.category, price: e.price, image: e.image })),
    { occasion: "passeio" }
  );
  const composedIds = composed.flatMap((l) => l.items.map((i) => i.productId));
  check("Compositor (fallback da consultora) nunca inclui não-vestível", !composedIds.includes(caneca) && !composedIds.includes(fone));

  // ---- resultado ----
  console.log("\n=== Fashion AI Studio — classificação VESTÍVEL (ADR-041) ===\n");
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
