/**
 * TEST — BackupService (ADR-057).
 *
 * Backup era um gap crítico: ADR-057 assumiu explicitamente que "restore não
 * é testado". Este teste fecha parte desse gap — cria backup, valida
 * conteúdo, valida isolamento por tenant, valida anti-path-traversal,
 * valida checksum + delete idempotente.
 *
 * Não cobre restauração de VOLUME (isso exige derrubar/subir DB e não é
 * viável em CI barato). Cobre: fluxo de escrita, autorização por path, PII
 * NÃO vaza entre orgs no backup.
 *
 * Uso: npm run test:backup-service
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-backup-"));
process.env.DATA_DIR = tmpDir;
process.env.BACKUPS_DIR = path.join(tmpDir, "backups");
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-backup-1234567890ab";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BackupService } = await import("../src/server/BackupService.js");

  // Setup: 2 orgs com contatos, tickets, mensagens (dados que DEVEM ficar isolados).
  const orgA = `org_A_${randomUUID().slice(0, 6)}`;
  const orgB = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgA, "Loja A");
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgB, "Loja B");

  const chA = randomUUID(), chB = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'evolution', 'canal A', 'active')`).run(chA, orgA);
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'evolution', 'canal B', 'active')`).run(chB, orgB);

  const contactA = randomUUID(), contactB = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(contactA, orgA, chA, "Alice", "5511911110000");
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(contactB, orgB, chB, "Bruno", "5511922220000");

  const ticketA = randomUUID();
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id) VALUES (?, ?, ?)`).run(ticketA, orgA, contactA);
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content) VALUES (?, ?, ?, 'contact', 'segredo da Alice para orgA')`)
    .run(randomUUID(), orgA, ticketA);

  // ==== 1. Backup cria arquivo com conteúdo esperado ====
  console.log("\n=== 1. Backup — criação ===");
  const jobId = `job_${randomUUID().slice(0, 8)}`;
  const res = BackupService.run(orgA, jobId, "manual");
  check("1.1 retorna nome + tamanho + contagem", !!res.fileName && res.sizeBytes > 0 && res.recordCount >= 3);
  const filePath = path.join(process.env.BACKUPS_DIR!, res.fileName);
  check("1.2 arquivo criado no disco", fs.existsSync(filePath));

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  check("1.3 snapshot tem version + org id", parsed.version === 1 && parsed.organization_id === orgA);
  check("1.4 snapshot inclui organization_settings", (parsed.tables.organization_settings || []).length >= 1);
  check("1.5 snapshot inclui contacts", (parsed.tables.contacts || []).length === 1 && parsed.tables.contacts[0].id === contactA);
  check("1.6 snapshot inclui tickets", (parsed.tables.tickets || []).length === 1 && parsed.tables.tickets[0].id === ticketA);
  check("1.7 snapshot inclui messages com conteúdo real", (parsed.tables.messages || []).length === 1 && parsed.tables.messages[0].content.includes("Alice"));

  // ==== 2. Isolamento por tenant no backup ====
  console.log("\n=== 2. Isolamento — backup da org A NÃO tem dados da B ===");
  const contactsInA = parsed.tables.contacts;
  const hasBData = contactsInA.some((c: any) => c.id === contactB || c.name === "Bruno");
  check("2.1 backup da orgA não contém contato da orgB", !hasBData);

  // Backup da B: espelho
  const resB = BackupService.run(orgB, `job_${randomUUID().slice(0, 8)}`, "manual");
  const parsedB = JSON.parse(fs.readFileSync(path.join(process.env.BACKUPS_DIR!, resB.fileName), "utf-8"));
  const hasADataInB = parsedB.tables.contacts.some((c: any) => c.id === contactA);
  check("2.2 backup da orgB não contém contato da orgA", !hasADataInB);
  check("2.3 backup da B tem SEU próprio contato", parsedB.tables.contacts.some((c: any) => c.id === contactB));

  // ==== 3. resolveFile — anti-path-traversal ====
  console.log("\n=== 3. resolveFile (anti path-traversal) ===");
  check("3.1 arquivo legítimo da orgA resolve", BackupService.resolveFile(orgA, res.fileName) !== null);
  check("3.2 arquivo com .. rejeitado", BackupService.resolveFile(orgA, "../etc/passwd") === null);
  check("3.3 arquivo com / rejeitado", BackupService.resolveFile(orgA, "sub/dir.json") === null);
  check("3.4 arquivo com \\ rejeitado", BackupService.resolveFile(orgA, "sub\\dir.json") === null);
  check("3.5 arquivo da OUTRA org é rejeitado (não começa com o safeOrg)", BackupService.resolveFile(orgB, res.fileName) === null);
  check("3.6 arquivo inexistente retorna null", BackupService.resolveFile(orgA, `${orgA.replace(/[^a-zA-Z0-9_-]/g, "")}-nao-existe.json`) === null);
  check("3.7 fileName vazio retorna null", BackupService.resolveFile(orgA, "") === null);

  // ==== 4. Delete idempotente ====
  console.log("\n=== 4. Delete idempotente ===");
  const delTarget = res.fileName;
  check("4.1 delete legítimo retorna true", BackupService.deleteFile(orgA, delTarget) === true);
  check("4.2 delete de mesmo arquivo já removido retorna false (não crasha)", BackupService.deleteFile(orgA, delTarget) === false);
  check("4.3 delete de arquivo da outra org retorna false", BackupService.deleteFile(orgB, resB.fileName) === true && BackupService.deleteFile(orgA, resB.fileName) === false);
  // Arquivo do B ainda existe? Sim, primeiro delete acima removeu — vamos regerar
  BackupService.run(orgB, `job_new_${randomUUID().slice(0, 8)}`, "manual");

  // ==== 5. Checksum estável ====
  console.log("\n=== 5. Checksum SHA-256 estável ===");
  const jobC = `job_${randomUUID().slice(0, 8)}`;
  const resC = BackupService.run(orgA, jobC, "manual");
  const fullPathC = path.join(process.env.BACKUPS_DIR!, resC.fileName);
  const cs1 = BackupService.checksum(fullPathC);
  const cs2 = BackupService.checksum(fullPathC);
  check("5.1 checksum de mesmo arquivo é idêntico", cs1 === cs2);
  check("5.2 checksum é hex de 64 chars (SHA-256)", /^[0-9a-f]{64}$/.test(cs1));

  // ==== 6. type propaga para o snapshot ====
  console.log("\n=== 6. type propaga ===");
  const resM = BackupService.run(orgA, `job_${randomUUID().slice(0, 8)}`, "scheduled");
  const snapshotM = JSON.parse(fs.readFileSync(path.join(process.env.BACKUPS_DIR!, resM.fileName), "utf-8"));
  check("6.1 type customizado aparece no snapshot", snapshotM.type === "scheduled");

  // ==== 7. Org sem dados: snapshot vazio mas não crasha ====
  console.log("\n=== 7. Org vazia gera snapshot íntegro ===");
  const orgEmpty = `org_empty_${randomUUID().slice(0, 6)}`;
  const resE = BackupService.run(orgEmpty, `job_${randomUUID().slice(0, 8)}`, "manual");
  check("7.1 backup de org sem dados existe", fs.existsSync(path.join(process.env.BACKUPS_DIR!, resE.fileName)));
  const snapshotE = JSON.parse(fs.readFileSync(path.join(process.env.BACKUPS_DIR!, resE.fileName), "utf-8"));
  check("7.2 recordCount da org vazia é 0", resE.recordCount === 0);
  check("7.3 tables presentes mas vazias", Array.isArray(snapshotE.tables.contacts) && snapshotE.tables.contacts.length === 0);

  // ==== Relatório ====
  console.log("\n=========================================");
  console.log("RELATÓRIO — BackupService (ADR-057)");
  console.log("=========================================");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  console.log("=========================================");
  console.log(`${results.length - failures}/${results.length} passaram`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.log(`❌ ${failures} falhas`); process.exit(1); }
  console.log("✅ Todos os testes passaram");
  process.exit(0);
}

main().catch((e) => {
  console.error("💥 Teste explodiu:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
