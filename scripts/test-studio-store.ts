/**
 * TEST — Enviar mídia do Estúdio pra loja virtual (Fatia 2).
 * Cobre: anexar imagem a produto (append não-destrutivo + vira capa só se vazio),
 * criar produto a partir da arte (slug único), banner da vitrine (exige loja),
 * e a recusa de VÍDEO em todos os caminhos (a vitrine só tem imagem — F3).
 * Uso: npm run test:studio-store
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-studiostore-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-studiostore-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { StudioService: S } = await import("../src/server/StudioService.js");
  const ORG = `org_${randomUUID().slice(0, 8)}`, OTHER = `org_${randomUUID().slice(0, 8)}`;

  const mkCreation = (org: string, kind: "image" | "video") => {
    const id = randomUUID();
    const url = kind === "video" ? `/media/${id}.mp4` : `/media/${id}.png`;
    db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status) VALUES (?, ?, ?, ?, ?, 'done')")
      .run(id, org, kind, "arte teste", url);
    return { id, url };
  };
  const mkProduct = (org: string, name: string) => {
    const id = randomUUID();
    db.prepare("INSERT INTO products_services (id, organization_id, type, name, description, price, stock_control_enabled, slug) VALUES (?, ?, 'product', ?, '', 0, 0, ?)")
      .run(id, org, name, name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    return id;
  };
  const imgCount = (pid: string) => (db.prepare("SELECT COUNT(*) c FROM product_images WHERE product_service_id = ?").get(pid) as any).c;
  const studioUrl = (pid: string) => (db.prepare("SELECT studio_image_url FROM products_services WHERE id = ?").get(pid) as any).studio_image_url;

  // ── 1. anexar imagem a produto existente (append não-destrutivo) ──
  const prod = mkProduct(ORG, "Calça Carpinteiro");
  const img1 = mkCreation(ORG, "image");
  const r1 = S.attachImageToProduct(ORG, img1.id, prod);
  check("1.1 anexa imagem ao produto", r1.ok === true);
  check("1.2 product_images tem 1 foto", imgCount(prod) === 1);
  check("1.3 vira capa (studio_image_url) pois estava vazio", studioUrl(prod) === img1.url);

  const img2 = mkCreation(ORG, "image");
  const r2 = S.attachImageToProduct(ORG, img2.id, prod);
  check("1.4 segunda imagem também anexa", r2.ok === true);
  check("1.5 append não-destrutivo: agora 2 fotos", imgCount(prod) === 2);
  check("1.6 capa NÃO muda (mantém a primeira)", studioUrl(prod) === img1.url);

  // ── 2. recusas ──
  const vid = mkCreation(ORG, "video");
  check("2.1 vídeo é recusado no produto", S.attachImageToProduct(ORG, vid.id, prod).ok === false);
  check("2.2 produto inexistente é recusado", S.attachImageToProduct(ORG, mkCreation(ORG, "image").id, "nope").ok === false);
  check("2.3 criação de outra org não é encontrada", S.attachImageToProduct(OTHER, img1.id, prod).ok === false);

  // ── 3. criar produto a partir da arte ──
  const img3 = mkCreation(ORG, "image");
  const c1 = S.createProductFromCreation(ORG, img3.id, "Sandália de Dedo", 99.9);
  check("3.1 cria produto", c1.ok === true && !!c1.id);
  check("3.2 produto novo já tem a foto", imgCount(c1.id!) === 1 && studioUrl(c1.id!) === img3.url);
  const img4 = mkCreation(ORG, "image");
  const c2 = S.createProductFromCreation(ORG, img4.id, "Sandália de Dedo");
  const slug1 = (db.prepare("SELECT slug FROM products_services WHERE id = ?").get(c1.id) as any).slug;
  const slug2 = (db.prepare("SELECT slug FROM products_services WHERE id = ?").get(c2.id) as any).slug;
  check("3.3 slug único mesmo com nome repetido", !!slug1 && !!slug2 && slug1 !== slug2);
  check("3.4 nome vazio é recusado", S.createProductFromCreation(ORG, mkCreation(ORG, "image").id, "  ").ok === false);
  check("3.5 vídeo não vira produto", S.createProductFromCreation(ORG, mkCreation(ORG, "video").id, "X").ok === false);

  // ── 4. banner da vitrine ──
  const imgB = mkCreation(ORG, "image");
  check("4.1 sem loja configurada → recusa", S.setStorefrontBanner(ORG, imgB.id).ok === false);
  db.prepare("INSERT INTO storefront_settings (organization_id, slug, title, default_mode, accent_color, published) VALUES (?, ?, 'Loja', 'night', '#ec4899', 0)")
    .run(ORG, `loja-${ORG.slice(0, 6)}`);
  const rb = S.setStorefrontBanner(ORG, imgB.id);
  check("4.2 com loja → define banner", rb.ok === true);
  check("4.3 banner_url gravado", (db.prepare("SELECT banner_url FROM storefront_settings WHERE organization_id = ?").get(ORG) as any).banner_url === imgB.url);
  check("4.4 vídeo não vira banner", S.setStorefrontBanner(ORG, mkCreation(ORG, "video").id).ok === false);

  // ── 5. vídeo na loja (Fatia 3) — só VÍDEO ──
  const prodV = mkProduct(ORG, "Look em Movimento");
  const vid1 = mkCreation(ORG, "video");
  const v1 = S.setProductVideo(ORG, vid1.id, prodV);
  check("5.1 define vídeo do produto", v1.ok === true);
  check("5.2 video_url gravado no produto", (db.prepare("SELECT video_url FROM products_services WHERE id = ?").get(prodV) as any).video_url === vid1.url);
  check("5.3 imagem é recusada no vídeo do produto", S.setProductVideo(ORG, mkCreation(ORG, "image").id, prodV).ok === false);
  check("5.4 produto inexistente é recusado", S.setProductVideo(ORG, mkCreation(ORG, "video").id, "nope").ok === false);

  // banner de vídeo (ORG já tem storefront_settings da seção 4)
  const vidB = mkCreation(ORG, "video");
  check("5.5 define banner de vídeo", S.setStorefrontVideoBanner(ORG, vidB.id).ok === true);
  check("5.6 banner_video_url gravado", (db.prepare("SELECT banner_video_url FROM storefront_settings WHERE organization_id = ?").get(ORG) as any).banner_video_url === vidB.url);
  check("5.7 imagem é recusada no banner de vídeo", S.setStorefrontVideoBanner(ORG, mkCreation(ORG, "image").id).ok === false);
  check("5.8 sem loja (outra org) → banner de vídeo recusado", S.setStorefrontVideoBanner(OTHER, mkCreation(OTHER, "video").id).ok === false);

  console.log("\n=== Estúdio → loja virtual (Fatia 2+3) ===");
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} studio-store: ${results.length - failures}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
