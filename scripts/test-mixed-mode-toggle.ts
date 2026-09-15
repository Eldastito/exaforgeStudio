/**
 * TESTE — W3: interruptor do modo misto (um número = atendimento + gestão).
 * ------------------------------------------------------------------------------
 * A flag `mixed_mode_enabled` existia (F3.3b) mas NÃO tinha como ser ligada
 * sem SQL manual. `MixedModeInboundService.setEnabled` (+ rotas
 * GET/POST /api/channels/mixed-mode) dá o interruptor ao dono. Prova, offline:
 *   - default OFF (0-regressão: inbound idêntico ao de hoje);
 *   - ligar → isEnabled true; desligar → false (rollback do runbook §604);
 *   - managersCount honesto (avisa ligar sem gestor autorizado);
 *   - auditado; isolamento multi-tenant.
 *
 * Uso:  npm run test:mixed-mode-toggle
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mixed-toggle-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-mixed-toggle-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { MixedModeInboundService } = await import("../src/server/MixedModeInboundService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);

  // 1) Default OFF (0-regressão do inbound).
  check("1.1 default é DESLIGADO", MixedModeInboundService.isEnabled(A) === false);

  // 2) Ligar sem gestor: liga, mas managersCount=0 (a UI avisa — não é erro).
  const on = MixedModeInboundService.setEnabled(A, true, "owner1");
  check("2.1 ligar → enabled true", on.enabled === true && MixedModeInboundService.isEnabled(A) === true);
  check("2.2 sem gestor autorizado → managersCount 0 (honesto)", on.managersCount === 0);

  // 3) Com gestor cadastrado, managersCount reflete.
  db.prepare(`INSERT INTO authorized_managers (id, organization_id, identifier, name) VALUES (?, ?, '5521999990000', 'Dono')`).run(randomUUID(), A);
  const on2 = MixedModeInboundService.setEnabled(A, true, "owner1");
  check("3.1 managersCount conta o gestor da org", on2.managersCount === 1);

  // 4) Desligar = rollback (§604): volta false na hora.
  const off = MixedModeInboundService.setEnabled(A, false, "owner1");
  check("4.1 desligar → enabled false", off.enabled === false && MixedModeInboundService.isEnabled(A) === false);

  // 5) Isolamento multi-tenant: mexer em A nunca liga B (e vice-versa).
  MixedModeInboundService.setEnabled(A, true, "owner1");
  check("5.1 ligar A não liga B", MixedModeInboundService.isEnabled(B) === false);
  MixedModeInboundService.setEnabled(B, true, "ownerB");
  MixedModeInboundService.setEnabled(A, false, "owner1");
  check("5.2 desligar A não desliga B", MixedModeInboundService.isEnabled(B) === true);
  check("5.3 managersCount de B não vê gestor de A", MixedModeInboundService.setEnabled(B, true, "ownerB").managersCount === 0);

  // 6) Auditoria registrada.
  const audits = db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'MIXED_MODE_TOGGLED'`).get(A) as any;
  check("6.1 toggles auditados (MIXED_MODE_TOGGLED)", Number(audits?.c || 0) >= 2);

  console.log("\n=== TEST: Interruptor do modo misto (W3) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
