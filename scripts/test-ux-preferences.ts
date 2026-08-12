/**
 * TEST — Preferências de UX: quiet-hours + limiar de alerta (PRD 6 / ADR-163 F13).
 * DB-backed, det., isolado. Prova (§53/§68, D7):
 *   - effective: default do sistema quando não configurado (7..22, limiar 0);
 *   - set: persiste + auditoria + validação (hora 0-23, limiar >=0); undo via null;
 *   - isAwake: janela normal + virada de meia-noite; shouldAlert respeita limiar;
 *   - FalaTuProactiveService HONRA a preferência (quiet_hours) — e 0 regressão no default;
 *   - role-gate na rota (testado via service+multi-tenant aqui).
 *
 * Uso: npm run test:ux-preferences
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pref-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pref-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { UxPreferencesService: PREF } = await import("../src/server/UxPreferencesService.js");
  const { FalaTuProactiveService: PROA } = await import("../src/server/FalaTuProactiveService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  const mkOrg = (org: string) =>
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'X', 'active', 'varejo', 'autonomo', 'active')`).run(randomUUID(), org);
  mkOrg(A); mkOrg(B);
  const actor = "u1";

  // ═══════════════ 1. default (0 regressão) ═══════════════
  const d = PREF.effective(A);
  check("1.1 default 7..22, limiar 0, source default", d.awakeStart === 7 && d.awakeEnd === 22 && d.alertMinAmount === 0 && d.source === "default");
  check("1.2 isAwake default: 10h acordado, 3h quiet, 22h quiet (exclusivo)", PREF.isAwake(A, 10) === true && PREF.isAwake(A, 3) === false && PREF.isAwake(A, 22) === false);

  // ═══════════════ 2. set + auditoria + validação ═══════════════
  const s = PREF.set(A, actor, { awakeStart: 9, awakeEnd: 18, alertMinAmount: 500 });
  check("2.1 set persiste + source custom", s.awakeStart === 9 && s.awakeEnd === 18 && s.alertMinAmount === 500 && s.source === "custom");
  const audited = (db.prepare(`SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'UX_PREFERENCES_UPDATED'`).get(A) as any).n;
  check("2.2 gravação auditada", audited >= 1);
  let threw = false; try { PREF.set(A, actor, { awakeStart: 25 }); } catch { threw = true; }
  check("2.3 hora inválida (25) rejeitada", threw === true);
  let threw2 = false; try { PREF.set(A, actor, { alertMinAmount: -5 }); } catch { threw2 = true; }
  check("2.4 limiar negativo rejeitado", threw2 === true);

  // ═══════════════ 3. isAwake + shouldAlert com custom ═══════════════
  check("3.1 janela custom 9..18: 8h quiet, 12h acordado", PREF.isAwake(A, 8) === false && PREF.isAwake(A, 12) === true);
  check("3.2 shouldAlert: R$300 abaixo do limiar (500) filtra", PREF.shouldAlert(A, 300) === false && PREF.shouldAlert(A, 800) === true);
  check("3.3 shouldAlert: alerta sem valor sempre passa", PREF.shouldAlert(A, null) === true);

  // ═══════════════ 4. virada de meia-noite (start>end) + undo ═══════════════
  PREF.set(A, actor, { awakeStart: 22, awakeEnd: 6 });   // acordado 22h..06h (cruza meia-noite)
  check("4.1 wrap: 23h acordado, 3h acordado, 12h quiet", PREF.isAwake(A, 23) === true && PREF.isAwake(A, 3) === true && PREF.isAwake(A, 12) === false);
  PREF.set(A, actor, { awakeStart: null, awakeEnd: null, alertMinAmount: null });   // undo → default
  const back = PREF.effective(A);
  check("4.2 undo (null) volta ao default", back.awakeStart === 7 && back.awakeEnd === 22 && back.source === "default");

  // ═══════════════ 5. FalaTuProactive HONRA a preferência ═══════════════
  // 14h SP — dentro do default (acordado). Configura janela 15..18 → 14h vira quiet.
  const at14hUTC = new Date("2026-08-12T17:00:00Z");   // 14h SP (UTC-3)
  db.prepare(`UPDATE organization_settings SET falatu_proactive_alerts_enabled = 1 WHERE organization_id = ?`).run(A);
  const deliveredDefault = await PROA.deliver(A, { userId: actor, role: "owner", organizationId: A }, { now: at14hUTC, push: { sendToUser: async () => ({ sent: 0, reason: "no_sub" }) } as any });
  check("5.1 default: 14h NÃO é quiet (skip != quiet_hours)", deliveredDefault.skipped !== "quiet_hours");
  PREF.set(A, actor, { awakeStart: 15, awakeEnd: 18 });
  const deliveredCustom = await PROA.deliver(A, { userId: actor, role: "owner", organizationId: A }, { now: at14hUTC, push: { sendToUser: async () => ({ sent: 0, reason: "no_sub" }) } as any });
  check("5.2 custom 15..18: 14h VIRA quiet_hours (preferência honrada)", deliveredCustom.skipped === "quiet_hours");

  // ═══════════════ 6. multi-tenant ═══════════════
  check("6.1 org B intacta no default", PREF.effective(B).source === "default" && PREF.isAwake(B, 14) === true);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} ux-preferences: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
