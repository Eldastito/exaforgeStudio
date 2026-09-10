/**
 * TEST — ADR-153 Fatia 6.1 (PRD §18/§19): preview de mudança de plano.
 *
 * Prova, offline (tmp db, `applyPlanGrade` semeia os 5 tiers no init), que
 * `SubscriptionOrchestratorService.preview` calcula proporcionalidade + diff SEM
 * efeito colateral:
 *  - UPGRADE: imediato + proporcional ao período restante; renovação mantida;
 *    upgrade NUNCA perde módulo (F2.1);
 *  - DOWNGRADE: vale no próximo ciclo, sem cobrança imediata, avisa módulos perdidos;
 *  - SAME: sem custo; NEW (org sem plano): proporcional null (checkout cheio, não inventa);
 *  - sem ciclo definido → prorationBasis 'unknown' + amount null (não inventa valor);
 *  - plano inexistente → {ok:false}; read-only (não muda o plano da org); isolamento.
 *
 * Uso: npm run test:billing-preview
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-billing-preview-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-billing-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SubscriptionOrchestratorService: SO } = await import("../src/server/SubscriptionOrchestratorService.js");
  const { PlanService } = await import("../src/server/PlanService.js");

  const DAY = 86400000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = Date.now();

  const mkOrg = (plan: string | null, withPeriod = true) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status, current_period_start, current_period_end) VALUES (?, ?, 'T', 'active', ?, 'active', ?, ?)`)
      .run(randomUUID(), id, plan, withPeriod ? iso(now - 15 * DAY) : null, withPeriod ? iso(now + 15 * DAY) : null);
    return id;
  };

  // ── 0. sanidade: os 5 tiers existem (applyPlanGrade no init) ──
  const plans = PlanService.listPlans();
  check("0.1 catálogo tem os 5 tiers", ["autonomo", "start", "growth", "scale", "enterprise"].every((t) => plans.some((p) => p.id === t)));

  // ── 1. UPGRADE start(597)→growth(1797): imediato + proporcional (15/30 do delta 1200 ≈ 600) ──
  const orgU = mkOrg("start");
  const up = SO.preview(orgU, "growth");
  check("1.1 upgrade → ok", up.ok === true);
  if (up.ok) {
    check("1.2 direction=upgrade", up.direction === "upgrade");
    check("1.3 priceDelta = 1200", up.priceDelta === 1200);
    check("1.4 proporcional ~600 (15/30 do delta)", up.prorationBasis === "period" && up.prorationAmount !== null && Math.abs(up.prorationAmount - 600) <= 40);
    check("1.5 renovação mantida (= fim do período)", up.renewalAt === up.breakdown.currentPeriodEnd && up.renewalAt !== null);
    check("1.6 efetivo agora (upgrade imediato)", !!up.effectiveAt && Math.abs(Date.parse(up.effectiveAt) - now) < 5 * 60000);
    check("1.7 upgrade GANHA módulos e NÃO perde (F2.1)", up.modulesGained.length > 0 && up.modulesLost.length === 0);
  }

  // ── 2. DOWNGRADE growth→autonomo: próximo ciclo, sem cobrança, avisa perdas ──
  const orgD = mkOrg("growth");
  const dn = SO.preview(orgD, "autonomo");
  check("2.1 downgrade → ok", dn.ok === true);
  if (dn.ok) {
    check("2.2 direction=downgrade", dn.direction === "downgrade");
    check("2.3 sem cobrança imediata (proration 0)", dn.prorationAmount === 0);
    check("2.4 efetivo no próximo ciclo (= fim do período)", dn.effectiveAt === dn.breakdown.currentPeriodEnd);
    check("2.5 avisa módulos perdidos", dn.modulesLost.length > 0 && dn.warnings.some((w) => /remover/i.test(w)));
  }

  // ── 3. SAME start→start ──
  const same = SO.preview(orgU, "start");
  check("3.1 same → direction=same + proration 0", same.ok === true && same.ok && same.direction === "same" && same.prorationAmount === 0);

  // ── 4. NEW (org sem plano) → checkout cheio, não inventa proporcional ──
  const orgN = mkOrg(null);
  const nw = SO.preview(orgN, "growth");
  check("4.1 new → direction=new", nw.ok === true && nw.ok && nw.direction === "new");
  check("4.2 new → prorationAmount null (não inventa) + fromPlan null", nw.ok === true && nw.ok && nw.prorationAmount === null && nw.fromPlan === null);

  // ── 5. sem ciclo → unknown + amount null (não inventa) ──
  const orgNoPeriod = mkOrg("start", false);
  const noPer = SO.preview(orgNoPeriod, "growth");
  check("5.1 upgrade sem ciclo → basis 'unknown' + amount null", noPer.ok === true && noPer.ok && noPer.prorationBasis === "unknown" && noPer.prorationAmount === null);
  check("5.2 avisa que não pôde calcular", noPer.ok === true && noPer.ok && noPer.warnings.length > 0);

  // ── 6. plano inexistente ──
  const bad = SO.preview(orgU, "inexistente_xyz");
  check("6.1 plano inexistente → {ok:false, plan_not_found}", bad.ok === false && (bad as any).reason === "plan_not_found");

  // ── 7. read-only: preview NÃO muda o plano da org ──
  const before = PlanService.getCurrentPlan(orgU)?.id;
  SO.preview(orgU, "enterprise");
  check("7.1 preview é read-only (plano da org inalterado)", PlanService.getCurrentPlan(orgU)?.id === before && before === "start");

  // ── 8. isolamento: cada org usa o próprio snapshot ──
  const isoU = SO.preview(orgU, "growth");
  const isoD = SO.preview(orgD, "growth");
  check("8.1 orgs distintas → fromPlan próprio", isoU.ok && isoD.ok && isoU.fromPlan?.id === "start" && isoD.fromPlan?.id === "growth");

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} billing-preview: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
