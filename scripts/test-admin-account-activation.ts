/**
 * TEST — Ativação de conta no Master Admin (liberar a TOULON).
 *
 * Cobre os dois gaps fechados: (1) atribuir/trocar o PLANO de uma org existente
 * (PlanService.setPlan) libera o teto de módulos do plano na hora; (2) mudar o
 * billing_status pela porta auditável (setBillingStatus) ZERA a régua de
 * inadimplência ao voltar para active/trialing — o que o UPDATE cru do admin
 * deixava preso.
 *
 * Uso: npm run test:admin-account-activation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-admin-act-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-admin-act-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PlanService } = await import("../src/server/PlanService.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");

  const orgId = `org_toulon_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, billing_status) VALUES (?, ?, 'TOULON', 'active', 'active')`)
    .run(randomUUID(), orgId);
  // Vertical moda → grava enabled_modules (inclui 'estudio' no preset).
  ModuleService.applyVertical(orgId, "moda");
  check("moda ligou 'estudio' no enabled_modules", (ModuleService.enabledModules(orgId) || []).includes("estudio"));

  // Planos: um SEM 'estudio' no teto (start) e um COM (growth). Semeia direto.
  const startFeat = JSON.stringify({ modules: ["catalogo", "vendas", "loja", "pagamentos", "campanhas", "integracoes"] });
  const growthFeat = JSON.stringify({ modules: ["catalogo", "vendas", "loja", "pagamentos", "campanhas", "integracoes", "estudio", "diretor", "rie", "execucao"] });
  db.prepare(`INSERT OR REPLACE INTO plans (id, name, price, features) VALUES ('start_t', 'Start', 597, ?)`).run(startFeat);
  db.prepare(`INSERT OR REPLACE INTO plans (id, name, price, features) VALUES ('growth_t', 'Growth', 1797, ?)`).run(growthFeat);

  // ===== 1. setPlan valida o plano =====
  check("setPlan rejeita plano inexistente", PlanService.setPlan(orgId, "nao_existe").ok === false);

  // ===== 2. Plano START (sem estudio) → Estúdio fica fora do teto =====
  check("setPlan('start_t') ok", PlanService.setPlan(orgId, "start_t").ok === true);
  check("plan_id gravado = start_t", (db.prepare(`SELECT plan_id FROM organization_settings WHERE organization_id = ?`).get(orgId) as any).plan_id === "start_t");
  check("Estúdio BLOQUEADO no Start (fora do teto)", ModuleService.isEnabled(orgId, "estudio") === false);
  check("Catálogo liberado no Start", ModuleService.isEnabled(orgId, "catalogo") === true);

  // ===== 3. Trocar para GROWTH → Estúdio entra no teto na hora =====
  check("setPlan('growth_t') ok", PlanService.setPlan(orgId, "growth_t").ok === true);
  check("Estúdio LIBERADO no Growth", ModuleService.isEnabled(orgId, "estudio") === true);

  // ===== 4. setBillingStatus zera a régua de inadimplência ao reativar =====
  db.prepare(`UPDATE organization_settings SET billing_status='past_due', billing_dunning_stage='d5' WHERE organization_id=?`).run(orgId);
  const okBill = PlanService.setBillingStatus(orgId, "active", { reason: "admin_panel" });
  const after = db.prepare(`SELECT billing_status, billing_dunning_stage FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  check("setBillingStatus('active') ok", okBill === true);
  check("billing_status = active", after.billing_status === "active");
  check("régua de inadimplência ZERADA (dunning_stage null)", after.billing_dunning_stage === null);
  check("setBillingStatus rejeita estado inválido", PlanService.setBillingStatus(orgId, "banana") === false);

  // ===== 5. Suspenso NÃO zera a régua (só active/trialing) =====
  db.prepare(`UPDATE organization_settings SET billing_dunning_stage='d10' WHERE organization_id=?`).run(orgId);
  PlanService.setBillingStatus(orgId, "suspended");
  const susp = db.prepare(`SELECT billing_dunning_stage FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
  check("suspender preserva a régua (dunning intacto)", susp.billing_dunning_stage === "d10");

  // --- Relatório ---
  console.log("\n=== TEST: Ativação de conta no Master Admin ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Ativação de conta OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
