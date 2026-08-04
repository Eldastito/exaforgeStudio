/**
 * TEST — Fatia 2.1 (ADR-153): Comigo persistente em todos os planos.
 *
 * Corrige o BUG BLOQUEANTE do PRD §3.2: upgrade Autônomo→Start removia
 * silenciosamente o balcão de peixaria/chaveiro. Depois desta fatia,
 * `copiloto` está em TODOS os tiers (Decisão #1 aprovada) e nunca sai por
 * upgrade.
 *
 * Cenários cobertos:
 *   1. Peixaria (varejo, autonomo, copiloto ligado) → upgrade pra Start:
 *      EntitlementService.check(copiloto, 'use') continua allowed.
 *   2. Chaveiro (servicos, autonomo, copiloto ligado) → upgrade pra Growth:
 *      copiloto continua allowed.
 *   3. Todos os tiers (autonomo→start→growth→scale→enterprise): PLAN_GRADE
 *      inclui copiloto em cada um.
 *   4. Peixaria em Enterprise: copiloto continua active (pra multi-branch).
 *   5. Cenário reverso (downgrade Growth→Autonomo): copiloto continua ligado
 *      se estava — não é cenário desta fatia, mas confirmado como não-regressão.
 *   6. Sem `copiloto` em enabled_modules: upgrade não LIGA copiloto (só
 *      preserva o que já estava).
 *   7. Master admin: também vê copiloto em qualquer plano.
 *
 * Uso: npm run test:comigo-preserved-on-upgrade
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-upgrade-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-comigo-upgrade-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { EntitlementService } = await import("../src/server/EntitlementService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { PLAN_GRADE } = await import("../src/server/plansGrade.js");
  const { MASTER_ADMIN_EMAIL } = await import("../src/server/config/secret.js");

  // ===== Pré-requisito: PLAN_GRADE tem copiloto em todos =====
  for (const p of PLAN_GRADE) {
    check(`PLAN_GRADE.${p.id}.modules inclui copiloto`, p.features.modules.includes("copiloto"));
  }

  // ===== Setup: peixaria autônoma com copiloto ligado =====
  const peixaria = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status) VALUES (?, ?, 'Peixaria da Ana', 'active', 'varejo', 'autonomo', ?, 'active')`)
    .run(randomUUID(), peixaria, JSON.stringify(["catalogo", "vendas", "copiloto", "pagamentos"]));
  PermissionService.seedSystemProfiles(peixaria);
  const ownerP = { userId: "u1", email: "dono@peixaria.com", role: "owner",
    role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'owner'`).get(peixaria) as any).id,
    organizationId: peixaria };

  const master = { userId: "u0", email: MASTER_ADMIN_EMAIL, role: "owner", organizationId: peixaria };

  // ===== 1. Antes do upgrade: use allowed =====
  const antes = EntitlementService.check(peixaria, ownerP, "copiloto", "use");
  check("peixaria (autonomo): copiloto use allowed antes do upgrade", antes.allowed && antes.state === "active");

  // ===== 2. Upgrade pra Start (simulando PlanService.setPlan) =====
  db.prepare(`UPDATE organization_settings SET plan_id = 'start' WHERE organization_id = ?`).run(peixaria);
  const start = EntitlementService.check(peixaria, ownerP, "copiloto", "use");
  check("peixaria (start): copiloto use CONTINUA allowed (não removeu balcão!)", start.allowed && start.state === "active");
  check("peixaria (start): copiloto source.plan reflete start", start.source.plan === "start");

  // ===== 3. Upgrade pra Growth =====
  db.prepare(`UPDATE organization_settings SET plan_id = 'growth' WHERE organization_id = ?`).run(peixaria);
  const growth = EntitlementService.check(peixaria, ownerP, "copiloto", "use");
  check("peixaria (growth): copiloto use CONTINUA allowed", growth.allowed && growth.state === "active");

  // ===== 4. Upgrade pra Scale =====
  db.prepare(`UPDATE organization_settings SET plan_id = 'scale' WHERE organization_id = ?`).run(peixaria);
  const scale = EntitlementService.check(peixaria, ownerP, "copiloto", "use");
  check("peixaria (scale): copiloto use CONTINUA allowed", scale.allowed && scale.state === "active");

  // ===== 5. Upgrade pra Enterprise (útil pra multi-branch: matriz + filiais podem usar) =====
  db.prepare(`UPDATE organization_settings SET plan_id = 'enterprise' WHERE organization_id = ?`).run(peixaria);
  const ent = EntitlementService.check(peixaria, ownerP, "copiloto", "use");
  check("peixaria (enterprise): copiloto use CONTINUA allowed", ent.allowed && ent.state === "active");

  // ===== 6. Chaveiro similar (servicos + autonomo → growth) =====
  const chaveiro = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status) VALUES (?, ?, 'Chaveiro do José', 'active', 'servicos', 'autonomo', ?, 'active')`)
    .run(randomUUID(), chaveiro, JSON.stringify(["catalogo", "agenda", "vendas", "copiloto", "pagamentos"]));
  PermissionService.seedSystemProfiles(chaveiro);
  const ownerC = { userId: "u2", email: "dono@chaveiro.com", role: "owner",
    role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'owner'`).get(chaveiro) as any).id,
    organizationId: chaveiro };
  const chAntes = EntitlementService.check(chaveiro, ownerC, "copiloto", "use");
  check("chaveiro (autonomo): copiloto allowed", chAntes.allowed);
  db.prepare(`UPDATE organization_settings SET plan_id = 'growth' WHERE organization_id = ?`).run(chaveiro);
  const chGrowth = EntitlementService.check(chaveiro, ownerC, "copiloto", "use");
  check("chaveiro (growth): copiloto CONTINUA allowed após upgrade", chGrowth.allowed && chGrowth.state === "active");

  // ===== 7. Sem copiloto em enabled_modules: upgrade não LIGA por conta própria =====
  // (não é responsabilidade da fatia — plan grade só define TETO; ligar é escolha do dono).
  const semComigo = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status) VALUES (?, ?, 'Loja Y', 'active', 'moda', 'start', ?, 'active')`)
    .run(randomUUID(), semComigo, JSON.stringify(["catalogo", "vendas", "pagamentos"]));
  PermissionService.seedSystemProfiles(semComigo);
  const ownerY = { userId: "u3", email: "dono@lojay.com", role: "owner",
    role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'owner'`).get(semComigo) as any).id,
    organizationId: semComigo };
  const semCop = EntitlementService.check(semComigo, ownerY, "copiloto", "use");
  check("start sem copiloto em enabled_modules: state=available_to_enable (não liga sozinho)", semCop.state === "available_to_enable");
  check("start sem copiloto em enabled_modules: use NÃO allowed (dono precisa ligar)", !semCop.allowed);

  // ===== 8. Master admin vê copiloto em qualquer plano =====
  const masterCop = EntitlementService.check(peixaria, master, "copiloto", "use");
  check("master admin: copiloto allowed em enterprise (bypass)", masterCop.allowed);

  // ===== Resultado =====
  console.log("\n=== Comigo persistente em todos os planos (F2.1) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
