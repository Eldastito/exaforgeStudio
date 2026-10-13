/**
 * TESTE — Edição de vídeo em segundo plano (ADR-207 F13b.8). Rotas Express reais + JobQueueService real + ffmpeg real.
 * Prova: reusa a fila existente (background_jobs, tipo video_render), status do cliente, resultado, dedupe de duplo-clique, limite
 * por empresa, cancelamento (na fila, rodando, depois de pronto), `busy` volta pra fila sem falhar, erro de cliente sem retry nem
 * dead-letter, recuperação pós-reinício (sweepStale), cancelamento REAL do processo ffmpeg, isolamento por empresa.
 * Uso: npm run test:video-render-jobs
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http"; import { execSync } from "child_process"; import { randomUUID } from "crypto";
import express from "express";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vjob-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-vjob-1234567890";
let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FfmpegService: F } = await import("../src/server/FfmpegService.js");
  const { JobQueueService } = await import("../src/server/JobQueueService.js");
  const { VideoPostProductionService: V } = await import("../src/server/VideoPostProductionService.js");
  const { VideoRenderJobService: J } = await import("../src/server/VideoRenderJobService.js");
  const studio = (await import("../src/server/routes/studio.js")).default;
  const A = `org_vj_${randomUUID().slice(0, 8)}`, B = `org_vj_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);

  const mediaDir = path.join(tmpDir, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  const g = await F.run(["-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(mediaDir, "src.mp4")]);
  check("0.0 fixture gerada", g.code === 0);
  const creation = (org: string) => { const id = randomUUID(); db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status, source) VALUES (?, ?, 'video', 'p', '/media/src.mp4', 'done', 'uploaded')").run(id, org, ); return id; };
  const editedCount = (org: string) => (db.prepare("SELECT COUNT(*) c FROM studio_creations WHERE organization_id = ? AND source = 'edited'").get(org) as any).c;
  const mediaFiles = () => fs.readdirSync(mediaDir).sort();

  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => { if (req.headers["x-org"]) req.organizationId = String(req.headers["x-org"]); next(); });
  app.use("/api/studio", studio);
  const server = http.createServer(app);
  const port: number = await new Promise((rs) => server.listen(0, () => rs((server.address() as any).port)));
  const call = async (org: string | null, method: string, p: string, body?: any) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/studio/video-post${p}`, { method, headers: { ...(org ? { "x-org": org } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const waitFor = async (org: string, id: string, statuses: string[], ms = 30000) => { const t0 = Date.now(); for (;;) { const j = J.get(org, id); if (j && statuses.includes(j.status)) return j; if (Date.now() - t0 > ms) throw new Error("timeout esperando " + statuses.join("/") + " (atual " + j?.status + ")"); await sleep(50); } };
  const bg = (jobId: string) => db.prepare("SELECT * FROM background_jobs WHERE type = 'video_render' AND payload_json LIKE ?").get(`%${jobId}%`) as any;

  F.limits.maxConcurrentJobs = 4;   // sem disputa de ffmpeg entre os cenários (a trava de concorrência tem teste próprio na seção 9)
  const cA = creation(A);
  // 1. caminho feliz pela rota
  check("1.1 sem login → 401", (await call(null, "POST", "/render-async", { creationId: cA, channel: "instagram", topic: "x" })).status === 401);
  const e0 = editedCount(A);
  const r1 = await call(A, "POST", "/render-async", { creationId: cA, channel: "instagram", topic: "camisa de linho", title: true });
  check("1.2 pedido aceito: 202 com job na fila (não bloqueia até terminar)", r1.status === 202 && r1.body.status === "queued" && r1.body.deduplicated === false && !!r1.body.id, JSON.stringify(r1.body));
  const done = await waitFor(A, r1.body.id, ["completed", "failed"]);
  check("1.3 conclui sozinho; resultado = o do render síncrono (nova criação 'edited', título aplicado)", done.status === "completed" && !!done.result?.creationId && done.result.applied.includes("título") && editedCount(A) === e0 + 1 && (db.prepare("SELECT source FROM studio_creations WHERE id = ?").get(done.result.creationId) as any).source === "edited", JSON.stringify(done));
  const b1 = bg(r1.body.id);
  check("1.4 REUSA a fila existente: há um background_jobs tipo video_render, concluído na 1ª tentativa", !!b1 && b1.status === "completed" && b1.attempts === 1 && b1.organization_id === A);
  const poll = await call(A, "GET", `/jobs/${r1.body.id}`);
  check("1.5 consulta por rota devolve status+resultado; lista da empresa traz o job", poll.status === 200 && poll.body.status === "completed" && (await call(A, "GET", "/jobs")).body.jobs.some((j: any) => j.id === r1.body.id));
  check("1.6 sem progresso inventado: resposta não traz percentual", !("progress" in poll.body) && !("percent" in poll.body));
  const sync = await call(A, "POST", "/render", { creationId: cA, channel: "instagram", topic: "camisa de linho" });
  check("1.7 0-regressão: o endpoint síncrono segue funcionando", sync.status === 200 && !!sync.body.creationId);

  // 2. validação rápida
  check("2.1 vídeo de outra empresa / inexistente → 400 imediato", (await call(B, "POST", "/render-async", { creationId: cA, channel: "instagram", topic: "x" })).status === 400 && (await call(A, "POST", "/render-async", { creationId: "nada", channel: "instagram", topic: "x" })).status === 400);
  check("2.2 canal inválido / sem tópico → 400 imediato (nem entra na fila)", (await call(A, "POST", "/render-async", { creationId: cA, channel: "orkut", topic: "x" })).status === 400 && (await call(A, "POST", "/render-async", { creationId: cA, channel: "instagram", topic: " " })).status === 400);

  // 3. dedupe + limite
  const d1 = J.enqueue(A, null, { creationId: cA, channel: "tiktok", topic: "dup" });
  const d2 = J.enqueue(A, null, { creationId: cA, channel: "tiktok", topic: "dup" });
  check("3.1 duplo clique (mesmo pedido ativo) devolve o MESMO job, sem 2º trabalho", d2.id === d1.id && d2.deduplicated === true && (db.prepare("SELECT COUNT(*) c FROM background_jobs WHERE type='video_render' AND payload_json LIKE ?").get(`%${d1.id}%`) as any).c === 1);
  const prevMax = process.env.VIDEO_JOBS_MAX_ACTIVE; process.env.VIDEO_JOBS_MAX_ACTIVE = "2";
  const l2 = J.enqueue(A, null, { creationId: cA, channel: "facebook", topic: "lim" });
  let limitMsg = ""; try { J.enqueue(A, null, { creationId: cA, channel: "youtube", topic: "lim" }); } catch (e: any) { limitMsg = e.message; }
  check("3.2 limite de edições ativas por empresa (2) com mensagem de cliente", /já tem 2 edições em andamento/.test(limitMsg), limitMsg);
  check("3.3 o limite é por empresa: outra empresa não é afetada", (() => { const cB = creation(B); return J.enqueue(B, null, { creationId: cB, channel: "youtube", topic: "lim" }).status === "queued"; })());
  await waitFor(A, d1.id, ["completed", "failed"]); await waitFor(A, l2.id, ["completed", "failed"]);
  if (prevMax === undefined) delete process.env.VIDEO_JOBS_MAX_ACTIVE; else process.env.VIDEO_JOBS_MAX_ACTIVE = prevMax;
  check("3.4 depois de terminar, a vaga libera", J.enqueue(A, null, { creationId: cA, channel: "linkedin", topic: "lim2" }).status === "queued");

  // 4. cancelamento
  await sleep(1500);
  const before4 = editedCount(A); const files4 = mediaFiles();
  const q = J.enqueue(A, null, { creationId: cA, channel: "x", topic: "cancela na fila" });
  const cq = await call(A, "POST", `/jobs/${q.id}/cancel`);
  await sleep(600);
  check("4.1 cancelar NA FILA: cancelado na hora, nenhum trabalho feito (sem nova criação, sem arquivo)", cq.status === 200 && cq.body.ok && J.get(A, q.id)!.status === "cancelled" && editedCount(A) === before4 && mediaFiles().join() === files4.join() && bg(q.id).status === "completed");

  // cancelamento RODANDO: o render fica retido numa porta; cancelar aborta o signal e o render real recusa seguir
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const origRender = V.render.bind(V); let sawSignal: AbortSignal | undefined;
  (V as any).render = async (org: string, input: any, opts: any) => { sawSignal = opts?.signal; await gate; return origRender(org, input, opts); };
  const files4b = mediaFiles(); const before4b = editedCount(A);
  const run = J.enqueue(A, null, { creationId: cA, channel: "tiktok", topic: "cancela rodando" });
  await waitFor(A, run.id, ["processing"]);
  const cr = await call(A, "POST", `/jobs/${run.id}/cancel`);
  check("4.2 cancelar RODANDO: responde ok e o signal chega ao render", cr.status === 200 && cr.body.ok && sawSignal?.aborted === true && J.get(A, run.id)!.status === "cancelled");
  release(); await sleep(1200);
  (V as any).render = origRender;
  check("4.3 render liberado depois do cancelamento NÃO cria vídeo nem deixa arquivo; estado segue 'cancelled'", J.get(A, run.id)!.status === "cancelled" && editedCount(A) === before4b && mediaFiles().join() === files4b.join() && !J.get(A, run.id)!.result);
  const late = await call(A, "POST", `/jobs/${r1.body.id}/cancel`);
  check("4.4 cancelar depois de pronto: 409 'já terminou' e o vídeo continua", late.status === 409 && /já terminou/.test(late.body.message) && J.get(A, r1.body.id)!.status === "completed");
  check("4.5 cancelar de novo / inexistente / de outra empresa", (await call(A, "POST", `/jobs/${q.id}/cancel`)).status === 409 && (await call(A, "POST", "/jobs/nada/cancel")).status === 404 && (await call(B, "POST", `/jobs/${r1.body.id}/cancel`)).status === 404);
  check("4.6 isolamento: outra empresa não vê o job nem na lista", (await call(B, "GET", `/jobs/${r1.body.id}`)).status === 404 && !(await call(B, "GET", "/jobs")).body.jobs.some((j: any) => j.id === r1.body.id));

  // 5. cancelamento REAL do ffmpeg
  const tmpJobDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("zf-ffmpeg-")).length;
  await sleep(300); const tmpBaseline = tmpJobDirs();   // lixo de execuções anteriores não é deste teste
  const longIn = path.join(mediaDir, "long.mp4");
  await F.run(["-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", longIn]);
  const marker = `zfmark${randomUUID().slice(0, 8)}`;
  const ac = new AbortController(); const t0 = Date.now();
  const heavy = F.process({ orgId: A, operation: "test_heavy", inputPath: longIn, finalOutPath: path.join(tmpDir, "heavy.mp4"), outExt: "mp4", signal: ac.signal, buildArgs: (i, o) => ["-y", "-i", i, "-c:v", "libx264", "-preset", "veryslow", "-crf", "5", "-metadata", `title=${marker}`, o] }).then(() => "ok", (e: any) => e.code);
  await sleep(700);
  const aliveBefore = (() => { try { return execSync(`pgrep -f "[z]${marker.slice(1)}" || true`).toString().trim().length > 0; } catch { return false; } })();
  ac.abort();
  const outcome = await heavy; const took = Date.now() - t0;
  await sleep(200);
  const aliveAfter = (() => { try { return execSync(`pgrep -f "[z]${marker.slice(1)}" || true`).toString().trim().length > 0; } catch { return false; } })();
  check("5.1 abort MATA o processo ffmpeg de verdade (rodava, parou) e devolve 'cancelled' rápido", aliveBefore && !aliveAfter && outcome === "cancelled" && took < 6000, `${aliveBefore}/${aliveAfter}/${outcome}/${took}ms`);
  check("5.2 nada entregue e pasta temporária do job removida", !fs.existsSync(path.join(tmpDir, "heavy.mp4")) && tmpJobDirs() === tmpBaseline);
  const pre = new AbortController(); pre.abort();
  check("5.3 signal já abortado: nem começa (cancelled sem spawn)", (await F.process({ orgId: A, operation: "t", inputPath: longIn, finalOutPath: path.join(tmpDir, "x.mp4"), outExt: "mp4", signal: pre.signal, buildArgs: () => ["-version"] }).then(() => "ok", (e: any) => e.code)) === "cancelled");

  // 6. ffmpeg ocupado volta pra fila; esgotadas as tentativas, falha com mensagem de cliente
  const savedConc = F.limits.maxConcurrentJobs; F.limits.maxConcurrentJobs = 0;
  const bz = J.enqueue(A, null, { creationId: cA, channel: "youtube", topic: "ocupado" });
  await sleep(700);
  const bzBg = bg(bz.id);
  check("6.1 ffmpeg ocupado NÃO falha: job volta pra 'queued' e o JobQueue agenda nova tentativa (retryable + backoff)", J.get(A, bz.id)!.status === "queued" && bzBg.status === "pending" && bzBg.error_class === "retryable" && !!bzBg.next_attempt_at && bzBg.attempts === 1, JSON.stringify(bzBg));
  F.limits.maxConcurrentJobs = savedConc;
  await JobQueueService.runJob(bzBg.id);
  const bzDone = await waitFor(A, bz.id, ["completed", "failed"]);
  check("6.2 livre de novo: a tentativa seguinte conclui", bzDone.status === "completed");
  F.limits.maxConcurrentJobs = 0;
  const bz2 = J.enqueue(A, null, { creationId: cA, channel: "x", topic: "ocupado 2" });
  await sleep(500);
  const bz2Bg = bg(bz2.id);
  db.prepare("UPDATE background_jobs SET attempts = max_attempts - 1 WHERE id = ?").run(bz2Bg.id);
  await JobQueueService.runJob(bz2Bg.id);
  const bz2Row = J.get(A, bz2.id)!;
  check("6.3 última tentativa ainda ocupada: 'failed' com mensagem de cliente (nunca fica na fila pra sempre)", bz2Row.status === "failed" && /ocupado/.test(bz2Row.error || "") && !/ffmpeg/i.test(bz2Row.error || ""), JSON.stringify(bz2Row));
  F.limits.maxConcurrentJobs = savedConc;

  // 7. erro de cliente: failed com a mensagem, sem retry, sem dead-letter
  const bad = J.enqueue(A, null, { creationId: cA, channel: "instagram", topic: "sem transcrição", subtitles: true });
  const badDone = await waitFor(A, bad.id, ["failed", "completed"]);
  const badBg = bg(bad.id);
  check("7.1 pedido inválido na execução (legenda sem transcrição): failed com a mensagem de cliente", badDone.status === "failed" && /Transcreva o vídeo antes/.test(badDone.error || ""));
  check("7.2 sem nova tentativa e FORA do dead-letter da operação", badBg.status === "completed" && badBg.attempts === 1 && !JobQueueService.deadLetters(A).some((d: any) => d.id === badBg.id));

  // 8. recuperação pós-reinício
  const rid = randomUUID();
  db.prepare("INSERT INTO video_render_jobs (id, organization_id, creation_id, channel, params_json, status, started_at) VALUES (?, ?, ?, 'instagram', ?, 'processing', datetime('now','-20 minutes'))").run(rid, A, cA, JSON.stringify({ creationId: cA, channel: "instagram", topic: "recuperação", subtitles: false, removePauses: false, title: false, cta: false }));
  db.prepare("INSERT INTO background_jobs (id, organization_id, type, payload_json, status, max_attempts, attempts, started_at) VALUES (?, ?, 'video_render', ?, 'processing', 6, 1, datetime('now','-20 minutes'))").run(randomUUID(), A, JSON.stringify({ videoJobId: rid }));
  check("8.1 sweepStale reprocessa o job que ficou 'processing' (servidor caiu no meio)", JobQueueService.sweepStale(10) >= 1);
  const rec = await waitFor(A, rid, ["completed", "failed"]);
  check("8.2 e ele conclui normalmente", rec.status === "completed" && !!rec.result?.creationId);
  const cancelledBefore = J.get(A, q.id)!;
  await J.run(q.id); await J.run(rid);
  check("8.3 rodar de novo um job cancelado/concluído é inofensivo (idempotente: sem 2ª criação)", J.get(A, q.id)!.status === "cancelled" && J.get(A, rid)!.result.creationId === rec.result.creationId && cancelledBefore.status === "cancelled");

  // 9. trava de concorrência: excedentes ESPERAM a vez (não falham, não voltam só pelo sweep de 5 min)
  F.limits.maxConcurrentJobs = 1;
  const g1 = J.enqueue(A, null, { creationId: cA, channel: "instagram", topic: "fila 1" });
  const g2 = J.enqueue(A, null, { creationId: cA, channel: "tiktok", topic: "fila 2" });
  const g3 = J.enqueue(A, null, { creationId: cA, channel: "youtube", topic: "fila 3" });
  let maxProc = 0; const watch = setInterval(() => { const c = (db.prepare("SELECT COUNT(*) c FROM video_render_jobs WHERE organization_id = ? AND status = 'processing'").get(A) as any).c; if (c > maxProc) maxProc = c; }, 5);
  const gd = await Promise.all([g1, g2, g3].map((j) => waitFor(A, j.id, ["completed", "failed"])));
  clearInterval(watch);
  check("9.1 3 jobs com 1 vaga: os 3 concluem (nenhum falha por 'ocupado')", gd.every((j) => j.status === "completed"), gd.map((j) => j.status + ":" + j.error).join());
  check("9.2 nunca mais de 1 rodando ao mesmo tempo", maxProc === 1, String(maxProc));
  check("9.3 todos na 1ª tentativa do JobQueue (sem backoff de 30 s+)", [g1, g2, g3].every((j) => bg(j.id).attempts === 1 && bg(j.id).status === "completed"));
  // cancelar quem espera a vez: não roda
  const w1 = J.enqueue(A, null, { creationId: cA, channel: "instagram", topic: "espera 1" });
  const w2 = J.enqueue(A, null, { creationId: cA, channel: "facebook", topic: "espera 2" });
  const eBefore = editedCount(A);
  J.cancel(A, w2.id);
  await waitFor(A, w1.id, ["completed", "failed"]); await sleep(800);
  check("9.4 quem foi cancelado esperando a vez sai da fila sem rodar (só o 1º gera vídeo)", J.get(A, w2.id)!.status === "cancelled" && J.get(A, w1.id)!.status === "completed" && editedCount(A) === eBefore + 1);
  // sweep não duplica quem está esperando
  const s1 = J.enqueue(A, null, { creationId: cA, channel: "instagram", topic: "sweep 1" });
  const s2 = J.enqueue(A, null, { creationId: cA, channel: "tiktok", topic: "sweep 2" });
  const eB2 = editedCount(A);
  db.prepare("UPDATE background_jobs SET started_at = datetime('now','-20 minutes') WHERE type='video_render' AND status = 'processing'").run();
  JobQueueService.sweepStale(10);
  await waitFor(A, s1.id, ["completed", "failed"]); await waitFor(A, s2.id, ["completed", "failed"]); await sleep(500);
  check("9.5 sweep durante a espera NÃO duplica o trabalho (2 jobs → exatamente 2 vídeos novos)", editedCount(A) === eB2 + 2, `${editedCount(A) - eB2}`);
  // sweep/retry chamando o MESMO job enquanto ele ainda roda (com vaga sobrando): não pode renderizar 2 vezes
  F.limits.maxConcurrentJobs = 3;
  let calls = 0; let open2!: () => void; const gate2 = new Promise<void>((r) => { open2 = r; });
  const orig2 = V.render.bind(V);
  (V as any).render = async (org: string, input: any, opts: any) => { calls++; await gate2; return orig2(org, input, opts); };
  const dj = J.enqueue(A, null, { creationId: cA, channel: "instagram", topic: "duplicata" });
  await waitFor(A, dj.id, ["processing"]);
  const second = J.run(dj.id); const third = J.run(dj.id);
  await sleep(300);
  open2(); await Promise.all([second, third]);
  (V as any).render = orig2;
  const djDone = await waitFor(A, dj.id, ["completed", "failed"]);
  check("9.6 chamadas repetidas do mesmo job em andamento esperam o 1º e NÃO renderizam de novo", calls === 1 && djDone.status === "completed", `calls=${calls}`);
  F.limits.maxConcurrentJobs = savedConc;

  server.close();
  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
