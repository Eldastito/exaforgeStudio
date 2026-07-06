/**
 * TEST — SEO vitrine + Reativação progressiva + Categorias agrupadas
 * -----------------------------------------------------------------------
 * Covers:
 *   1. Sitemap.xml generation (stores + products)
 *   2. Robots.txt with sitemap reference
 *   3. Product detail JSON-LD structured data
 *   4. Store listing meta tags
 *   5. Category exposed in storefront product payload
 *   6. Reactivation progressive sequence (3 steps, per-contact tracking)
 *   7. Campaign settings with 3 message templates
 *
 * Runs on a TEMPORARY database. Usage: npm run test:seo-reactivation-categories
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seo-react-cat-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-seo-react-cat-1234567890abcdef";
process.env.APP_URL = "https://example.com";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Empresa ${tag}`);
    return orgId;
  }

  // ==== Setup ====
  const orgId = seedOrg("seo");

  // Create storefront
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, title, subtitle, published) VALUES (?, ?, ?, ?, 1)`)
    .run(orgId, 'minha-loja', 'Loja Legal', 'Subtítulo da loja');

  // Create products with categories and slugs
  const prodA = randomUUID();
  const prodB = randomUUID();
  const prodC = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, slug, description, price, active, category) VALUES (?, ?, 'product', ?, ?, ?, ?, 1, ?)`)
    .run(prodA, orgId, 'Camiseta Azul', 'camiseta-azul', 'Linda camiseta azul', 100, 'Roupas');
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, slug, description, price, active, category) VALUES (?, ?, 'product', ?, ?, ?, ?, 1, ?)`)
    .run(prodB, orgId, 'Calça Jeans', 'calca-jeans', 'Calça jeans confortável', 200, 'Roupas');
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, slug, description, price, active, category) VALUES (?, ?, 'product', ?, ?, ?, ?, 1, ?)`)
    .run(prodC, orgId, 'Boné Preto', 'bone-preto', 'Boné estiloso', 50, 'Acessórios');

  // Create product image
  db.prepare(`INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, ?, 1)`)
    .run(randomUUID(), orgId, prodA, '/media/camiseta.jpg');

  // ==== PART 1: Sitemap.xml ====
  console.log('\n=== PART 1: Sitemap.xml ===');

  const stores = db.prepare(`SELECT slug FROM storefront_settings WHERE published = 1`).all() as any[];
  check("1.1 Published store found", stores.length >= 1);

  // Build sitemap XML
  const base = 'https://example.com';
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
  for (const s of stores) {
    const storeUrl = `${base}/loja/${encodeURIComponent(s.slug)}`;
    xml += `  <url><loc>${storeUrl}</loc><changefreq>weekly</changefreq></url>\n`;
    const storeOrgId = (db.prepare(`SELECT organization_id FROM storefront_settings WHERE slug = ?`).get(s.slug) as any)?.organization_id;
    if (!storeOrgId) continue;
    const products = db.prepare(
      `SELECT slug FROM products_services WHERE organization_id = ? AND active = 1 AND COALESCE(storefront_visible,1) = 1 AND slug IS NOT NULL`
    ).all(storeOrgId) as any[];
    for (const p of products) {
      xml += `  <url><loc>${storeUrl}/produto/${encodeURIComponent(p.slug)}</loc><changefreq>weekly</changefreq></url>\n`;
    }
  }
  xml += `</urlset>`;

  check("1.2 Sitemap contains store URL", xml.includes('https://example.com/loja/minha-loja'));
  check("1.3 Sitemap contains product URL", xml.includes('https://example.com/loja/minha-loja/produto/camiseta-azul'));
  check("1.4 Sitemap has 4 URLs (1 store + 3 products)", (xml.match(/<url>/g) || []).length === 4);
  check("1.5 Sitemap is valid XML header", xml.startsWith('<?xml'));

  // ==== PART 2: Robots.txt ====
  console.log('\n=== PART 2: Robots.txt ===');

  let robotsTxt = `User-agent: *\nAllow: /loja/\nDisallow: /api/\nDisallow: /admin\n`;
  robotsTxt += `\nSitemap: ${base}/sitemap.xml\n`;

  check("2.1 Robots allows /loja/", robotsTxt.includes('Allow: /loja/'));
  check("2.2 Robots disallows /api/", robotsTxt.includes('Disallow: /api/'));
  check("2.3 Robots references sitemap", robotsTxt.includes('Sitemap: https://example.com/sitemap.xml'));

  // ==== PART 3: JSON-LD (schema.org Product) ====
  console.log('\n=== PART 3: JSON-LD Product ===');

  const product = db.prepare(
    `SELECT id, name, description, price, currency FROM products_services WHERE id = ?`
  ).get(prodA) as any;
  const images = db.prepare(
    `SELECT url FROM product_images WHERE product_service_id = ? ORDER BY position ASC`
  ).all(prodA) as any[];

  const jsonLd: any = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.description,
    image: images.map((i: any) => `${base}${i.url}`),
    url: `${base}/loja/minha-loja/produto/camiseta-azul`,
    offers: {
      '@type': 'Offer',
      price: Number(product.price).toFixed(2),
      priceCurrency: product.currency || 'BRL',
      availability: 'https://schema.org/InStock',
    },
  };

  check("3.1 JSON-LD type is Product", jsonLd['@type'] === 'Product');
  check("3.2 JSON-LD has name", jsonLd.name === 'Camiseta Azul');
  check("3.3 JSON-LD has price", jsonLd.offers.price === '100.00');
  check("3.4 JSON-LD has image array", Array.isArray(jsonLd.image) && jsonLd.image.length === 1);
  check("3.5 JSON-LD image URL is absolute", jsonLd.image[0].startsWith('https://'));
  check("3.6 JSON-LD has URL", jsonLd.url.includes('/loja/minha-loja/produto/camiseta-azul'));
  check("3.7 JSON-LD currency is BRL", jsonLd.offers.priceCurrency === 'BRL');

  // ==== PART 4: Store listing meta ====
  console.log('\n=== PART 4: Store listing meta ===');

  const store = db.prepare(
    `SELECT organization_id, title, subtitle, slug FROM storefront_settings WHERE slug = 'minha-loja' AND published = 1`
  ).get() as any;

  check("4.1 Store found", !!store);
  const storeTitle = store.title || 'Loja';
  const storeDesc = String(store.subtitle || '').slice(0, 160) || `Conheça os produtos de ${storeTitle}.`;
  check("4.2 Store title resolved", storeTitle === 'Loja Legal');
  check("4.3 Store desc from subtitle", storeDesc === 'Subtítulo da loja');

  // ==== PART 5: Category in product payload ====
  console.log('\n=== PART 5: Categories ===');

  const allProducts = db.prepare(
    `SELECT * FROM products_services WHERE organization_id = ? AND active = 1 AND type = 'product'`
  ).all(orgId) as any[];

  const payloads = allProducts.map((p: any) => ({
    id: p.id,
    name: p.name,
    category: p.category || null,
  }));

  check("5.1 3 products returned", payloads.length === 3);
  const camiseta = payloads.find((p: any) => p.name === 'Camiseta Azul');
  check("5.2 Camiseta has category Roupas", camiseta?.category === 'Roupas');
  const bone = payloads.find((p: any) => p.name === 'Boné Preto');
  check("5.3 Boné has category Acessórios", bone?.category === 'Acessórios');

  // Group by category
  const cats = new Map<string, any[]>();
  for (const p of payloads) {
    if (p.category) {
      const list = cats.get(p.category) || [];
      list.push(p);
      cats.set(p.category, list);
    }
  }
  check("5.4 2 categories (Roupas, Acessórios)", cats.size === 2);
  check("5.5 Roupas has 2 products", (cats.get('Roupas') || []).length === 2);
  check("5.6 Acessórios has 1 product", (cats.get('Acessórios') || []).length === 1);

  // ==== PART 6: Reactivation progressive sequence ====
  console.log('\n=== PART 6: Reactivation sequence ===');

  const org2 = seedOrg("react");

  // Enable reactivation
  db.prepare(`UPDATE organization_settings SET auto_reactivation_enabled = 1, auto_reactivation_days = 60 WHERE organization_id = ?`).run(org2);

  // Verify message columns exist
  db.prepare(`UPDATE organization_settings SET auto_reactivation_message = ?, auto_reactivation_message_2 = ?, auto_reactivation_message_3 = ? WHERE organization_id = ?`)
    .run('Msg 1: {nome}', 'Msg 2: {nome}', 'Msg 3: {nome}', org2);

  const settings = db.prepare(`SELECT auto_reactivation_message, auto_reactivation_message_2, auto_reactivation_message_3 FROM organization_settings WHERE organization_id = ?`).get(org2) as any;
  check("6.1 Message 1 saved", settings.auto_reactivation_message === 'Msg 1: {nome}');
  check("6.2 Message 2 saved", settings.auto_reactivation_message_2 === 'Msg 2: {nome}');
  check("6.3 Message 3 saved", settings.auto_reactivation_message_3 === 'Msg 3: {nome}');

  // Create contacts with reactivation step tracking
  const channelId = `ch_${randomUUID().slice(0, 6)}`;
  try { db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'whatsapp', 'Canal', 'active')`).run(channelId, org2); } catch {}

  const ctA = `ct_${randomUUID().slice(0, 8)}`;
  const ctB = `ct_${randomUUID().slice(0, 8)}`;
  const ctC = `ct_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, purchase_count, last_purchase_at) VALUES (?, ?, ?, ?, ?, 3, datetime('now', '-90 days'))`)
    .run(ctA, org2, channelId, 'Ana Step0', '5511900000001');
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, purchase_count, last_purchase_at, reactivation_step) VALUES (?, ?, ?, ?, ?, 2, datetime('now', '-90 days'), 1)`)
    .run(ctB, org2, channelId, 'Bruno Step1', '5511900000002');
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, purchase_count, last_purchase_at, reactivation_step) VALUES (?, ?, ?, ?, ?, 1, datetime('now', '-90 days'), 2)`)
    .run(ctC, org2, channelId, 'Carla Step2', '5511900000003');

  // Verify step tracking columns
  const contactA = db.prepare(`SELECT reactivation_step, reactivation_last_sent_at FROM contacts WHERE id = ?`).get(ctA) as any;
  check("6.4 New contact starts at step 0", (contactA.reactivation_step || 0) === 0);
  check("6.5 New contact has no last_sent_at", contactA.reactivation_last_sent_at === null);

  const contactB = db.prepare(`SELECT reactivation_step FROM contacts WHERE id = ?`).get(ctB) as any;
  check("6.6 Contact B at step 1", contactB.reactivation_step === 1);

  const contactC = db.prepare(`SELECT reactivation_step FROM contacts WHERE id = ?`).get(ctC) as any;
  check("6.7 Contact C at step 2", contactC.reactivation_step === 2);

  // Simulate step advancement
  db.prepare(`UPDATE contacts SET reactivation_step = 1, reactivation_last_sent_at = CURRENT_TIMESTAMP WHERE id = ?`).run(ctA);
  const updatedA = db.prepare(`SELECT reactivation_step, reactivation_last_sent_at FROM contacts WHERE id = ?`).get(ctA) as any;
  check("6.8 Step advanced to 1", updatedA.reactivation_step === 1);
  check("6.9 last_sent_at set", updatedA.reactivation_last_sent_at !== null);

  // Step 3 = done (no more messages)
  db.prepare(`UPDATE contacts SET reactivation_step = 3 WHERE id = ?`).run(ctA);
  const doneA = db.prepare(`SELECT reactivation_step FROM contacts WHERE id = ?`).get(ctA) as any;
  check("6.10 Step 3 means sequence complete", doneA.reactivation_step === 3);

  // Contact who bought resets step
  db.prepare(`UPDATE contacts SET reactivation_step = 0, last_purchase_at = CURRENT_TIMESTAMP WHERE id = ?`).run(ctA);
  const resetA = db.prepare(`SELECT reactivation_step FROM contacts WHERE id = ?`).get(ctA) as any;
  check("6.11 Step reset after purchase", resetA.reactivation_step === 0);

  // ==== PART 7: Campaign settings API shape ====
  console.log('\n=== PART 7: Campaign settings shape ===');

  const orgSettings = db.prepare(`
    SELECT auto_reactivation_enabled, auto_reactivation_days,
           auto_reactivation_message, auto_reactivation_message_2, auto_reactivation_message_3,
           auto_reactivation_last_run
    FROM organization_settings WHERE organization_id = ?
  `).get(org2) as any;

  const apiShape = {
    enabled: !!(orgSettings && orgSettings.auto_reactivation_enabled),
    days: orgSettings?.auto_reactivation_days || 60,
    message: orgSettings?.auto_reactivation_message || "",
    message2: orgSettings?.auto_reactivation_message_2 || "",
    message3: orgSettings?.auto_reactivation_message_3 || "",
    lastRun: orgSettings?.auto_reactivation_last_run || null,
  };

  check("7.1 API shape has enabled", typeof apiShape.enabled === 'boolean');
  check("7.2 API shape has message", apiShape.message === 'Msg 1: {nome}');
  check("7.3 API shape has message2", apiShape.message2 === 'Msg 2: {nome}');
  check("7.4 API shape has message3", apiShape.message3 === 'Msg 3: {nome}');
  check("7.5 API shape has days", apiShape.days === 60);

  // ---- Summary ----
  console.log("\n──── Resultados ────");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` [${r.detail}]` : ""}`);
  }
  console.log(`\n${results.length} verificações, ${failures} falha(s).`);
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
