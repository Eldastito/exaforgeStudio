/**
 * TESTE — Retail Ops Fase D: cobrança automática (ADR-083) — fecha o MVP
 * ---------------------------------------------------------------------
 * Prova, offline (WhatsApp e relógio injetados), a cobrança das pendências:
 *   - pendência vencida é cobrada pelo WhatsApp da loja (mensagem por tipo);
 *   - respeita o intervalo de recobrança (não repete antes de retry_minutes);
 *   - após o teto de tentativas, ESCALA ao gestor e marca 'late';
 *   - pendência já enviada não é cobrada; loja sem WhatsApp é ignorada;
 *   - isolamento por organização.
 *
 * Uso:  npm run test:retail-cobranca
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-d-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-d-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailTaskService } = await import("../src/server/RetailOpsService.js");

  const DATE = "2026-07-10";
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  db.prepare(`UPDATE organization_settings SET retail_daily_closing_enabled=1, retail_daily_closing_due_hour=21 WHERE organization_id=?`).run(A);
  const s1 = RetailStoreService.create(A, { name: "Loja Barra", whatsappIdentifier: "5511900000001" });
  const s2 = RetailStoreService.create(A, { name: "Loja Sem Zap" }); // sem whatsapp_identifier
  RetailTaskService.generateDay(A, DATE); // cria 1 tarefa 'fechamento' por loja (due 21:00)

  const sent: { target: string; message: string }[] = [];
  const escalations: any[] = [];
  const send = async (target: string, message: string) => { sent.push({ target, message }); };
  const notify = (info: any) => { escalations.push(info); };
  const run = (now: string) => RetailTaskService.runReminders(A, { now, send, notify, retryMinutes: 30, maxReminders: 3 });

  // ---- Round 1: cobra ----
  const r1 = await run(`${DATE} 21:05:00`);
  check("Cobra a pendência vencida (1 loja com WhatsApp)", r1.reminded === 1);
  check("Envia ao WhatsApp da loja com a mensagem certa", sent.length === 1 && sent[0].target === "5511900000001" && /Loja Barra/.test(sent[0].message) && /fechamento/i.test(sent[0].message));
  check("Loja sem WhatsApp não é cobrada", !sent.some((s) => /Sem Zap/.test(s.message)));

  // ---- Round 2: dentro do intervalo → não repete ----
  const r2 = await run(`${DATE} 21:06:00`);
  check("Não recobra antes de retry_minutes", r2.reminded === 0 && sent.length === 1);

  // ---- Rounds 3 e 4: recobra após o intervalo ----
  await run(`${DATE} 21:40:00`);
  await run(`${DATE} 22:15:00`);
  const tk = db.prepare(`SELECT reminder_count, status FROM retail_store_daily_tasks WHERE store_id = ? AND task_date = ?`).get(s1.id, DATE) as any;
  check("Recobra após o intervalo (3 tentativas no total)", tk.reminder_count === 3 && sent.length === 3);

  // ---- Round 5: teto → escala ao gestor + 'late' ----
  const r5 = await run(`${DATE} 22:50:00`);
  check("Após o teto → escala ao gestor", r5.escalated === 1 && escalations.length === 1 && escalations[0].store.id === s1.id);
  check("Pendância escalada vira 'late'", (db.prepare(`SELECT status FROM retail_store_daily_tasks WHERE store_id = ? AND task_date = ?`).get(s1.id, DATE) as any).status === "late");
  check("Escalada não envia novo WhatsApp", sent.length === 3);

  // ---- Pendência já enviada não é cobrada ----
  const DATE2 = "2026-07-11";
  RetailTaskService.generateDay(A, DATE2);
  const t2 = (RetailTaskService.listByDate(A, DATE2)).find((t: any) => t.store_id === s1.id);
  RetailTaskService.markSubmitted(A, t2.id, {});
  const before = sent.length;
  await run(`${DATE2} 21:30:00`);
  check("Pendência já enviada não é cobrada", sent.length === before);

  // ---- Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const rb = await RetailTaskService.runReminders(B, { now: `${DATE} 23:00:00`, send, notify, retryMinutes: 30, maxReminders: 3 });
  check("Isolamento: org B não cobra nada de A", rb.reminded === 0 && rb.escalated === 0);

  console.log("\n=== Retail Ops — Fase D: cobrança automática (ADR-083) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
