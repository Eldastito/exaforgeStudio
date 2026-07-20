/**
 * TEST — Consumo excedente de IA: pacote extra + recompra automática (ADR-091 §4, Bloco D).
 *
 * Ao atingir o limite mensal de ações do plano, a org compra um PACOTE EXTRA
 * (folga só no mês) ou liga a recompra automática ao cruzar 90%. O enforcement
 * (PlanService.aiAllowed) passa a considerar limite + top-ups.
 *
 * Uso: npm run test:consumption-topup
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-topup-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-topup-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ConsumptionService } = await import("../src/server/ConsumptionService.js");
  const { PlanService } = await import("../src/server/PlanService.js");

  const seedUsage = (orgId: string, n: number) => {
    const ins = db.prepare(`INSERT INTO ai_interactions_log (id, organization_id, created_at) VALUES (?, ?, datetime('now'))`);
    for (let i = 0; i < n; i++) ins.run(randomUUID(), orgId);
  };

  // Org no Growth (limite 10.000 ações/mês; pacote extra 15.000 por R$1.000).
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'TOULON', 'active', 'growth', 'active')`).run(randomUUID(), orgId);

  // ===== 1. Pacote correto do plano =====
  const pkg = ConsumptionService.packageFor(orgId);
  check("pacote do Growth = 15.000 ações por R$1.000", pkg?.actions === 15000 && pkg?.price === 1000);

  // ===== 2. No limite → IA bloqueia; comprar pacote destrava =====
  seedUsage(orgId, 10000); // atinge o limite
  check("no limite (10.000) a IA bloqueia", PlanService.aiAllowed(orgId).allowed === false && PlanService.aiAllowed(orgId).reason === "monthly_limit");
  const bought = ConsumptionService.buyTopup(orgId, "manual");
  check("compra de pacote credita 15.000", bought?.actions === 15000);
  check("folga sobe para 25.000", ConsumptionService.getAllowance(orgId) === 25000);
  check("com pacote, IA volta a responder", PlanService.aiAllowed(orgId).allowed === true);

  const st = ConsumptionService.status(orgId);
  check("status: used 10.000 / allowance 25.000", st.used === 10000 && st.allowance === 25000 && st.baseLimit === 10000 && st.topupActions === 15000);

  // ===== 3. Recompra automática ao cruzar 90% (opt-in) =====
  const org2 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'Auto', 'active', 'growth', 'active')`).run(randomUUID(), org2);
  ConsumptionService.setAutoTopup(org2, true);
  seedUsage(org2, 9200); // 92% de 10.000
  const auto = ConsumptionService.maybeAutoTopup(org2);
  check("recompra automática dispara ao passar de 90%", auto?.actions === 15000);
  check("após recompra automática a folga é 25.000", ConsumptionService.getAllowance(org2) === 25000);
  const auto2 = ConsumptionService.maybeAutoTopup(org2);
  check("não recompra de novo (uso caiu abaixo de 90% da nova folga)", auto2 === null);

  // ===== 4. Recompra automática NÃO dispara sem opt-in =====
  const org3 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'Sem auto', 'active', 'growth', 'active')`).run(randomUUID(), org3);
  seedUsage(org3, 9500);
  check("sem opt-in, recompra automática não dispara", ConsumptionService.maybeAutoTopup(org3) === null);

  // ===== 5. Enterprise/sem-pacote: buyTopup retorna null =====
  const org4 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'Ent', 'active', 'enterprise', 'active')`).run(randomUUID(), org4);
  check("Enterprise não tem pacote fixo (buyTopup null)", ConsumptionService.buyTopup(org4) === null);
  check("Enterprise é ilimitado (allowance 0)", ConsumptionService.getAllowance(org4) === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Consumo excedente de IA (ADR-091 §4) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Consumo excedente de IA OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
