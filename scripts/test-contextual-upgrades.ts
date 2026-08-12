/**
 * TEST — Contextual upgrades (PRD 6 / ADR-163 F9). DB-backed, det., isolado.
 * Prova (§55-§57, D3):
 *   - upgrade só surge na INTERSEÇÃO: recomendação situacional (pending) ∩ módulo
 *     `available_to_buy`+visível (Entitlement);
 *   - D3 / anti-catálogo: módulo comprável SEM recomendação NÃO aparece;
 *   - módulo já ATIVO (no plano) com recomendação NÃO vira oferta;
 *   - role-gate (§57): não-gestor não recebe oferta; flag refletida; multi-tenant.
 *
 * Uso: npm run test:contextual-upgrades
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cup-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-cup-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ContextualUpgradeService: CUP } = await import("../src/server/ContextualUpgradeService.js");
  const { EntitlementService } = await import("../src/server/EntitlementService.js");
  const { UpgradeRecommendationService: REC } = await import("../src/server/UpgradeRecommendationService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  const mkOrg = (org: string, cu: number) =>
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status, contextual_upgrade_enabled) VALUES (?, ?, 'X', 'active', 'varejo', 'autonomo', 'active', ?)`).run(randomUUID(), org, cu);
  mkOrg(A, 1); mkOrg(B, 0);
  PermissionService.seedSystemProfiles(A); PermissionService.seedSystemProfiles(B);
  const prof = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any).id;
  const owner = { userId: "u1", email: "dono@x.com", role: "owner", role_profile_id: prof(A, "owner"), organizationId: A };
  const atendente = { userId: "u3", email: "at@x.com", role: "agent", role_profile_id: prof(A, "atendente"), organizationId: A };
  const ownerB = { userId: "u9", email: "dono@b.com", role: "owner", role_profile_id: prof(B, "owner"), organizationId: B };

  // Descobre módulos reais por estado (robusto à config de entitlement).
  const ov = EntitlementService.overview(A, owner);
  const buyable = Object.entries(ov).filter(([, d]: any) => d.state === "available_to_buy" && d.visibility === "visible").map(([k]) => k);
  const active = Object.entries(ov).filter(([, d]: any) => d.state === "active").map(([k]) => k);
  check("0.1 há ≥2 módulos compráveis + ≥1 ativo p/ o teste", buyable.length >= 2 && active.length >= 1);
  const withRec = buyable[0], noRec = buyable[1], activeMod = active[0];

  // Recomendação situacional pro módulo comprável (o gatilho).
  REC.record(A, { signalId: randomUUID(), signalType: "usage_high", targetPlanId: null, targetModuleKey: withRec, score: 80, impactAmount: 1200, impactUnit: "BRL", evidence: { reason: "Uso alto indicou necessidade." } });
  // Recomendação pra módulo JÁ ATIVO (não deve virar oferta).
  REC.record(A, { signalId: randomUUID(), signalType: "usage_high", targetPlanId: null, targetModuleKey: activeMod, score: 90 });

  // ═══════════════ 1. interseção: só o comprável COM recomendação ═══════════════
  const r = CUP.forUser(A, owner);
  const up = r.upgrades.find((u: any) => u.moduleKey === withRec);
  check("1.1 flag refletida (ON em A)", r.contextualUpgradeEnabled === true);
  check("1.2 upgrade do módulo comprável+recomendado aparece", !!up && up.situational === true);
  check("1.3 traz situação + motivo + impacto", up!.situation === "usage_high" && /uso alto/i.test(up!.reason) && up!.impact.amount === 1200);

  // ═══════════════ 2. D3 — anti-catálogo de cadeados ═══════════════
  check("2.1 módulo comprável SEM recomendação NÃO aparece", !r.upgrades.find((u: any) => u.moduleKey === noRec));
  check("2.2 módulo já ATIVO com recomendação NÃO vira oferta", !r.upgrades.find((u: any) => u.moduleKey === activeMod));

  // ═══════════════ 3. role-gate (§57) ═══════════════
  const rAt = CUP.forUser(A, atendente);
  check("3.1 atendente (não-gestor) não recebe oferta", rAt.upgrades.length === 0);

  // ═══════════════ 4. multi-tenant + flag OFF ═══════════════
  const rB = CUP.forUser(B, ownerB);
  check("4.1 org B isolada (sem recomendação → vazio)", rB.upgrades.length === 0);
  check("4.2 flag OFF em B", rB.contextualUpgradeEnabled === false);

  // ═══════════════ 5. sem gatilho → vazio é o correto (§56) ═══════════════
  // (org A já provou o positivo; aqui garantimos que dispensar zera a oferta)
  const pend = REC.list(A, { status: "pending" }).find((x: any) => x.targetModuleKey === withRec);
  REC.dismiss(A, pend!.id, owner.userId);
  const r2 = CUP.forUser(A, owner);
  check("5.1 após dispensar, a oferta some (cooldown/dismiss respeitado)", !r2.upgrades.find((u: any) => u.moduleKey === withRec));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const rr of results) if (!rr.ok) console.log(`  ✗ ${rr.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} contextual-upgrades: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
