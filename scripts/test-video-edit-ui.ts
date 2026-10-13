/**
 * TESTE — Tela "Editar vídeo" (ADR-207 F13b.9): regras PURAS da tela (`videoEditLabels`) contra as respostas REAIS do servidor
 * (rotas Express reais + JobQueue + ffmpeg) + fiação do componente. Não vejo a tela num navegador: o que se prova aqui é a lógica
 * (o que pode marcar, o que é enviado, como a resposta vira texto, quando para de consultar) e que a tela só usa rotas que existem.
 * Uso: npm run test:video-edit-ui
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http"; import { fileURLToPath } from "url"; import { randomUUID } from "crypto";
import express from "express";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-veui-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-veui-1234567890";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const L = await import("../src/features/videoedit/videoEditLabels.js");
  const db = (await import("../src/server/db.js")).default;
  const { FfmpegService: F } = await import("../src/server/FfmpegService.js");
  const studio = (await import("../src/server/routes/studio.js")).default;

  // ── 1. rótulos / estados ──
  check("1.1 status em português para cada estado; desconhecido não finge", ["queued", "processing", "completed", "failed", "cancelled"].every((s) => L.statusLabel(s).length > 3) && /Pronto/.test(L.statusLabel("completed")) && /Cancelada/.test(L.statusLabel("cancelled")) && L.statusLabel("zzz") === "Situação desconhecida");
  check("1.2 ativo × final × cancelável", L.isActive("queued") && L.isActive("processing") && !L.isActive("completed") && L.isFinal("failed") && L.isFinal("cancelled") && L.isFinal("completed") && !L.isFinal("processing") && L.canCancel("queued") && L.canCancel("processing") && !L.canCancel("completed"));
  check("1.3 intervalo de consulta: começa em 1,5 s, cresce, tem teto de 6 s, aguenta lixo", L.pollDelayMs(0) === 1500 && L.pollDelayMs(1) > L.pollDelayMs(0) && L.pollDelayMs(1000) === 6000 && L.pollDelayMs(-5) === 1500 && L.pollDelayMs(NaN) === 1500 && L.MAX_POLL_ATTEMPTS * 3000 >= 10 * 60 * 1000);

  // ── 2. o que o cliente pode marcar ──
  const full = { ffmpeg: true, transcription: true, canRenderCaptions: true };
  const o1 = L.optionAvailability(full, true);
  check("2.1 tudo disponível com transcrição pronta", o1.subtitles.enabled && o1.pauses.enabled && o1.title.enabled && o1.cta.enabled && !o1.subtitles.needsTranscript);
  const o2 = L.optionAvailability(full, false);
  check("2.2 sem transcrição pronta: legenda travada, pede transcrever (e diz que usa IA); o resto liberado", !o2.subtitles.enabled && o2.subtitles.needsTranscript && /usa IA/.test(o2.subtitles.reason || "") && o2.pauses.enabled && o2.title.enabled);
  const o3 = L.optionAvailability({ ffmpeg: true, transcription: false, canRenderCaptions: true }, false);
  check("2.3 servidor sem transcrição: legenda travada SEM oferecer transcrever, com motivo", !o3.subtitles.enabled && !o3.subtitles.needsTranscript && /transcrição não está disponível/.test(o3.subtitles.reason || ""));
  const o4 = L.optionAvailability({ ffmpeg: true, transcription: true, canRenderCaptions: false }, true);
  check("2.4 sem filtro/fonte de legenda: legenda, título e CTA travados; pausas seguem", !o4.subtitles.enabled && !o4.title.enabled && !o4.cta.enabled && o4.pauses.enabled && /indisponível/.test(o4.title.reason || ""));
  const o5 = L.optionAvailability({ ffmpeg: false, transcription: false, canRenderCaptions: false }, true);
  check("2.5 sem ffmpeg tudo travado com o mesmo motivo; sem capacidades carregadas também", [o5.subtitles, o5.pauses, o5.title, o5.cta].every((x) => !x.enabled && /não está disponível neste servidor/.test(x.reason || "")) && !L.optionAvailability(null, true).pauses.enabled && !L.optionAvailability(undefined, false).title.enabled);

  // ── 3. corpo do pedido ──
  const base: any = { creationId: "c1", channel: "instagram", topic: "camisa de linho", subtitles: false, removePauses: false, title: false, titleText: "", cta: false, ctaText: "" };
  const b1: any = L.buildRenderBody(base, o1);
  check("3.1 pedido mínimo: só corte+enquadramento (tudo false)", b1.ok && b1.body.creationId === "c1" && b1.body.channel === "instagram" && b1.body.subtitles === false && b1.body.title === false && b1.body.cta === false && b1.body.removePauses === false);
  const b2: any = L.buildRenderBody({ ...base, title: true, titleText: "  Promo de verão  ", cta: true, ctaText: "", removePauses: true, subtitles: true }, o1);
  check("3.2 título com texto próprio vai aparado; CTA em branco vira `true` (usa o do plano)", b2.ok && b2.body.title === "Promo de verão" && b2.body.cta === true && b2.body.removePauses === true && b2.body.subtitles === true);
  check("3.3 texto desmarcado é ignorado mesmo preenchido", (L.buildRenderBody({ ...base, title: false, titleText: "x".repeat(10) }, o1) as any).body.title === false);
  check("3.4 texto próprio é limitado a 140 caracteres", (L.buildRenderBody({ ...base, title: true, titleText: "a".repeat(500) }, o1) as any).body.title.length === 140);
  check("3.5 recusas claras: sem canal, sem tópico (ou 1 letra), sem vídeo", (L.buildRenderBody({ ...base, channel: "" }, o1) as any).error.includes("onde") && (L.buildRenderBody({ ...base, topic: "  " }, o1) as any).error.includes("do que é") && (L.buildRenderBody({ ...base, topic: "a" }, o1) as any).ok === false && (L.buildRenderBody({ ...base, creationId: "" }, o1) as any).error.includes("vídeo"));
  check("3.6 opção travada não passa pelo botão (mesmo que o estado diga marcado): usa o motivo do servidor", (L.buildRenderBody({ ...base, subtitles: true }, o2) as any).error === o2.subtitles.reason && (L.buildRenderBody({ ...base, title: true }, o4) as any).ok === false && (L.buildRenderBody({ ...base, removePauses: true }, o5) as any).ok === false);

  // ── 4. textos de resultado ──
  check("4.1 duração legível", L.formatDuration(6.6) === "6,6 s" && L.formatDuration(10) === "10 s" && L.formatDuration(65) === "1 min 05 s" && L.formatDuration(119.7) === "2 min" && L.formatDuration(null) === "—" && L.formatDuration(-3) === "—" && L.formatDuration(NaN) === "—");
  check("4.2 pausas: sem pausas diz que não achou (nunca 'cortei 0'); com pausas mostra antes→depois; singular/plural", /Não encontrei pausas claras/.test(L.pausesSummary({ removedCount: 0, removedSec: 0, durationBeforeSec: 10, durationAfterSec: 10 })!) && /Cortei 3 pausas \(3,4 s\).*10 s para 6,6 s/.test(L.pausesSummary({ removedCount: 3, removedSec: 3.4, durationBeforeSec: 10, durationAfterSec: 6.6 })!) && /Cortei 1 pausa /.test(L.pausesSummary({ removedCount: 1, removedSec: 1, durationBeforeSec: 5, durationAfterSec: 4 })!) && L.pausesSummary(undefined) === null);
  const req = { subtitles: true, removePauses: true, title: true, cta: true };
  const rs = L.resultSummary({ applied: ["corte", "enquadramento", "título"], notApplied: ["legenda", "CTA na imagem"], overlays: { title: "T", cta: null, omitted: ["CTA na imagem"] } }, req);
  check("4.3 resultado: o que foi feito; só o PEDIDO que não aconteceu vira aviso (CTA não coube, pausas, legenda)", rs.done.join() === "Corte,Enquadramento,Título" && rs.notDone.some((n) => /CTA na imagem: não coube/.test(n)) && rs.notDone.some((n) => /pausas claras/.test(n)) && rs.notDone.some((n) => /Legenda: não foi aplicado/.test(n)) && rs.notDone.length === 3, JSON.stringify(rs));
  check("4.4 o que NÃO foi pedido não aparece como 'não feito'", L.resultSummary({ applied: ["corte", "enquadramento"], notApplied: ["legenda", "remoção de pausas", "título", "CTA na imagem"] }, { subtitles: false, removePauses: false, title: false, cta: false }).notDone.length === 0 && L.resultSummary(null, req).done.length === 0);
  check("4.5 erro do servidor aparece; sem mensagem: texto por status; nunca vazio", L.errorText(400, { error: "Você já tem 3 edições em andamento." }) === "Você já tem 3 edições em andamento." && /permissão/.test(L.errorText(401, {})) && /Não encontrei/.test(L.errorText(404, null)) && /servidor teve um problema/.test(L.errorText(502, {})) && L.errorText(418, {}).length > 10);
  check("4.6 só vídeo pronto e com arquivo é editável", L.isVideoEditable({ kind: "video", status: "done", media_url: "/media/a.mp4" }) && L.isVideoEditable({ media_url: "/media/a.mov" }) && !L.isVideoEditable({ kind: "video", status: "processing", media_url: "/media/a.mp4" }) && !L.isVideoEditable({ kind: "video", media_url: "" }) && !L.isVideoEditable({ kind: "image", media_url: "/media/a.png" }) && !L.isVideoEditable(null));

  // ── 5. contra o servidor REAL ──
  const A = `org_ve_${randomUUID().slice(0, 8)}`, B = `org_ve_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  const mediaDir = path.join(tmpDir, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  const gen = async (name: string, dur: number, expr: string) => (await F.run(["-y", "-f", "lavfi", "-i", `color=c=gray:s=640x360:r=15:d=${dur}`, "-f", "lavfi", "-i", `aevalsrc=${expr}:s=16000:d=${dur}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(mediaDir, name)])).code === 0;
  const talk = "0.3*sin(2*PI*440*t)*(between(t\\,1\\,3)+between(t\\,5\\,7)+between(t\\,7.4\\,9))";
  check("5.0 fixtures", (await gen("talk.mp4", 10, talk)) && (await gen("short.mp4", 2, "0.3*sin(2*PI*440*t)")));
  const creation = (org: string, file: string) => { const id = randomUUID(); db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status, source) VALUES (?, ?, 'video', 'p', ?, 'done', 'uploaded')").run(id, org, `/media/${file}`); return id; };
  F.limits.maxConcurrentJobs = 3;
  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => { if (req.headers["x-org"]) req.organizationId = String(req.headers["x-org"]); next(); });
  app.use("/api/studio", studio);
  const server = http.createServer(app);
  const port: number = await new Promise((rs) => server.listen(0, () => rs((server.address() as any).port)));
  const call = async (org: string, method: string, p: string, body?: any) => { const r = await fetch(`http://127.0.0.1:${port}/api/studio${p}`, { method, headers: { "x-org": org, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const follow = async (org: string, id: string) => { for (let i = 0; i < 400; i++) { const j = await call(org, "GET", `/video-post/jobs/${id}`); if (L.isFinal(j.body.status)) return j.body; await sleep(100); } throw new Error("sem fim"); };

  const caps = (await call(A, "GET", "/video-post/capabilities")).body;
  const real = L.optionAvailability(caps, false);
  check("5.1 capacidades REAIS do servidor liberam pausas, título e CTA; legenda pede transcrição (sem transcrição pronta)", caps.ffmpeg === true && real.pauses.enabled && real.title.enabled && real.cta.enabled && !real.subtitles.enabled, JSON.stringify(caps));
  const ch = (await call(A, "GET", "/channels")).body.channels;
  check("5.2 lista de canais traz channel+label (o que a tela mostra)", Array.isArray(ch) && ch.length >= 4 && ch.every((c: any) => c.channel && c.label) && ch.some((c: any) => c.channel === "instagram"));
  check("5.3 sem transcrição → a rota devolve 404 (a tela entende como 'ainda não transcrito')", (await call(A, "GET", `/video-post/${creation(A, "talk.mp4")}/transcript`)).status === 404);

  const cid = creation(A, "talk.mp4");
  const built: any = L.buildRenderBody({ ...base, creationId: cid, removePauses: true, title: true, cta: true }, real);
  const started = await call(A, "POST", "/video-post/render-async", built.body);
  check("5.4 o corpo montado pela tela é ACEITO pelo servidor (202) e nasce na fila", started.status === 202 && L.isActive(started.body.status) && L.statusLabel(started.body.status).length > 3, JSON.stringify(started.body));
  const dup = await call(A, "POST", "/video-post/render-async", built.body);
  check("5.5 clique repetido devolve o mesmo job (a tela avisa que já estava em andamento)", dup.status === 200 && dup.body.deduplicated === true && dup.body.id === started.body.id);
  const fin = await follow(A, started.body.id);
  const sum = L.resultSummary(fin.result, { subtitles: false, removePauses: true, title: true, cta: true });
  check("5.6 resultado real: concluiu, aplicou pausas+título+CTA, nada pedido ficou sem explicação", fin.status === "completed" && sum.done.includes("Remoção de pausas") && sum.done.includes("Título") && sum.done.includes("CTA na imagem") && sum.notDone.length === 0, JSON.stringify(sum));
  check("5.7 texto das pausas com números reais (3 pausas, ≈10 s → ≈6,6 s)", /Cortei 3 pausas/.test(L.pausesSummary(fin.result.pauses) || "") && /6,[5-7] s/.test(L.pausesSummary(fin.result.pauses) || ""), L.pausesSummary(fin.result.pauses) || "");
  check("5.8 o vídeo novo existe e aparece na lista de recentes com status final", !!fin.result.mediaUrl && fs.existsSync(path.join(mediaDir, path.basename(fin.result.mediaUrl))) && (await call(A, "GET", "/video-post/jobs?limit=5")).body.jobs.some((j: any) => j.id === fin.id && j.status === "completed"));

  const cs = creation(A, "short.mp4");
  const sb: any = L.buildRenderBody({ ...base, creationId: cs, title: true, cta: true }, real);
  const finS = await follow(A, (await call(A, "POST", "/video-post/render-async", sb.body)).body.id);
  const sumS = L.resultSummary(finS.result, { subtitles: false, removePauses: false, title: true, cta: true });
  check("5.9 vídeo curto: a tela avisa que o CTA não coube (e o título entrou)", finS.status === "completed" && sumS.done.includes("Título") && sumS.notDone.some((n) => /CTA na imagem: não coube/.test(n)), JSON.stringify(sumS));

  const stop = await call(A, "POST", "/video-post/render-async", { ...built.body, channel: "tiktok" });
  const cancelled = await call(A, "POST", `/video-post/jobs/${stop.body.id}/cancel`);
  const finC = await follow(A, stop.body.id);
  check("5.10 cancelar pela tela: a rota responde e o estado final é 'Cancelada'", cancelled.status === 200 && finC.status === "cancelled" && L.statusLabel(finC.status) === "Cancelada" && L.canCancel(finC.status) === false);
  const late = await call(A, "POST", `/video-post/jobs/${fin.id}/cancel`);
  check("5.11 cancelar tarde demais: 409 com mensagem que a tela mostra como está", late.status === 409 && /já terminou/.test(late.body.message));
  const other = await call(B, "POST", "/video-post/render-async", built.body);
  check("5.12 vídeo de outra empresa: 400 com texto de cliente (nada técnico)", other.status === 400 && L.errorText(other.status, other.body) === "Vídeo do Estúdio não encontrado." && !/sqlite|ffmpeg|stack/i.test(JSON.stringify(other.body)));
  const failed = await follow(A, (await call(A, "POST", "/video-post/render-async", L.buildRenderBody({ ...base, creationId: creation(A, "talk.mp4"), topic: "sem transcrição" }, { ...real, subtitles: { enabled: true, reason: null, needsTranscript: false } }).ok ? { ...built.body, subtitles: true, removePauses: false, title: false, cta: false, topic: "sem transcrição", creationId: creation(A, "talk.mp4") } : {})).body.id);
  check("5.13 legenda pedida sem transcrição (servidor recusa na execução): estado 'Não deu certo' com a mensagem de cliente", failed.status === "failed" && /Transcreva o vídeo antes/.test(failed.error || "") && L.statusLabel("failed") === "Não deu certo");
  server.close();

  // ── 6. fiação ──
  const panel = read("src/features/VideoEditPanel.tsx"), view = read("src/features/StudioView.tsx"), routes = read("src/server/routes/studio.ts");
  check("6.1 tela abre pelo Estúdio, lazy (só carrega ao abrir), botão só em vídeo pronto, sem menu novo", /lazy\(\(\) => import\('\.\/VideoEditPanel'\)\)/.test(view) && /isVideoEditable\(c\) &&/.test(view) && !/VideoEdit/.test(read("src/features/Sidebar.tsx")) && !/VideoEdit/.test(read("src/App.tsx")));
  const used = Array.from(panel.matchAll(/\$\{API\}(\/[a-zA-Z/${}:.-]*)/g)).map((m) => m[1]);
  const exists = (u: string) => { const p = u.replace(/\$\{[^}]+\}/g, ":x").replace(/\?.*$/, ""); return new RegExp(`router\\.(get|post|put)\\("/video-post${p.replace(/:x/g, ":[a-zA-Z]+").replace(/\//g, "\\/")}"`).test(routes); };
  check("6.2 todas as rotas de video-post que a tela chama existem no servidor", used.length >= 6 && used.every(exists), JSON.stringify(used.filter((u) => !exists(u))));
  check("6.3 as outras rotas usadas também existem (capacidades de canais; envio de vídeo próprio)", /router\.get\("\/channels"/.test(routes) && /router\.post\("\/video-post\/upload"/.test(routes) && /\/api\/studio\/channels/.test(panel) && /\/api\/studio\/video-post\/upload/.test(view));
  check("6.4 a consulta do job é cancelável ao sair (flag + clearTimeout) e não usa setInterval; para após o limite", /cancelled = true; clearTimeout\(timer\)/.test(panel) && !/setInterval/.test(panel) && /MAX_POLL_ATTEMPTS/.test(panel) && /alive\.current = false/.test(panel));
  check("6.5 tem botão de cancelar, de fazer outra edição, e mostra edições recentes", /Cancelar edição/.test(panel) && /Fazer outra edição/.test(panel) && /Edições recentes/.test(panel));
  check("6.6 honestidade na tela: sem barra de porcentagem, sem HTML injetado, sem token no código", !/progress|\d+\s*%/.test(panel.replace(/\/\/.*$/gm, "")) && !/dangerouslySetInnerHTML/.test(panel) && !/localStorage|zappflow_token/.test(panel));
  check("6.7 envio de vídeo próprio aceita só mp4/mov/webm, mesmo formato que o servidor valida; abre o editor com o vídeo enviado", /accept="video\/mp4,video\/quicktime,video\/webm"/.test(view) && /setEditVideo\(\{ id: d\.creationId/.test(view));
  check("6.8 a galeria (e o botão de enviar) aparece mesmo sem criações; a grade só com criações", /creations\.length > 0 && <div className="grid/.test(view));
  check("6.9 celular: painel cabe na tela (rolagem própria, colunas empilhadas, botões de largura cheia)", /max-h-\[92vh\] overflow-y-auto/.test(panel) && /flex-col sm:flex-row/.test(panel) && /items-end sm:items-center/.test(panel));

  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
