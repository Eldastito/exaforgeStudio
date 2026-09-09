/**
 * TEST — F4.2 (RF-09 §15.2): backfill com dry-run + checkpoint + listas.
 *
 * Prova, offline (tmp db):
 *  - dry-run (tasks e lists): relata wouldBackfill SEM criar canônico, SEM
 *    carimbar, SEM gravar checkpoint (zero efeito externo — §15.1).
 *  - real: cria canônico, carimba bridged_*, grava checkpoint (migrated_total/
 *    runs/remaining); idempotente (2ª vez backfilled=0), checkpoint acumula.
 *  - listas: só shopping com item que CASA o catálogo vira requisição; sem
 *    match / vazia fica candidata (não carimba, RN-151).
 *  - events: backfillEvents → not_applicable (contact-gated).
 *  - flag off → recusa (dry-run e real); isolamento entre orgs.
 *
 * Uso: npm run test:falatu-bridge-backfill
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ft-backfill-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ft-backfill-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuBridgeReconService: RECON } = await import("../src/server/FalaTuBridgeReconService.js");
  const { TaskService } = await import("../src/server/TaskService.js");

  const A = "org_bf_A", B = "org_bf_B", U = "U1";
  const enableOrg = (org: string, on: boolean) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET falatu_bridge_tasks_enabled = ?, falatu_bridge_lists_enabled = ? WHERE organization_id = ?`).run(on ? 1 : 0, on ? 1 : 0, org);
  };
  const mkTask = (org: string, title: string) =>
    db.prepare(`INSERT INTO falatu_tasks (id, organization_id, user_id, title, inbox_item_id) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, U, title, `ib-${randomUUID()}`);
  const mkList = (org: string, type: string) => { const id = randomUUID(); db.prepare(`INSERT INTO falatu_lists (id, organization_id, user_id, title, list_type, inbox_item_id) VALUES (?, ?, ?, ?, ?, ?)`).run(id, org, U, `l-${type}`, type, `ib-${randomUUID()}`); return id; };
  const addItem = (org: string, listId: string, name: string) => db.prepare(`INSERT INTO falatu_list_items (id, organization_id, list_id, name) VALUES (?, ?, ?, ?)`).run(randomUUID(), org, listId, name);
  const mkProduct = (org: string, name: string) => db.prepare(`INSERT INTO products_services (id, organization_id, name, type, active) VALUES (?, ?, ?, 'product', 1)`).run(randomUUID(), org, name);
  const unbridgedTasks = (org: string) => (db.prepare(`SELECT COUNT(*) n FROM falatu_tasks WHERE organization_id = ? AND bridged_task_id IS NULL`).get(org) as any).n;
  const stampedLists = (org: string) => (db.prepare(`SELECT COUNT(*) n FROM falatu_lists WHERE organization_id = ? AND bridged_requisition_id IS NOT NULL`).get(org) as any).n;

  enableOrg(A, true); enableOrg(B, false);

  // ── TASKS ──
  mkTask(A, "t1"); mkTask(A, "t2");
  // dry-run: relata, não faz nada
  const dr = RECON.backfillTasks(A, { dryRun: true });
  check("1.1 dry-run: wouldBackfill=2, backfilled=0", dr.dryRun && dr.wouldBackfill === 2 && dr.backfilled === 0);
  check("1.2 dry-run NÃO criou canônico (silo intacto)", unbridgedTasks(A) === 2 && TaskService.list(A, {}).length === 0);
  check("1.3 dry-run NÃO gravou checkpoint", RECON.backfillState(A).tasks === null);
  // real
  const r1 = RECON.backfillTasks(A);
  check("1.4 real: backfilled=2, remaining=0", !r1.dryRun && r1.backfilled === 2 && r1.remaining === 0);
  check("1.5 canônico criado e carimbado", unbridgedTasks(A) === 0 && TaskService.list(A, {}).length === 2);
  const st1 = RECON.backfillState(A).tasks;
  check("1.6 checkpoint gravado (migrated_total=2, runs=1)", st1 && st1.migrated_total === 2 && st1.runs === 1);
  // idempotente + checkpoint acumula runs
  const r2 = RECON.backfillTasks(A);
  check("1.7 idempotente: backfilled=0", r2.backfilled === 0);
  const st2 = RECON.backfillState(A).tasks;
  check("1.8 checkpoint: runs=2, migrated_total inalterado=2", st2.runs === 2 && st2.migrated_total === 2);

  // ── LISTS ──
  mkProduct(A, "café");
  const L1 = mkList(A, "shopping"); addItem(A, L1, "café");     // casa catálogo
  const L2 = mkList(A, "shopping"); addItem(A, L2, "produto-inexistente-xyz"); // não casa
  mkList(A, "shopping");                                        // vazia
  // dry-run
  const dl = RECON.backfillLists(A, { dryRun: true });
  check("2.1 dry-run lists: wouldBackfill=3, backfilled=0", dl.dryRun && dl.wouldBackfill === 3 && dl.backfilled === 0);
  check("2.2 dry-run lists: nenhuma requisição carimbada", stampedLists(A) === 0);
  check("2.3 dry-run lists: sem checkpoint", RECON.backfillState(A).lists === null);
  // real
  const rl = RECON.backfillLists(A);
  check("2.4 real lists: só a que casa vira requisição (backfilled=1)", rl.backfilled === 1);
  check("2.5 L1 carimbada; L2/L3 continuam candidatas (remaining=2)", stampedLists(A) === 1 && rl.remaining === 2);
  const bridgedL1 = (db.prepare(`SELECT bridged_requisition_id b FROM falatu_lists WHERE id = ?`).get(L1) as any).b;
  const bridgedL2 = (db.prepare(`SELECT bridged_requisition_id b FROM falatu_lists WHERE id = ?`).get(L2) as any).b;
  check("2.6 L1 tem requisição, L2 não", !!bridgedL1 && !bridgedL2);
  check("2.7 checkpoint lists (migrated_total=1)", RECON.backfillState(A).lists?.migrated_total === 1);

  // ── EVENTS: não aplicável ──
  const ev = RECON.backfillEvents(A);
  check("3.1 backfillEvents → not_applicable", ev.ok === false && ev.reason === "not_applicable_contact_gated");

  // ── FLAG OFF (org B) ──
  mkTask(B, "tb");
  check("4.1 flag off: backfillTasks recusa", RECON.backfillTasks(B).ok === false && RECON.backfillTasks(B).reason === "bridge_disabled");
  check("4.2 flag off: dry-run também recusa", RECON.backfillTasks(B, { dryRun: true }).ok === false);
  check("4.3 flag off: backfillLists recusa", RECON.backfillLists(B).ok === false);
  check("4.4 flag off não criou nada", unbridgedTasks(B) === 1);

  // ── ISOLAMENTO ──
  check("5.1 org B sem checkpoint", RECON.backfillState(B).tasks === null && RECON.backfillState(B).lists === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-bridge-backfill: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
