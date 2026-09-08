/**
 * TEST — Fala Tu: o flag `falatu_enabled` libera o módulo de verdade (ADR-151, correção durável).
 * Reproduz o caso TOULON: org de VAREJO num plano com TETO de módulos que NÃO inclui `falatu`
 * (ex.: "Cortesia"). Prova que:
 *   - SEM o flag → `falatu` fica HIDDEN pro dono (o menu não aparece) — era o bug.
 *   - COM o flag → `falatu` fica VISIBLE + allowed (o Admin Master "liberou o Fala Tu"), mesmo o
 *     plano não cobrindo — o flag É a contratação.
 *   - `ModuleService.isEnabled('falatu')` passa a honrar o flag.
 *   - RBAC continua valendo: vendedor (nível none) NÃO vê, mesmo com o flag ligado.
 *   - Isolamento por org.
 *
 * Uso: npm run test:falatu-entitlement
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-ent-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-falatu-ent-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { EntitlementService } = await import("../src/server/EntitlementService.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");

  // Plano com teto de módulos que NÃO inclui `falatu` (simula "Cortesia").
  const CAPPED = ["atendimento", "contatos", "relatorios", "configuracoes", "estudio"];
  db.prepare(`INSERT INTO plans (id, name, price, features) VALUES ('plan_capped', 'Cortesia', 0, ?)`).run(JSON.stringify({ modules: CAPPED }));

  const mkOrg = () => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical, plan_id) VALUES (?, 'Toulon Teste', 'active', 'moda', 'plan_capped')`).run(o);
    return o;
  };
  const owner = (org: string) => ({ userId: randomUUID(), email: "toulon@teste.com", role: "owner", organizationId: org });

  const A = mkOrg();
  const donoA = owner(A);

  // ── 1. SEM o flag → falatu não cobre (plano capped) → HIDDEN pro dono (o bug) ──
  const semFlag = EntitlementService.check(A, donoA, "falatu", "view");
  check("1.1 sem flag: falatu NÃO visível pro dono (plano não cobre)", semFlag.visibility !== "visible");
  check("1.2 sem flag: isEnabled('falatu') = false", ModuleService.isEnabled(A, "falatu") === false);

  // ── 2. COM o flag → o Admin Master liberou → VISIBLE + allowed, mesmo o plano não cobrindo ──
  FalaTuService.setOrgEnabled(A, true);
  const comFlag = EntitlementService.check(A, donoA, "falatu", "view");
  check("2.1 com flag: falatu VISIBLE pro dono", comFlag.visibility === "visible");
  check("2.2 com flag: allowed (view)", comFlag.allowed === true);
  check("2.3 com flag: isEnabled('falatu') = true", ModuleService.isEnabled(A, "falatu") === true);
  check("2.4 com flag: state active (não 'available_to_enable')", comFlag.state === "active");

  // ── 3. Desligar de volta → volta a HIDDEN (reversível) ──
  FalaTuService.setOrgEnabled(A, false);
  check("3.1 desligado de novo: volta a não-visível", EntitlementService.check(A, donoA, "falatu", "view").visibility !== "visible" && ModuleService.isEnabled(A, "falatu") === false);

  // ── 4. RBAC preservado: vendedor (nível none) NÃO vê, mesmo com o flag ligado ──
  FalaTuService.setOrgEnabled(A, true);
  const vendProfile = "prof_vend_" + randomUUID().slice(0, 6);
  db.prepare(`INSERT INTO role_profiles (id, organization_id, name, system_key, is_system) VALUES (?, ?, 'Vendedor', 'vendedor', 1)`).run(vendProfile, A);
  // sem linha em role_permissions p/ 'falatu' → levelFor devolve 'none'
  const vendedor = { userId: randomUUID(), email: "vend@teste.com", role: "agent", role_profile_id: vendProfile, organizationId: A };
  const vendCheck = EntitlementService.check(A, vendedor, "falatu", "view");
  check("4.1 vendedor (rbac none) NÃO vê o Fala Tu, mesmo com flag ligado (RBAC preservado)", vendCheck.visibility === "hidden");

  // ── 5. Isolamento: org B (sem flag) não herda o de A ──
  const B = mkOrg();
  check("5.1 org B sem flag continua não-visível", EntitlementService.check(B, owner(B), "falatu", "view").visibility !== "visible" && ModuleService.isEnabled(B, "falatu") === false);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-entitlement: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
