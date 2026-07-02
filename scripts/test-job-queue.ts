/**
 * TESTE — Fila de jobs em background (JobQueueService)
 * ------------------------------------------------------------------
 * Cobre:
 *   - enqueue() não bloqueia o caller (retorna antes do job terminar);
 *   - job com sucesso fica 'completed' com o resultado gravado;
 *   - job que falha uma vez e depois funciona é reprocessado (retry) até
 *     max_attempts, e só então vira 'failed';
 *   - tipo sem handler registrado falha de forma clara, não trava a fila;
 *   - sweepStale() reprocessa job preso em 'processing' há muito tempo
 *     (simula processo que caiu no meio da execução);
 *   - isolamento: listByOrg só devolve jobs da própria organização.
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:job-queue
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-jobqueue-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fila-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { JobQueueService } = await import("../src/server/JobQueueService.js");

  const orgA = `org_A_${randomUUID().slice(0, 6)}`;
  const orgB = `org_B_${randomUUID().slice(0, 6)}`;

  // ---- Job de sucesso ----
  let ran = false;
  JobQueueService.registerHandler("test_ok", async (payload: any) => {
    ran = true;
    await sleep(5);
    return { echoed: payload.value };
  });
  const beforeEnqueue = Date.now();
  const okId = JobQueueService.enqueue("test_ok", { value: 42 }, { organizationId: orgA });
  const enqueueElapsed = Date.now() - beforeEnqueue;
  check("enqueue() retorna quase instantaneamente (não espera o handler)", enqueueElapsed < 20, `${enqueueElapsed}ms`);
  await sleep(60); // dá tempo do setImmediate rodar
  check("Handler foi realmente executado em background", ran);
  const okJob = JobQueueService.get(okId);
  check("Job de sucesso fica 'completed'", okJob.status === "completed", `status=${okJob.status}`);
  check("Resultado do handler foi gravado", JSON.parse(okJob.result_json).echoed === 42);
  check("attempts = 1 num job que deu certo de primeira", okJob.attempts === 1);

  // ---- Job que falha as duas primeiras vezes e funciona na terceira ----
  let attemptsSeen = 0;
  JobQueueService.registerHandler("test_flaky", async () => {
    attemptsSeen++;
    if (attemptsSeen < 3) throw new Error(`falha proposital #${attemptsSeen}`);
    return { ok: true };
  });
  const flakyId = JobQueueService.enqueue("test_flaky", {}, { organizationId: orgA, maxAttempts: 5 });
  await sleep(50);
  // As tentativas 2/3 não disparam sozinhas (só o enqueue inicial chama
  // setImmediate) — simula o Scheduler reprocessando um job 'pending'.
  await JobQueueService.runJob(flakyId);
  await JobQueueService.runJob(flakyId);
  const flakyJob = JobQueueService.get(flakyId);
  check("Job intermitente eventualmente conclui (retry funcionou)", flakyJob.status === "completed", `status=${flakyJob.status} attempts=${flakyJob.attempts}`);
  check("Levou exatamente 3 tentativas", flakyJob.attempts === 3);

  // ---- Job que sempre falha esgota as tentativas e vira 'failed' ----
  JobQueueService.registerHandler("test_always_fails", async () => { throw new Error("sempre falha"); });
  const badId = JobQueueService.enqueue("test_always_fails", {}, { organizationId: orgA, maxAttempts: 2 });
  await sleep(30);
  await JobQueueService.runJob(badId); // 2ª tentativa
  const badJob = JobQueueService.get(badId);
  check("Job que sempre falha vira 'failed' após esgotar max_attempts", badJob.status === "failed", `status=${badJob.status} attempts=${badJob.attempts}`);
  check("Mensagem de erro fica registrada", typeof badJob.last_error === "string" && badJob.last_error.includes("sempre falha"));

  // ---- Tipo sem handler registrado ----
  const orphanId = JobQueueService.enqueue("tipo_inexistente", {}, { organizationId: orgA });
  await sleep(30);
  const orphanJob = JobQueueService.get(orphanId);
  check("Job de tipo sem handler falha com mensagem clara (não trava a fila)", orphanJob.status === "failed" && orphanJob.last_error.includes("Nenhum handler"));

  // ---- sweepStale: job preso em 'processing' (processo caiu no meio) ----
  JobQueueService.registerHandler("test_recovered", async () => ({ recovered: true }));
  const stuckId = randomUUID();
  db.prepare(
    `INSERT INTO background_jobs (id, organization_id, type, payload_json, status, attempts, max_attempts, started_at)
     VALUES (?, ?, 'test_recovered', '{}', 'processing', 1, 3, datetime('now', '-20 minutes'))`
  ).run(stuckId, orgA);
  const swept = JobQueueService.sweepStale(10);
  check("sweepStale() encontrou o job travado", swept >= 1, `varridos=${swept}`);
  await sleep(30);
  const recoveredJob = JobQueueService.get(stuckId);
  check("Job travado foi reprocessado e concluído pela varredura", recoveredJob.status === "completed", `status=${recoveredJob.status}`);

  // ---- sweepStale NÃO mexe em job 'processing' recente (ainda rodando de verdade) ----
  const freshId = randomUUID();
  db.prepare(
    `INSERT INTO background_jobs (id, organization_id, type, payload_json, status, attempts, max_attempts, started_at)
     VALUES (?, ?, 'test_recovered', '{}', 'processing', 1, 3, datetime('now'))`
  ).run(freshId, orgA);
  JobQueueService.sweepStale(10);
  const freshJob = JobQueueService.get(freshId);
  check("sweepStale() não mexe em job 'processing' ainda dentro da janela", freshJob.status === "processing");

  // ---- Isolamento por organização ----
  JobQueueService.enqueue("test_ok", { value: 1 }, { organizationId: orgB });
  await sleep(30);
  const jobsA = JobQueueService.listByOrg(orgA);
  const jobsB = JobQueueService.listByOrg(orgB);
  check("listByOrg(A) não inclui jobs de B", !jobsA.some((j: any) => j.organization_id === orgB));
  check("listByOrg(B) só tem o job de B", jobsB.length === 1 && jobsB[0].organization_id === orgB);

  // ============ RELATÓRIO ============
  console.log("\n==================================================");
  console.log("  TESTE — FILA DE JOBS EM BACKGROUND");
  console.log("==================================================\n");
  for (const r of results) {
    console.log(`  ${r.ok ? "✅ PASS" : "❌ FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const total = results.length;
  console.log(`\n  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(failures === 0 ? "  🔒 FILA, RETRY E VARREDURA CONFIRMADOS.\n" : `  ⚠️  ${failures} verificação(ões) FALHARAM.\n`);

  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste da fila de jobs:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
