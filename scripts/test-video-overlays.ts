/**
 * TESTE — Título e CTA na imagem (ADR-207 F13b.7). Mesmo ASS + fonte empacotada da legenda. ffmpeg real.
 * Prova: tempos (título no começo, CTA no fim, nunca se sobrepõem; vídeo curto omite o que não cabe), texto de terceiro neutralizado,
 * a legenda existente NÃO muda, e no render real o título aparece no TOPO só no começo, o CTA no MEIO só no fim, a base fica livre,
 * termo proibido da marca recusa, funciona junto de legenda+pausas, original intacto, isolamento.
 * Uso: npm run test:video-overlays
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vov-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-vov-1234567890";
let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FfmpegService: F } = await import("../src/server/FfmpegService.js");
  const S = await import("../src/server/VideoSubtitleService.js");
  const { VideoPostProductionService: V } = await import("../src/server/VideoPostProductionService.js");
  const { VideoTranscriptionService: T } = await import("../src/server/VideoTranscriptionService.js");
  const { StubSpeechToTextProvider } = await import("../src/server/SpeechToTextProvider.js");
  const { BrandDnaService } = await import("../src/server/BrandDnaService.js");
  const A = `org_ov_${randomUUID().slice(0, 8)}`, B = `org_ov_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  const rej = async (fn: () => Promise<any>) => { try { await fn(); return ""; } catch (e: any) { return String(e.message); } };

  // 1. tempos
  const n = S.buildOverlays({ aspect: "9:16", durationMs: 20000, title: "Coleção nova chegou", cta: "Chame no WhatsApp" });
  check("1.1 vídeo de 20 s: título 0–3 s e CTA 17–20 s", n.events.length === 2 && n.events[0].kind === "title" && n.events[0].startMs === 0 && n.events[0].endMs === 3000 && n.events[1].kind === "cta" && n.events[1].startMs === 17000 && n.events[1].endMs === 20000 && n.omitted.length === 0, JSON.stringify(n.events));
  const sh = S.buildOverlays({ aspect: "9:16", durationMs: 4000, title: "T", cta: "C" });
  check("1.2 vídeo de 4 s: título ≤45% (1,8 s), CTA depois com respiro, sem sobreposição", sh.events.length === 2 && sh.events[0].endMs === 1800 && sh.events[1].startMs >= sh.events[0].endMs + 300 && sh.events[1].endMs === 4000, JSON.stringify(sh.events));
  const tiny = S.buildOverlays({ aspect: "9:16", durationMs: 2000, title: "T", cta: "C" });
  check("1.3 vídeo de 2 s: o CTA que não cabe é OMITIDO e dito (nunca atropela o título)", tiny.events.length === 1 && tiny.events[0].kind === "title" && tiny.omitted.join() === "CTA na imagem", JSON.stringify(tiny));
  const one = S.buildOverlays({ aspect: "9:16", durationMs: 1000, title: "T", cta: "C" });
  check("1.4 vídeo de 1 s: título omitido (curto demais p/ ler), CTA de 1 s ocupa o vídeo", one.omitted.join() === "título" && one.events.length === 1 && one.events[0].kind === "cta");
  check("1.5 só título / só CTA / nenhum", S.buildOverlays({ aspect: "1:1", durationMs: 10000, title: "T" }).events.length === 1 && S.buildOverlays({ aspect: "1:1", durationMs: 10000, cta: "C" }).events[0].startMs === 7000 && S.buildOverlays({ aspect: "1:1", durationMs: 10000 }).events.length === 0);
  const longT = S.buildOverlays({ aspect: "9:16", durationMs: 20000, title: "palavra ".repeat(60) });
  check("1.6 texto longo é cortado com reticências dentro do máximo de linhas/colunas (não estoura a tela)", longT.events[0].lines.length <= 3 && longT.events[0].lines.every((l) => l.length <= 20) && longT.events[0].lines[2].endsWith("…"), JSON.stringify(longT.events[0].lines));

  // 2. ASS
  const ass = S.toAss([{ startMs: 1000, endMs: 2500, lines: ["Fala"] }], { aspect: "9:16", overlays: S.buildOverlays({ aspect: "9:16", durationMs: 10000, title: "Olá {\\an5}\\N{\\fs300}x", cta: "Compre já" }).events });
  const dl = ass.split("\n").filter((l) => l.startsWith("Dialogue"));
  check("2.1 estilos Title (topo, alinhamento 8) e Cta (meio, 5, caixa opaca) + eventos em camada própria com fade", /Style: Title,.*,-1,0,0,0,100,100,0,0,1,6,0,8,/.test(ass) && /Style: Cta,.*,0,0,3,22,0,5,/.test(ass) && dl.filter((l) => l.startsWith("Dialogue: 1,")).length === 2 && dl.filter((l) => /\{\\fad\(250,250\)\}/.test(l)).length === 2);
  const tl = dl.find((l) => /,Title,/.test(l))!;
  check("2.2 texto do título é dado não confiável: chaves/barras do texto neutralizadas (só o fad nosso sobra)", (tl.match(/\{/g) || []).length === 1 && (tl.match(/\}/g) || []).length === 1 && !/\{\\(an|fs)/.test(tl) && !/\\an5|\\fs300/.test(tl) && /Olá/.test(tl));
  const plain = S.toAss([{ startMs: 1500, endMs: 4250, lines: ["Fala"] }], { aspect: "9:16" });
  check("2.3 sem overlays a legenda é a de antes (0-regressão: mesma linha Dialogue, camada 0)", /Dialogue: 0,0:00:01\.50,0:00:04\.25,Default,,0,0,0,,Fala/.test(plain) && !/Dialogue: 1,/.test(plain));

  // 3. render real
  const mediaDir = path.join(tmpDir, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  const gen = async (name: string, dur: number, expr = "0.3*sin(2*PI*440*t)") => (await F.run(["-y", "-f", "lavfi", "-i", `color=c=gray:s=640x360:r=15:d=${dur}`, "-f", "lavfi", "-i", `aevalsrc=${expr}:s=16000:d=${dur}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(mediaDir, name)])).code === 0;
  const talk = "0.3*sin(2*PI*440*t)*(between(t\\,1\\,3)+between(t\\,5\\,7)+between(t\\,7.4\\,9))";
  check("3.0 fixtures (cinza liso: qualquer pixel diferente é texto)", (await gen("v10.mp4", 10)) && (await gen("v2.mp4", 2)) && (await gen("talk.mp4", 10, talk)));
  const creation = (org: string, file: string) => { const id = randomUUID(); db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status, source) VALUES (?, ?, 'video', 'p', ?, 'done', 'uploaded')").run(id, org, `/media/${file}`); return id; };
  const cid = creation(A, "v10.mp4");
  const base = await V.render(A, { creationId: cid, channel: "instagram", topic: "camisa de linho" });
  const ov = await V.render(A, { creationId: cid, channel: "instagram", topic: "camisa de linho", title: true, cta: true });
  check("3.1 sem o pedido nada muda; com o pedido aplica título e CTA e devolve o que entrou", base.overlays === undefined && base.notApplied.includes("título") && ov.applied.includes("título") && ov.applied.includes("CTA na imagem") && !ov.notApplied.includes("título") && !!ov.overlays!.title && !!ov.overlays!.cta && ov.overlays!.omitted.length === 0, JSON.stringify(ov.overlays));
  const region = async (u: string, t: number, crop: string) => { const out = path.join(tmpDir, `r_${randomUUID()}.raw`); const x = await F.run(["-y", "-ss", String(t), "-i", path.join(mediaDir, path.basename(u)), "-frames:v", "1", "-vf", `crop=${crop}`, "-f", "rawvideo", "-pix_fmt", "gray", out]); if (x.code !== 0) throw new Error(x.stderr.slice(-200)); const b = fs.readFileSync(out); fs.rmSync(out); return b; };
  const diff = (a: Buffer, b: Buffer) => { let c = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (Math.abs(a[i] - b[i]) > 40) c++; return c / Math.min(a.length, b.length); };
  const TOP = "iw:ih*0.3:0:0", MID = "iw:ih*0.3:0:ih*0.35", BOT = "iw:ih*0.3:0:ih*0.7";
  const d = async (u: string, t: number, c: string, ref = base.mediaUrl) => diff(await region(u, t, c), await region(ref, t, c));
  check("3.2 título aparece no TOPO nos primeiros segundos (pixels do topo mudam em 1,5 s)", (await d(ov.mediaUrl, 1.5, TOP)) > 0.01);
  check("3.3 e o CTA não aparece nessa hora (meio igual em 1,5 s)", (await d(ov.mediaUrl, 1.5, MID)) < 0.0005);
  check("3.4 no meio do vídeo (5 s) não há nada: topo e meio iguais", (await d(ov.mediaUrl, 5, TOP)) < 0.0005 && (await d(ov.mediaUrl, 5, MID)) < 0.0005);
  check("3.5 CTA aparece no MEIO no fim (8,5 s), e o título já saiu (topo igual)", (await d(ov.mediaUrl, 8.5, MID)) > 0.01 && (await d(ov.mediaUrl, 8.5, TOP)) < 0.0005);
  check("3.6 a BASE fica livre (legenda/botões da plataforma): igual em 1,5 s e 8,5 s", (await d(ov.mediaUrl, 1.5, BOT)) < 0.0005 && (await d(ov.mediaUrl, 8.5, BOT)) < 0.0005);

  const custom = await V.render(A, { creationId: cid, channel: "instagram", topic: "x", title: "Promo de verão {\\an5}", cta: false });
  check("3.7 texto próprio do dono é usado (e sem CTA, o meio fica limpo em 8,5 s)", custom.overlays!.title === "Promo de verão {\\an5}" && custom.overlays!.cta === null && custom.applied.includes("título") && !custom.applied.includes("CTA na imagem") && (await d(custom.mediaUrl, 8.5, MID)) < 0.0005 && (await d(custom.mediaUrl, 1.5, TOP)) > 0.01);

  // 4. recusas e avisos
  await BrandDnaService.save(A, "u", { forbidden: ["barato"] });
  check("4.1 termo proibido da marca no título/CTA recusa (o texto é nosso, não fala)", /termo\(s\) que a marca não usa \(barato\)/.test(await rej(() => V.render(A, { creationId: cid, channel: "instagram", topic: "x", title: "Tudo barato hoje" }))));
  check("4.2 isolamento: a marca de outra empresa não bloqueia", (await V.render(B, { creationId: creation(B, "v10.mp4"), channel: "instagram", topic: "x", title: "Tudo barato hoje" }).then(() => "ok", (e) => e.message)) === "ok");
  check("4.3 outra empresa não edita o vídeo", /não encontrado/.test(await rej(() => V.render(B, { creationId: cid, channel: "instagram", topic: "x", title: true }))));
  const short = await V.render(A, { creationId: creation(A, "v2.mp4"), channel: "instagram", topic: "camisa de linho", title: true, cta: true });
  check("4.4 vídeo de 2 s: o CTA que não cabe sai em `omitted`, não em `applied`, e a nota diz", short.overlays!.omitted.join() === "CTA na imagem" && !short.applied.includes("CTA na imagem") && short.notApplied.includes("CTA na imagem") && /Não coube/.test(short.note));
  process.env.SUBTITLE_FONTS_DIR = path.join(tmpDir, "nada");
  check("4.5 sem a fonte empacotada recusa com mensagem de cliente", /não estão disponíveis/.test(await rej(() => V.render(A, { creationId: cid, channel: "instagram", topic: "x", title: true }))));
  delete process.env.SUBTITLE_FONTS_DIR;

  // 5. junto de legenda + pausas (o CTA usa a duração do vídeo JÁ cortado)
  T.provider = new StubSpeechToTextProvider({ text: "a b c", language: "pt", durationSec: 10, segments: [{ startMs: 1000, endMs: 3000, text: "Primeira frase aqui." }, { startMs: 5000, endMs: 7000, text: "Segunda frase aqui." }, { startMs: 7400, endMs: 9000, text: "Terceira frase aqui." }], words: [] });
  const ct = creation(A, "talk.mp4"); await T.transcribe(A, "u", ct);
  const cut = await V.render(A, { creationId: ct, channel: "instagram", topic: "camisa de linho", removePauses: true });
  const all = await V.render(A, { creationId: ct, channel: "instagram", topic: "camisa de linho", removePauses: true, subtitles: true, title: true, cta: true });
  check("5.1 tudo junto: aplica as 4 coisas, duração é a do corte (≈6,6 s)", ["legenda", "remoção de pausas", "título", "CTA na imagem"].every((x) => all.applied.includes(x)) && Math.abs(all.durationSec - 6.6) < 0.1, all.applied.join());
  check("5.2 o CTA cai no fim do vídeo JÁ cortado (6 s ≈ 3,6–6,6 s) e não aos 17 s do plano", (await d(all.mediaUrl, 6.0, MID, cut.mediaUrl)) > 0.01 && (await d(all.mediaUrl, 3.0, MID, cut.mediaUrl)) < 0.0005);
  check("5.3 título no começo do cortado e legenda continua na base", (await d(all.mediaUrl, 1.0, TOP, cut.mediaUrl)) > 0.01 && (await d(all.mediaUrl, 1.0, BOT, cut.mediaUrl)) > 0.01);
  check("5.4 original intacto e temporários limpos", fs.existsSync(path.join(mediaDir, "v10.mp4")) && fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith("zf-sub-") || x.startsWith("zf-ffmpeg-")).length === 0);

  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
