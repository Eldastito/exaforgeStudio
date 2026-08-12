/**
 * TEST — FalaTu Home "Hoje" por exceção (PRD 6 / ADR-163 F3). DB-backed, det., isolado.
 * Prova (§11-§13, D1):
 *   - campos ADITIVOS na home (0 regressão nos existentes);
 *   - attention: decisões precisam de você / riscos / em execução + todayLine + crítico;
 *   - resolvedSinceYesterday: conta os concluídos 24h; valueRecovered (R$) só pra visão
 *     completa (role-gated §73) — atendente vê count, não vê R$;
 *   - goals: distância à meta só pra gestor (BusinessGoalService.progress);
 *   - empty state → "Nenhuma exceção crítica agora" (§12); flag refletida; multi-tenant.
 *
 * Uso: npm run test:falatu-home-today
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-home-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-home-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuHomeService: HOME } = await import("../src/server/FalaTuHomeService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");
  const { BusinessSignalService: BSS } = await import("../src/server/BusinessSignalService.js");
  const { BusinessGoalService: GOAL } = await import("../src/server/BusinessGoalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  const mkOrg = (org: string, inv: number) =>
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status, invisible_ux_enabled) VALUES (?, ?, 'X', 'active', 'varejo', 'autonomo', 'active', ?)`).run(randomUUID(), org, inv);
  mkOrg(A, 1); mkOrg(B, 0);
  PermissionService.seedSystemProfiles(A); PermissionService.seedSystemProfiles(B);
  const prof = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any).id;
  const owner = { userId: "u1", email: "dono@x.com", role: "owner", role_profile_id: prof(A, "owner"), organizationId: A };
  const atendente = { userId: "u3", email: "at@x.com", role: "agent", role_profile_id: prof(A, "atendente"), organizationId: A };
  const ownerB = { userId: "u9", email: "dono@b.com", role: "owner", role_profile_id: prof(B, "owner"), organizationId: B };

  // ── Semeia o caso: 1 aprovação pendente, 1 risco crítico, 1 resolvido (R$500), 1 meta ──
  DA.propose(A, { domain: "sales", actionType: "prepare_campaign", title: "Campanha" }); // awaiting_approval → needsApproval
  BSS.publish(A, { domain: "sales", signalType: "conversion_drop", severity: "critical", basis: "fact", confidence: 0.8, sourceService: "test", subjectType: "sku", subjectId: "S1", dedupeKey: "risk:S1" } as any);
  const done = DA.propose(A, { domain: "sales", actionType: "create_task", title: "Resolvido" }); // policy none → approved
  DA.complete(A, done.id, { resultAmount: 500, categoryOutcomes: { revenueRecovered: 500 } });   // → done + outcome
  GOAL.set(A, { metric: "revenue", targetAmount: 10000 });

  // ═══════════════ 1. attention por exceção ═══════════════
  const h = HOME.home(A, owner);
  check("1.1 decisões precisam de você ≥ 1", h.attention.decisionsNeedingYou >= 1);
  check("1.2 riscos acompanhados ≥ 1 + crítico", h.attention.risksWatched >= 1 && h.attention.hasCriticalException === true);
  check("1.3 todayLine descreve exceções", /decis|risco/.test(h.attention.todayLine));

  // ═══════════════ 2. resolvido desde ontem + valor recuperado ═══════════════
  check("2.1 conta resolvidos 24h ≥ 1", h.resolvedSinceYesterday.count >= 1);
  check("2.2 valor recuperado = R$500 (visão completa)", h.resolvedSinceYesterday.valueRecovered === 500);

  // ═══════════════ 3. metas (gestor) ═══════════════
  check("3.1 goals presente pra gestor + meta contada", h.goals !== null && h.goals!.total >= 1);
  check("3.2 goals item traz distância (attainmentPct/pace)", h.goals!.items.length >= 1 && typeof h.goals!.items[0].attainmentPct === "number");

  // ═══════════════ 4. role-gating (§73) ═══════════════
  const hAt = HOME.home(A, atendente);
  check("4.1 atendente NÃO vê R$ recuperado (money role-gated)", hAt.resolvedSinceYesterday.valueRecovered === null);
  check("4.2 atendente NÃO vê metas (não-gestor)", hAt.goals === null);
  check("4.3 atendente ainda recebe a home (campos presentes)", typeof hAt.attention.todayLine === "string" && !!hAt.summary);

  // ═══════════════ 5. flag + campos legados intactos ═══════════════
  check("5.1 invisibleUxEnabled reflete a flag", h.invisibleUxEnabled === true);
  check("5.2 campos legados preservados (greeting/summary/approvals/execution)", !!h.greeting && !!h.summary && !!h.approvals && !!h.execution);

  // ═══════════════ 6. empty state (§12) + multi-tenant ═══════════════
  const hB = HOME.home(B, ownerB);
  check("6.1 sem exceção → 'Nenhuma exceção crítica agora'", hB.attention.todayLine === "Nenhuma exceção crítica agora." && hB.attention.hasCriticalException === false);
  check("6.2 orgB sem resolvidos/metas", hB.resolvedSinceYesterday.count === 0 && hB.goals!.total === 0);
  check("6.3 flag OFF em B", hB.invisibleUxEnabled === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-home-today: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
