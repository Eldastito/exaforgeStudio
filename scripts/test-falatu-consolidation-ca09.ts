/**
 * TEST — F4.4 (RF-09 / CA-09): prova ponta-a-ponta da consolidação do Fala Tu.
 *
 * CA-09: "conjunto de dados com vínculos válidos, ausentes, conflitantes e
 * pessoais é migrado DUAS VEZES sem perda, promoção de acesso ou duplicação;
 * estados continuam coerentes entre interfaces." Compõe as fatias F4.1
 * (records), F4.2 (backfill dry-run/checkpoint/listas) e F4.3 (convergência) —
 * NÃO adiciona código de produção.
 *
 * Prova:
 *  1. dataset misto (válido/ausente/quebrado/conflitante/pessoal).
 *  2. migrar 2× → SEM duplicação (idempotente; canônicos não crescem) e SEM
 *     perda (nenhum registro do silo some — discard é UPDATE, nunca DELETE).
 *  3. SEM promoção de acesso: nota/evento pessoal e lista não-shopping nunca
 *     viram objeto canônico de equipe.
 *  4. vínculo quebrado NÃO é recriado silenciosamente (segue broken_link).
 *  5. estados COERENTES entre interfaces (convergência de conclusão).
 *  6. reversibilidade/compat: flag off → silo ainda legível, dados preservados,
 *     re-habilitar não duplica.
 *  7. isolamento entre orgs.
 *
 * Uso: npm run test:falatu-consolidation-ca09
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ca09-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ca09-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuBridgeReconService: RECON } = await import("../src/server/FalaTuBridgeReconService.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { TaskService } = await import("../src/server/TaskService.js");

  const A = "org_ca09_A", B = "org_ca09_B", U = "U1";
  const enable = (org: string, on: boolean) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET falatu_bridge_tasks_enabled = ?, falatu_bridge_lists_enabled = ?, falatu_bridge_events_enabled = ? WHERE organization_id = ?`).run(on ? 1 : 0, on ? 1 : 0, on ? 1 : 0, org);
  };
  const ftTask = (org: string, title: string, bridged: string | null, completed = 0) => { const id = randomUUID(); db.prepare(`INSERT INTO falatu_tasks (id, organization_id, user_id, title, completed, inbox_item_id, bridged_task_id) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, org, U, title, completed, `ib-${randomUUID()}`, bridged); return id; };
  const ftEvent = (org: string, title: string, bridged: string | null) => { const id = randomUUID(); db.prepare(`INSERT INTO falatu_events (id, organization_id, user_id, title, event_date, event_time, inbox_item_id, bridged_appointment_id) VALUES (?, ?, ?, ?, '2026-08-20', '14:00', ?, ?)`).run(id, org, U, title, `ib-${randomUUID()}`, bridged); return id; };
  const ftList = (org: string, type: string, item?: string) => { const id = randomUUID(); db.prepare(`INSERT INTO falatu_lists (id, organization_id, user_id, title, list_type, inbox_item_id) VALUES (?, ?, ?, ?, ?, ?)`).run(id, org, U, `l-${type}`, type, `ib-${randomUUID()}`); if (item) db.prepare(`INSERT INTO falatu_list_items (id, organization_id, list_id, name) VALUES (?, ?, ?, ?)`).run(randomUUID(), org, id, item); return id; };
  const appt = (org: string) => { const id = randomUUID(); db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title) VALUES (?, ?, 'c1', 'a')`).run(id, org); return id; };
  const count = (sql: string, org: string) => (db.prepare(sql).get(org) as any).n;
  const canonTasks = (org: string) => count(`SELECT COUNT(*) n FROM tasks WHERE organization_id = ?`, org);
  const reqs = (org: string) => count(`SELECT COUNT(*) n FROM purchase_requisitions WHERE organization_id = ?`, org);
  const appts = (org: string) => count(`SELECT COUNT(*) n FROM appointments WHERE organization_id = ?`, org);
  const siloTasks = (org: string) => count(`SELECT COUNT(*) n FROM falatu_tasks WHERE organization_id = ?`, org);
  const siloEvents = (org: string) => count(`SELECT COUNT(*) n FROM falatu_events WHERE organization_id = ?`, org);
  const siloLists = (org: string) => count(`SELECT COUNT(*) n FROM falatu_lists WHERE organization_id = ?`, org);

  enable(A, true); enable(B, false);
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type, active) VALUES (?, ?, 'café', 'product', 1)`).run(randomUUID(), A);

  // ── 1. dataset misto ──
  const cValid = TaskService.create(A, { title: "válida", source: "falatu" }, U);
  ftTask(A, "t-valid", cValid.id, 0);            // vínculo válido e coerente
  const cDiv = TaskService.create(A, { title: "divergente", source: "falatu" }, U);
  const tDivId = ftTask(A, "t-divergent", cDiv.id, 1); // silo feita × canônico aberta = conflito de estado
  ftTask(A, "t-unbridged", null, 0);             // ausente → migratable
  ftTask(A, "t-broken", "ghost-task", 0);         // vínculo quebrado
  ftEvent(A, "e-personal", null);                 // pessoal
  ftEvent(A, "e-bridged", appt(A));               // válido
  ftList(A, "shopping", "café");                  // migratable (casa catálogo)
  ftList(A, "general");                           // pessoal
  const apptsSeed = appts(A), canonSeed = canonTasks(A), reqsSeed = reqs(A);
  const siloT0 = siloTasks(A), siloE0 = siloEvents(A), siloL0 = siloLists(A);

  // ── 2. migrar 2× (idempotente, sem duplicação) ──
  const t1 = RECON.backfillTasks(A); const l1 = RECON.backfillLists(A);
  check("2.1 1ª migração: 1 tarefa + 1 lista", t1.backfilled === 1 && l1.backfilled === 1);
  const canonAfter1 = canonTasks(A), reqsAfter1 = reqs(A);
  const t2 = RECON.backfillTasks(A); const l2 = RECON.backfillLists(A);
  check("2.2 2ª migração: nada (idempotente)", t2.backfilled === 0 && l2.backfilled === 0);
  check("2.3 canônicos NÃO cresceram na 2ª (sem duplicação)", canonTasks(A) === canonAfter1 && reqs(A) === reqsAfter1);

  // ── 2b. sem perda: nenhum registro do silo sumiu ──
  check("2.4 silo intacto (nada apagado)", siloTasks(A) === siloT0 && siloEvents(A) === siloE0 && siloLists(A) === siloL0);

  // ── 3. sem promoção de acesso: pessoal nunca vira canônico ──
  // events backfill não-aplicável → nº de appointments só o que semeamos.
  check("3.1 evento pessoal não virou appointment", appts(A) === apptsSeed);
  check("3.2 e-personal segue sem espelho", !(db.prepare(`SELECT bridged_appointment_id b FROM falatu_events WHERE title='e-personal' AND organization_id=?`).get(A) as any).b);
  // lista general nunca vira requisição (só a shopping migrou → +1 sobre a seed)
  check("3.3 só a lista shopping virou requisição", reqs(A) === reqsSeed + 1);
  check("3.4 lista 'general' segue sem requisição", !(db.prepare(`SELECT bridged_requisition_id b FROM falatu_lists WHERE list_type='general' AND organization_id=?`).get(A) as any).b);

  // ── 4. vínculo quebrado NÃO recriado silenciosamente ──
  const rep = RECON.records(A, { limit: 1000 });
  check("4.1 t-broken segue broken_link", rep.records.find((r) => r.title === "t-broken")?.classification === "broken_link");
  check("4.2 conflito de estado segue sinalizado (não auto-resolvido)", rep.records.find((r) => r.title === "t-divergent")?.classification === "linked_state_divergent");

  // ── 5. estados coerentes entre interfaces (convergência) ──
  const ftValidId = (db.prepare(`SELECT id FROM falatu_tasks WHERE title='t-valid' AND organization_id=?`).get(A) as any).id;
  FalaTuService.toggleTask(A, U, ftValidId, true);
  check("5.1 concluir no Fala Tu → canônico feito", (db.prepare(`SELECT status s FROM tasks WHERE id=?`).get(cValid.id) as any).s === "feito");
  TaskService.move(A, cValid.id, "a_fazer", U);
  check("5.2 reabrir no quadro → silo não-concluído", Number((db.prepare(`SELECT completed c FROM falatu_tasks WHERE id=?`).get(ftValidId) as any).c) === 0);
  // a tarefa migrada (t-unbridged) agora bridgeada também converge
  const ftMigId = (db.prepare(`SELECT id, bridged_task_id b FROM falatu_tasks WHERE title='t-unbridged' AND organization_id=?`).get(A) as any);
  FalaTuService.toggleTask(A, U, ftMigId.id, true);
  check("5.3 tarefa migrada também converge", (db.prepare(`SELECT status s FROM tasks WHERE id=?`).get(ftMigId.b) as any).s === "feito");

  // ── 6. reversibilidade / compat: flag off não perde dados nem duplica ──
  enable(A, false);
  check("6.1 flag off: silo ainda legível", FalaTuService.tasks(A, U).length === siloT0);
  check("6.2 flag off: vínculos preservados (não apagados)", canonTasks(A) === canonAfter1);
  const tOff = RECON.backfillTasks(A);
  check("6.3 flag off: backfill recusa (não migra o que o dono desligou)", tOff.ok === false);
  enable(A, true);
  const t3 = RECON.backfillTasks(A);
  check("6.4 re-habilitar: nada a migrar (sem duplicar)", t3.backfilled === 0 && canonTasks(A) === canonAfter1);

  // ── 7. isolamento ──
  check("7.1 org B (flag off, vazia) sem canônicos", canonTasks(B) === 0 && reqs(B) === 0);

  // referência p/ evitar unused
  void tDivId; void siloL0; void canonSeed;

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-consolidation-ca09: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
