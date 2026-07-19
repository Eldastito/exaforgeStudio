/**
 * TEST — Backup automático programado + redundância da plataforma + retenção (ADR-097).
 * Uso: npm run test:backup-scheduler
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bkpsched-"));
process.env.DATA_DIR = tmpDir;
process.env.BACKUPS_DIR = path.join(tmpDir, "backups");
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-bkpsched-1234567890abcdef";
process.env.S3_ENABLED = "false";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { Scheduler } = await import("../src/server/Scheduler.js");
  const { BackupService } = await import("../src/server/BackupService.js");

  const jobsOf = (orgId: string, type: string) =>
    db.prepare(`SELECT * FROM backup_jobs WHERE organization_id = ? AND type = ? AND status = 'completed'`).all(orgId, type) as any[];

  // Org A: backup automático LIGADO (diário, retenção 2). Org B: desligada (só redundância).
  const orgA = randomUUID(), orgB = randomUUID();
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, backup_auto_enabled, backup_frequency, backup_retention, backup_to_drive) VALUES (?, 'Loja A', 'active', 1, 'daily', 2, 0)`).run(orgA);
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, backup_auto_enabled) VALUES (?, 'Loja B', 'active', 0)`).run(orgB);

  // 1) Primeiro passe: gera backup do cliente (org A) + redundância nas duas.
  await Scheduler.backupPass();
  check("1.1 org A ganhou backup 'auto'", jobsOf(orgA, 'auto').length === 1);
  check("1.2 org A gravou backup_auto_last_run", !!(db.prepare(`SELECT backup_auto_last_run AS x FROM organization_settings WHERE organization_id=?`).get(orgA) as any)?.x);
  check("1.3 org A ganhou redundância 'platform'", jobsOf(orgA, 'platform').length === 1);
  check("1.4 org B (auto OFF) NÃO ganhou backup 'auto'", jobsOf(orgB, 'auto').length === 0);
  check("1.5 org B ganhou redundância 'platform' (independe do opt-in)", jobsOf(orgB, 'platform').length === 1);

  // 2) Segundo passe imediato: travas de frequência não deixam duplicar.
  await Scheduler.backupPass();
  check("2.1 org A não duplicou 'auto' (trava diária)", jobsOf(orgA, 'auto').length === 1);
  check("2.2 'platform' não duplicou (trava semanal)", jobsOf(orgA, 'platform').length === 1 && jobsOf(orgB, 'platform').length === 1);

  // 3) Arquivo no disco de verdade.
  const anyAuto = jobsOf(orgA, 'auto')[0];
  const full = BackupService.resolveFile(orgA, anyAuto.file_url);
  check("3.1 arquivo do backup existe no disco", !!full && fs.existsSync(full));

  // 4) Retenção: com 5 backups 'auto', manter só os 2 mais recentes.
  for (let i = 0; i < 4; i++) await BackupService.runAndDistribute(orgA, 'auto', { toDrive: false });
  check("4.1 há 5 backups 'auto' antes da retenção", jobsOf(orgA, 'auto').length === 5);
  const removed = await BackupService.applyRetention(orgA, 2, 'auto');
  check("4.2 retenção removeu 3", removed === 3);
  check("4.3 restaram 2 backups 'auto'", jobsOf(orgA, 'auto').length === 2);
  check("4.4 retenção não tocou nos 'platform'", jobsOf(orgA, 'platform').length === 1);

  // 5) Isolamento: backup da org A só contém dados da org A (multi-tenant).
  const latest = jobsOf(orgA, 'auto')[0];
  const p = BackupService.resolveFile(orgA, latest.file_url);
  const snap = JSON.parse(fs.readFileSync(p!, 'utf-8'));
  check("5.1 snapshot é da org A", snap.organization_id === orgA);

  console.log("\n=== test:backup-scheduler ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s).`); process.exit(1); }
  console.log("\n✅ Backup automático + redundância + retenção OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
