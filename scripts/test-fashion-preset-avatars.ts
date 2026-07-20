/**
 * TESTE — Avatares PRESET da loja no provador (ADR-103, item #13).
 *
 * O cliente escolhe um avatar curado pela loja em vez de subir a própria foto.
 * Cobre: CRUD do preset (só aceita imagem /media), listagem pública (só ativos),
 * e o try-on usando presetAvatarId — inclusive para cliente SEM avatar próprio
 * (o ponto do recurso), com o input_hash distinguindo preset da foto do cliente.
 *
 * Uso: npm run test:fashion-preset-avatars
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fashion-preset-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-fashion-preset-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FashionTryOnService } = await import("../src/server/FashionTryOnService.js");
  const { FashionPresetAvatarService } = await import("../src/server/FashionPresetAvatarService.js");
  const { FashionCustomerService } = await import("../src/server/FashionCustomerService.js");
  const { FashionLookService } = await import("../src/server/FashionLookService.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Boutique', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, fashion_studio_enabled, fashion_daily_generation_limit) VALUES (?, 'bt', 1, 1, 3)`).run(orgA);

  const MEDIA_DIR = path.join(tmpDir, "media");
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  // Produto com foto (peça do look).
  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, category, price, active, storefront_visible, slug) VALUES (?, ?, 'product', 'Blusa', 'Roupas', 89.9, 1, 1, ?)`)
    .run(prod, orgA, `p-${prod.slice(0, 8)}`);
  const garmentImg = `${randomUUID()}.jpg`;
  fs.writeFileSync(path.join(MEDIA_DIR, garmentImg), Buffer.from("fake-garment"));
  db.prepare(`INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, ?, 0)`).run(randomUUID(), orgA, prod, `/media/${garmentImg}`);

  // Cliente SEM avatar próprio (o caso que os presets resolvem).
  const reg = FashionCustomerService.register(orgA, { name: "Léo", email: "leo@t.com", password: "senhaforte1", birthDate: "1990-01-01" });
  const customerId = (reg as any).customerId as string;
  const lookRes = await FashionLookService.createRequestAndRecommend(orgA, customerId, { occasion: "trabalho" });
  const lookId = (lookRes as any).looks[0].id as string;

  // ===== 1. CRUD do preset — só aceita imagem /media =====
  check("cria falha se a imagem não é /media", FashionPresetAvatarService.create(orgA, { label: "X", imageUrl: "https://externo/img.jpg" }).ok === false);
  const presetImg = `${randomUUID()}.jpg`;
  fs.writeFileSync(path.join(MEDIA_DIR, presetImg), Buffer.from("fake-avatar-model"));
  const c1 = FashionPresetAvatarService.create(orgA, { label: "Modelo atlético", bodyType: "atletico", imageUrl: `/media/${presetImg}` });
  check("cria preset com /media ok", c1.ok === true && !!c1.id);
  const presetId = c1.id!;
  check("list traz o preset", FashionPresetAvatarService.list(orgA).length === 1);
  const pub = FashionPresetAvatarService.publicList(orgA);
  check("publicList expõe id/label/bodyType/imageUrl", pub.length === 1 && pub[0].id === presetId && pub[0].bodyType === "atletico");
  check("body_type inválido cai em 'outro'", FashionPresetAvatarService.create(orgA, { imageUrl: `/media/${presetImg}`, bodyType: "xpto" }).ok && FashionPresetAvatarService.list(orgA).some(a => a.body_type === "outro"));

  // ===== 2. Ativar/desativar reflete na vitrine e no try-on =====
  FashionPresetAvatarService.update(orgA, presetId, { active: false });
  check("preset inativo some do publicList", !FashionPresetAvatarService.publicList(orgA).some(a => a.id === presetId));
  check("activeImageUrl null p/ inativo", FashionPresetAvatarService.activeImageUrl(orgA, presetId) === null);
  FashionPresetAvatarService.update(orgA, presetId, { active: true });
  check("reativado volta ao publicList", FashionPresetAvatarService.publicList(orgA).some(a => a.id === presetId));

  process.env.OPENAI_API_KEY = "sk-fake-para-teste"; // provedor "disponível"

  // ===== 3. Try-on com preset funciona SEM avatar do cliente =====
  const gen = FashionTryOnService.requestGeneration(orgA, customerId, lookId, presetId);
  check("gera com preset mesmo sem foto do cliente (QUEUED)", gen.ok === true && (gen as any).status === "QUEUED");
  const jobId = (gen as any).jobId as string;
  const jobRow = db.prepare(`SELECT preset_avatar_id, input_hash FROM fashion_tryon_jobs WHERE id = ?`).get(jobId) as any;
  check("job grava preset_avatar_id", jobRow?.preset_avatar_id === presetId);

  // ===== 4. presetAvatarId inválido é recusado =====
  const bad = FashionTryOnService.requestGeneration(orgA, customerId, lookId, "nao-existe");
  check("preset inexistente: recusa 'indisponível'", !bad.ok && /indispon/i.test((bad as any).error));

  // ===== 5. Sem preset e sem foto: orienta a subir OU escolher avatar =====
  const noneRes = FashionTryOnService.requestGeneration(orgA, customerId, lookId);
  check("sem preset e sem foto: mensagem cita 'avatar da loja'", !noneRes.ok && /avatar da loja/i.test((noneRes as any).error));

  // ===== 6. processJob lê a imagem do PRESET (em /media), não 'avatar_missing' =====
  await FashionTryOnService.processJob(jobId); // chave fake → falha técnica no provedor, mas achou a imagem
  const done = db.prepare(`SELECT status, error_code FROM fashion_tryon_jobs WHERE id = ?`).get(jobId) as any;
  check("achou a imagem do preset (erro NÃO é avatar_missing)", done.error_code && done.error_code !== "avatar_missing");

  // ===== 7. preset apontando p/ arquivo inexistente → avatar_missing no processJob =====
  const ghost = FashionPresetAvatarService.create(orgA, { imageUrl: `/media/ghost-${randomUUID()}.jpg` });
  db.prepare(`UPDATE fashion_usage_credits SET used_count = 0, reserved_count = 0 WHERE organization_id = ? AND customer_id = ?`).run(orgA, customerId);
  const gen2 = FashionTryOnService.requestGeneration(orgA, customerId, lookId, ghost.id!);
  await FashionTryOnService.processJob((gen2 as any).jobId);
  const ghostJob = db.prepare(`SELECT error_code FROM fashion_tryon_jobs WHERE id = ?`).get((gen2 as any).jobId) as any;
  check("preset sem arquivo: falha 'avatar_missing'", ghostJob.error_code === "avatar_missing");

  delete process.env.OPENAI_API_KEY;

  // ===== 8. remove =====
  check("remove preset ok", FashionPresetAvatarService.remove(orgA, presetId) === true);
  check("preset removido some da lista", !FashionPresetAvatarService.get(orgA, presetId));

  // --- Relatório ---
  console.log("\n=== TEST: Avatares preset no provador (ADR-103) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Avatares preset OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
