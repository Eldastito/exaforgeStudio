/**
 * TESTE — Cobrança por pessoa + baixa de malote/escala (ADR-108, Bloco B/TOULON)
 * -----------------------------------------------------------------------------
 * Prova, offline:
 *   - CRUD de responsáveis por loja (com task_types 'all' ou específicos);
 *   - targetsForTask: cobra os responsáveis do tipo; fallback no número da loja;
 *   - runReminders envia para TODOS os responsáveis do tipo (cobrança por pessoa);
 *   - findStoreByResponsible casa o número do responsável → loja (9º dígito);
 *   - intake: matchStore via responsável; baixa de malote/escala por confirmação;
 *   - detectTaskConfirmation exige o substantivo + confirmação;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-responsibles
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-resp-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-resp-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailQuotaService, RetailTaskService, RetailResponsibleService } = await import("../src/server/RetailOpsService.js");
  const { RetailWhatsAppIntakeService, detectTaskConfirmation } = await import("../src/server/RetailWhatsAppIntakeService.js");
  const db = (await import("../src/server/db.js")).default;

  const DATE = "2026-07-20";
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  db.prepare(`UPDATE organization_settings SET retail_daily_closing_enabled=1, retail_malote_enabled=1, retail_scale_reminder_enabled=1, retail_daily_closing_due_hour=1 WHERE organization_id=?`).run(A);
  const store = RetailStoreService.create(A, { name: "Toulon Savassi", whatsappIdentifier: "5531900000000" });

  // ---- 0. detectTaskConfirmation ----
  check("detect: 'malote enviado' → malote", detectTaskConfirmation("malote enviado") === "malote");
  check("detect: 'escala ok' → escala", detectTaskConfirmation("escala ok") === "escala");
  check("detect: 'já mandei o malote' → malote", detectTaskConfirmation("já mandei o malote") === "malote");
  check("detect: 'bom dia' → null", detectTaskConfirmation("bom dia") === null);
  check("detect: 'ok' sozinho → null", detectTaskConfirmation("ok") === null);

  // ---- 1. CRUD de responsáveis ----
  const r1 = RetailResponsibleService.add(A, store.id, { name: "Ana", whatsappIdentifier: "5531988880001", taskTypes: ["fechamento"] });
  const r2 = RetailResponsibleService.add(A, store.id, { name: "Bruno", whatsappIdentifier: "5531988880002" }); // all
  check("add responsável grava wa normalizado", r1.whatsapp_identifier === "5531988880001");
  check("add sem task_types vira 'all'", r2.task_types === "all");
  check("list retorna os 2", RetailResponsibleService.list(A, store.id).length === 2);
  const upd = RetailResponsibleService.update(A, r1.id, { taskTypes: ["fechamento", "malote"] });
  check("update task_types", upd.task_types === "fechamento,malote");

  // ---- 2. targetsForTask ----
  const tFech = RetailResponsibleService.targetsForTask(A, store.id, "fechamento");
  check("targets fechamento = Ana + Bruno", tFech.length === 2 && tFech.includes("5531988880001") && tFech.includes("5531988880002"));
  const tEscala = RetailResponsibleService.targetsForTask(A, store.id, "escala");
  check("targets escala = só Bruno (all)", tEscala.length === 1 && tEscala[0] === "5531988880002");
  // Sem responsáveis → fallback no número da loja
  const store2 = RetailStoreService.create(A, { name: "Loja sem resp", whatsappIdentifier: "5531900000009" });
  const tFallback = RetailResponsibleService.targetsForTask(A, store2.id, "fechamento");
  check("targets fallback = número da loja", tFallback.length === 1 && tFallback[0] === "5531900000009");

  // ---- 3. findStoreByResponsible (tolerante ao 9º dígito) ----
  const found = RetailResponsibleService.findStoreByResponsible(A, "553188880001"); // sem o 9
  check("findStoreByResponsible casa (sem 9º dígito)", found?.id === store.id);

  // ---- 4. runReminders cobra TODOS os responsáveis do tipo ----
  RetailTaskService.generateDay(A, DATE);
  const sent: Array<{ target: string; msg: string }> = [];
  const now = `${DATE} 12:00:00`;
  const summ = await RetailTaskService.runReminders(A, { now, send: async (target, msg) => { sent.push({ target, msg }); }, maxReminders: 3 });
  // Escopa pela loja (o nome da loja aparece na mensagem) — a org tem 2 lojas.
  const fechTargets = sent.filter((s) => /fechamento/i.test(s.msg) && s.msg.includes("Savassi")).map((s) => s.target);
  check("cobrança de fechamento vai para os 2 responsáveis", fechTargets.length === 2 && fechTargets.includes("5531988880001") && fechTargets.includes("5531988880002"), JSON.stringify(fechTargets));
  const escTargets = sent.filter((s) => /escala/i.test(s.msg) && s.msg.includes("Savassi")).map((s) => s.target);
  check("cobrança de escala vai só para Bruno", escTargets.length === 1 && escTargets[0] === "5531988880002", JSON.stringify(escTargets));
  check("summary conta a tarefa cobrada uma vez", summ.reminded >= 3);

  // ---- 5. Intake: matchStore via responsável ----
  const matched = RetailWhatsAppIntakeService.matchStore(A, "5531988880001");
  check("matchStore resolve pelo responsável", matched?.id === store.id);

  // ---- 6. Intake: baixa de MALOTE por confirmação ----
  const before = RetailTaskService.listByDate(A, DATE).find((t: any) => t.store_id === store.id && t.task_type === "malote");
  check("malote começa pendente/late", before && before.status !== "submitted");
  const rMal = await RetailWhatsAppIntakeService.handleInbound(A, store, { senderId: "5531988880002", text: "malote enviado ✅", contactId: "c9", date: DATE });
  const afterMal = RetailTaskService.listByDate(A, DATE).find((t: any) => t.store_id === store.id && t.task_type === "malote");
  check("baixa de malote pela confirmação", afterMal?.status === "submitted", afterMal?.status);
  check("resposta confirma o malote", !!rMal?.reply && /malote/i.test(rMal!.reply));

  // ---- 7. Intake: baixa de ESCALA ----
  const rEsc = await RetailWhatsAppIntakeService.handleInbound(A, store, { senderId: "5531988880002", text: "escala já atualizada", contactId: "c9", date: DATE });
  const afterEsc = RetailTaskService.listByDate(A, DATE).find((t: any) => t.store_id === store.id && t.task_type === "escala");
  check("baixa de escala pela confirmação", afterEsc?.status === "submitted", afterEsc?.status);
  check("resposta confirma a escala", !!rEsc?.reply && /escala/i.test(rEsc!.reply));

  // Reenviar "malote enviado" com o malote JÁ baixado é idempotente: não
  // reprocessa a baixa (o malote continua submitted, sem crash).
  await RetailWhatsAppIntakeService.handleInbound(A, store, { senderId: "5531988880002", text: "malote enviado", contactId: "c9", date: DATE });
  const afterMal2 = RetailTaskService.listByDate(A, DATE).find((t: any) => t.store_id === store.id && t.task_type === "malote");
  check("malote já baixado permanece submitted (idempotente)", afterMal2?.status === "submitted");

  // ---- 8. Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  check("Isolamento: responsável de A não casa em B", RetailResponsibleService.findStoreByResponsible(B, "5531988880001") === null);

  console.log("\n=== Cobrança por pessoa + baixa malote/escala (ADR-108) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
