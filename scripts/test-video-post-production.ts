/**
 * TESTE — Vídeo bruto → pronto, até onde dá (ADR-207 F13b). Determinístico, sem LLM/rede/ffmpeg.
 * Prova: plano de edição por canal (gancho, segmentos, silêncio, legenda, título, CTA, enquadramento) sobre o roteiro
 * existente; duração-alvo do roteiro, nunca maior que o bruto; marca respeitada; canal desconhecido rejeitado; capacidades
 * DESCOBERTAS (ffmpeg/transcrição) e render honesto "awaiting_provider" (nunca finge editar); rotas.
 * Uso: npm run test:video-post-production
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vpost-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-vpost-1234567890";
let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const studio = (await import("../src/server/routes/studio.js")).default;
  const { VideoPostProductionService: V, StubVideoPostProvider } = await import("../src/server/VideoPostProductionService.js");
  const { BrandDnaService } = await import("../src/server/BrandDnaService.js");
  const orgA = `org_vp_${randomUUID().slice(0, 8)}`, orgB = `org_vp_${randomUUID().slice(0, 8)}`;
  for (const o of [orgA, orgB]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  const rej = async (fn: () => Promise<any>) => { try { await fn(); return ""; } catch (e: any) { return String(e.message); } };

  const p = await V.plan(orgA, { topic: "camisa de linho", objectiveId: "vendas", channels: ["instagram", "linkedin", "tiktok"] });
  check("1.1 um plano por canal pedido", p.plans.length === 3 && p.plans.map((x) => x.channel).join() === "instagram,linkedin,tiktok");
  const ig = p.plans[0];
  check("1.2 enquadramento por canal (9:16 no Instagram, 1:1 no LinkedIn)", ig.aspect === "9:16" && p.plans[1].aspect === "1:1");
  check("1.3 passos na ordem: enquadrar → gancho → segmentos → silêncio → legenda → título → CTA", ig.steps.map((s) => s.kind).join().startsWith("reframe,hook,segment") && ig.steps.map((s) => s.kind).join().endsWith("silence,captions,title,cta") && ig.steps.every((s, i) => s.order === i + 1));
  const hook = ig.steps.find((s) => s.kind === "hook")!;
  check("1.4 gancho nos primeiros segundos, com o texto do roteiro (F3/F4 reusados)", hook.startSec === 0 && (hook.endSec || 0) > 0 && !!hook.text && hook.text === ig.hookText);
  const cta = ig.steps.find((s) => s.kind === "cta")!;
  check("1.5 CTA vem do objetivo + CTA idiomática do canal", /Garanta já o seu/.test(cta.text || "") && /Link na bio/.test(cta.text || ""));
  const timed = ig.steps.filter((s) => s.startSec !== undefined);
  check("1.6 trechos cronometrados contíguos, sem sobreposição, terminando na duração-alvo", timed.every((s, i) => i === 0 || s.startSec === timed[i - 1].endSec) && timed[timed.length - 1].endSec === ig.targetDurationSec);
  check("1.7 título limitado ao máximo do canal", ig.title.length <= 60 && p.plans[1].title.length <= 100);
  check("1.8 sem o vídeo bruto, a duração-fonte fica null (não inventa)", p.sourceDurationSec === null);

  const short = await V.plan(orgA, { topic: "camisa de linho", channels: ["instagram"], sourceDurationSec: 9 });
  check("2.1 bruto mais curto que o roteiro → plano nunca passa do bruto, e avisa", short.plans[0].targetDurationSec <= 9 && short.plans[0].caveats.some((c) => /mais curto/.test(c)) && short.sourceDurationSec === 9);
  check("2.2 duração do bruto inválida recusa", /inválida/.test(await rej(() => V.plan(orgA, { topic: "x", channels: ["instagram"], sourceDurationSec: -3 }))));

  check("3.1 canal desconhecido vai pra skipped, os demais seguem", (await (async () => { const r = await V.plan(orgA, { topic: "x", channels: ["instagram", "orkut"] }); return r.plans.length === 1 && r.skipped[0].channel === "orkut"; })()));
  check("3.2 sem tópico ou sem canal recusa", /tópico/.test(await rej(() => V.plan(orgA, { topic: " ", channels: ["instagram"] }))) && /canal/.test(await rej(() => V.plan(orgA, { topic: "x", channels: [] }))));

  await BrandDnaService.save(orgA, "u", { forbidden: ["prova"], persona: "estilista" });
  const br = await V.plan(orgA, { topic: "camisa de linho", channels: ["instagram"] });
  check("4.1 marca respeitada: termo proibido não aparece nos textos do plano e vira aviso", br.plans[0].steps.every((s) => !/prova/i.test(s.text || "")) && br.plans[0].caveats.some((c) => /saneado/.test(c)));
  const other = await V.plan(orgB, { topic: "camisa de linho", channels: ["instagram"] });
  check("4.2 isolamento: a marca de outra empresa não vaza", other.plans[0].caveats.every((c) => !/saneado/.test(c)));

  check("5.1 render: com ffmpeg empacotado, 'partial_available' (corte+enquadramento+legenda), nunca 'tudo pronto'", p.render.status === "partial_available" && p.render.capabilities.renderImplemented === true && p.render.capabilities.canRenderCaptions === true && /seguem manuais/.test(p.render.reason) && /legendar/.test(p.render.reason));
  const { FfmpegService } = await import("../src/server/FfmpegService.js");
  process.env.FFMPEG_PATH = "/nonexistent/ffmpeg"; FfmpegService.resetCache();
  const c0 = await new StubVideoPostProvider().capabilities();
  check("5.2 sem ffmpeg: nada disponível, mensagem de cliente (sem erro técnico)", !c0.ffmpeg && !c0.canRenderCaptions && !c0.canRenderTrimReframe && !c0.renderImplemented && c0.notes.some((n) => /não está disponível neste servidor/.test(n)));
  const pNo = await V.plan(orgA, { topic: "x", channels: ["instagram"] });
  check("5.3 sem ffmpeg o PLANO segue funcionando (status 'unavailable')", pNo.plans.length === 1 && pNo.render.status === "unavailable");
  delete process.env.FFMPEG_PATH; FfmpegService.resetCache();
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test"; FfmpegService.resetCache();
  const c1 = await new StubVideoPostProvider().capabilities();
  check("5.5 transcrição descoberta (ffmpeg + provider de fala); legenda descoberta pelo filtro + fonte empacotada", c1.transcription && c1.canRenderCaptions);
  delete process.env.OPENAI_API_KEY;
  const c2 = await new StubVideoPostProvider().capabilities();
  check("5.5b sem provider de fala a transcrição fica indisponível", c2.ffmpeg && !c2.transcription);
  if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;

  // render real
  const mediaDir = path.join(tmpDir, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  const srcName = "studio_fixture.mp4";
  const gen = await FfmpegService.run(["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=15:duration=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(mediaDir, srcName)]);
  check("6.0 fixture de vídeo gerada", gen.code === 0);
  const cid = randomUUID(), imgId = randomUUID(), otherId = randomUUID(), pendId = randomUUID();
  db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status) VALUES (?, ?, 'video', 'p', ?, 'done')").run(cid, orgA, `/media/${srcName}`);
  db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status) VALUES (?, ?, 'image', 'p', '/media/a.png', 'done')").run(imgId, orgA);
  db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status) VALUES (?, ?, 'video', 'p', ?, 'done')").run(otherId, orgB, `/media/${srcName}`);
  db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status) VALUES (?, ?, 'video', 'p', NULL, 'processing')").run(pendId, orgA);
  process.env.FFMPEG_PATH = "/nonexistent/ffmpeg"; FfmpegService.resetCache();
  const noFf = await rej(() => V.render(orgA, { creationId: cid, channel: "tiktok", topic: "x" }));
  delete process.env.FFMPEG_PATH; FfmpegService.resetCache();
  check("6.0b sem ffmpeg o render recusa com mensagem de cliente e não cria criação", /não está disponível neste servidor/.test(noFf) && !/ffmpeg_|spawn|ENOENT/.test(noFf) && (db.prepare("SELECT COUNT(*) n FROM studio_creations WHERE organization_id = ? AND prompt LIKE 'edição%'").get(orgA) as any).n === 0);
  const rr = await V.render(orgA, { creationId: cid, channel: "tiktok", topic: "camisa de linho", objectiveId: "vendas" });
  const outFile = path.join(mediaDir, path.basename(rr.mediaUrl));
  const probe = await FfmpegService.run(["-i", outFile]);
  const dm = /Video:[^\n]*?(\d{2,5})x(\d{2,5})/.exec(probe.stderr)!;
  check("6.1 render cria arquivo novo 9:16 (TikTok) com duração do plano", fs.existsSync(outFile) && Math.abs(+dm[1] / +dm[2] - 9 / 16) < 0.03 && rr.durationSec > 0 && rr.aspect === "9:16");
  check("6.2 o original é preservado e o resultado vira NOVA criação do Estúdio", fs.existsSync(path.join(mediaDir, srcName)) && rr.creationId !== cid && (db.prepare("SELECT media_url FROM studio_creations WHERE id = ? AND organization_id = ?").get(rr.creationId, orgA) as any)?.media_url === rr.mediaUrl);
  check("6.3 diz o que foi aplicado e o que NÃO foi", rr.applied.join() === "corte,enquadramento" && rr.notApplied.includes("legenda") && rr.notApplied.includes("título"));
  check("6.4 vídeo de outra empresa / imagem / ainda processando → recusa", /não encontrado/.test(await rej(() => V.render(orgA, { creationId: otherId, channel: "tiktok", topic: "x" }))) && /não encontrado/.test(await rej(() => V.render(orgA, { creationId: imgId, channel: "tiktok", topic: "x" }))) && /ainda não está pronto/.test(await rej(() => V.render(orgA, { creationId: pendId, channel: "tiktok", topic: "x" }))));
  check("6.5 canal desconhecido recusa", /não suportado/.test(await rej(() => V.render(orgA, { creationId: cid, channel: "orkut", topic: "x" }))));
  const traversal = randomUUID();
  db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status) VALUES (?, ?, 'video', 'p', '/media/../secret.mp4', 'done')").run(traversal, orgA);
  fs.copyFileSync(path.join(mediaDir, srcName), path.join(tmpDir, "secret.mp4"));
  check("6.6 media_url com ../ nunca sai da pasta de mídia (usa só o nome do arquivo)", /Não encontrei o arquivo/.test(await rej(() => V.render(orgA, { creationId: traversal, channel: "tiktok", topic: "x" }))));

  // rotas
  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => { if (req.headers["x-org"]) req.organizationId = String(req.headers["x-org"]); next(); });
  app.use("/api/studio", studio);
  const server = http.createServer(app);
  const port: number = await new Promise((rs) => server.listen(0, () => rs((server.address() as any).port)));
  const call = async (org: string | null, method: string, p2: string, body?: any) => { const r = await fetch(`http://127.0.0.1:${port}/api/studio${p2}`, { method, headers: { "Content-Type": "application/json", ...(org ? { "x-org": org } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const r1 = await call(orgA, "POST", "/video-post/plan", { topic: "camisa de linho", channels: ["tiktok"] });
  check("7.1 rota de plano devolve o plano", r1.status === 200 && r1.body.plans?.[0]?.channel === "tiktok");
  check("7.2 rota recusa sem tópico (400) e sem login (401)", (await call(orgA, "POST", "/video-post/plan", { channels: ["tiktok"] })).status === 400 && (await call(null, "POST", "/video-post/plan", { topic: "x", channels: ["tiktok"] })).status === 401);
  const r3 = await call(orgA, "GET", "/video-post/capabilities");
  check("7.3 rota de capacidades", r3.status === 200 && r3.body.renderImplemented === true && (await call(null, "GET", "/video-post/capabilities")).status === 401);
  const r4 = await call(orgA, "POST", "/video-post/render", { creationId: cid, channel: "instagram", topic: "camisa de linho" });
  check("7.4 rota de render devolve a nova criação; 400 para vídeo inexistente; 401 sem login", r4.status === 200 && r4.body.applied?.length === 2 && (await call(orgA, "POST", "/video-post/render", { creationId: "nao", channel: "instagram", topic: "x" })).status === 400 && (await call(null, "POST", "/video-post/render", {})).status === 401);
  server.close();

  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
