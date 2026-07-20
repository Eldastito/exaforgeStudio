/**
 * TEST — 2ª foto tratada por peça no cadastro (ADR-104 Bloco 1).
 *
 * Após cadastrar a peça, o gerente pode mandar uma 2ª foto (tecido/detalhe): a
 * IA trata (fundo/estúdio) e publica como imagem ADICIONAL, sem trocar a capa.
 * Respeita o teto de estúdio do plano; "pronto" finaliza.
 *
 * Mocka o tratamento por IA (StudioCatalogPhotoService.generateForNewProduct) e
 * o teto (PlanService.studioAllowed); usa uma imagem real via sharp.
 *
 * Uso: npm run test:catalog-second-photo
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import sharp from "sharp";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cat2foto-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-cat2foto-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { WhatsAppInventoryIntake } = await import("../src/server/WhatsAppInventoryIntake.js");
  const { InventoryIntakeService } = await import("../src/server/InventoryIntakeService.js");
  const { StudioCatalogPhotoService } = await import("../src/server/StudioCatalogPhotoService.js");
  const { PlanService } = await import("../src/server/PlanService.js");
  const { savePendingAction, getPendingAction } = await import("../src/server/PendingManagerActions.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const mgr = "5521999990000";
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'TOULON', 'active')`).run(randomUUID(), orgId);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, ai_catalog_photos_enabled) VALUES (?, 'toulon', 1, 1)`).run(orgId);

  // Uma imagem JPEG real (sharp aceita) em base64.
  const imgBuf = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 200, g: 60, b: 90 } } }).jpeg().toBuffer();
  const imgB64 = imgBuf.toString("base64");

  // Produto já cadastrado (capa na position 0).
  const productId = InventoryIntakeService.commitProductFromScan(orgId, {
    name: "Camisa Polo Branca", category: "Roupas", salePrice: 149.9, marginPercent: 50, quantity: 10, imageUrl: "/media/capa.jpg",
  });
  const imgs = () => db.prepare(`SELECT url, position FROM product_images WHERE product_service_id = ? ORDER BY position ASC`).all(productId) as any[];
  check("produto nasce com 1 imagem (capa position 0)", imgs().length === 1 && imgs()[0].position === 0);

  // ===== addProductImage: anexa na próxima posição sem trocar a capa =====
  InventoryIntakeService.addProductImage(orgId, productId, "/media/extra.jpg");
  check("addProductImage anexa em position 1", imgs().length === 2 && imgs()[1].position === 1 && imgs()[1].url === "/media/extra.jpg");
  check("capa (position 0) intacta", imgs()[0].url === "/media/capa.jpg");

  // Mocks do tratamento por IA + teto do plano.
  let treatCalls = 0;
  (StudioCatalogPhotoService as any).generateForNewProduct = async () => { treatCalls++; return `/media/tratada_${randomUUID().slice(0, 6)}.png`; };
  (PlanService as any).studioAllowed = () => ({ allowed: true });

  // ===== 2ª foto: handlePhoto roteia para o tratamento e publica =====
  savePendingAction(orgId, mgr, "awaiting_second_photo", { productId, name: "Camisa Polo Branca" });
  const r1 = await WhatsAppInventoryIntake.handlePhoto(orgId, mgr, imgB64, "image/jpeg");
  check("2ª foto: resposta cita tratamento/publicação", /tratad|publicad|vitrine/i.test(r1));
  check("2ª foto: IA de tratamento foi chamada", treatCalls === 1);
  check("2ª foto: virou 3ª imagem do produto (position 2)", imgs().length === 3 && imgs()[2].position === 2 && imgs()[2].url.startsWith("/media/tratada_"));
  check("2ª foto: pendência consumida", !getPendingAction(orgId, mgr));

  // ===== Teto do plano estourado: recebe mas não trata/não adiciona =====
  (PlanService as any).studioAllowed = () => ({ allowed: false, reason: "monthly_limit" });
  const before = imgs().length;
  savePendingAction(orgId, mgr, "awaiting_second_photo", { productId, name: "Camisa Polo Branca" });
  const r2 = await WhatsAppInventoryIntake.handlePhoto(orgId, mgr, imgB64, "image/jpeg");
  check("teto estourado: avisa limite e não publica nova imagem", /limite/i.test(r2) && imgs().length === before);
  check("teto estourado: pendência consumida", !getPendingAction(orgId, mgr));

  // ===== "pronto" finaliza sem 2ª foto =====
  savePendingAction(orgId, mgr, "awaiting_second_photo", { productId, name: "Camisa Polo Branca" });
  const pend = getPendingAction(orgId, mgr);
  const r3 = await WhatsAppInventoryIntake.handleReply(orgId, mgr, pend, "pronto");
  check("'pronto' finaliza o cadastro", /finalizad/i.test(r3) && !getPendingAction(orgId, mgr));

  // --- Relatório ---
  console.log("\n=== TEST: 2ª foto tratada no cadastro (ADR-104 Bloco 1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ 2ª foto tratada OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
