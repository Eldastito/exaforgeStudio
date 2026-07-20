/**
 * TEST — Grade de planos ADR-091 (Bloco A): seed, limites, migração das orgs.
 *
 * Trava o contrato comercial da grade nova (Autônomo/Start/Growth/Scale/
 * Enterprise): preços, limites, herança de módulos (teto do plano) e a
 * migração idempotente das orgs da grade antiga (Starter→Autônomo, Pro→Growth,
 * Business→Scale), sem clobber de edição do admin.
 *
 * Uso: npm run test:plans-migration
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-plans-mig-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-plans-mig-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { applyPlanGrade, PLAN_GRADE } = await import("../src/server/plansGrade.js");
  const feat = (id: string) => { const r = db.prepare(`SELECT features FROM plans WHERE id = ?`).get(id) as any; return r ? JSON.parse(r.features) : null; };

  // ===== 1. Grade nova presente; grade antiga ausente =====
  const ids = (db.prepare(`SELECT id FROM plans`).all() as any[]).map(r => r.id);
  for (const t of ["autonomo", "start", "growth", "scale", "enterprise"]) check(`plano '${t}' existe`, ids.includes(t));
  check("Starter/Pro/Business removidos", !ids.includes("starter") && !ids.includes("pro") && !ids.includes("business"));
  check("Cortesia preservada", ids.includes("cortesia"));

  // ===== 2. Preços + limites (ADR-091 §1/§3) =====
  const autonomo = db.prepare(`SELECT price FROM plans WHERE id='autonomo'`).get() as any;
  check("Autônomo R$ 247", autonomo?.price === 247);
  check("Autônomo: ai 500 / 1 canal / 1 usuário / trial 30", (() => { const f = feat("autonomo"); return f.ai_monthly_limit === 500 && f.channels_limit === 1 && f.users_limit === 1 && f.trial_days === 30; })());
  check("Scale R$ 4797 / ai 30000 / 20 usuários", (() => { const p = db.prepare(`SELECT price FROM plans WHERE id='scale'`).get() as any; const f = feat("scale"); return p.price === 4797 && f.ai_monthly_limit === 30000 && f.users_limit === 20; })());
  check("Enterprise sem trava (limites 0)", (() => { const f = feat("enterprise"); return f.ai_monthly_limit === 0 && f.contacts_limit === 0; })());
  check("preço anual/mês do Growth = 1497", feat("growth").price_annual_month === 1497);

  // ===== 3. Herança de módulos (teto do plano) =====
  const mods = (id: string) => feat(id).modules as string[];
  check("Autônomo tem catalogo+loja+copiloto, NÃO campanhas", mods("autonomo").includes("catalogo") && mods("autonomo").includes("copiloto") && !mods("autonomo").includes("campanhas"));
  check("Start adiciona campanhas/areas/diretor", ["campanhas", "areas", "diretor"].every(m => mods("start").includes(m)));
  check("Growth herda Start + estudio/reservas/assinaturas", mods("start").every(m => mods("growth").includes(m)) && ["estudio", "reservas", "assinaturas"].every(m => mods("growth").includes(m)));
  check("Scale adiciona compras/eventos/radar/retail", ["compras", "eventos", "radar", "retail"].every(m => mods("scale").includes(m)));
  check("Enterprise adiciona vms/clinica/prospect", ["vms", "clinica", "prospect"].every(m => mods("enterprise").includes(m)));
  check("copiloto é exclusivo do Autônomo", mods("autonomo").includes("copiloto") && !mods("start").includes("copiloto"));

  // ===== 4. Migração das orgs da grade antiga =====
  // Recria planos legados + orgs neles, e roda a migração de novo (idempotente).
  const insLegacy = db.prepare(`INSERT OR IGNORE INTO plans (id, name, price, features) VALUES (?, ?, ?, '{}')`);
  insLegacy.run("starter", "Starter", 99); insLegacy.run("pro", "Pro", 299); insLegacy.run("business", "Business", 799);
  const orgS = randomUUID(), orgP = randomUUID(), orgB = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'A', 'active', 'starter')`).run(randomUUID(), orgS);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'B', 'active', 'pro')`).run(randomUUID(), orgP);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'C', 'active', 'business')`).run(randomUUID(), orgB);

  applyPlanGrade(db);

  const planOf = (org: string) => (db.prepare(`SELECT plan_id FROM organization_settings WHERE organization_id = ?`).get(org) as any)?.plan_id;
  check("Starter → Autônomo", planOf(orgS) === "autonomo");
  check("Pro → Growth", planOf(orgP) === "growth");
  check("Business → Scale", planOf(orgB) === "scale");
  const idsAfter = (db.prepare(`SELECT id FROM plans`).all() as any[]).map(r => r.id);
  check("planos legados removidos de novo", !idsAfter.includes("starter") && !idsAfter.includes("pro") && !idsAfter.includes("business"));

  // ===== 5. Idempotência + não clobbra edição do admin =====
  db.prepare(`UPDATE plans SET price = 999 WHERE id = 'autonomo'`).run();
  applyPlanGrade(db);
  const editedPrice = (db.prepare(`SELECT price FROM plans WHERE id='autonomo'`).get() as any).price;
  check("re-rodar NÃO sobrescreve preço editado pelo admin", editedPrice === 999);
  check("PLAN_GRADE exporta 5 tiers", Array.isArray(PLAN_GRADE) && PLAN_GRADE.length === 5);

  // --- Relatório ---
  console.log("\n=== TEST: Grade de planos (ADR-091) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Grade de planos OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
