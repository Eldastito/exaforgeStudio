/**
 * TEST — Comigo/Motor de Precificação (ADR-111 D3 / ADR-088 D6, PR #2).
 *
 * Cobre o cálculo puro (revenda/fabricação/serviço), o preço sugerido com
 * guarda-corpo, a dica de "custos que você esquece" e o loop estimativa→realidade
 * (calibração recalcula rendimento/custo real).
 *
 * Uso: npm run test:comigo-pricing
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-price-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-price-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoPricingService: P } = await import("../src/server/ComigoPricingService.js");

  // ===== 1. Custo — REVENDA (insumos + indiretos, yield 1) =====
  const rev = P.unitCost({ kind: "revenda" }, [
    { label: "custo de compra", kind: "insumo", amount: 3 },
    { label: "transporte", kind: "indireto", amount: 0.5 },
  ]);
  check("revenda: unitCost = 3.50", near(rev.unitCost, 3.5));
  check("revenda: yield = 1", rev.yield === 1);

  // ===== 2. Custo — FABRICAÇÃO (denominador = rendimento) =====
  // pipoca: 1kg de milho (R$8) + óleo/sal/embalagem (R$4) = R$12 ÷ 40 saquinhos = 0,30
  const fab = P.unitCost({ kind: "fabricacao", yield_qty: 40 }, [
    { label: "milho", kind: "insumo", amount: 8 },
    { label: "óleo+sal", kind: "insumo", amount: 2 },
    { label: "embalagem (saquinho)", kind: "indireto", amount: 2 },
  ]);
  check("fabricação: unitCost = 0.30 (12÷40)", near(fab.unitCost, 0.3));
  check("fabricação: yield = 40", fab.yield === 40);

  // ===== 3. Custo — SERVIÇO (tempo × valor da hora) =====
  // manicure: insumo R$5 + 45 min a R$40/h = R$5 + R$30 = R$35
  const serv = P.unitCost({ kind: "servico", labor_minutes: 45 }, [
    { label: "esmalte+material", kind: "insumo", amount: 5 },
  ], 40);
  check("serviço: tempo (45min @ R$40/h) = 30", near(serv.tempo, 30));
  check("serviço: unitCost = 35", near(serv.unitCost, 35));

  // ===== 4. Preço sugerido + guarda-corpo =====
  const sp = P.suggestPrice(0.3, 0.4); // 0.30 ÷ (1-0.4) = 0.50
  check("suggestPrice: custo 0.30 margem 40% = 0.50", near(sp.price, 0.5));
  const clamp = P.suggestPrice(10, 1.5); // margem absurda travada em 0.9
  check("suggestPrice: margem clampada a 0.9", clamp.margin === 0.9);
  check("suggestPrice: preço finito com margem clampada", Number.isFinite(clamp.price) && clamp.price === 100);
  check("marginOf: preço 50 custo 35 → 0.30", near(P.marginOf(50, 35), 0.3));

  // ===== 5. "Custos que você esquece" =====
  const missingEmpty = P.missingCostsHint([]).map((m) => m.key);
  check("missing: ficha vazia lista todos os 6", missingEmpty.length === 6);
  const withSome = P.missingCostsHint([
    { label: "Saquinho G", kind: "indireto", amount: 2 },   // casa embalagem
    { label: "Taxa da maquininha", kind: "indireto", amount: 1 }, // casa taxa_pix
  ]).map((m) => m.key);
  check("missing: embalagem detectada via 'saquinho'", !withSome.includes("embalagem"));
  check("missing: taxa_pix detectada via 'maquininha'", !withSome.includes("taxa_pix"));
  check("missing: gás ainda falta", withSome.includes("gas"));

  // ===== 6. Loop estimativa→realidade (calibração via DB) =====
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_hour_value) VALUES (?, ?, 'X', 'active', ?)`)
    .run(randomUUID(), orgId, 40);
  const recipeId = randomUUID();
  db.prepare(`INSERT INTO comigo_recipes (id, organization_id, name, kind, yield_qty) VALUES (?, ?, 'Pipoca', 'fabricacao', 40)`)
    .run(recipeId, orgId);
  db.prepare(`INSERT INTO comigo_recipe_costs (id, recipe_id, label, kind, amount, is_estimate) VALUES (?, ?, 'milho', 'insumo', 12, 1)`)
    .run(randomUUID(), recipeId);

  const before = P.computeForRecipe(orgId, recipeId)!;
  check("compute: custo inicial 0.30 (12÷40, chute)", near(before.breakdown.unitCost, 0.3));
  check("compute: marcado como chute", before.breakdown.hasEstimate === true);

  // Fechou o dia: rendeu 30 (não 40), 3 queimaram. Recalibra.
  const after = P.applyCalibration(orgId, recipeId, 30, 3, "3 queimaram")!;
  check("calibração: custo real recalculado 0.40 (12÷30)", near(after.breakdown.unitCost, 0.4));
  const recRow = db.prepare("SELECT yield_qty FROM comigo_recipes WHERE id = ?").get(recipeId) as any;
  check("calibração: rendimento da ficha vira 30 (real)", Number(recRow.yield_qty) === 30);
  const calibCount = (db.prepare("SELECT COUNT(*) c FROM comigo_calibrations WHERE recipe_id = ?").get(recipeId) as any).c;
  check("calibração: registro de calibração persistido", calibCount === 1);

  // ===== 7. Isolamento: recipe de outra org não é acessível =====
  const other = P.computeForRecipe(`org_${randomUUID().slice(0, 8)}`, recipeId);
  check("isolamento: recipe não vaza p/ outra org", other === null);

  // --- Relatório ---
  console.log("\n=== TEST: Comigo — Motor de Precificação (ADR-111/088) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Motor de precificação OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
