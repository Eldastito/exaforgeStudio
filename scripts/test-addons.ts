/**
 * TEST — Add-ons contratáveis (ADR-091 §5, Bloco D).
 *
 * Um add-on é um módulo acima do teto do plano que a org contrata avulso.
 * Contratar estende modulesForPlan e liga o módulo (isEnabled=true); cancelar
 * corta o acesso. Só add-ons do catálogo do plano podem ser contratados.
 *
 * Uso: npm run test:addons
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-addons-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-addons-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AddonService } = await import("../src/server/AddonService.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { PlanService } = await import("../src/server/PlanService.js");

  // Org no Start (não tem 'reservas' no teto).
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'Loja', 'active', 'start')`).run(randomUUID(), orgId);
  ModuleService.applyVertical(orgId, "servicos"); // liga os módulos do teto do Start

  // ===== 1. Catálogo do Start + reservas fora do teto =====
  const cat = AddonService.list(orgId);
  check("catálogo do Start oferece 'reservas' (R$800)", cat.available.some(a => a.key === "reservas" && a.price === 800));
  check("reservas NÃO está no teto do Start", !(PlanService.modulesForPlan(orgId) || []).includes("reservas"));
  check("reservas indisponível antes de contratar (isEnabled=false)", ModuleService.isEnabled(orgId, "reservas") === false);

  // ===== 2. Contratar reservas → estende teto + liga módulo =====
  const r = AddonService.contract(orgId, "reservas");
  ModuleService.enableModule(orgId, "reservas"); // (a rota faz isso)
  check("contratação ok (R$800)", r.ok && r.price === 800);
  check("teto do plano passa a incluir reservas", (PlanService.modulesForPlan(orgId) || []).includes("reservas"));
  check("reservas fica disponível (isEnabled=true)", ModuleService.isEnabled(orgId, "reservas") === true);
  check("aparece em 'ativos' e sai de 'disponíveis'", (() => { const l = AddonService.list(orgId); return l.active.some((a: any) => a.key === "reservas") && !l.available.some(a => a.key === "reservas"); })());

  // ===== 3. Add-on fora do catálogo do plano é rejeitado =====
  const bad = AddonService.contract(orgId, "vms"); // vms é add-on de Scale, não de Start
  check("add-on de outro tier é rejeitado", bad.ok === false);
  check("vms segue indisponível", ModuleService.isEnabled(orgId, "vms") === false);

  // ===== 4. Cancelar corta o acesso =====
  AddonService.cancel(orgId, "reservas");
  check("após cancelar, reservas sai do teto", !(PlanService.modulesForPlan(orgId) || []).includes("reservas"));
  check("após cancelar, reservas fica indisponível de novo", ModuleService.isEnabled(orgId, "reservas") === false);
  check("reservas volta pra 'disponíveis'", AddonService.list(orgId).available.some(a => a.key === "reservas"));

  // ===== 5. Contratar de novo é idempotente (não duplica) =====
  AddonService.contract(orgId, "reservas");
  AddonService.contract(orgId, "reservas");
  const activeCount = (db.prepare(`SELECT COUNT(*) c FROM org_addons WHERE organization_id = ? AND addon_key = 'reservas' AND status = 'active'`).get(orgId) as any).c;
  check("recontratar não duplica o ativo", activeCount === 1);

  // --- Relatório ---
  console.log("\n=== TEST: Add-ons contratáveis (ADR-091 §5) ===\n");
  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Add-ons OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
