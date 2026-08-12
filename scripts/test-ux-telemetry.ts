/**
 * TEST — Telemetria de UX (PRD 6 / ADR-163 F10). DB-backed, det., isolado.
 * Prova (§80-§84, RN-UX-7/LGPD):
 *   - opt-in: sem a flag, record é NO-OP (nada coletado);
 *   - whitelist: event_type fora da lista não grava;
 *   - minimização LGPD: surface/module sanitizados ([a-z0-9_-]) — sem texto livre/PII;
 *   - TTFV só em first_value; agregados (byType, ttfv, adoção, abandono) derivados;
 *   - summary só pra gestor (§73); multi-tenant.
 *
 * Uso: npm run test:ux-telemetry
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-tel-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-tel-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { UxTelemetryService: TEL } = await import("../src/server/UxTelemetryService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  const mkOrg = (org: string, tel: number) =>
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status, ux_telemetry_enabled) VALUES (?, ?, 'X', 'active', 'varejo', 'autonomo', 'active', ?)`).run(randomUUID(), org, tel);
  mkOrg(A, 1); mkOrg(B, 0);
  PermissionService.seedSystemProfiles(A); PermissionService.seedSystemProfiles(B);
  const prof = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any).id;
  const owner = { userId: "u1", email: "dono@x.com", role: "owner", role_profile_id: prof(A, "owner"), organizationId: A };
  const atendente = { userId: "u3", email: "at@x.com", role: "agent", role_profile_id: prof(A, "atendente"), organizationId: A };
  const ownerB = { userId: "u9", email: "dono@b.com", role: "owner", role_profile_id: prof(B, "owner"), organizationId: B };
  const rowCount = (org: string) => (db.prepare(`SELECT COUNT(*) n FROM ux_telemetry_events WHERE organization_id = ?`).get(org) as any).n;

  // ═══════════════ 1. opt-in (consentimento §84) ═══════════════
  const off = TEL.record(B, ownerB, { eventType: "view_opened", surface: "hoje", sessionId: "s0" });
  check("1.1 sem flag → no-op (recorded false, disabled)", off.recorded === false && off.reason === "disabled");
  check("1.2 nada coletado em B", rowCount(B) === 0);

  // ═══════════════ 2. whitelist ═══════════════
  const bad = TEL.record(A, owner, { eventType: "keylogger" as any, surface: "hoje" });
  check("2.1 event_type fora do whitelist não grava", bad.recorded === false && bad.reason === "event_type_not_allowed");

  // ═══════════════ 3. minimização LGPD (sanitização) ═══════════════
  TEL.record(A, owner, { eventType: "view_opened", surface: "Minha Tela!! <x@y.com>", moduleKey: "campanhas", sessionId: "s1" });
  const stored = db.prepare(`SELECT surface, module_key FROM ux_telemetry_events WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1`).get(A) as any;
  check("3.1 surface sanitizado (sem espaço, sem @, sem !)", !/[^a-z0-9_-]/.test(stored.surface) && stored.surface.length > 0);
  check("3.2 module_key preservado como id curto", stored.module_key === "campanhas");
  // Garante que a tabela não tem coluna de conteúdo (minimização estrutural).
  const cols = (db.prepare(`PRAGMA table_info(ux_telemetry_events)`).all() as any[]).map((c: any) => c.name);
  check("3.3 tabela não tem coluna de conteúdo/payload/text", !cols.some((c: string) => /content|payload|text|body|message/i.test(c)));

  // ═══════════════ 4. TTFV só em first_value + eventos de sessão ═══════════════
  TEL.record(A, owner, { eventType: "action_clicked", surface: "hoje", sessionId: "s1", ttfvMs: 999 }); // ttfv deve ser ignorado
  TEL.record(A, owner, { eventType: "first_value", surface: "hoje", sessionId: "s1", ttfvMs: 1200 });
  TEL.record(A, owner, { eventType: "view_opened", surface: "resultados", sessionId: "s2" }); // sessão abandonada (só view)
  const clickRow = db.prepare(`SELECT ttfv_ms FROM ux_telemetry_events WHERE organization_id = ? AND event_type='action_clicked'`).get(A) as any;
  check("4.1 TTFV ignorado fora de first_value", clickRow.ttfv_ms === null);
  const fvRow = db.prepare(`SELECT ttfv_ms FROM ux_telemetry_events WHERE organization_id = ? AND event_type='first_value'`).get(A) as any;
  check("4.2 TTFV gravado em first_value", fvRow.ttfv_ms === 1200);

  // ═══════════════ 5. summary agregado (gestor) ═══════════════
  const s = TEL.summary(A, owner) as any;
  check("5.1 totals por tipo", s.totals.byType.view_opened === 2 && s.totals.byType.action_clicked === 1 && s.totals.byType.first_value === 1);
  check("5.2 ttfv agregado (median/avg = 1200)", s.ttfv.count === 1 && s.ttfv.medianMs === 1200 && s.ttfv.avgMs === 1200);
  check("5.3 adoção: 1 usuário distinto", s.adoption.distinctUsers === 1);
  check("5.4 abandono: s1 tem ação, s2 não → 1 abandonada de 2", s.abandonment.viewSessions === 2 && s.abandonment.sessionsWithAction === 1 && s.abandonment.abandonedSessions === 1 && s.abandonment.rate === 0.5);

  // ═══════════════ 6. summary role-gated (§73) ═══════════════
  const sAt = TEL.summary(A, atendente) as any;
  check("6.1 atendente (não-gestor) → restricted", sAt.restricted === true);

  // ═══════════════ 7. multi-tenant ═══════════════
  check("7.1 org A tem eventos, B isolada (0)", rowCount(A) >= 4 && rowCount(B) === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} ux-telemetry: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
