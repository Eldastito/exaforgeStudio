/**
 * TESTE — Fashion AI Studio FAS-2: consultora por ocasião e Look Builder (ADR-036)
 * -------------------------------------------------------------------------
 * Sem chave de IA (mesma limitação de sempre), o caminho coberto é 100%
 * determinístico — que aqui é a parte que MAIS importa:
 *   - validação anti-injection da saída da IA (validateAILooks): IDs fora do
 *     catálogo elegível são descartados, >3 looks cortados, orçamento e
 *     cores/peças evitadas aplicados como rede de segurança;
 *   - compositor fallback (sem IA): looks só com itens elegíveis/permitidos;
 *   - questionário vira preferências explícitas editáveis (listar/apagar);
 *   - fluxo completo createRequestAndRecommend via fallback: request/looks/
 *     itens persistidos com snapshot de preço;
 *   - salvar look (RF-018) com ownership/isolamento entre clientes e orgs.
 *
 * Uso: npm run test:fashion-looks
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fashion-fas2-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fashion-fas2-1234567890";
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
  const vestidoVermelho = product(orgA, "Vestido Vermelho Longo", "Vestidos", 199.9);
  const blazer = product(orgA, "Blazer Cinza", "Blazers", 249.9);
  const caro = product(orgA, "Vestido de Gala Bordado", "Vestidos", 2500);
  // Produto INELEGÍVEL (estoque zerado com controle) — nunca pode aparecer em look.
  const esgotado = (() => {
    const id = product(orgA, "Calça Alfaiataria Esgotada", "Calças", 159.9);
    db.prepare(`UPDATE products_services SET stock_control_enabled = 1 WHERE id = ?`).run(id);
    db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available) VALUES (?, ?, ?, 0)`).run(randomUUID(), orgA, id);
    return id;
  })();
  const produtoOrgB = product(orgB, "Camisa da Outra Loja", "Camisas", 79.9);

  const reg = FashionCustomerService.register(orgA, { name: "Ana", email: "ana@t.com", password: "senhaforte1", birthDate: "1990-01-01" });
  const customerId = (reg as any).customerId as string;
  const regB = FashionCustomerService.register(orgB, { name: "Bia", email: "bia@t.com", password: "senhaforte1", birthDate: "1992-01-01" });
  const customerB = (regB as any).customerId as string;

  const eligible = [
    { id: blusa, name: "Blusa Social Branca", category: "Blusas", price: 89.9, image: "/media/x.jpg" },
    { id: saia, name: "Saia Midi Preta", category: "Saias", price: 129.9, image: "/media/x.jpg" },
    { id: vestidoVermelho, name: "Vestido Vermelho Longo", category: "Vestidos", price: 199.9, image: "/media/x.jpg" },
  ];

  // ---- itemAllowed: cores/peças evitadas por texto normalizado ----
  check("Cor evitada bloqueia o item ('vermelho' pega 'Vestido Vermelho Longo')", !FashionLookService.itemAllowed("Vestido Vermelho Longo", { occasion: "x", colorsAvoid: ["vermelho"] }));
  check("Acento não engana o filtro ('VERMELHO' vs 'vermelho')", !FashionLookService.itemAllowed("Vestido VERMELHO", { occasion: "x", colorsAvoid: ["Vermelho"] }));
  check("Peça evitada bloqueia ('saia')", !FashionLookService.itemAllowed("Saia Midi Preta", { occasion: "x", piecesAvoid: ["saia"] }));
  check("Item sem palavra evitada passa", FashionLookService.itemAllowed("Blusa Social Branca", { occasion: "x", colorsAvoid: ["vermelho"], piecesAvoid: ["saia"] }));

  // ---- validateAILooks: payload adversarial (anti-injection, 19.3) ----
  const adversarial = {
    looks: [
      { items: [{ id: blusa, role: "main" }, { id: "id-injetado-fora-do-catalogo", role: "bottom" }, { id: saia, role: "bottom" }], explanation: "ok" },
      { items: [{ id: vestidoVermelho, role: "main" }], explanation: "tem cor evitada" },
      { items: [{ id: blusa, role: "papel-invalido" as any }, { id: blusa, role: "main" }], explanation: "duplicado e papel inválido" },
      { items: [{ id: saia, role: "main" }], explanation: "look 4 (deve ser cortado)" },
      { items: [{ id: blusa, role: "main" }], explanation: "look 5 (deve ser cortado)" },
    ],
  };
  const validated = FashionLookService.validateAILooks(adversarial, eligible, { occasion: "jantar", colorsAvoid: ["vermelho"] });
  check("Máximo de 3 looks (RF-017) — 5 viram no máximo 3", validated.length <= 3);
  const allIds = validated.flatMap((l) => l.items.map((i) => i.productId));
  check("ID injetado (fora do catálogo elegível) foi descartado", !allIds.includes("id-injetado-fora-do-catalogo"));
  check("Item com cor evitada foi descartado do look da IA", !allIds.includes(vestidoVermelho));
  const dupLook = validated.find((l) => l.items.filter((i) => i.productId === blusa).length > 1);
  check("Item duplicado no mesmo look é removido", !dupLook);
  const badRole = validated.flatMap((l) => l.items).find((i) => !["main", "bottom", "outerwear", "shoes", "accessory"].includes(i.role));
  check("Papel inválido vira 'main' (nunca persiste papel desconhecido)", !badRole);

  const overBudget = FashionLookService.validateAILooks(
    { looks: [{ items: [{ id: blusa, role: "main" }, { id: saia, role: "bottom" }], explanation: "estoura" }] },
    eligible, { occasion: "x", budgetMax: 100 }
  );
  check("Look que estoura o orçamento declarado é descartado", overBudget.length === 0);

  // ---- fallbackCompose (sem IA) ----
  const fallback = FashionLookService.fallbackCompose(eligible, { occasion: "entrevista", colorsAvoid: ["vermelho"], budgetMax: 300 });
  check("Fallback compõe ao menos 1 look sem IA", fallback.length >= 1 && fallback.length <= 3);
  const fbIds = fallback.flatMap((l) => l.items.map((i) => i.productId));
  check("Fallback nunca inclui item com cor evitada", !fbIds.includes(vestidoVermelho));
  const fbTotals = fallback.map((l) => l.items.reduce((s, i) => s + (eligible.find((e) => e.id === i.productId)?.price || 0), 0));
  check("Fallback respeita o orçamento do look", fbTotals.every((t) => t <= 300));
  check("Explicação do fallback cita a ocasião declarada", fallback[0].explanation.includes("entrevista"));

  // ---- fluxo completo (via fallback, sem IA) ----
  const noOccasion = await FashionLookService.createRequestAndRecommend(orgA, customerId, { occasion: "" });
  check("Sem ocasião: pedido recusado com mensagem amigável", !noOccasion.ok);

  const result = await FashionLookService.createRequestAndRecommend(orgA, customerId, {
    occasion: "casamento à noite", dayNight: "noite", style: "elegante", colorsAvoid: ["vermelho"], piecesAvoid: [], budgetMax: 500,
  });
  check("Pedido completo funciona sem IA (fallback)", result.ok);
  if (result.ok) {
    check("Até 3 looks retornados", result.looks.length >= 1 && result.looks.length <= 3);
    const ids = result.looks.flatMap((l) => l.items.map((i) => i.productId));
    check("Nenhum look inclui o produto esgotado (catálogo elegível do FAS-0)", !ids.includes(esgotado));
    check("Nenhum look inclui produto de outra organização", !ids.includes(produtoOrgB));
    check("Nenhum look inclui a cor evitada", !ids.includes(vestidoVermelho));
    check("Nenhum look inclui o item acima do orçamento (R$ 2500 > 500)", !ids.includes(caro));

    const requestRow = db.prepare(`SELECT * FROM fashion_look_requests WHERE id = ?`).get(result.requestId) as any;
    check("Request persistido como completed com as respostas", requestRow?.status === "completed" && JSON.parse(requestRow.answers_json).style === "elegante");
    const itemRows = db.prepare(`SELECT * FROM fashion_look_items WHERE look_id = ?`).all(result.looks[0].id) as any[];
    check("Itens persistidos com snapshot de preço (checkout revalida depois)", itemRows.length > 0 && itemRows.every((r) => r.price_snapshot > 0));

    // ---- salvar look: ownership e isolamento ----
    check("Outro cliente NÃO salva o look da Ana", FashionLookService.saveLook(orgA, customerB, result.looks[0].id) === false);
    check("Outra organização NÃO salva o look", FashionLookService.saveLook(orgB, customerB, result.looks[0].id) === false);
    check("Dona salva o look (RF-018)", FashionLookService.saveLook(orgA, customerId, result.looks[0].id) === true);
    const savedRow = db.prepare(`SELECT status FROM fashion_looks WHERE id = ?`).get(result.looks[0].id) as any;
    check("Look salvo marcado como 'selected'", savedRow?.status === "selected");

    // ---- reabrir o pedido ----
    const reopened = FashionLookService.getRequestLooks(orgA, customerId, result.requestId);
    check("Reabrir o pedido devolve os looks com itens", reopened && reopened.looks.length === result.looks.length && reopened.looks[0].items.length > 0);
    check("Outro cliente não reabre o pedido da Ana", FashionLookService.getRequestLooks(orgA, customerB, result.requestId) === null);
  }

  // ---- preferências explícitas editáveis (7.4/11.4) ----
  const prefs = FashionLookService.listPreferences(orgA, customerId);
  check("Questionário virou preferências explícitas", prefs.some((p) => p.type === "occasion") && prefs.some((p) => p.type === "style_like") && prefs.some((p) => p.type === "color_avoid"));
  check("Orçamento salvo como budget_range", prefs.some((p) => p.type === "budget_range" && p.value?.max === 500));

  // novo questionário SUBSTITUI as preferências do mesmo tipo (não acumula lixo)
  await FashionLookService.createRequestAndRecommend(orgA, customerId, { occasion: "trabalho", style: "discreto" });
  const prefs2 = FashionLookService.listPreferences(orgA, customerId);
  const occasions = prefs2.filter((p) => p.type === "occasion");
  check("Novo questionário substitui a preferência anterior do mesmo tipo", occasions.length === 1 && occasions[0].value === "trabalho");

  const toDelete = prefs2.find((p) => p.type === "style_like");
  check("Cliente apaga uma preferência (11.4)", !!toDelete && FashionLookService.deletePreference(orgA, customerId, toDelete!.id) === true);
  check("Preferência apagada some da lista", !FashionLookService.listPreferences(orgA, customerId).some((p) => p.id === toDelete!.id));
  check("Outro cliente não apaga preferência alheia", FashionLookService.deletePreference(orgA, customerB, prefs2[0]?.id || "x") === false);

  // consentimento de personalização registrado ao responder o questionário
  const consent = db.prepare(`SELECT * FROM fashion_consents WHERE organization_id = ? AND customer_id = ? AND consent_type = 'personalization' AND revoked_at IS NULL`).get(orgA, customerId) as any;
  check("Responder o questionário registra consentimento de personalização", !!consent);

  // ---- resultado ----
  console.log("\n=== Fashion AI Studio FAS-2 — consultora por ocasião e Look Builder (ADR-036) ===\n");
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
