/**
 * TEST — Inferred settings: observa→infere→sugere→confirma (PRD 6 / ADR-163 F6).
 * DB-backed, det., isolado. Prova (§26/§101):
 *   - suggestions: infere regra de aprovação a partir de ações financeiras SEM
 *     banda; conservadora (nunca 'allow' pra dinheiro); com rationale/observação/confiança;
 *   - RN-UX-3: sugestão é INERTE — nada grava até apply();
 *   - role-gate (§73): só gestor recebe sugestões de política;
 *   - apply: grava via ApprovalPolicyService.setBands (+audit); depois a sugestão
 *     SOME (já governado); estado inválido é recusado; multi-tenant.
 *
 * Uso: npm run test:inferred-settings
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-inf-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-inf-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { InferredSettingsService: INF } = await import("../src/server/InferredSettingsService.js");
  const { ApprovalPolicyService: POL } = await import("../src/server/ApprovalPolicyService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  const mkOrg = (org: string, inf: number) =>
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status, inferred_settings_enabled) VALUES (?, ?, 'X', 'active', 'varejo', 'autonomo', 'active', ?)`).run(randomUUID(), org, inf);
  mkOrg(A, 1); mkOrg(B, 0);
  PermissionService.seedSystemProfiles(A); PermissionService.seedSystemProfiles(B);
  const prof = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any).id;
  const owner = { userId: "u1", email: "dono@x.com", role: "owner", role_profile_id: prof(A, "owner"), organizationId: A };
  const atendente = { userId: "u3", email: "at@x.com", role: "agent", role_profile_id: prof(A, "atendente"), organizationId: A };
  const ownerB = { userId: "u9", email: "dono@b.com", role: "owner", role_profile_id: prof(B, "owner"), organizationId: B };

  // 3 reembolsos financeiros SEM banda de aprovação (o padrão que dispara a sugestão).
  for (const amt of [1200, 800, 3000]) DA.propose(A, { domain: "finance", actionType: "refund", title: "Reembolso", expectedImpact: amt });

  // ═══════════════ 1. suggestions (gestor) ═══════════════
  const s = INF.suggestions(A, owner);
  const ref = s.suggestions.find((x: any) => x.key === "finance:refund");
  check("1.1 flag refletida (ON em A)", s.inferredSettingsEnabled === true);
  check("1.2 infere regra p/ reembolso sem banda", !!ref);
  check("1.3 observação: 3 ações, maxAmount 3000", ref!.observed.count === 3 && ref!.observed.maxAmount === 3000);
  check("1.4 banda CONSERVADORA — nunca 'allow' pra dinheiro", ref!.suggestedBands.every((b: any) => b.state !== "allow") && ref!.suggestedBands.some((b: any) => b.state === "require_approval"));
  check("1.5 rationale + confiança presentes", /reembolso|refund|aprova/i.test(ref!.rationale) && ["alta", "média", "baixa"].includes(ref!.confidence));
  check("1.6 status sempre 'suggested' (inerte)", ref!.status === "suggested");

  // ═══════════════ 2. RN-UX-3 — sugestão NÃO grava nada ═══════════════
  const before = POL.resolveContract(A, { domain: "finance", actionType: "refund", amount: 3000 });
  check("2.1 nenhuma banda gravada só por sugerir", before.band === null);

  // ═══════════════ 3. role-gate (§73) — atendente não recebe ═══════════════
  const sAt = INF.suggestions(A, atendente);
  check("3.1 atendente (não-gestor) recebe lista vazia", sAt.suggestions.length === 0);

  // ═══════════════ 4. apply — único caminho que grava (+audit) ═══════════════
  const applied = INF.apply(A, owner.userId, { domain: "finance", actionType: "refund", bands: ref!.suggestedBands });
  check("4.1 apply grava e confirma", applied.applied === true);
  const after = POL.resolveContract(A, { domain: "finance", actionType: "refund", amount: 3000 });
  check("4.2 banda agora existe e é enforced", after.band !== null && after.enforced === true);
  const audited = (db.prepare(`SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'INFERRED_SETTING_APPLIED'`).get(A) as any).n;
  check("4.3 aplicação auditada", audited >= 1);

  // ═══════════════ 5. após governar, a sugestão SOME ═══════════════
  const s2 = INF.suggestions(A, owner);
  check("5.1 sugestão de finance:refund some (já governado)", !s2.suggestions.find((x: any) => x.key === "finance:refund"));

  // ═══════════════ 6. apply inválido é recusado ═══════════════
  const bad = INF.apply(A, owner.userId, { domain: "finance", actionType: "refund", bands: [{ upTo: null, state: "banana" as any }] });
  check("6.1 estado inválido recusado", bad.applied === false && /inválido/i.test(bad.reason || ""));
  const empty = INF.apply(A, owner.userId, { domain: "finance", actionType: "refund", bands: [] });
  check("6.2 sem bandas recusado", empty.applied === false);

  // ═══════════════ 7. multi-tenant ═══════════════
  const sB = INF.suggestions(B, ownerB);
  check("7.1 org B isolada (sem ações de A)", sB.suggestions.length === 0);
  check("7.2 flag OFF em B", sB.inferredSettingsEnabled === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} inferred-settings: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
