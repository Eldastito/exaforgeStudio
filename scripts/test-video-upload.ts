/**
 * TESTE — Upload de vídeo próprio no Estúdio (ADR-207 F13b.3). ffmpeg real, sem rede.
 * Prova: mp4/mov/webm válidos viram criação `uploaded` com metadados reais; MIME falso, arquivo corrompido, imagem
 * disfarçada, só-áudio, grande demais e longo demais são recusados (e o temporário SEMPRE removido); nome malicioso é inerte;
 * o render trata gerado × enviado igual; upload/edição NÃO consomem a cota de geração por IA; isolamento entre empresas;
 * `parseMediaInfo`; rota multipart.
 * Uso: npm run test:video-upload
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vupl-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-vupl-1234567890";
process.env.VIDEO_UPLOAD_MAX_BYTES = String(400 * 1024); process.env.VIDEO_UPLOAD_MAX_SECONDS = "6";
let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const studio = (await import("../src/server/routes/studio.js")).default;
  const { FfmpegService: F, parseMediaInfo } = await import("../src/server/FfmpegService.js");
  const { VideoUploadService: U, VideoUploadError } = await import("../src/server/VideoUploadService.js");
  const { VideoPostProductionService: V } = await import("../src/server/VideoPostProductionService.js");
  const { PlanService } = await import("../src/server/PlanService.js");
  const A = `org_vu_${randomUUID().slice(0, 8)}`, B = `org_vu_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  const fx = path.join(tmpDir, "fx"); fs.mkdirSync(fx, { recursive: true });
  const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("zf-upload-") || n.startsWith("zf-ffmpeg-")).length;
  const gen = async (name: string, args: string[]) => { const p = path.join(fx, name); const r = await F.run(["-y", ...args, p]); if (r.code !== 0) throw new Error("fixture " + name + ": " + r.stderr.slice(-200)); return p; };
  const src = (secs: number, size = "160x120") => ["-f", "lavfi", "-i", `testsrc=size=${size}:rate=10:duration=${secs}`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${secs}`, "-shortest"];
  const mp4 = await gen("ok.mp4", [...src(3), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  const mov = await gen("ok.mov", [...src(3), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  const webm = await gen("ok.webm", [...src(3), "-c:v", "libvpx", "-b:v", "200k", "-c:a", "libvorbis"]);
  const silent = await gen("mudo.mp4", ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const audioOnly = await gen("so-audio.mp4", ["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac"]);
  const longVid = await gen("longo.mp4", [...src(9), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  const bigVid = await gen("grande.mp4", ["-f", "lavfi", "-i", "testsrc2=size=640x480:rate=25:duration=5", "-c:v", "libx264", "-crf", "5", "-pix_fmt", "yuv420p"]);
  const fake = path.join(fx, "fake.mp4"); fs.writeFileSync(fake, "isto não é um vídeo, é só texto");
  const png = path.join(fx, "img.mp4"); fs.writeFileSync(png, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  const staged = (p: string) => { const t = path.join(os.tmpdir(), `zf-upload-t-${randomUUID()}`); fs.copyFileSync(p, t); return t; };
  const ing = (org: string, p: string, mime: string, name = path.basename(p)) => U.ingest(org, { tmpPath: staged(p), originalName: name, mime, size: fs.statSync(p).size });
  const rej = async (fn: () => Promise<any>) => { try { await fn(); return ""; } catch (e: any) { return e instanceof VideoUploadError ? e.code : "other:" + e.message; } };
  const mediaDir = path.join(tmpDir, "media");

  // 1. formatos válidos
  const r1 = await ing(A, mp4, "video/mp4"), r2 = await ing(A, mov, "video/quicktime"), r3 = await ing(A, webm, "video/webm");
  check("1.1 mp4 válido: criação 'uploaded' com metadados reais", r1.metadata.hasVideo && r1.metadata.hasAudio && r1.metadata.width === 160 && r1.metadata.height === 120 && Math.abs(r1.metadata.durationMs - 3000) < 300 && r1.metadata.videoCodec === "h264" && r1.metadata.audioCodec === "aac");
  check("1.2 mov e webm válidos", r2.mediaUrl.endsWith(".mov") && r3.mediaUrl.endsWith(".webm") && r3.metadata.hasVideo);
  check("1.3 gravado na mesma estrutura do Estúdio (kind video, source uploaded, status done, org certa)", (() => { const row = db.prepare("SELECT kind, source, status, organization_id, media_url FROM studio_creations WHERE id = ?").get(r1.creationId) as any; return row.kind === "video" && row.source === "uploaded" && row.status === "done" && row.organization_id === A && fs.existsSync(path.join(mediaDir, path.basename(row.media_url))); })());
  check("1.4 vídeo sem áudio é aceito, hasAudio=false", (await ing(A, silent, "video/mp4")).metadata.hasAudio === false);

  // 2. recusas
  check("2.1 MIME fora da lista", (await rej(() => ing(A, mp4, "application/pdf"))) === "bad_type");
  check("2.2 texto disfarçado de mp4 (MIME falso) → corrompido", (await rej(() => ing(A, fake, "video/mp4"))) === "invalid");
  check("2.3 imagem disfarçada de mp4", ["invalid", "no_video"].includes(await rej(() => ing(A, png, "video/mp4"))));
  check("2.4 só áudio (sem stream de vídeo)", (await rej(() => ing(A, audioOnly, "video/mp4"))) === "no_video");
  check("2.5 acima do limite de tamanho", fs.statSync(bigVid).size > 400 * 1024 && (await rej(() => ing(A, bigVid, "video/mp4"))) === "too_large");
  check("2.6 acima do limite de duração", (await rej(() => ing(A, longVid, "video/mp4"))) === "too_long");
  check("2.7 nenhum temporário sobrou (sucesso e recusas)", leftovers() === 0, String(leftovers()));
  const before = fs.readdirSync(mediaDir).length;
  await rej(() => ing(A, fake, "video/mp4"));
  check("2.8 recusa não grava nada no Estúdio", fs.readdirSync(mediaDir).length === before);

  // 3. nome malicioso
  const evilName = `../../../etc/x; touch pwned_${process.pid} $(touch pwned2) \`id\` <b>.mp4`;
  const re = await ing(A, mp4, "video/mp4", evilName);
  check("3.1 nome malicioso é inerte: arquivo salvo com nome gerado, rótulo higienizado", /^\/media\/studio_[0-9a-f-]{36}\.mp4$/.test(re.mediaUrl) && !/[<>`$;|&\\/]/.test(re.label) && !fs.existsSync(path.join(process.cwd(), `pwned_${process.pid}`)) && !fs.existsSync(path.join(process.cwd(), "pwned2")));

  // 4. pipeline agnóstico (gerado × enviado) e isolamento
  const rr = await V.render(A, { creationId: r1.creationId, channel: "instagram", topic: "camisa de linho" });
  check("4.1 o render funciona sobre o vídeo ENVIADO (sem distinguir origem)", fs.existsSync(path.join(mediaDir, path.basename(rr.mediaUrl))) && rr.aspect === "9:16");
  check("4.2 original enviado continua intacto", fs.existsSync(path.join(mediaDir, path.basename(r1.mediaUrl))));
  check("4.3 o resultado editado é marcado 'edited'", (db.prepare("SELECT source FROM studio_creations WHERE id = ?").get(rr.creationId) as any).source === "edited");
  check("4.4 outra empresa não edita o vídeo enviado", /não encontrado/.test(await rej(() => V.render(B, { creationId: r1.creationId, channel: "instagram", topic: "x" })).then((c) => c.replace("other:", ""))));

  // 5. cota de geração
  const genId = randomUUID();
  db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status) VALUES (?, ?, 'video', 'veo', '/media/x.mp4', 'done')").run(genId, B);
  check("5.1 só vídeo GERADO conta na cota; enviado/editado não", PlanService.studioUsage(B).videos === 1 && PlanService.studioUsage(A).videos === 0, JSON.stringify([PlanService.studioUsage(A), PlanService.studioUsage(B)]));
  const legacy = randomUUID();
  db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status) VALUES (?, ?, 'video', 'edição para TikTok (corte + enquadramento)', '/media/y.mp4', 'done')").run(legacy, B);
  db.exec(`UPDATE studio_creations SET source = 'edited' WHERE source IS NULL AND kind = 'video' AND prompt LIKE 'edição para %'`);
  check("5.2 edições legadas (sem source) são reclassificadas e saem da cota", (db.prepare("SELECT source FROM studio_creations WHERE id = ?").get(legacy) as any).source === "edited" && PlanService.studioUsage(B).videos === 1);

  // 6. parseMediaInfo
  const pm = parseMediaInfo("  Duration: 00:01:02.50, start: 0.000000, bitrate: 900 kb/s\n  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1080x1920 [SAR 1:1 DAR 9:16], 30 fps, 30 tbr\n  Stream #0:1: Audio: aac (LC), 44100 Hz, stereo");
  check("6.1 parseMediaInfo lê duração, resolução, codecs e fps", pm.durationMs === 62500 && pm.width === 1080 && pm.height === 1920 && pm.videoCodec === "h264" && pm.audioCodec === "aac" && pm.fps === 30 && pm.hasAudio);
  const pe = parseMediaInfo("nada reconhecível");
  check("6.2 saída ilegível → sem vídeo, sem áudio, duração 0 (não inventa)", !pe.hasVideo && !pe.hasAudio && pe.durationMs === 0 && pe.width === null);

  // 7. rota
  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => { if (req.headers["x-org"]) req.organizationId = String(req.headers["x-org"]); next(); });
  app.use("/api/studio", studio);
  const server = http.createServer(app);
  const port: number = await new Promise((rs) => server.listen(0, () => rs((server.address() as any).port)));
  const post = async (org: string | null, p: string, mime: string, name = "meu video.mp4") => {
    const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync(p)], { type: mime }), name);
    const r = await fetch(`http://127.0.0.1:${port}/api/studio/video-post/upload`, { method: "POST", headers: org ? { "x-org": org } : {}, body: fd });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const u1 = await post(A, mp4, "video/mp4");
  check("7.1 rota: upload válido devolve creationId e metadados", u1.status === 200 && !!u1.body.creationId && u1.body.metadata?.hasVideo === true);
  check("7.2 rota: MIME inválido → 400 com mensagem de cliente", (await post(A, mp4, "application/pdf")).status === 400);
  check("7.3 rota: arquivo falso → 400; sem login → 401", (await post(A, fake, "video/mp4")).status === 400 && (await post(null, mp4, "video/mp4")).status === 401);
  const big = await post(A, bigVid, "video/mp4");
  check("7.4 rota: acima do limite → 400 'grande demais' (corta no multer)", big.status === 400 && /grande demais/.test(big.body.error || ""));
  check("7.5 rota: nenhum temporário sobrou", leftovers() === 0, String(leftovers()));
  server.close();

  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
