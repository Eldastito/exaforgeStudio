/**
 * TEST — F4.1 (RF-09 §15.1): relatório POR REGISTRO + classificação de conflito.
 *
 * Prova, offline (tmp db), que FalaTuBridgeReconService.records classifica cada
 * registro do silo na taxonomia da política de migração, read-only:
 *  - linked_ok / linked_state_divergent / broken_link / unlinked_migratable /
 *    personal_only, para tasks/events/lists.
 *  - counts cobrem TODA a população; records é paginado (offset/limit) + truncated.
 *  - isolamento entre orgs.
 *
 * Uso: npm run test:falatu-bridge-records
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ft-records-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ft-records-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuBridgeReconService: RECON } = await import("../src/server/FalaTuBridgeReconService.js");
  const { TaskService } = await import("../src/server/TaskService.js");

  const A = "org_rec_A", B = "org_rec_B", U = "U1";
  const mkOrg = (org: string) => db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
  const mkFtTask = (org: string, title: string, bridged: string | null, completed = 0) =>
    db.prepare(`INSERT INTO falatu_tasks (id, organization_id, user_id, title, completed, inbox_item_id, bridged_task_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), org, U, title, completed, `ib-${randomUUID()}`, bridged);
  const mkFtEvent = (org: string, title: string, bridged: string | null) =>
    db.prepare(`INSERT INTO falatu_events (id, organization_id, user_id, title, event_date, event_time, inbox_item_id, bridged_appointment_id) VALUES (?, ?, ?, ?, '2026-08-20', '14:00', ?, ?)`)
      .run(randomUUID(), org, U, title, `ib-${randomUUID()}`, bridged);
  const mkFtList = (org: string, type: string, bridged: string | null) =>
    db.prepare(`INSERT INTO falatu_lists (id, organization_id, user_id, title, list_type, bridged_requisition_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), org, U, `lista ${type}`, type, bridged);
  const mkAppt = (org: string) => { const id = randomUUID(); db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title) VALUES (?, ?, 'c1', 'appt')`).run(id, org); return id; };
  const mkReq = (org: string) => { const id = randomUUID(); db.prepare(`INSERT INTO purchase_requisitions (id, organization_id) VALUES (?, ?)`).run(id, org); return id; };

  mkOrg(A); mkOrg(B);

  const classOf = (recs: any[], title: string) => recs.find((r) => r.title === title)?.classification;

  // ── TASKS: 4 situações ──
  const canonOpen = TaskService.create(A, { title: "canon-open", source: "falatu" }, U); // status a_fazer
  mkFtTask(A, "t-ok", canonOpen.id, 0);          // silo aberta × canon aberta → linked_ok
  const canonOpen2 = TaskService.create(A, { title: "canon-open2", source: "falatu" }, U);
  mkFtTask(A, "t-divergent", canonOpen2.id, 1);  // silo FEITA × canon aberta → divergent
  mkFtTask(A, "t-broken", "ghost-task", 0);      // vínculo pra canônico inexistente
  mkFtTask(A, "t-unlinked", null, 0);            // sem espelho → migratable

  // ── EVENTS: linked_ok, broken, personal ──
  const apptId = mkAppt(A);
  mkFtEvent(A, "e-ok", apptId);      // linked_ok
  mkFtEvent(A, "e-broken", "ghost-appt");
  mkFtEvent(A, "e-personal", null);  // personal_only

  // ── LISTS: linked_ok, unlinked, broken, personal ──
  const reqId = mkReq(A);
  mkFtList(A, "shopping", reqId);        // linked_ok
  mkFtList(A, "shopping", null);          // unlinked_migratable
  mkFtList(A, "shopping", "ghost-req");   // broken_link
  mkFtList(A, "general", null);           // personal_only

  const rep = RECON.records(A, { limit: 1000 });

  // ── 1. classificações por registro ──
  check("1.1 task linked_ok", classOf(rep.records, "t-ok") === "linked_ok");
  check("1.2 task state_divergent", classOf(rep.records, "t-divergent") === "linked_state_divergent");
  check("1.3 task broken_link", classOf(rep.records, "t-broken") === "broken_link");
  check("1.4 task unlinked_migratable", classOf(rep.records, "t-unlinked") === "unlinked_migratable");
  check("1.5 event linked_ok", classOf(rep.records, "e-ok") === "linked_ok");
  check("1.6 event broken_link", classOf(rep.records, "e-broken") === "broken_link");
  check("1.7 event personal_only", classOf(rep.records, "e-personal") === "personal_only");
  check("1.8 list linked_ok", classOf(rep.records, "lista shopping") === "linked_ok" || rep.records.some((r) => r.recordType === "list" && r.classification === "linked_ok"));
  check("1.9 list unlinked_migratable presente", rep.records.some((r) => r.recordType === "list" && r.classification === "unlinked_migratable"));
  check("1.10 list broken_link presente", rep.records.some((r) => r.recordType === "list" && r.classification === "broken_link"));
  check("1.11 list personal_only (general)", rep.records.some((r) => r.recordType === "list" && r.classification === "personal_only"));

  // ── 2. counts cobrem toda a população ──
  // tasks: 1 ok + 1 divergent + 1 broken + 1 unlinked  (canon-open/canon-open2 NÃO são falatu_tasks)
  // events: 1 ok + 1 broken + 1 personal
  // lists: 1 ok + 1 unlinked + 1 broken + 1 personal
  check("2.1 count linked_ok = 3", rep.counts.linked_ok === 3);
  check("2.2 count linked_state_divergent = 1", rep.counts.linked_state_divergent === 1);
  check("2.3 count broken_link = 3", rep.counts.broken_link === 3);
  check("2.4 count unlinked_migratable = 2", rep.counts.unlinked_migratable === 2);
  check("2.5 count personal_only = 2", rep.counts.personal_only === 2);
  check("2.6 total = 11", rep.total === 11);

  // ── 3. paginação ──
  const page = RECON.records(A, { limit: 4, offset: 0 });
  check("3.1 limit respeitado", page.records.length === 4 && page.returned === 4);
  check("3.2 truncated true", page.truncated === true);
  const page2 = RECON.records(A, { limit: 4, offset: 8 });
  check("3.3 offset traz o resto (3) e truncated false", page2.records.length === 3 && page2.truncated === false);
  // counts estáveis independentemente da paginação
  check("3.4 counts não mudam com paginação", page.total === 11 && page2.total === 11);

  // ── 4. divergência no outro sentido (canon feito × silo aberta) ──
  const canonDone = TaskService.create(A, { title: "canon-done", source: "falatu" }, U);
  TaskService.move(A, canonDone.id, "feito", U);
  mkFtTask(A, "t-div2", canonDone.id, 0); // silo aberta × canon feito → divergent
  check("4.1 divergência canon-feito×silo-aberta", classOf(RECON.records(A, { limit: 1000 }).records, "t-div2") === "linked_state_divergent");

  // ── 5. isolamento ──
  const repB = RECON.records(B, { limit: 1000 });
  check("5.1 org B vazia", repB.total === 0 && repB.records.length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-bridge-records: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
