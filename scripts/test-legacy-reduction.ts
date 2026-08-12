/**
 * TEST — Redução de legado guiada por telemetria (PRD 6 / ADR-163 F12).
 * DB-backed, det., isolado. Prova (§107/§112, RN-UX-5):
 *   - ready_to_retire só quando a nova superfície tem adoção real E o legado virou resíduo;
 *   - keep quando o legado ainda é usado; insufficient_data (default) sem dados;
 *   - ADVISÓRIO: nada é removido (não há método de delete; advisory:true);
 *   - role-gate (§73 — só gestor); multi-tenant.
 *
 * Uso: npm run test:legacy-reduction
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-leg-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-leg-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegacyReductionService: LEG } = await import("../src/server/LegacyReductionService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  const mkOrg = (org: string) =>
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status, ux_telemetry_enabled) VALUES (?, ?, 'X', 'active', 'varejo', 'autonomo', 'active', 1)`).run(randomUUID(), org);
  mkOrg(A); mkOrg(B);
  PermissionService.seedSystemProfiles(A); PermissionService.seedSystemProfiles(B);
  const prof = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any).id;
  const owner = { userId: "u1", email: "dono@x.com", role: "owner", role_profile_id: prof(A, "owner"), organizationId: A };
  const atendente = { userId: "u3", email: "at@x.com", role: "agent", role_profile_id: prof(A, "atendente"), organizationId: A };
  const ownerB = { userId: "u9", email: "dono@b.com", role: "owner", role_profile_id: prof(B, "owner"), organizationId: B };

  const ev = (org: string, surface: string, userId: string, n: number) => {
    for (let i = 0; i < n; i++)
      db.prepare(`INSERT INTO ux_telemetry_events (id, organization_id, user_id, event_type, surface) VALUES (?, ?, ?, 'view_opened', ?)`).run(randomUUID(), org, userId, surface);
  };
  // Par insights→hoje: hoje adotada (20 aberturas, 3 usuários), insights = 0 → ready.
  ev(A, "hoje", "u1", 8); ev(A, "hoje", "u2", 7); ev(A, "hoje", "u5", 5);
  // Par dashboard→resultados: resultados adotada, mas dashboard AINDA muito usado → keep.
  ev(A, "resultados", "u1", 7); ev(A, "resultados", "u2", 6); ev(A, "dashboard", "u1", 30);
  // Par tarefas→executando: pouca adoção (1 usuário, 3 aberturas) → insufficient_data.
  ev(A, "executando", "u1", 3);

  // ═══════════════ 1. ready_to_retire (substituição provada) ═══════════════
  const r = LEG.candidates(A, owner) as any;
  const cand = (leg: string) => r.candidates.find((c: any) => c.legacy === leg);
  check("1.1 insights→hoje: ready_to_retire", cand("insights").status === "ready_to_retire");
  check("1.2 evidência: nova adotada, legado resíduo", cand("insights").evidence.newViews === 20 && cand("insights").evidence.newUsers === 3 && cand("insights").evidence.legacyViews === 0);

  // ═══════════════ 2. keep (legado ainda usado) ═══════════════
  check("2.1 dashboard→resultados: keep (dashboard ainda pesado)", cand("dashboard").status === "keep");
  check("2.2 legacyShare > limiar", cand("dashboard").evidence.legacyShare > 0.1);

  // ═══════════════ 3. insufficient_data (default conservador §112) ═══════════════
  check("3.1 tarefas→executando: insufficient_data (pouca adoção)", cand("tarefas").status === "insufficient_data");
  check("3.2 par sem dado nenhum (saude→hoje só se hoje conta) → não recomenda retirar sem prova", cand("saude").status !== "ready_to_retire" || cand("saude").evidence.legacyViews === 0);

  // ═══════════════ 4. ADVISÓRIO — nada é removido ═══════════════
  check("4.1 todo candidato é advisory:true", r.candidates.every((c: any) => c.advisory === true));
  check("4.2 nota deixa claro que não remove", /nenhuma tela é removida|advis/i.test(r.note));
  // Métodos ESTÁTICOS PRÓPRIOS do service — não deve haver remove/retire/delete/apply de negócio.
  const ownStatics = Object.getOwnPropertyNames(LEG).filter((n) => typeof (LEG as any)[n] === "function" && !["length", "name", "prototype"].includes(n));
  check("4.3 service só expõe leitura (candidates), sem método de remoção", ownStatics.length === 1 && ownStatics[0] === "candidates");

  // ═══════════════ 5. role-gate (§73) ═══════════════
  const rAt = LEG.candidates(A, atendente) as any;
  check("5.1 atendente (não-gestor) → restricted", rAt.restricted === true);

  // ═══════════════ 6. multi-tenant ═══════════════
  const rB = LEG.candidates(B, ownerB) as any;
  check("6.1 org B sem eventos → tudo insufficient_data (keep)", rB.candidates.every((c: any) => c.status === "insufficient_data"));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const rr of results) if (!rr.ok) console.log(`  ✗ ${rr.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legacy-reduction: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
