/**
 * TESTE — Fatia 7.6 (ADR-153): rotas admin cross-tenant do funil de
 * recomendações de upgrade.
 *
 * Cobre:
 *   1. `listAcrossOrgs()` sem filtro retorna recs de TODAS as orgs.
 *   2. Filtro por status (accepted/pending/dismissed) funciona.
 *   3. Filtro por targetPlanId isola.
 *   4. Filtro por targetModuleKey isola.
 *   5. Filtro por organizationId isola (útil se admin quer drill down).
 *   6. `organizationName` vem preenchido do JOIN com organization_settings.
 *   7. Cap em 500 respeitado.
 *   8. Ordem: accepted → pending → dismissed → outros; dentro do bucket
 *      updated_at DESC.
 *   9. `summaryAcrossOrgs()` conta por status corretamente.
 *  10. `summary.acceptedAwaitingCheckout` == count accepted.
 *  11. `summary.totalPendingUplift` soma só pending + BRL (ignora não-BRL).
 *  12. Rota HTTP `/api/admin/upgrade-recommendations` responde com items.
 *  13. Rota HTTP `/api/admin/upgrade-recommendations/summary` responde.
 *  14. Rota aceita filtros via querystring (status, targetPlanId, ...).
 *
 * OBS: gate `requireMasterAdmin` é validado por `test-admin-users` +
 * `test-master-admin-guard` (mesma convenção do resto do repo).
 *
 * Uso: npm run test:admin-upgrade-recommendations
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import express from "express";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-admin-recs-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-admin-recs-1234567890";
process.env.MASTER_ADMIN_EMAIL = "master@test.local";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function req(port: number, url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${url}`);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 300));
  const { UpgradeRecommendationService } = await import("../src/server/UpgradeRecommendationService.js");

  // ===== Seed: 3 orgs com recs distintas =====
  const orgA = "org_A_" + randomUUID().slice(0, 6);
  const orgB = "org_B_" + randomUUID().slice(0, 6);
  const orgC = "org_C_" + randomUUID().slice(0, 6);
  for (const [id, name] of [[orgA, "Empresa Alpha"], [orgB, "Empresa Beta"], [orgC, "Empresa Charlie"]]) {
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status)
       VALUES (?, ?, ?, 'active', 'start', 'active')`,
    ).run(randomUUID(), id, name);
  }

  // orgA: 1 pending growth (BRL 3000), 1 accepted scale (BRL 5000)
  UpgradeRecommendationService.record(orgA, {
    signalId: randomUUID(), signalType: "plan_near_limit_ai",
    targetPlanId: "growth", score: 70, impactAmount: 3000, impactUnit: "BRL",
  });
  const recA_accept = UpgradeRecommendationService.record(orgA, {
    signalId: randomUUID(), signalType: "plan_module_gap",
    targetPlanId: "scale", score: 80, impactAmount: 5000, impactUnit: "BRL",
  });
  UpgradeRecommendationService.accept(orgA, recA_accept.id, "user_a");

  // orgB: 1 pending com uplift em UNITS (não BRL — não deve entrar no
  // totalPendingUplift), 1 dismissed
  UpgradeRecommendationService.record(orgB, {
    signalId: randomUUID(), signalType: "plan_near_limit_users",
    targetPlanId: "growth", score: 55, impactAmount: 100, impactUnit: "units",
  });
  const recB_dis = UpgradeRecommendationService.record(orgB, {
    signalId: randomUUID(), signalType: "plan_near_limit_contacts",
    targetPlanId: "scale", score: 60, impactAmount: 2000, impactUnit: "BRL",
  });
  UpgradeRecommendationService.dismiss(orgB, recB_dis.id, "user_b");

  // orgC: 1 accepted module_gap clinica (enterprise)
  const recC_accept = UpgradeRecommendationService.record(orgC, {
    signalId: randomUUID(), signalType: "plan_module_gap",
    targetPlanId: "enterprise", targetModuleKey: "clinica",
    score: 65, impactAmount: 22000, impactUnit: "BRL",
  });
  UpgradeRecommendationService.accept(orgC, recC_accept.id, "user_c");

  // ===== 1. sem filtro retorna de todas as orgs =====
  const all = UpgradeRecommendationService.listAcrossOrgs();
  const orgIds = new Set(all.map((r) => r.organizationId));
  check("listAcrossOrgs sem filtro retorna >= 5 recs (2A + 2B + 1C)", all.length >= 5, `got ${all.length}`);
  check("listAcrossOrgs inclui recs das 3 orgs", orgIds.has(orgA) && orgIds.has(orgB) && orgIds.has(orgC));

  // ===== 2. filtro status =====
  const accepted = UpgradeRecommendationService.listAcrossOrgs({ status: "accepted" });
  check("filtro status=accepted retorna 2 recs (orgA scale + orgC clinica)", accepted.length === 2, `got ${accepted.length}`);
  check("filtro status=accepted todas são accepted", accepted.every((r) => r.status === "accepted"));

  const pending = UpgradeRecommendationService.listAcrossOrgs({ status: "pending" });
  check("filtro status=pending retorna 2 recs (orgA growth + orgB users)", pending.length === 2, `got ${pending.length}`);

  const dismissed = UpgradeRecommendationService.listAcrossOrgs({ status: "dismissed" });
  check("filtro status=dismissed retorna 1 rec (orgB scale)", dismissed.length === 1, `got ${dismissed.length}`);

  // ===== 3. filtro targetPlanId =====
  const scaleOnly = UpgradeRecommendationService.listAcrossOrgs({ targetPlanId: "scale" });
  check("filtro targetPlanId=scale isola (orgA accepted + orgB dismissed)", scaleOnly.length === 2 && scaleOnly.every((r) => r.targetPlanId === "scale"), `got ${scaleOnly.length}`);

  // ===== 4. filtro targetModuleKey =====
  const clinicaOnly = UpgradeRecommendationService.listAcrossOrgs({ targetModuleKey: "clinica" });
  check("filtro targetModuleKey=clinica isola só a rec da orgC", clinicaOnly.length === 1 && clinicaOnly[0].organizationId === orgC);

  // ===== 5. filtro organizationId =====
  const orgAOnly = UpgradeRecommendationService.listAcrossOrgs({ organizationId: orgA });
  check("filtro organizationId=orgA retorna só recs de orgA", orgAOnly.length === 2 && orgAOnly.every((r) => r.organizationId === orgA));

  // ===== 6. organizationName preenchido do JOIN =====
  const orgARec = all.find((r) => r.organizationId === orgA);
  check("organizationName vem preenchido (Empresa Alpha)", orgARec?.organizationName === "Empresa Alpha", String(orgARec?.organizationName));

  // ===== 7. cap 500 =====
  const capped = UpgradeRecommendationService.listAcrossOrgs({ limit: 10000 });
  check("cap 500 respeitado mesmo com limit=10000", capped.length <= 500);

  // ===== 8. ordem: accepted primeiro =====
  check("ordem: accepted vem antes de pending vem antes de dismissed",
    (() => {
      const first3 = all.slice(0, 5);
      const statusRank = { accepted: 0, pending: 1, dismissed: 2, expired: 3 } as Record<string, number>;
      let prev = -1;
      for (const r of first3) {
        const rank = statusRank[r.status] ?? 9;
        if (rank < prev) return false;
        prev = rank;
      }
      return true;
    })(),
  );

  // ===== 9. summary.byStatus =====
  const summary = UpgradeRecommendationService.summaryAcrossOrgs();
  check("summary.byStatus.accepted == 2", summary.byStatus.accepted === 2, JSON.stringify(summary.byStatus));
  check("summary.byStatus.pending == 2", summary.byStatus.pending === 2);
  check("summary.byStatus.dismissed == 1", summary.byStatus.dismissed === 1);

  // ===== 10. summary.acceptedAwaitingCheckout =====
  check("summary.acceptedAwaitingCheckout == 2", summary.acceptedAwaitingCheckout === 2);

  // ===== 11. summary.totalPendingUplift soma só pending+BRL =====
  // orgA growth pending = 3000 BRL; orgB users pending = 100 units (excluído).
  check("summary.totalPendingUplift == 3000 (só BRL pending, ignora units)",
    summary.totalPendingUplift === 3000,
    String(summary.totalPendingUplift));

  // ===== 12-14. Rota HTTP (gate `requireMasterAdmin` testado em outros suítes) =====
  const adminRoutes = (await import("../src/server/routes/admin.js")).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: "master-uid", email: "master@zappflow.test", role: "owner" };
    next();
  });
  app.use("/api/admin", adminRoutes);
  const server = http.createServer(app);
  const port: number = await new Promise((resolve) => server.listen(0, () => resolve((server.address() as any).port)));

  const rItems = await req(port, "/api/admin/upgrade-recommendations?status=accepted");
  check("rota upgrade-recommendations: status 200", rItems.status === 200, `got ${rItems.status}`);
  check("rota upgrade-recommendations: retorna items com orgA + orgC (accepted)",
    Array.isArray(rItems.json?.items)
      && rItems.json.items.some((r: any) => r.organizationId === orgA)
      && rItems.json.items.some((r: any) => r.organizationId === orgC),
    JSON.stringify(rItems.json).slice(0, 200));

  const rSummary = await req(port, "/api/admin/upgrade-recommendations/summary");
  check("rota summary: retorna acceptedAwaitingCheckout=2",
    rSummary.status === 200 && rSummary.json?.acceptedAwaitingCheckout === 2,
    JSON.stringify(rSummary.json));

  const rFiltered = await req(port, "/api/admin/upgrade-recommendations?targetModuleKey=clinica");
  check("rota: filtro targetModuleKey=clinica retorna só 1 (orgC)",
    rFiltered.status === 200 && Array.isArray(rFiltered.json?.items) && rFiltered.json.items.length === 1 && rFiltered.json.items[0].organizationId === orgC,
    JSON.stringify(rFiltered.json).slice(0, 200));

  server.close();

  // ===== Resultado =====
  console.log("\n=== Admin Upgrade Recommendations (F7.6) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  (" + r.detail.slice(0, 200) + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
