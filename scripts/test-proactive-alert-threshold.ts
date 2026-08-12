/**
 * TEST — Limiar de alerta aplicado à proatividade (PRD 6 / ADR-163 F14).
 * DB-backed, det., isolado. Fecha o loop da F13: `alert_min_amount` agora TOMA
 * EFEITO em `FalaTuProactiveService.selectUrgent`. Prova (§53/§68, D7/§45):
 *   - item de valor ABAIXO do limiar não vira push proativo (segue na Inbox);
 *   - item ACIMA do limiar passa; item SEM valor conhecido sempre passa;
 *   - risco CRÍTICO nunca é filtrado pelo limiar (§45/D7);
 *   - default (limiar 0) → 0 regressão; multi-tenant.
 *
 * Uso: npm run test:proactive-alert-threshold
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-athr-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-athr-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuProactiveService: PROA } = await import("../src/server/FalaTuProactiveService.js");
  const { UxPreferencesService: PREF } = await import("../src/server/UxPreferencesService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");
  const { BusinessSignalService: BSS } = await import("../src/server/BusinessSignalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  const mkOrg = (org: string) =>
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'X', 'active', 'varejo', 'autonomo', 'active')`).run(randomUUID(), org);
  mkOrg(A); mkOrg(B);
  PermissionService.seedSystemProfiles(A); PermissionService.seedSystemProfiles(B);
  const prof = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any).id;
  const owner = { userId: "u1", email: "dono@x.com", role: "owner", role_profile_id: prof(A, "owner"), organizationId: A };
  const now = new Date("2026-08-12T15:00:00Z"); // 12h SP — acordado no default
  const ids = (org: string, u: any) => PROA.selectUrgent(org, u, now).map((i: any) => i.title);

  // Aprovações de valores distintos + uma sem valor + um risco crítico de valor baixo.
  DA.propose(A, { domain: "sales", actionType: "prepare_campaign", title: "Pequena", expectedImpact: 100 });
  DA.propose(A, { domain: "sales", actionType: "prepare_campaign", title: "Grande", expectedImpact: 5000 });
  DA.propose(A, { domain: "sales", actionType: "prepare_campaign", title: "SemValor" }); // sem expectedImpact
  BSS.publish(A, { domain: "sales", signalType: "conversion_drop", severity: "critical", basis: "fact", confidence: 0.9, sourceService: "test", subjectType: "sku", subjectId: "S1", dedupeKey: "risk:S1", impactAmount: 50 } as any);

  // ═══════════════ 1. default (limiar 0) → tudo passa (0 regressão) ═══════════════
  const def = ids(A, owner);
  check("1.1 default: pequena+grande+semvalor todas urgentes", def.includes("Pequena") && def.includes("Grande") && def.includes("SemValor"));

  // ═══════════════ 2. limiar 500 → pequena some, grande e sem-valor ficam ═══════════════
  PREF.set(A, owner.userId, { alertMinAmount: 500 });
  const thr = ids(A, owner);
  check("2.1 valor abaixo do limiar (100) NÃO é push", !thr.includes("Pequena"));
  check("2.2 valor acima (5000) permanece", thr.includes("Grande"));
  check("2.3 sem valor conhecido sempre passa (não cala decisão)", thr.includes("SemValor"));

  // ═══════════════ 3. crítico nunca é filtrado (§45/D7) ═══════════════
  // O risco crítico tem valor 50 (< 500) mas DEVE aparecer.
  const hasCritical = PROA.selectUrgent(A, owner, now).some((i: any) => i.severity === "critical");
  check("3.1 risco crítico de valor baixo AINDA aparece (nunca silencia crítico)", hasCritical === true);

  // ═══════════════ 4. undo volta ao comportamento default ═══════════════
  PREF.set(A, owner.userId, { alertMinAmount: null });
  check("4.1 undo: pequena volta a ser urgente", ids(A, owner).includes("Pequena"));

  // ═══════════════ 5. multi-tenant ═══════════════
  check("5.1 org B isolada (sem itens de A)", PROA.selectUrgent(B, { userId: "u9", role: "owner", organizationId: B }, now).length === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} proactive-alert-threshold: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
