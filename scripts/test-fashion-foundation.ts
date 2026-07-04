/**
 * TESTE — Fashion AI Studio FAS-0: fundação (ADR-034 / PRD-E-006)
 * -------------------------------------------------------------------------
 * Cobre a fundação do provador virtual, 100% determinística (sem IA, sem
 * foto): schema das tabelas fashion_*, flag por loja (kill switch), limite
 * diário com clamp, regras do catálogo ELEGÍVEL (seção 8.3 do PRD — ativo,
 * visível, com preço, com imagem, com estoque vendável, variação esgotada),
 * isolamento entre organizações e telemetria (incl. a recusa de payload
 * grande — RNF-004: nunca conteúdo visual em log/evento).
 *
 * Uso: npm run test:fashion-foundation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fashion-fas0-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fashion-fas0-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FashionStudioService } = await import("../src/server/FashionStudioService.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  const orgB = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Boutique A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Boutique B', 'active')`).run(randomUUID(), orgB);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published) VALUES (?, 'boutique-a', 1)`).run(orgA);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published) VALUES (?, 'boutique-b', 1)`).run(orgB);

  // ---- schema: todas as tabelas fashion_* existem ----
  for (const table of ["fashion_customer_profiles", "fashion_preferences", "fashion_avatar_assets", "fashion_look_requests", "fashion_looks", "fashion_look_items", "fashion_tryon_jobs", "fashion_usage_credits", "fashion_consents", "fashion_events"]) {
    const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
    check(`Tabela ${table} existe`, !!exists);
  }
  const cols = (db.prepare(`PRAGMA table_info(storefront_settings)`).all() as any[]).map((c) => c.name);
  check("storefront_settings tem fashion_studio_enabled", cols.includes("fashion_studio_enabled"));
  check("storefront_settings tem fashion_daily_generation_limit", cols.includes("fashion_daily_generation_limit"));

  // ---- flag: desligada por padrão (kill switch = o toggle) ----
  check("Módulo desligado por padrão (opt-in)", !FashionStudioService.isEnabled(orgA));
  db.prepare(`UPDATE storefront_settings SET fashion_studio_enabled = 1 WHERE organization_id = ?`).run(orgA);
  check("Toggle ligado: isEnabled reflete", FashionStudioService.isEnabled(orgA));
  check("Flag é por loja: org B continua desligada", !FashionStudioService.isEnabled(orgB));

  // ---- limite diário: padrão 3, clamp 1–20 ----
  check("Limite diário padrão é 3", FashionStudioService.dailyGenerationLimit(orgA) === 3);
  db.prepare(`UPDATE storefront_settings SET fashion_daily_generation_limit = 10 WHERE organization_id = ?`).run(orgA);
  check("Limite configurado (10) é respeitado", FashionStudioService.dailyGenerationLimit(orgA) === 10);
  db.prepare(`UPDATE storefront_settings SET fashion_daily_generation_limit = 999 WHERE organization_id = ?`).run(orgA);
  check("Limite corrompido (999) sofre clamp para 20 (nunca ilimitado)", FashionStudioService.dailyGenerationLimit(orgA) === 20);
  db.prepare(`UPDATE storefront_settings SET fashion_daily_generation_limit = 0 WHERE organization_id = ?`).run(orgA);
  check("Limite 0/negativo volta ao padrão 3 (nunca bloqueia tudo por engano)", FashionStudioService.dailyGenerationLimit(orgA) === 3);

  // ---- catálogo elegível (seção 8.3) ----
  function product(orgId: string, opts: { name: string; price?: number | null; visible?: number; active?: number; stockControl?: number; qty?: number; image?: boolean; studioImage?: boolean }): string {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO products_services (id, organization_id, type, name, price, active, storefront_visible, stock_control_enabled, slug, studio_image_url)
       VALUES (?, ?, 'product', ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, opts.name, opts.price === undefined ? 10 : opts.price, opts.active ?? 1, opts.visible ?? 1, opts.stockControl ?? 0, `p-${id.slice(0, 8)}`, opts.studioImage ? "/media/studio.png" : null);
    if (opts.stockControl) {
      db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available) VALUES (?, ?, ?, ?)`).run(randomUUID(), orgId, id, opts.qty ?? 0);
    }
    if (opts.image !== false && !opts.studioImage) {
      db.prepare(`INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, '/media/x.jpg', 0)`).run(randomUUID(), orgId, id);
    }
    return id;
  }

  const ok1 = product(orgA, { name: "Vestido Elegível", price: 199.9 });
  const noPrice = product(orgA, { name: "Sem Preço", price: null });
  const hidden = product(orgA, { name: "Oculto", visible: 0 });
  const inactive = product(orgA, { name: "Inativo", active: 0 });
  const noImage = product(orgA, { name: "Sem Imagem", image: false });
  const zeroStock = product(orgA, { name: "Sem Estoque", stockControl: 1, qty: 0 });
  const withStock = product(orgA, { name: "Com Estoque", stockControl: 1, qty: 5 });
  const onlyStudioImg = product(orgA, { name: "Só Foto de Estúdio", image: false, studioImage: true });
  const orgBProduct = product(orgB, { name: "Produto da Outra Loja", price: 50 });

  const eligible = FashionStudioService.eligibleItems(orgA);
  const ids = new Set(eligible.map((e) => e.id));
  check("Produto completo é elegível", ids.has(ok1));
  check("Produto sem preço NÃO é elegível", !ids.has(noPrice));
  check("Produto oculto da vitrine NÃO é elegível", !ids.has(hidden));
  check("Produto inativo NÃO é elegível", !ids.has(inactive));
  check("Produto sem NENHUMA imagem NÃO é elegível (try-on precisa dela)", !ids.has(noImage));
  check("Produto com estoque zerado NÃO é elegível (ADR-033)", !ids.has(zeroStock));
  check("Produto com estoque positivo é elegível", ids.has(withStock));
  check("Foto de estúdio (ADR-032) conta como imagem comercial", ids.has(onlyStudioImg));
  check("Isolamento: produto da org B nunca aparece na org A", !ids.has(orgBProduct));
  const eligibleB = FashionStudioService.eligibleItems(orgB);
  check("Isolamento: org B só vê o próprio produto", eligibleB.length === 1 && eligibleB[0].id === orgBProduct);

  // ---- variações: todas esgotadas = inelegível; alguma com estoque = elegível só com as disponíveis ----
  const withVariants = product(orgA, { name: "Camisa com Tamanhos", stockControl: 1, qty: 99 });
  db.prepare(`UPDATE products_services SET has_variants = 1 WHERE id = ?`).run(withVariants);
  const vP = randomUUID(), vM = randomUUID();
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, active) VALUES (?, ?, ?, 'P', 1)`).run(vP, orgA, withVariants);
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, active) VALUES (?, ?, ?, 'M', 1)`).run(vM, orgA, withVariants);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, 0)`).run(randomUUID(), orgA, withVariants, vP);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, 4)`).run(randomUUID(), orgA, withVariants, vM);
  const eligible2 = FashionStudioService.eligibleItems(orgA);
  const shirt = eligible2.find((e) => e.id === withVariants);
  check("Produto com variações: elegível quando ao menos uma tem estoque", !!shirt);
  check("Só as variações COM estoque aparecem (P esgotada some, M fica)", shirt?.variants.length === 1 && shirt?.variants[0].name === "M");
  db.prepare(`UPDATE inventory_items SET quantity_available = 0 WHERE variant_id = ?`).run(vM);
  const eligible3 = FashionStudioService.eligibleItems(orgA);
  check("Todas as variações esgotadas: produto sai do catálogo elegível", !eligible3.some((e) => e.id === withVariants));

  // ---- telemetria ----
  FashionStudioService.recordEvent(orgA, "FashionEligibleCatalogViewed", { itemCount: 4 }, null, "corr-1");
  const ev = db.prepare(`SELECT * FROM fashion_events WHERE organization_id = ? AND event_type = 'FashionEligibleCatalogViewed'`).get(orgA) as any;
  check("Evento de telemetria gravado com payload e correlation_id", !!ev && JSON.parse(ev.payload_json).itemCount === 4 && ev.correlation_id === "corr-1");
  FashionStudioService.recordEvent(orgA, "FashionBlobAttempt", { img: "x".repeat(10_000) });
  const blobEv = db.prepare(`SELECT COUNT(*) AS c FROM fashion_events WHERE organization_id = ? AND event_type = 'FashionBlobAttempt'`).get(orgA) as any;
  check("Payload grande (provável blob) é RECUSADO — RNF-004, nunca imagem em evento", blobEv.c === 0);
  const counts = FashionStudioService.eventCounts(orgA);
  check("Contagem agregada de eventos funciona (RF-036: admin vê agregado)", counts.some((c) => c.event_type === "FashionEligibleCatalogViewed" && c.count === 1));

  // ---- rota pública: gated pela flag (404 indistinguível de inexistente) ----
  // Testa a LÓGICA da rota sem subir servidor: o gate é isEnabled + resolveStore(published).
  db.prepare(`UPDATE storefront_settings SET fashion_studio_enabled = 0 WHERE organization_id = ?`).run(orgA);
  check("Kill switch: desligar a flag desativa o módulo na hora", !FashionStudioService.isEnabled(orgA));
  const routeSrc = fs.readFileSync(path.join(process.cwd(), "src/server/routes/storefrontPublic.ts"), "utf-8");
  check("Rota pública existe e é gated pela flag (404 quando desligada)", /fashion\/eligible/.test(routeSrc) && /isEnabled\(orgId\)\)\s*return res\.status\(404\)/.test(routeSrc));

  // ---- resultado ----
  console.log("\n=== Fashion AI Studio FAS-0 — fundação (ADR-034) ===\n");
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
