/**
 * TEST — Vertical × plano (ADR-092): vertical = wishlist, plano = teto.
 *
 * `applyVertical` liga por padrão só a interseção preset ∩ módulos do plano.
 * O que a vertical sugere mas o plano não entrega NÃO é pré-ligado (fica como
 * "requer upgrade" na tela). Cobre também a nova vertical "moda" (com Estúdio),
 * varejo sem cadências e serviços com reservas opt-in — sem regressão das
 * verticais existentes.
 *
 * Uso: npm run test:vertical-plan-intersection
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vert-plan-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-vert-plan-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { VERTICALS, getVertical } = await import("../src/server/verticals.js");

  function seedOrg(planId?: string) {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'X', 'active', ?)`)
      .run(randomUUID(), orgId, planId || null);
    return orgId;
  }
  const enabledOf = (orgId: string) => { const r = db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id=?`).get(orgId) as any; return r?.enabled_modules ? JSON.parse(r.enabled_modules) as string[] : null; };

  // ===== 1. Vertical "moda" existe com Estúdio no preset =====
  const moda = getVertical("moda");
  check("vertical 'moda' existe", !!moda);
  check("moda tem estudio no preset", !!moda && moda.modules.includes("estudio"));
  check("moda aparece no catálogo de verticais (card)", VERTICALS.some(v => v.key === "moda" && v.icon === "👗"));

  // ===== 2. Presets revisados (ADR-092) =====
  check("varejo NÃO tem mais cadencias", !getVertical("varejo")!.modules.includes("cadencias"));
  check("serviços NÃO tem reservas por padrão (opt-in)", !getVertical("servicos")!.modules.includes("reservas"));

  // ===== 3. Moda + Autônomo = interseção (teto recorta a wishlist) =====
  const orgModaAuto = seedOrg("autonomo");
  ModuleService.applyVertical(orgModaAuto, "moda");
  const modaAuto = enabledOf(orgModaAuto)!;
  check("moda+autonomo liga catalogo/vendas/loja/pagamentos/integracoes", ["catalogo", "vendas", "loja", "pagamentos", "integracoes"].every(m => modaAuto.includes(m)));
  check("moda+autonomo NÃO liga estudio (acima do teto)", !modaAuto.includes("estudio"));
  check("moda+autonomo NÃO liga campanhas/diretor (acima do teto)", !modaAuto.includes("campanhas") && !modaAuto.includes("diretor"));
  check("estudio fica indisponível no autonomo (isEnabled=false)", !ModuleService.isEnabled(orgModaAuto, "estudio"));

  // ===== 4. Moda + Growth = Estúdio entra =====
  const orgModaGrowth = seedOrg("growth");
  ModuleService.applyVertical(orgModaGrowth, "moda");
  const modaGrowth = enabledOf(orgModaGrowth)!;
  check("moda+growth liga estudio", modaGrowth.includes("estudio"));
  check("moda+growth liga catalogo/loja/campanhas/diretor", ["catalogo", "loja", "campanhas", "diretor"].every(m => modaGrowth.includes(m)));
  check("estudio disponível no growth (isEnabled=true)", ModuleService.isEnabled(orgModaGrowth, "estudio"));

  // ===== 5. Sem plano = sem teto (preset inteiro) =====
  const orgNoPlan = seedOrg();
  ModuleService.applyVertical(orgNoPlan, "moda");
  const noPlan = enabledOf(orgNoPlan)!;
  check("moda sem plano liga o preset inteiro (inclui estudio)", noPlan.includes("estudio") && noPlan.includes("diretor"));

  // ===== 6. Verticais existentes aplicam sem quebrar =====
  let allApplied = true;
  for (const v of VERTICALS) {
    const o = seedOrg("scale");
    try { ModuleService.applyVertical(o, v.key); if (!Array.isArray(enabledOf(o))) allApplied = false; }
    catch { allApplied = false; }
  }
  check("todas as verticais aplicam sem erro (com plano Scale)", allApplied);

  // ===== 7. Grandfather: add-on já ligado sobrevive à re-aplicação =====
  const orgGf = seedOrg("growth");
  ModuleService.applyVertical(orgGf, "moda");
  ModuleService.setModules(orgGf, [...enabledOf(orgGf)!, "radar"]); // liga add-on manualmente
  ModuleService.applyVertical(orgGf, "moda"); // re-aplica
  check("add-on 'radar' preservado ao re-aplicar a vertical", enabledOf(orgGf)!.includes("radar"));

  // ===== 8. overview() agrupa em 3 seções (ADR-093) =====
  const ovAuto = ModuleService.overview(orgModaAuto);
  const sect = (o: any, key: string) => o.items.find((i: any) => i.key === key);
  check("overview: catalogo é 'recommended' (moda+autonomo)", sect(ovAuto, "catalogo")?.section === "recommended");
  check("overview: agenda é 'available' (no plano, fora do preset)", sect(ovAuto, "agenda")?.section === "available");
  check("overview: estudio é 'upgrade' e marcado sugerido p/ a vertical", sect(ovAuto, "estudio")?.section === "upgrade" && sect(ovAuto, "estudio")?.recommended === true);
  const ovGrowth = ModuleService.overview(orgModaGrowth);
  check("overview: estudio vira 'recommended' no growth", sect(ovGrowth, "estudio")?.section === "recommended");

  // --- Relatório ---
  console.log("\n=== TEST: Vertical × plano (ADR-092) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Interseção vertical × plano OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
