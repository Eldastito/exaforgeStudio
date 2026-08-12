/**
 * TEST — Fala Tu Bridge Reconciliation (ADR-160 Onda A D5, F10). DB-backed, det., isolado.
 * Prova:
 *   - report() por tipo de bridge: cobertura (bridged/total), ELOS QUEBRADOS (vínculo →
 *     canônico inexistente = drift), prontidão; derivado por query, não toca stores;
 *   - backfillTasks(): liga tarefas históricas ao canônico (TaskService.create), só com a
 *     flag ligada, idempotente, sem inventar;
 *   - events contact-gated (cobertura não conta; só drift) + lists só 'shopping';
 *   - multi-tenant.
 *
 * Uso: npm run test:falatu-bridge-recon
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ft-recon-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ft-recon-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuBridgeReconService: RECON } = await import("../src/server/FalaTuBridgeReconService.js");
  const { TaskService } = await import("../src/server/TaskService.js");

  const A = "org_recon_A", B = "org_recon_B", U = "U1";
  const enableOrg = (org: string, flags: Partial<Record<"tasks" | "events" | "lists", boolean>> = {}) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET falatu_bridge_tasks_enabled = ?, falatu_bridge_events_enabled = ?, falatu_bridge_lists_enabled = ? WHERE organization_id = ?`)
      .run(flags.tasks ? 1 : 0, flags.events ? 1 : 0, flags.lists ? 1 : 0, org);
  };
  const mkFtTask = (org: string, title: string, bridged: string | null) =>
    db.prepare(`INSERT INTO falatu_tasks (id, organization_id, user_id, title, description, inbox_item_id, bridged_task_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), org, U, title, "desc", `ib-${randomUUID()}`, bridged);
  const mkFtEvent = (org: string, title: string, bridged: string | null) =>
    db.prepare(`INSERT INTO falatu_events (id, organization_id, user_id, title, event_date, event_time, inbox_item_id, bridged_appointment_id) VALUES (?, ?, ?, ?, '2026-08-20', '14:00', ?, ?)`)
      .run(randomUUID(), org, U, title, `ib-${randomUUID()}`, bridged);
  const mkFtList = (org: string, type: string, bridged: string | null) =>
    db.prepare(`INSERT INTO falatu_lists (id, organization_id, user_id, title, list_type, bridged_requisition_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), org, U, `lista ${type}`, type, bridged);

  enableOrg(A, { tasks: true, events: true, lists: true });
  enableOrg(B);

  // ═══════════════ 0. sem dados → nada pronto ═══════════════
  const r0 = RECON.report(A);
  check("0.1 sem tarefas → coverage null, not ready", r0.bridges.tasks.total === 0 && r0.bridges.tasks.coveragePct === null && r0.bridges.tasks.ready === false);

  // ═══════════════ 1. TASKS — cobertura + elo quebrado ═══════════════
  const canonical = TaskService.create(A, { title: "tarefa canônica", source: "falatu" }, U);
  mkFtTask(A, "t1 bridged", canonical.id);   // espelhada de verdade
  mkFtTask(A, "t2 histórica", null);          // sem espelho (backfill alvo)
  mkFtTask(A, "t3 quebrada", "ghost-id");      // vínculo pra canônico inexistente
  const r1 = RECON.report(A).bridges.tasks;
  check("1.1 total/bridged/unbridged", r1.total === 3 && r1.bridged === 2 && r1.unbridged === 1);
  check("1.2 elo quebrado detectado (drift)", r1.brokenLinks === 1);
  check("1.3 cobertura 66.7% e NÃO pronto (unbridged+broken)", r1.coveragePct === 66.7 && r1.ready === false);

  // ═══════════════ 2. BACKFILL — liga histórica, idempotente ═══════════════
  const bf = RECON.backfillTasks(A);
  check("2.1 backfill liga a tarefa histórica (1)", bf.ok && bf.backfilled === 1);
  const r2 = RECON.report(A).bridges.tasks;
  check("2.2 sem unbridged após backfill (broken persiste)", r2.unbridged === 0 && r2.brokenLinks === 1);
  const bf2 = RECON.backfillTasks(A);
  check("2.3 idempotente: 2º backfill não faz nada", bf2.backfilled === 0);
  // a tarefa canônica do backfill existe de verdade
  check("2.4 backfill criou tarefa canônica real (source falatu)", TaskService.list(A, {}).some((t: any) => t.title === "t2 histórica" && t.source === "falatu"));

  // ═══════════════ 3. BACKFILL flag-gated ═══════════════
  enableOrg(A, { tasks: false, events: true, lists: true }); // desliga só tasks
  const bfOff = RECON.backfillTasks(A);
  check("3.1 flag off → backfill recusa (bridge_disabled)", bfOff.ok === false && bfOff.reason === "bridge_disabled");
  enableOrg(A, { tasks: true, events: true, lists: true });

  // ═══════════════ 4. EVENTS — contact-gated (só drift) ═══════════════
  mkFtEvent(A, "e1 quebrada", "ghost-appt");
  mkFtEvent(A, "e2 silo-only", null);
  const re = RECON.report(A).bridges.events;
  check("4.1 events: total 2, bridged 1, coverage null (contact-gated)", re.total === 2 && re.bridged === 1 && re.coveragePct === null);
  check("4.2 events: elo quebrado → not ready + nota", re.brokenLinks === 1 && re.ready === false && !!re.note);

  // ═══════════════ 5. LISTS — só 'shopping' ═══════════════
  mkFtList(A, "shopping", "ghost-req");  // shopping bridged (quebrado)
  mkFtList(A, "shopping", null);          // shopping unbridged
  mkFtList(A, "general", null);           // ignorada (não é shopping)
  const rl = RECON.report(A).bridges.lists;
  check("5.1 lists: só shopping conta (total 2)", rl.total === 2 && rl.bridged === 1 && rl.unbridged === 1);
  check("5.2 lists: elo quebrado + cobertura 50% + nota", rl.brokenLinks === 1 && rl.coveragePct === 50 && !!rl.note);

  // ═══════════════ 6. multi-tenant ═══════════════
  const rB = RECON.report(B);
  check("6.1 org B vazia", rB.bridges.tasks.total === 0 && rB.bridges.events.total === 0 && rB.bridges.lists.total === 0);
  check("6.2 backfill B (flag off) recusa", RECON.backfillTasks(B).ok === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-bridge-recon: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
