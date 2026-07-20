/**
 * TEST — Geração + publicação das fotos do look de vitrine (ADR-104 Bloco 3).
 *
 * Cobre StorefrontLookGenerationService: gate do teto de estúdio, escolha do
 * avatar (fixo × IA/fallback), geração das 2 poses (mockada), contagem no teto
 * (studio_creations), publicar × publicar-direto, despublicar e o lookbook público.
 *
 * A geração de imagem por IA é mockada (generateOne) — o teste não chama provedor.
 *
 * Uso: npm run test:storefront-look-generation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-lookgen-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-lookgen-1234567890";
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const mediaDir = path.join(tmpDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const writeMedia = (name: string) => { fs.writeFileSync(path.join(mediaDir, name), Buffer.from([0xff, 0xd8, 0xff])); return `/media/${name}`; };

  const { StorefrontLookService } = await import("../src/server/StorefrontLookService.js");
  const { StorefrontLookGenerationService } = await import("../src/server/StorefrontLookGenerationService.js");
  const { InventoryIntakeService } = await import("../src/server/InventoryIntakeService.js");
  const { FashionPresetAvatarService } = await import("../src/server/FashionPresetAvatarService.js");
  const { PlanService } = await import("../src/server/PlanService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'TOULON', 'active')`).run(randomUUID(), orgId);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, vitrine_auto_publish) VALUES (?, 'toulon', 1, 0)`).run(orgId);

  // Peças elegíveis (com foto real em /media) + avatares preset (clara/escura).
  const mkProduct = (name: string, category: string) => {
    const id = InventoryIntakeService.commitProductFromScan(orgId, { name, category, salePrice: 100, marginPercent: 50, quantity: 5, imageUrl: writeMedia(`${randomUUID().slice(0, 6)}.jpg`) });
    db.prepare(`UPDATE products_services SET fashion_wearable = 1 WHERE id = ?`).run(id);
    return id;
  };
  mkProduct("Camisa Branca", "Camisas");
  mkProduct("Calça Preta", "Calças");
  const avatarClara = FashionPresetAvatarService.create(orgId, { label: "Clara", bodyType: "medio", skinTone: "clara", imageUrl: writeMedia(`${randomUUID().slice(0, 6)}.jpg`) });
  FashionPresetAvatarService.create(orgId, { label: "Escura", bodyType: "medio", skinTone: "escura", imageUrl: writeMedia(`${randomUUID().slice(0, 6)}.jpg`) });
  check("avatar guarda skin_tone", (FashionPresetAvatarService.get(orgId, (avatarClara as any).id) as any).skin_tone === "clara");

  const eligibleIds = (StorefrontLookService as any).catalog(orgId).map((e: any) => e.id);
  const cm = StorefrontLookService.createManual(orgId, eligibleIds, { title: "Look teste", status: "approved" });
  const lookId = (cm as any).id;
  check("look criado e aprovado", (cm as any).ok && StorefrontLookService.get(orgId, lookId).status === "approved");

  // Mocka a geração de imagem por IA (não chama provedor).
  let genCalls = 0;
  (StorefrontLookGenerationService as any).generateOne = async () => { genCalls++; return Buffer.from("fake-image").toString("base64"); };

  // ===== escolha do avatar: sem fixo e sem IA → 1º ativo =====
  const chosen = await StorefrontLookGenerationService.chooseAvatar(orgId, StorefrontLookService.get(orgId, lookId));
  check("chooseAvatar retorna um avatar ativo", !!chosen && chosen.id === (avatarClara as any).id);

  // ===== requestGeneration + processJob: gera 2 poses e conta no teto =====
  const rg = StorefrontLookGenerationService.requestGeneration(orgId, lookId);
  check("requestGeneration ok (queued)", (rg as any).ok && (rg as any).status === "queued");
  await StorefrontLookGenerationService.processJob(lookId, orgId);
  const look1 = StorefrontLookService.list(orgId).find((l: any) => l.id === lookId);
  check("gerou 2 poses", genCalls === 2 && look1.images.length === 2);
  check("generationStatus = done", look1.generationStatus === "done");
  check("NÃO publicou (auto_publish off)", look1.status === "approved" && !look1.publishedImageUrl);
  check("contou 2 imagens no teto (studio_creations)", PlanService.studioUsage(orgId).images === 2);
  check("fixou o avatar usado no look", look1.presetAvatarId === (avatarClara as any).id);

  // ===== idempotência: já done → reused, não regera =====
  const rg2 = StorefrontLookGenerationService.requestGeneration(orgId, lookId);
  check("requestGeneration idempotente (reused)", (rg2 as any).ok && (rg2 as any).reused === true);

  // ===== publicar manual → vira lookbook público =====
  const pub = StorefrontLookGenerationService.publish(orgId, lookId);
  check("publish ok", (pub as any).ok === true);
  const look2 = StorefrontLookService.list(orgId).find((l: any) => l.id === lookId);
  check("look publicado com capa", look2.status === "published" && !!look2.publishedImageUrl);
  const book = StorefrontLookGenerationService.publicLookbook(orgId);
  check("lookbook público traz o look com 2 imagens + peças", book.length === 1 && book[0].images.length === 2 && book[0].items.length === 2);

  // ===== despublicar → volta pra approved, mantém imagens =====
  check("unpublish volta pra approved", StorefrontLookGenerationService.unpublish(orgId, lookId) === true && StorefrontLookService.get(orgId, lookId).status === "approved");
  check("lookbook vazio após despublicar", StorefrontLookGenerationService.publicLookbook(orgId).length === 0);

  // ===== teto estourado: requestGeneration recusa =====
  (PlanService as any).studioAllowed = () => ({ allowed: false, reason: "monthly_limit", limit: 100, used: 100 });
  const cm2 = StorefrontLookService.createManual(orgId, eligibleIds, { title: "Outro", status: "approved" });
  const rg3 = StorefrontLookGenerationService.requestGeneration(orgId, (cm2 as any).id);
  check("teto estourado → requestGeneration recusa", (rg3 as any).ok === false && /limite/i.test((rg3 as any).error));

  // --- Relatório ---
  console.log("\n=== TEST: Geração + publicação de looks (ADR-104 Bloco 3) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Geração de looks OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
