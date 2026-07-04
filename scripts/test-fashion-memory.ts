/**
 * TESTE — Fashion AI Studio FAS-5: memória de estilo (ADR-039, fecha o PRD-E-006)
 * -------------------------------------------------------------------------
 * 100% determinístico:
 *   - feedback explícito de look (gostei/não gostei/não usaria) com as
 *     categorias das peças; um feedback por look (o novo substitui);
 *   - styleMemorySummary: curtidas/recusadas do feedback + COMPRADAS via a
 *     atribuição pedido<->look do FAS-4 (encadeada até a cliente);
 *   - toggle de personalização (11.4): desligar PARA de salvar/usar sem
 *     apagar nada; feedback recusado com aviso; religar volta a usar;
 *   - fallback de recomendação exclui categoria "não usaria" — a menos que a
 *     exclusão zere as opções;
 *   - ownership em tudo.
 *
 * Uso: npm run test:fashion-memory
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fashion-fas5-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fashion-fas5-1234567890";
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

  function product(name: string, category: string, price: number): string {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, category, price, active, storefront_visible, slug) VALUES (?, ?, 'product', ?, ?, ?, 1, 1, ?)`)
      .run(id, orgA, name, category, price, `p-${id.slice(0, 8)}`);
    db.prepare(`INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, '/media/x.jpg', 0)`).run(randomUUID(), orgA, id);
    return id;
  }
  product("Blusa Social", "Blusas", 89.9);
  const saiaId = product("Saia Midi", "Saias", 129.9);
  product("Blazer Slim", "Blazers", 249.9);

  const reg = FashionCustomerService.register(orgA, { name: "Ana", email: "ana@t.com", password: "senhaforte1", birthDate: "1990-01-01" });
  const customerId = (reg as any).customerId as string;
  const regB = FashionCustomerService.register(orgA, { name: "Bia", email: "bia@t.com", password: "senhaforte1", birthDate: "1992-01-01" });
  const customerB = (regB as any).customerId as string;

  const lookResult = await FashionLookService.createRequestAndRecommend(orgA, customerId, { occasion: "trabalho" });
  const looks = (lookResult as any).looks as any[];
  const lookId = looks[0].id as string;

  // ---- feedback explícito ----
  check("Feedback inválido é recusado", !(FashionLookService.recordLookFeedback(orgA, customerId, lookId, "amei-demais") as any).ok);
  check("Outra cliente não dá feedback no look da Ana", !(FashionLookService.recordLookFeedback(orgA, customerB, lookId, "liked") as any).ok);
  check("Feedback 'gostei' registrado", (FashionLookService.recordLookFeedback(orgA, customerId, lookId, "liked") as any).ok);

  const summary1 = FashionLookService.styleMemorySummary(orgA, customerId);
  check("Categorias do look curtido entram na memória", summary1.likedCategories.length > 0);

  // um feedback por look: mudar de ideia substitui
  check("Mudar de ideia: 'não usaria' substitui o 'gostei'", (FashionLookService.recordLookFeedback(orgA, customerId, lookId, "would_not_wear") as any).ok);
  const summary2 = FashionLookService.styleMemorySummary(orgA, customerId);
  check("Memória reflete o feedback mais recente (curtidas saem, recusadas entram)",
    summary2.rejectedCategories.length > 0 && summary2.likedCategories.length === 0);
  const feedbackRows = db.prepare(`SELECT COUNT(*) AS c FROM fashion_preferences WHERE organization_id = ? AND preference_type = 'look_feedback' AND active = 1`).get(orgA) as any;
  check("Só UM feedback ativo por look (o antigo desativa)", feedbackRows.c === 1);

  // ---- compras entram na memória via atribuição do FAS-4 ----
  const orderId = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_by, fashion_look_id) VALUES (?, ?, 'pago', 129.9, 'storefront', ?)`).run(orderId, orgA, lookId);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, product_service_id, name_snapshot, unit_price, quantity, line_total) VALUES (?, ?, ?, ?, 'Saia Midi', 129.9, 1, 129.9)`)
    .run(randomUUID(), orderId, orgA, saiaId);
  const summary3 = FashionLookService.styleMemorySummary(orgA, customerId);
  check("Categoria COMPRADA entra na memória (cadeia pedido->look->cliente)", summary3.purchasedCategories.includes("Saias"));
  const summaryB = FashionLookService.styleMemorySummary(orgA, customerB);
  check("Memória é da cliente: Bia não herda as compras da Ana", summaryB.purchasedCategories.length === 0 && summaryB.rejectedCategories.length === 0);

  // ---- fallback exclui categoria 'não usaria' ----
  // O feedback anterior recusou um look com TODAS as categorias da loja — a
  // exclusão zeraria o catálogo e é corretamente ignorada. Para testar a
  // exclusão de verdade, volta o primeiro feedback para 'gostei' e recusa um
  // look de UMA categoria só (montado com piecesAvoid nas outras).
  FashionLookService.recordLookFeedback(orgA, customerId, lookId, "liked");
  const blazerLook = await FashionLookService.createRequestAndRecommend(orgA, customerId, { occasion: "jantar", piecesAvoid: ["blusa", "saia"] });
  FashionLookService.recordLookFeedback(orgA, customerId, (blazerLook as any).looks[0].id, "would_not_wear");
  const summaryAfter = FashionLookService.styleMemorySummary(orgA, customerId);
  check("Look de categoria única recusado: só ela entra nas recusadas", summaryAfter.rejectedCategories.length === 1 && summaryAfter.rejectedCategories[0] === "Blazers", `rejeitadas=${summaryAfter.rejectedCategories.join(",")}`);
  const rejectedCat = summaryAfter.rejectedCategories[0];
  const result2 = await FashionLookService.createRequestAndRecommend(orgA, customerId, { occasion: "jantar" });
  if (result2.ok) {
    const catsUsed = new Set<string>();
    for (const l of (result2 as any).looks) {
      for (const it of l.items) {
        const cat = (db.prepare(`SELECT category FROM products_services WHERE id = ?`).get(it.productId) as any)?.category;
        if (cat) catsUsed.add(cat);
      }
    }
    check(`Fallback EXCLUI a categoria recusada ('${rejectedCat}')`, !catsUsed.has(rejectedCat), `usadas=${[...catsUsed].join(",")}`);
    check("Ainda assim monta looks com as demais categorias", catsUsed.size > 0);
  } else {
    check("Recomendação continua funcionando com memória ativa", false);
  }

  // exclusão que zeraria as opções: não deixa a cliente sem nada
  const orgB2 = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Boutique C', 'active')`).run(randomUUID(), orgB2);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, fashion_studio_enabled) VALUES (?, 'bc', 1, 1)`).run(orgB2);
  const only = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, category, price, active, storefront_visible, slug) VALUES (?, ?, 'product', 'Vestido Único', 'Vestidos', 99, 1, 1, ?)`).run(only, orgB2, `p-${only.slice(0, 8)}`);
  db.prepare(`INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, '/media/x.jpg', 0)`).run(randomUUID(), orgB2, only);
  const regC = FashionCustomerService.register(orgB2, { name: "Cris", email: "cris@t.com", password: "senhaforte1", birthDate: "1990-01-01" });
  const customerC = (regC as any).customerId as string;
  const lookC = await FashionLookService.createRequestAndRecommend(orgB2, customerC, { occasion: "festa" });
  FashionLookService.recordLookFeedback(orgB2, customerC, (lookC as any).looks[0].id, "would_not_wear");
  const lookC2 = await FashionLookService.createRequestAndRecommend(orgB2, customerC, { occasion: "festa" });
  check("Exclusão que zeraria o catálogo: ignora a exclusão (melhor sugerir algo que nada)", lookC2.ok && (lookC2 as any).looks.length > 0);

  // ---- toggle de personalização (11.4) ----
  check("Personalização nasce ligada", FashionLookService.personalizationEnabled(orgA, customerId));
  FashionLookService.setPersonalization(orgA, customerId, false);
  check("Desligada: flag reflete", !FashionLookService.personalizationEnabled(orgA, customerId));
  const consent = db.prepare(`SELECT COUNT(*) AS c FROM fashion_consents WHERE organization_id = ? AND customer_id = ? AND consent_type = 'personalization' AND revoked_at IS NULL`).get(orgA, customerId) as any;
  check("Desligar revoga o consentimento de personalização", consent.c === 0);
  check("Desligada: feedback é recusado com aviso", !(FashionLookService.recordLookFeedback(orgA, customerId, lookId, "liked") as any).ok);

  const prefsBefore = db.prepare(`SELECT COUNT(*) AS c FROM fashion_preferences WHERE organization_id = ? AND active = 1`).get(orgA) as any;
  const offResult = await FashionLookService.createRequestAndRecommend(orgA, customerId, { occasion: "casamento", style: "moderno" });
  check("Desligada: questionário AINDA funciona (looks saem)", offResult.ok);
  const prefsAfter = db.prepare(`SELECT COUNT(*) AS c FROM fashion_preferences WHERE organization_id = ? AND active = 1`).get(orgA) as any;
  check("Desligada: NADA novo é salvo na memória", prefsAfter.c === prefsBefore.c);
  const occPref = db.prepare(`SELECT value_json FROM fashion_preferences fp JOIN fashion_customer_profiles p ON p.id = fp.profile_id WHERE p.customer_id = ? AND fp.preference_type = 'occasion' AND fp.active = 1`).get(customerId) as any;
  check("Desligada: preferências ANTIGAS continuam guardadas (desligar não apaga)", !!occPref && JSON.parse(occPref.value_json) !== "casamento");

  FashionLookService.setPersonalization(orgA, customerId, true);
  check("Religada: flag e consentimento voltam", FashionLookService.personalizationEnabled(orgA, customerId));
  check("Religada: feedback volta a funcionar", (FashionLookService.recordLookFeedback(orgA, customerId, lookId, "liked") as any).ok);

  // ---- resultado ----
  console.log("\n=== Fashion AI Studio FAS-5 — memória de estilo (ADR-039) ===\n");
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
