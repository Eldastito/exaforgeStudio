/**
 * TEST — Comunicação por vertical (BrandVerticalProfileService, PRD 07).
 * Prova o overlay por nicho + a REGRA DURA: a essência/promessa/mecanismo são HERDADAS do
 * Brand Core (nunca redefinidas pela vertical) + defaults semeados + validação de vertical +
 * merge parcial + resolver combinando herança × overlay. Escopo GLOBAL (master-only).
 *
 * Uso: npm run test:brand-vertical-profile
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bvp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-bvp-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { BrandVerticalProfileService: BVP } = await import("../src/server/BrandVerticalProfileService.js");
  const { BrandCoreService } = await import("../src/server/BrandCoreService.js");

  // ── 1. Validação de vertical (não inventa) ──
  check("1.1 vertical válida aceita (moda)", BVP.isValidVertical("moda") === true);
  check("1.2 vertical inválida rejeitada", BVP.isValidVertical("naoexiste") === false);
  let threw = false; try { BVP.get("naoexiste"); } catch { threw = true; }
  check("1.3 get de vertical inválida lança", threw);

  // ── 2. Defaults semeados só pros nichos citados (§ exemplos), demais vazios ──
  const moda = BVP.get("moda");
  check("2.1 moda nasce com rascunho (messagingExamples)", moda.overlay.messagingExamples.length > 0 && moda.configured === false);
  const food = BVP.get("food");
  check("2.2 vertical não-citada nasce vazia (não inventa)", food.overlay.pains.length === 0 && food.overlay.messagingExamples.length === 0);
  check("2.3 list traz todas as verticais conhecidas", BVP.list().length >= 10 && BVP.list().every((v: any) => typeof v.configured === "boolean"));

  // ── 3. set: merge parcial + configured ──
  const saved = BVP.set("petshop", { pains: ["dor A", "dor B"], terminology: ["tutor", "pet"] }, "master@zapflow");
  check("3.1 set grava e marca configured", saved.configured === true && saved.overlay.pains.length === 2 && saved.overlay.terminology.length === 2);
  // merge parcial: setar só desiredOutcomes preserva pains
  const saved2 = BVP.set("petshop", { desiredOutcomes: ["operação acompanhada"] }, "master@zapflow");
  check("3.2 merge parcial preserva pains", saved2.overlay.pains.length === 2 && saved2.overlay.desiredOutcomes.length === 1);

  // ── 4. Resolver: herança do Brand Core (REGRA DURA — vertical não redefine essência) ──
  // Sem Brand Core publicado → inherited null (honesto).
  const r0 = BVP.resolve("petshop");
  check("4.1 sem Brand Core publicado → inherited null, brandConfigured false", r0.inherited === null && r0.brandConfigured === false);
  check("4.2 overlay presente mesmo sem Brand Core", r0.overlay.pains.length === 2 && r0.verticalConfigured === true);
  // Publica um Brand Core → a herança passa a vir DELE.
  const d = BrandCoreService.createDraft("master@zapflow");
  BrandCoreService.publish("master@zapflow", d.revision);
  const pub = BrandCoreService.getPublished() as any;
  const r1 = BVP.resolve("petshop");
  check("4.3 com Brand Core → inherited.essence vem do CORE (não da vertical)", r1.inherited?.essence === pub.essence && !!r1.inherited?.essence);
  check("4.4 inherited traz promise + mechanism do core", r1.inherited?.promise === pub.promise && Array.isArray(r1.inherited?.mechanism?.steps));
  check("4.5 overlay da vertical continua ao lado da herança", r1.overlay.pains.length === 2 && r1.brandConfigured === true);

  // ── 5. Escopo GLOBAL: overlay NÃO tem campos de essência (só herda) ──
  check("5.1 overlay não carrega essence/promise (herança é do core)", !("essence" in (r1.overlay as any)) && !("promise" in (r1.overlay as any)));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} brand-vertical-profile: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
