/**
 * TEST — Restore de backup com backup-guard, multi-tenant seguro (ADR-097).
 * Uso: npm run test:backup-restore
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bkprestore-"));
process.env.DATA_DIR = tmpDir;
process.env.BACKUPS_DIR = path.join(tmpDir, "backups");
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-bkprestore-1234567890abcdef";
process.env.S3_ENABLED = "false";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { BackupService } = await import("../src/server/BackupService.js");

  const orgA = randomUUID(), orgB = randomUUID();
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'Loja A', 'active')`).run(orgA);
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'Loja B', 'active')`).run(orgB);

  // Um canal por org (contacts.channel_id é NOT NULL).
  const chA = randomUUID(), chB = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, name, provider, identifier, status) VALUES (?, ?, 'Canal A', 'evolution_go', 'a', 'active')`).run(chA, orgA);
  db.prepare(`INSERT INTO channels (id, organization_id, name, provider, identifier, status) VALUES (?, ?, 'Canal B', 'evolution_go', 'b', 'active')`).run(chB, orgB);
  const chOf = (org: string) => org === orgA ? chA : chB;
  const addContact = (org: string, name: string) => db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, chOf(org), name, `55${Math.floor(Math.random()*1e10)}`);
  const countContacts = (org: string) => (db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE organization_id = ?`).get(org) as any).n;

  // Estado inicial: A com 3 contatos, B com 2.
  addContact(orgA, "Ana"); addContact(orgA, "Bruno"); addContact(orgA, "Carla");
  addContact(orgB, "Diego"); addContact(orgB, "Elisa");

  // Backup da org A.
  const bkp = await BackupService.runAndDistribute(orgA, 'manual', { toDrive: false });
  check("1.1 backup gerado", !!bkp?.fileName);

  // Muta o estado: apaga tudo de A e adiciona ruído.
  db.prepare(`DELETE FROM contacts WHERE organization_id = ?`).run(orgA);
  addContact(orgA, "Ruído1"); addContact(orgA, "Ruído2");
  check("2.1 estado de A mudou antes do restore", countContacts(orgA) === 2);

  // Restaura.
  const r = BackupService.restore(orgA, bkp!.fileName);
  check("3.1 restore ok", r.ok === true);
  check("3.2 gerou backup-guard antes de sobrescrever", !!r.guardFileName);
  check("3.3 há um backup 'pre-restore' registrado", (db.prepare(`SELECT COUNT(*) AS n FROM backup_jobs WHERE organization_id = ? AND type = 'pre-restore'`).get(orgA) as any).n === 1);
  check("3.4 A voltou a ter 3 contatos", countContacts(orgA) === 3);
  const names = (db.prepare(`SELECT name FROM contacts WHERE organization_id = ? ORDER BY name`).all(orgA) as any[]).map(x => x.name);
  check("3.5 contatos originais restaurados", JSON.stringify(names) === JSON.stringify(["Ana", "Bruno", "Carla"]));
  check("3.6 ruído removido", !names.includes("Ruído1") && !names.includes("Ruído2"));

  // Isolamento: a org B não pode ter sido tocada.
  check("4.1 org B intacta (2 contatos)", countContacts(orgB) === 2);

  // Snapshot de OUTRA org é rejeitado.
  const rB = BackupService.restore(orgA, bkp!.fileName.replace(orgA, orgA)); // mesmo arquivo (sanidade)
  check("4.2 restore do próprio arquivo continua ok", rB.ok === true);

  // Arquivo adulterado: snapshot da org A com uma linha de contato da org B dentro.
  const tamperedName = `${orgA}-tampered.json`;
  fs.writeFileSync(path.join(process.env.BACKUPS_DIR!, tamperedName), JSON.stringify({
    version: 1, organization_id: orgA, type: 'manual', tables: {
      contacts: [
        { id: randomUUID(), organization_id: orgA, channel_id: chA, name: "LegitA", identifier: "5511" },
        { id: randomUUID(), organization_id: orgB, channel_id: chB, name: "InvasorB", identifier: "5522" }, // deve ser IGNORADA
      ],
    },
  }));
  const rt = BackupService.restore(orgA, tamperedName);
  check("5.1 restore adulterado ok", rt.ok === true);
  check("5.2 só a linha da própria org foi escrita", countContacts(orgA) === 1);
  check("5.3 linha de outra org NÃO vazou", (db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE name = 'InvasorB'`).get() as any).n === 0);
  check("5.4 org B segue intacta após adulteração", countContacts(orgB) === 2);

  // Snapshot cujo organization_id é de outra org é recusado.
  const wrongOrgName = `${orgA}-wrongorg.json`;
  fs.writeFileSync(path.join(process.env.BACKUPS_DIR!, wrongOrgName), JSON.stringify({ version: 1, organization_id: orgB, type: 'manual', tables: {} }));
  const rw = BackupService.restore(orgA, wrongOrgName);
  check("6.1 snapshot de outra org é recusado", rw.ok === false && rw.error === 'snapshot_de_outra_org');

  console.log("\n=== test:backup-restore ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s).`); process.exit(1); }
  console.log("\n✅ Restore multi-tenant seguro + backup-guard OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
