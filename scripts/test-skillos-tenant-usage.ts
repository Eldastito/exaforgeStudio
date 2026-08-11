/**
 * TEST — PRD 4 F10 (Tenant Usage Experience): visão de CONSUMO de IA do tenant
 * (franquia %-ações + tendência + runs + alerta EXISTENTE), SEMPRE §30-safe (nunca
 * R$/US$). DB-backed, isolado por tmpDir. Determinístico. Prova:
 *
 *   - franquia REUSA ConsumptionService (used/allowance/pct) sem vazar package.price;
 *   - capacityLevel deriva por faixa (ok/attention/risk/exceeded);
 *   - runs REUSA a observabilidade §30-safe da F9;
 *   - tendência mês a mês por fronteira de mês (não 'now');
 *   - alertas: LÊ o sinal plan_near_limit_ai EXISTENTE e PROJETA §30-safe (descarta o
 *     uplift em R$ da evidência) — NÃO publica alerta novo (anti-duplicidade);
 *   - §30/D5: o payload inteiro passa por assertTenantSafe (sem custo/token);
 *   - ISOLAMENTO por org.
 *
 * Uso: npm run test:skillos-tenant-usage
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-skillos-tu-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-skillos-tu-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SkillOsTenantUsageService: TU } = await import("../src/server/SkillOsTenantUsageService.js");
  const { SkillOsObservabilityService: OBS } = await import("../src/server/SkillOsObservabilityService.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  // Plano com franquia de 100 ações/mês + pacote extra (preço NÃO deve vazar).
  db.prepare(`INSERT OR REPLACE INTO plans (id, name, price, features) VALUES ('growth', 'Growth', 1000, ?)`).run(JSON.stringify({ ai_monthly_limit: 100 }));
  for (const o of [orgA, orgB]) {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'X', 'active', 'growth')`).run(randomUUID(), o);
  }

  // mods = modificadores do datetime() do SQLite, cada um SEU argumento (nunca uma
  // string com vírgula — isso devolve NULL). null = agora (mês corrente).
  const action = (orgId: string, mods: string[] | null) => {
    if (mods === null) {
      db.prepare(`INSERT INTO ai_interactions_log (id, organization_id, agent_used) VALUES (?, ?, 'x')`).run(randomUUID(), orgId);
    } else {
      const ph = `datetime('now'${mods.map(() => ", ?").join("")})`;
      db.prepare(`INSERT INTO ai_interactions_log (id, organization_id, agent_used, created_at) VALUES (?, ?, 'x', ${ph})`).run(randomUUID(), orgId, ...mods);
    }
  };
  const run = (orgId: string, status: string, fallback = 0) => {
    db.prepare(`
      INSERT INTO ai_usage_log (id, organization_id, model, kind, run_id, provider, run_status, validation_status, fallback_used)
      VALUES (?, ?, 'm', 'k', ?, 'anthropic', ?, 'valid', ?)
    `).run(randomUUID(), orgId, randomUUID(), status, fallback);
  };

  // org A: 85 ações neste mês (85% de 100 → attention) + 50 no mês passado (tendência +70%).
  for (let i = 0; i < 85; i++) action(orgA, null);
  for (let i = 0; i < 50; i++) action(orgA, ["start of month", "-15 days"]); // meio do mês anterior
  // org A: 6 AI Runs (5 ok + 1 fallback).
  for (let i = 0; i < 5; i++) run(orgA, "ok");
  run(orgA, "fallback", 1);

  // ═══════════════ 1. franquia (REUSA ConsumptionService, §30-safe) ═══════════════
  const a = TU.summary(orgA);
  check("1.1 franquia used/allowance/pct", a.franquia.used === 85 && a.franquia.allowance === 100 && a.franquia.pct === 85);
  check("1.2 baseLimit + unlimited=false + hasTopupPackage", a.franquia.baseLimit === 100 && a.franquia.unlimited === false && a.franquia.hasTopupPackage === true);
  check("1.3 capacityLevel = attention (80–89)", a.capacityLevel === "attention");
  check("1.4 franquia NÃO expõe preço do pacote (§30)", !("package" in a.franquia) && !("price" in (a.franquia as any)));

  // ═══════════════ 2. runs (REUSA observabilidade F9) ═══════════════
  check("2.1 runs.total = 6", a.runs.total === 6);
  check("2.2 runs.successRate = 5/6", approx(a.runs.successRate, 5 / 6));
  check("2.3 runs.fallbackRate = 1/6", approx(a.runs.fallbackRate, 1 / 6));

  // ═══════════════ 3. tendência mês a mês (RN-004, count-based) ═══════════════
  check("3.1 trend.thisMonth = 85", a.trend.thisMonth === 85);
  check("3.2 trend.lastMonth = 50", a.trend.lastMonth === 50);
  check("3.3 trend.deltaPct = +70", a.trend.deltaPct === 70);

  // ═══════════════ 4. alertas: REUSA plan_near_limit_ai, projeta §30-safe ═══════════════
  // Publica o sinal EXISTENTE (como o PlanFitSignalPublisher faria), com uplift em R$
  // na evidência — a projeção da F10 deve DESCARTAR o R$.
  BS.publish(orgA, {
    domain: "plan", signalType: "plan_near_limit_ai", severity: "attention", basis: "fact", confidence: 1,
    impactAmount: 650, impactUnit: "BRL", sourceService: "PlanFitSignalPublisher",
    sourceEntityType: "organization", sourceEntityId: orgA,
    evidence: { metric: "ai", used: 85, limit: 100, pctInt: 85, upgradeTargetPlan: "scale", estimatedUpliftMonthly: 650 },
    dedupeKey: `plan:near_limit:ai:${orgA}`,
  });
  const a2 = TU.summary(orgA);
  check("4.1 alerta plan_near_limit_ai presente", a2.alerts.length === 1 && a2.alerts[0].signalType === "plan_near_limit_ai");
  check("4.2 alerta projeta used/limit/pct/target", a2.alerts[0].used === 85 && a2.alerts[0].limit === 100 && a2.alerts[0].pct === 85 && a2.alerts[0].upgradeTargetPlan === "scale");
  check("4.3 alerta NÃO carrega uplift em R$ (§30)", !("estimatedUpliftMonthly" in a2.alerts[0]) && !("impactAmount" in a2.alerts[0]) && !JSON.stringify(a2.alerts[0]).toLowerCase().includes("650"));
  // anti-duplicidade: NÃO criou sinal novo (só o publicado no teste segue existindo).
  const planSignals = BS.list(orgA, { status: "open", domain: "plan" }).filter((s: any) => s.signal_type === "plan_near_limit_ai");
  check("4.4 anti-duplicidade: nenhum alerta novo publicado pela F10", planSignals.length === 1);

  // ═══════════════ 5. §30 / D5 — invariante de custo no payload todo ═══════════════
  let safe = true;
  try { OBS.assertTenantSafe(a2); } catch { safe = false; }
  check("5.1 payload inteiro passa no assertTenantSafe", safe);
  const json = JSON.stringify(a2).toLowerCase();
  check("5.2 payload não contém chave de custo", !/(cost|brl|usd|cents|price|spend|"[^"]*token[^"]*":|uplift|monetary)/.test(json));

  // ═══════════════ 6. isolamento + casos de borda ═══════════════
  const b = TU.summary(orgB);
  check("6.1 org B isolada (sem ações, sem runs, sem alerta)", b.franquia.used === 0 && b.runs.total === 0 && b.alerts.length === 0 && b.capacityLevel === "ok");
  check("6.2 org A inalterada", TU.summary(orgA).franquia.used === 85);
  // plano ilimitado → pct 0, capacityLevel ok, unlimited true.
  const orgC = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT OR REPLACE INTO plans (id, name, price, features) VALUES ('enterprise', 'Ent', 0, '{}')`).run();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'Z', 'active', 'enterprise')`).run(randomUUID(), orgC);
  for (let i = 0; i < 9999; i++) { if (i < 3) action(orgC, null); }
  const c = TU.summary(orgC);
  check("6.3 plano ilimitado → unlimited + pct 0 + level ok", c.franquia.unlimited === true && c.franquia.pct === 0 && c.capacityLevel === "ok" && c.franquia.used === 3);

  // level=exceeded quando estoura 100%.
  const orgD = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'W', 'active', 'growth')`).run(randomUUID(), orgD);
  for (let i = 0; i < 120; i++) action(orgD, null);
  check("6.4 uso 120% → capacityLevel exceeded", TU.summary(orgD).capacityLevel === "exceeded");

  console.log("\n=== TEST: SkillOS Tenant Usage (PRD 4 F10) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ SkillOS Tenant Usage (F10) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
