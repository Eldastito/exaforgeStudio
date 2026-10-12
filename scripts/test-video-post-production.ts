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

  check("5.1 render honesto: awaiting_provider, nunca 'pronto'", p.render.status === "awaiting_provider" && p.render.capabilities.renderImplemented === false && /não está ligada/.test(p.render.reason));
  const savedPath = process.env.FFMPEG_PATH, savedUrl = process.env.VIDEO_TRANSCRIBE_URL;
  process.env.FFMPEG_PATH = "/nonexistent/ffmpeg"; delete process.env.VIDEO_TRANSCRIBE_URL;
  const c0 = new StubVideoPostProvider().capabilities();
  check("5.2 sem ffmpeg e sem transcrição: nada disponível, com o motivo dito", !c0.ffmpeg && !c0.transcription && !c0.canRenderTrimReframe && !c0.canRenderCaptions && c0.notes.some((n) => /ffmpeg/.test(n)) && c0.notes.some((n) => /transcrição/.test(n)));
  process.env.VIDEO_TRANSCRIBE_URL = "https://x.test/t";
  const c1 = new StubVideoPostProvider().capabilities();
  check("5.3 transcrição configurada sozinha não habilita legenda (precisa de ffmpeg)", c1.transcription && !c1.canRenderCaptions);
  if (savedPath === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = savedPath;
  if (savedUrl === undefined) delete process.env.VIDEO_TRANSCRIBE_URL; else process.env.VIDEO_TRANSCRIBE_URL = savedUrl;

  // rotas
  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => { if (req.headers["x-org"]) req.organizationId = String(req.headers["x-org"]); next(); });
  app.use("/api/studio", studio);
  const server = http.createServer(app);
  const port: number = await new Promise((rs) => server.listen(0, () => rs((server.address() as any).port)));
  const call = async (org: string | null, method: string, p2: string, body?: any) => { const r = await fetch(`http://127.0.0.1:${port}/api/studio${p2}`, { method, headers: { "Content-Type": "application/json", ...(org ? { "x-org": org } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const r1 = await call(orgA, "POST", "/video-post/plan", { topic: "camisa de linho", channels: ["tiktok"] });
  check("6.1 rota de plano devolve o plano", r1.status === 200 && r1.body.plans?.[0]?.channel === "tiktok");
  check("6.2 rota recusa sem tópico (400) e sem login (401)", (await call(orgA, "POST", "/video-post/plan", { channels: ["tiktok"] })).status === 400 && (await call(null, "POST", "/video-post/plan", { topic: "x", channels: ["tiktok"] })).status === 401);
  const r3 = await call(orgA, "GET", "/video-post/capabilities");
  check("6.3 rota de capacidades", r3.status === 200 && r3.body.renderImplemented === false && (await call(null, "GET", "/video-post/capabilities")).status === 401);
  server.close();

  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
