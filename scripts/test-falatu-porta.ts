/**
 * TEST — ADR-160 F5 (Onda A): Fala Tu vira PORTA I/O (bridge de tarefas).
 *
 * Prova, determinístico (sem IA — semeia o inbox pendente direto):
 *   - flag OFF (default): confirm(TASK) materializa SÓ o silo falatu_tasks, NÃO
 *     cria tarefa canônica, bridged_task_id NULL (0 regressão);
 *   - flag ON: confirm(TASK) cria a tarefa CANÔNICA via TaskService (source
 *     'falatu', created_by=user, título fiel) + grava o vínculo silo→canônico
 *     (bridged_task_id == id canônico) + retorna bridgedTaskId;
 *   - o bridge é atômico com o silo (o falatu_tasks aponta pro canônico);
 *   - intents não-TASK (EVENT) não criam tarefa canônica mesmo com a porta ON;
 *   - toggle isTaskBridgeEnabled/setTaskBridge;
 *   - isolamento multi-tenant (tarefa canônica não vaza de org).
 *
 * Uso: npm run test:falatu-porta
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-porta-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-porta-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService: FT } = await import("../src/server/FalaTuService.js");

  const mkOrg = (bridge: boolean) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, falatu_bridge_tasks_enabled) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, bridge ? 1 : 0);
    return id;
  };
  // Semeia um item de inbox PENDENTE (bypassa a IA — o teste é do bridge, não da extração).
  const seedInbox = (orgId: string, userId: string, intent: string, content: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO falatu_inbox_items (id, organization_id, user_id, source, content, summary, intent, entities_json, confidence, status) VALUES (?, ?, ?, 'webapp', ?, ?, ?, '{}', 0.9, 'pending')`)
      .run(id, orgId, userId, content, content, intent);
    return id;
  };
  const canonicalTasks = (orgId: string) => db.prepare(`SELECT * FROM tasks WHERE organization_id = ?`).all(orgId) as any[];
  const siloTask = (refId: string) => db.prepare(`SELECT * FROM falatu_tasks WHERE id = ?`).get(refId) as any;

  // ===== 1. Flag OFF (default) → só silo, sem canônico =====
  const orgOff = mkOrg(false);
  const uOff = `u_${randomUUID().slice(0, 6)}`;
  check("toggle: isTaskBridgeEnabled false por padrão", FT.isTaskBridgeEnabled(orgOff) === false);
  const inOff = seedInbox(orgOff, uOff, "TASK", "ligar pro fornecedor amanhã");
  const rOff = FT.confirm(orgOff, uOff, inOff, {});
  check("OFF: confirmou como task (silo)", rOff.kind === "task" && !!rOff.refId);
  check("OFF: NÃO criou tarefa canônica", canonicalTasks(orgOff).length === 0);
  check("OFF: bridged_task_id NULL no silo", siloTask(rOff.refId!)?.bridged_task_id == null);
  check("OFF: retorno sem bridgedTaskId", rOff.bridgedTaskId == null);

  // ===== 2. Flag ON → cria canônico + grava vínculo =====
  const orgOn = mkOrg(true);
  const uOn = `u_${randomUUID().slice(0, 6)}`;
  check("toggle: isTaskBridgeEnabled true com flag", FT.isTaskBridgeEnabled(orgOn) === true);
  const inOn = seedInbox(orgOn, uOn, "TASK", "comprar material de limpeza");
  const rOn = FT.confirm(orgOn, uOn, inOn, {});
  const canon = canonicalTasks(orgOn);
  check("ON: criou exatamente 1 tarefa canônica", canon.length === 1);
  check("ON: canônica com source 'falatu' + created_by=user + título fiel", canon[0]?.source === "falatu" && canon[0]?.created_by === uOn && canon[0]?.title === "comprar material de limpeza");
  check("ON: retorno traz bridgedTaskId == id canônico", rOn.bridgedTaskId === canon[0]?.id);
  check("ON: vínculo silo→canônico gravado (bridged_task_id)", siloTask(rOn.refId!)?.bridged_task_id === canon[0]?.id);
  check("ON: silo falatu_tasks preservado (dual-write)", !!siloTask(rOn.refId!));

  // ===== 3. Override de título respeitado no bridge =====
  const inOn2 = seedInbox(orgOn, uOn, "TASK", "texto cru");
  const rOn2 = FT.confirm(orgOn, uOn, inOn2, { title: "Título editado pelo humano" });
  const canon2 = canonicalTasks(orgOn).find((t) => t.id === rOn2.bridgedTaskId);
  check("ON: título editado na confirmação vai pro canônico", canon2?.title === "Título editado pelo humano");

  // ===== 4. Intent não-TASK não faz bridge (mesmo com porta ON) =====
  const inEvt = seedInbox(orgOn, uOn, "EVENT", "reunião com o contador");
  const before = canonicalTasks(orgOn).length;
  const rEvt = FT.confirm(orgOn, uOn, inEvt, { eventDate: "2026-09-01" });
  check("ON: EVENT confirma como event (silo), sem tarefa canônica nova", rEvt.kind === "event" && canonicalTasks(orgOn).length === before && rEvt.bridgedTaskId == null);

  // ===== 5. setTaskBridge liga/desliga em runtime =====
  const orgTgl = mkOrg(false);
  check("setTaskBridge(true) liga", FT.setTaskBridge(orgTgl, true).tasks === true && FT.isTaskBridgeEnabled(orgTgl) === true);
  check("setTaskBridge(false) desliga", FT.setTaskBridge(orgTgl, false).tasks === false && FT.isTaskBridgeEnabled(orgTgl) === false);

  // ===== 6. Isolamento multi-tenant =====
  const orgA = mkOrg(true); const orgB = mkOrg(true);
  const inA = seedInbox(orgA, "ua", "TASK", "tarefa da org A");
  FT.confirm(orgA, "ua", inA, {});
  check("isolamento: tarefa canônica de A não aparece em B", canonicalTasks(orgB).length === 0 && canonicalTasks(orgA).length === 1);

  console.log("\n=== TEST: Fala Tu porta I/O — bridge de tarefas (ADR-160 F5) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Fala Tu porta I/O (F5) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
