/**
 * TEST — Fatia 4.4 (ADR-153): série temporal aceitas × dispensadas por bucket
 * diário, alimentando o gráfico de tendência na aba "Plano e Expansões".
 *
 * Cobre:
 *   1. Empty org: série com N pontos, todos accepted=0 / dismissed=0.
 *   2. Days clampado no piso (< 7 → 7) e no teto (> 180 → 180).
 *   3. Series length === days.
 *   4. Datas ordenadas crescente e cobrem exatamente [now-days+1 .. now].
 *   5. accepted_at hoje conta no último bucket como accepted.
 *   6. dismissed_at hoje conta no último bucket como dismissed.
 *   7. Backdate accepted_at 3 dias → aparece no bucket [now-3].
 *   8. Backdate dismissed_at 10 dias → aparece no bucket [now-10].
 *   9. Múltiplas decisões no MESMO dia agregam (contadas juntas no bucket).
 *  10. Recomendação `pending` (não decidida) NÃO conta na série.
 *  11. Recomendação `expired` (housekeeping F7.7) NÃO conta na série.
 *  12. Backdate accepted_at 60 dias com days=30 → NÃO aparece (fora da janela).
 *  13. Backdate accepted_at 60 dias com days=90 → aparece.
 *  14. totalAccepted e totalDismissed batem com a soma da série.
 *  15. Isolamento multi-tenant: org B não vê decisões de org A.
 *  16. Rota HTTP /api/billing/recommendations/history-chart devolve payload esperado.
 *  17. Rota HTTP retorna 401 sem organizationId.
 *
 * Uso: npm run test:recommendation-history-chart
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import express from "express";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rechist-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-rechist-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function req(port: number, url: string, orgId?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (orgId) headers["x-test-org"] = orgId;
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 300));
  const { UpgradeRecommendationService } = await import("../src/server/UpgradeRecommendationService.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const orgEmpty = `org_${randomUUID().slice(0, 8)}`;

  const insertOrg = (id: string) => {
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status)
       VALUES (?, ?, ?, 'active', 'start', 'active')`,
    ).run(randomUUID(), id, `Org-${id.slice(0, 5)}`);
  };
  insertOrg(orgA);
  insertOrg(orgB);
  insertOrg(orgEmpty);

  // Helper — cria uma rec pending com signalId único (evita idempotência colidir).
  const recordPending = (orgId: string, targetPlan: string | null, moduleKey?: string | null) => {
    return UpgradeRecommendationService.record(orgId, {
      signalId: randomUUID(),
      signalType: moduleKey ? "plan_module_gap" : "plan_near_limit_ai",
      targetPlanId: targetPlan,
      targetModuleKey: moduleKey ?? null,
      score: 70,
      impactAmount: 1000,
      impactUnit: "BRL",
      evidence: {},
    });
  };

  // Backdatea accepted_at/dismissed_at para N dias atrás. updated_at acompanha
  // pra bater com o fallback COALESCE do service.
  const backdateAccepted = (id: string, daysAgo: number) => {
    db.prepare(
      `UPDATE upgrade_recommendations
          SET accepted_at = datetime('now', ?), updated_at = datetime('now', ?)
        WHERE id = ?`,
    ).run(`-${daysAgo} days`, `-${daysAgo} days`, id);
  };
  const backdateDismissed = (id: string, daysAgo: number) => {
    db.prepare(
      `UPDATE upgrade_recommendations
          SET dismissed_at = datetime('now', ?), updated_at = datetime('now', ?)
        WHERE id = ?`,
    ).run(`-${daysAgo} days`, `-${daysAgo} days`, id);
  };

  const todayKey = new Date().toISOString().slice(0, 10);
  const dateKey = (daysAgo: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  };

  // ===== 1. Empty org =====
  const emp30 = UpgradeRecommendationService.historyByBucket(orgEmpty, { days: 30 });
  check("empty org: series length = 30", emp30.series.length === 30);
  check("empty org: totalAccepted = 0", emp30.totalAccepted === 0);
  check("empty org: totalDismissed = 0", emp30.totalDismissed === 0);
  check("empty org: todos os buckets 0/0",
    emp30.series.every(s => s.accepted === 0 && s.dismissed === 0));

  // ===== 2. Days clamping =====
  const clampLow = UpgradeRecommendationService.historyByBucket(orgEmpty, { days: 1 });
  check("days=1 clampado pra 7", clampLow.days === 7 && clampLow.series.length === 7);
  const clampHigh = UpgradeRecommendationService.historyByBucket(orgEmpty, { days: 999 });
  check("days=999 clampado pra 180", clampHigh.days === 180 && clampHigh.series.length === 180);
  const defaultDays = UpgradeRecommendationService.historyByBucket(orgEmpty);
  check("sem opts: default 30 dias", defaultDays.days === 30 && defaultDays.series.length === 30);

  // ===== 3-4. Datas ordenadas e cobrem [now-29 .. now] =====
  check("series[0] é o dia mais antigo (now-29)",
    emp30.series[0].date === dateKey(29),
    `esperado=${dateKey(29)} obtido=${emp30.series[0].date}`);
  check("series[last] é hoje (now)",
    emp30.series[29].date === todayKey,
    `esperado=${todayKey} obtido=${emp30.series[29].date}`);
  const sorted = emp30.series.every((s, i) => i === 0 || s.date >= emp30.series[i - 1].date);
  check("datas ordenadas crescente", sorted);

  // ===== 5. accepted hoje conta no último bucket =====
  const recAcceptToday = recordPending(orgA, "growth");
  UpgradeRecommendationService.accept(orgA, recAcceptToday.id, "user_a");
  const afterAcceptToday = UpgradeRecommendationService.historyByBucket(orgA, { days: 30 });
  const lastBucket = afterAcceptToday.series[afterAcceptToday.series.length - 1];
  check("accepted hoje → último bucket (accepted=1)", lastBucket.accepted === 1);
  check("accepted hoje → último bucket (dismissed=0)", lastBucket.dismissed === 0);
  check("totalAccepted incrementou", afterAcceptToday.totalAccepted === 1);

  // ===== 6. dismissed hoje conta no último bucket =====
  const recDismissToday = recordPending(orgA, "scale");
  UpgradeRecommendationService.dismiss(orgA, recDismissToday.id, "user_a");
  const afterDismissToday = UpgradeRecommendationService.historyByBucket(orgA, { days: 30 });
  const lastBucket2 = afterDismissToday.series[afterDismissToday.series.length - 1];
  check("dismissed hoje → último bucket (dismissed=1)", lastBucket2.dismissed === 1);
  check("dismissed hoje → último bucket ainda accepted=1", lastBucket2.accepted === 1);
  check("totalDismissed incrementou", afterDismissToday.totalDismissed === 1);

  // ===== 7. Backdate accepted 3 dias =====
  const recAccept3d = recordPending(orgA, "enterprise");
  UpgradeRecommendationService.accept(orgA, recAccept3d.id, "user_a");
  backdateAccepted(recAccept3d.id, 3);
  const after3d = UpgradeRecommendationService.historyByBucket(orgA, { days: 30 });
  const bucket3d = after3d.series.find(s => s.date === dateKey(3));
  check(`accepted backdate -3d aparece em ${dateKey(3)}`, bucket3d?.accepted === 1);

  // ===== 8. Backdate dismissed 10 dias =====
  const recDismiss10d = recordPending(orgA, "enterprise", "vms");
  UpgradeRecommendationService.dismiss(orgA, recDismiss10d.id, "user_a");
  backdateDismissed(recDismiss10d.id, 10);
  const after10d = UpgradeRecommendationService.historyByBucket(orgA, { days: 30 });
  const bucket10d = after10d.series.find(s => s.date === dateKey(10));
  check(`dismissed backdate -10d aparece em ${dateKey(10)}`, bucket10d?.dismissed === 1);

  // ===== 9. Múltiplas no mesmo dia agregam =====
  const recSameDay1 = recordPending(orgA, "enterprise", "outra_x");
  UpgradeRecommendationService.accept(orgA, recSameDay1.id, "user_a");
  backdateAccepted(recSameDay1.id, 5);
  const recSameDay2 = recordPending(orgA, "enterprise", "outra_y");
  UpgradeRecommendationService.accept(orgA, recSameDay2.id, "user_a");
  backdateAccepted(recSameDay2.id, 5);
  const recSameDay3 = recordPending(orgA, "enterprise", "outra_z");
  UpgradeRecommendationService.dismiss(orgA, recSameDay3.id, "user_a");
  backdateDismissed(recSameDay3.id, 5);
  const afterSameDay = UpgradeRecommendationService.historyByBucket(orgA, { days: 30 });
  const bucket5d = afterSameDay.series.find(s => s.date === dateKey(5));
  check(`múltiplas mesma data ${dateKey(5)}: accepted=2 agregado`, bucket5d?.accepted === 2,
    `obtido=${bucket5d?.accepted}`);
  check(`múltiplas mesma data ${dateKey(5)}: dismissed=1 agregado`, bucket5d?.dismissed === 1);

  // ===== 10. Pending NÃO conta =====
  const totalBeforePending = afterSameDay.totalAccepted + afterSameDay.totalDismissed;
  const recStillPending = recordPending(orgA, "growth", "yet_another");
  const afterPending = UpgradeRecommendationService.historyByBucket(orgA, { days: 30 });
  const totalAfterPending = afterPending.totalAccepted + afterPending.totalDismissed;
  check("pending NÃO altera totais", totalAfterPending === totalBeforePending,
    `antes=${totalBeforePending} depois=${totalAfterPending}`);
  db.prepare(`DELETE FROM upgrade_recommendations WHERE id = ?`).run(recStillPending.id);

  // ===== 11. Expired NÃO conta =====
  const totalBeforeExpire = UpgradeRecommendationService.historyByBucket(orgA, { days: 30 }).totalDismissed;
  const recToExpire = recordPending(orgA, "growth", "expire_me");
  UpgradeRecommendationService.dismiss(orgA, recToExpire.id, "user_a");
  const dismissedIncremented = UpgradeRecommendationService.historyByBucket(orgA, { days: 30 }).totalDismissed;
  check("dismiss incrementou dismissed (antes de expirar)",
    dismissedIncremented === totalBeforeExpire + 1);
  // Força cooldown pra passado e roda o sweep pra virar expired.
  db.prepare(
    `UPDATE upgrade_recommendations SET cooldown_until = datetime('now', '-1 day') WHERE id = ?`,
  ).run(recToExpire.id);
  UpgradeRecommendationService.expireOldCooldowns(orgA);
  const rowExpired = db.prepare(`SELECT status FROM upgrade_recommendations WHERE id = ?`).get(recToExpire.id) as any;
  check("recomendação virou expired via sweep", rowExpired?.status === "expired");
  const afterExpire = UpgradeRecommendationService.historyByBucket(orgA, { days: 30 });
  check("expired NÃO conta como dismissed",
    afterExpire.totalDismissed === totalBeforeExpire,
    `esperado=${totalBeforeExpire} obtido=${afterExpire.totalDismissed}`);

  // ===== 12. Backdate 60 dias com days=30 → fora da janela =====
  const recFar = recordPending(orgA, "enterprise", "far_away");
  UpgradeRecommendationService.accept(orgA, recFar.id, "user_a");
  backdateAccepted(recFar.id, 60);
  const window30 = UpgradeRecommendationService.historyByBucket(orgA, { days: 30 });
  const window90 = UpgradeRecommendationService.historyByBucket(orgA, { days: 90 });
  check("backdate -60d NÃO aparece com days=30",
    !window30.series.some(s => s.date === dateKey(60)));
  // 13. Aparece com days=90
  const bucket60d = window90.series.find(s => s.date === dateKey(60));
  check(`backdate -60d aparece com days=90 (${dateKey(60)})`, bucket60d?.accepted === 1);

  // ===== 14. Totals batem com soma da série =====
  const sumAccepted = window30.series.reduce((acc, s) => acc + s.accepted, 0);
  const sumDismissed = window30.series.reduce((acc, s) => acc + s.dismissed, 0);
  check("totalAccepted === sum(series.accepted)", window30.totalAccepted === sumAccepted,
    `total=${window30.totalAccepted} sum=${sumAccepted}`);
  check("totalDismissed === sum(series.dismissed)", window30.totalDismissed === sumDismissed);

  // ===== 15. Isolamento multi-tenant =====
  const recB = recordPending(orgB, "growth");
  UpgradeRecommendationService.accept(orgB, recB.id, "user_b");
  const bWindow = UpgradeRecommendationService.historyByBucket(orgB, { days: 30 });
  check("orgB vê apenas suas decisões (totalAccepted=1)", bWindow.totalAccepted === 1);
  check("orgB não vê dismissed de orgA (totalDismissed=0)", bWindow.totalDismissed === 0);
  const aStillHas = UpgradeRecommendationService.historyByBucket(orgA, { days: 30 });
  check("orgA continua com seus totais (não vazou pra B)",
    aStillHas.totalAccepted > 0);

  // ===== 16-17. Rota HTTP =====
  // Mount enxuto — middleware fake injeta organizationId pra bypass do auth
  // real (auth JWT é validado em outros suítes). Preserva comportamento da
  // rota: sem organizationId → 401.
  const routerMod = await import("../src/server/routes/recommendations.js");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const orgHeader = req.headers["x-test-org"];
    if (orgHeader) {
      req.organizationId = String(orgHeader);
      req.user = { userId: "test-uid" };
    }
    next();
  });
  app.use("/api/billing/recommendations", routerMod.default);
  const server = http.createServer(app);
  const port: number = await new Promise((resolve) => server.listen(0, () => resolve((server.address() as any).port)));

  const rOk = await req(port, "/api/billing/recommendations/history-chart?days=30", orgB);
  check("rota HTTP: 200 com org", rOk.status === 200, `got ${rOk.status}`);
  check("rota HTTP: series length === 30",
    Array.isArray(rOk.json?.series) && rOk.json.series.length === 30,
    `length=${rOk.json?.series?.length}`);
  check("rota HTTP: totalAccepted correto pra orgB (1)", rOk.json?.totalAccepted === 1);
  check("rota HTTP: totalDismissed correto pra orgB (0)", rOk.json?.totalDismissed === 0);
  check("rota HTTP: days retornado === 30", rOk.json?.days === 30);
  check("rota HTTP: cada ponto tem {date, accepted, dismissed}",
    rOk.json?.series?.every((s: any) =>
      typeof s.date === "string" && typeof s.accepted === "number" && typeof s.dismissed === "number"));

  const rNoOrg = await req(port, "/api/billing/recommendations/history-chart");
  check("rota HTTP sem org: 401", rNoOrg.status === 401);

  // Isolamento via rota: orgA ≠ orgB
  const rOrgA = await req(port, "/api/billing/recommendations/history-chart?days=30", orgA);
  check("rota HTTP orgA vs orgB: totalAccepted diferente",
    rOrgA.json?.totalAccepted !== rOk.json?.totalAccepted);

  server.close();

  // ===== Resultado =====
  console.log("\n=== RecommendationHistoryByBucket + rota (F4.4) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  (" + r.detail + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
