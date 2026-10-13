/**
 * TESTE — Legenda automática queimada no vídeo (ADR-207 F13b.5). ffmpeg real (libass) + fonte empacotada.
 * Prova: quebra em linhas/cues sem sobreposição, janela recortada, ASS escapado (fala é dado não confiável), a fonte
 * EMPACOTADA é a usada pelo libass (sem fallback), a legenda aparece de fato no quadro (pixels da base mudam só durante a fala),
 * usa a transcrição EDITADA, exige transcrição pronta, original preservado, termo da marca vira aviso sem alterar a fala.
 * Uso: npm run test:video-subtitles
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vsub-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-vsub-1234567890";
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
  const A = `org_vs_${randomUUID().slice(0, 8)}`, B = `org_vs_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  const rej = async (fn: () => Promise<any>) => { try { await fn(); return ""; } catch (e: any) { return String(e.message); } };

  // 1. puros: linhas, cues, janela
  check("1.1 wrapLines respeita o máximo por linha e não corta palavra", S.wrapLines("uma frase bem comprida para quebrar em duas linhas curtas", 20).every((l) => l.length <= 20) && S.wrapLines("supercalifragilisticexpialidocious ok", 10)[0] === "supercalifragilisticexpialidocious");
  const cues = S.buildCues([
    { startMs: 2000, endMs: 4000, text: "Segunda frase aqui." },
    { startMs: 0, endMs: 1800, text: "Primeira frase, bem curta." },
    { startMs: 4200, endMs: 4300, text: "Muito rápida" },
    { startMs: 5000, endMs: 5000, text: "invertida" },
    { startMs: 6000, endMs: 7000, text: "" },
    { startMs: 8000, endMs: 14000, text: "Esta frase é bem longa e vai precisar de várias linhas para caber na tela do celular sem ficar ilegível." },
  ], { aspect: "9:16" });
  check("1.2 ordenadas, vazias/invertidas descartadas, no máximo 2 linhas por cue", cues[0].lines[0].startsWith("Primeira") && cues.every((c) => c.lines.length <= 2 && c.lines.every((l) => l.length <= 24)) && !cues.some((c) => c.lines.join("").includes("invertida")));
  check("1.3 sem sobreposição e com duração mínima legível", cues.every((c, i) => c.endMs > c.startMs && (i === 0 || c.startMs >= cues[i - 1].endMs)) && cues.find((c) => c.lines[0].startsWith("Muito"))!.endMs - 4200 >= 100);
  const tight = S.buildCues([{ startMs: 0, endMs: 300, text: "A" }, { startMs: 400, endMs: 900, text: "B" }], { aspect: "9:16" });
  check("1.3b duração mínima NUNCA invade a próxima cue", tight.length === 2 && tight[0].endMs <= tight[1].startMs && tight[0].endMs === 400, JSON.stringify(tight));
  const longCues = cues.filter((c) => c.startMs >= 8000);
  check("1.4 frase longa vira várias cues dividindo o tempo e cobrindo o intervalo todo", longCues.length >= 2 && longCues[0].startMs === 8000 && longCues[longCues.length - 1].endMs === 14000);
  const win = S.buildCues([{ startMs: 0, endMs: 3000, text: "A" }, { startMs: 3000, endMs: 6000, text: "B" }, { startMs: 9000, endMs: 12000, text: "C" }], { aspect: "1:1", windowStartMs: 2000, windowEndMs: 7000 });
  check("1.5 janela do vídeo editado: recorta, desloca p/ o início da janela e descarta o que ficou de fora", win.length === 2 && win[0].startMs === 0 && win[0].endMs === 1000 && win[1].startMs === 1000 && win[1].endMs === 4000 && !win.some((c) => c.lines[0] === "C"));

  // 2. ASS
  const ass = S.toAss(S.buildCues([{ startMs: 1500, endMs: 4250, text: "Coleção nova — ação! {\\an8}\\N{\\fs200}x" }], { aspect: "9:16" }), { aspect: "9:16" });
  check("2.1 ASS válido: resolução nominal, estilo com a fonte empacotada, base segura, tempos H:MM:SS.cc", /PlayResX: 1080/.test(ass) && /PlayResY: 1920/.test(ass) && /Style: Default,DejaVu Sans,/.test(ass) && /Dialogue: 0,0:00:01\.50,0:00:04\.25,Default/.test(ass) && /,2,90,90,300,1/.test(ass));
  const dlg = ass.split("\n").find((l) => l.startsWith("Dialogue"))!;
  check("2.2 texto da fala é dado não confiável: chaves de override e barras neutralizadas, acentos preservados", !/\{\\/.test(dlg) && !/\\an8|\\fs200/.test(dlg) && /Coleção nova — ação!/.test(dlg));
  check("2.3 proporções: 1:1 e 16:9 têm resolução e margem próprias", /PlayResX: 1080\nPlayResY: 1080/.test(S.toAss([], { aspect: "1:1" })) && /PlayResX: 1920/.test(S.toAss([], { aspect: "16:9" })));

  // 3. capacidade
  check("3.1 fonte empacotada presente e capacidade de legenda descoberta (ffmpeg com libass)", S.VideoSubtitleService.fontAvailable() && (await S.VideoSubtitleService.available()) === true && (await F.hasFilter("ass")) === true && (await F.hasFilter("filtro_inexistente")) === false);
  const savedDir = process.env.SUBTITLE_FONTS_DIR; process.env.SUBTITLE_FONTS_DIR = path.join(tmpDir, "nada");
  check("3.2 sem a fonte a capacidade fica indisponível (não renderiza com fonte aleatória)", (await S.VideoSubtitleService.available()) === false);
  if (savedDir === undefined) delete process.env.SUBTITLE_FONTS_DIR; else process.env.SUBTITLE_FONTS_DIR = savedDir;

  // Sem fontes do sistema (como num container enxuto): se a fonte empacotada não chegasse ao libass, não haveria texto.
  const fcConf = path.join(tmpDir, "fonts.conf"); fs.writeFileSync(fcConf, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><cachedir>${path.join(tmpDir, "fccache")}</cachedir></fontconfig>`);
  process.env.FONTCONFIG_FILE = fcConf;

  // 4. a fonte empacotada é MESMO a usada (libass não cai em fallback)
  const probeAss = path.join(tmpDir, "probe.ass"); fs.writeFileSync(probeAss, S.toAss([{ startMs: 0, endMs: 1500, lines: ["Teste ção"] }], { aspect: "16:9" }));
  const fdir = S.fontsDir();
  const vlog = await F.run(["-v", "verbose", "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=1.5:r=10", "-vf", `ass=filename=${probeAss}:fontsdir=${fdir}`, "-f", "null", "-"]);
  const vneg = await F.run(["-v", "verbose", "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=1.5:r=10", "-vf", `ass=filename=${probeAss}:fontsdir=${path.join(tmpDir, "sem-fontes")}`, "-f", "null", "-"]);
  check("4.1 sem fontes do sistema, o libass acha o DejaVuSans-Bold SÓ pela pasta empacotada (controle negativo: sem a pasta não acha)", /fontselect:[^\n]*DejaVuSans-Bold/.test(vlog.stderr) && vlog.code === 0 && !/fontselect:[^\n]*DejaVuSans-Bold/.test(vneg.stderr), (vlog.stderr.match(/fontselect[^\n]*/g) || []).slice(0, 2).join(" | "));

  // 5. render real
  const mediaDir = path.join(tmpDir, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  const srcName = "studio_src.mp4";
  const g = await F.run(["-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(mediaDir, srcName)]);
  check("5.0 fixture gerada", g.code === 0);
  const creation = (org: string) => { const id = randomUUID(); db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status, source) VALUES (?, ?, 'video', 'p', ?, 'done', 'uploaded')").run(id, org, `/media/${srcName}`); return id; };
  T.provider = new StubSpeechToTextProvider({ text: "Olá, olha a coleção nova. Chegou hoje na loja.", language: "pt", durationSec: 6,
    segments: [{ startMs: 500, endMs: 2500, text: "Olá, olha a coleção nova." }, { startMs: 3500, endMs: 5500, text: "Chegou hoje na loja." }], words: [] });
  const cid = creation(A);
  check("5.1 legenda sem transcrição pronta → pede a transcrição (não gasta IA escondido)", /Transcreva o vídeo antes/.test(await rej(() => V.render(A, { creationId: cid, channel: "instagram", topic: "x", subtitles: true }))));
  await T.transcribe(A, "u", cid);

  const withSub = await V.render(A, { creationId: cid, channel: "instagram", topic: "camisa de linho", subtitles: true });
  const noSub = await V.render(A, { creationId: cid, channel: "instagram", topic: "camisa de linho", subtitles: false });
  check("5.2 resposta: aplicou corte+enquadramento+legenda; sem o pedido, não legenda", withSub.applied.join() === "corte,enquadramento,legenda" && !withSub.notApplied.includes("legenda") && noSub.applied.join() === "corte,enquadramento" && noSub.notApplied.includes("legenda"));
  check("5.3 original intacto e temporários limpos", fs.existsSync(path.join(mediaDir, srcName)) && fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("zf-sub-") || n.startsWith("zf-ffmpeg-")).length === 0);

  // pixels da faixa inferior num instante: com legenda × sem legenda
  const frameBottom = async (file: string, tSec: number) => {
    const out = path.join(tmpDir, `f_${randomUUID()}.raw`);
    const r = await F.run(["-y", "-ss", String(tSec), "-i", path.join(mediaDir, path.basename(file)), "-frames:v", "1", "-vf", "crop=iw:ih*0.5:0:ih*0.5", "-f", "rawvideo", "-pix_fmt", "gray", out]);
    if (r.code !== 0) throw new Error("frame " + r.stderr.slice(-200)); const b = fs.readFileSync(out); fs.rmSync(out); return b;
  };
  const diff = (a: Buffer, b: Buffer) => { let n = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (Math.abs(a[i] - b[i]) > 40) n++; return n / Math.min(a.length, b.length); };
  const during = diff(await frameBottom(withSub.mediaUrl, 1.5), await frameBottom(noSub.mediaUrl, 1.5));
  const gap = diff(await frameBottom(withSub.mediaUrl, 3.0), await frameBottom(noSub.mediaUrl, 3.0));
  const during2 = diff(await frameBottom(withSub.mediaUrl, 4.5), await frameBottom(noSub.mediaUrl, 4.5));
  check("5.4 a legenda aparece NO QUADRO durante a fala (pixels da base mudam)", during > 0.01 && during2 > 0.01, `${during.toFixed(4)} / ${during2.toFixed(4)}`);
  check("5.5 e some entre as falas (mesmo quadro, sem legenda, idêntico)", gap < 0.0005, gap.toFixed(5));
  const topDiff = async (t: number) => { const f = async (u: string) => { const out = path.join(tmpDir, `t_${randomUUID()}.raw`); await F.run(["-y", "-ss", String(t), "-i", path.join(mediaDir, path.basename(u)), "-frames:v", "1", "-vf", "crop=iw:ih*0.3:0:0", "-f", "rawvideo", "-pix_fmt", "gray", out]); const b = fs.readFileSync(out); fs.rmSync(out); return b; }; return diff(await f(withSub.mediaUrl), await f(noSub.mediaUrl)); };
  check("5.6 a legenda fica na base: o topo do quadro não muda", (await topDiff(1.5)) < 0.0005);

  // 6. transcrição editada manda
  const cid2 = creation(A); await T.transcribe(A, "u", cid2);
  T.editText(A, cid2, [{ index: 1, text: "" }]);
  const edited = await V.render(A, { creationId: cid2, channel: "instagram", topic: "camisa de linho", subtitles: true });
  const dEdit = diff(await frameBottom(edited.mediaUrl, 4.5), await frameBottom(noSub.mediaUrl, 4.5));
  const dKept = diff(await frameBottom(edited.mediaUrl, 1.5), await frameBottom(noSub.mediaUrl, 1.5));
  check("6.1 frase removida na edição some da legenda; as demais ficam", dEdit < 0.0005 && dKept > 0.01, `${dEdit.toFixed(5)} / ${dKept.toFixed(4)}`);

  // 7. recusas
  check("7.1 transcrição de outra empresa não vale", /Transcreva o vídeo antes|não encontrado/.test(await rej(() => V.render(B, { creationId: cid, channel: "instagram", topic: "x", subtitles: true }))));
  const cid3 = creation(A);
  T.provider = new StubSpeechToTextProvider({ text: "", language: "pt", durationSec: 6, segments: [], words: [] }); await T.transcribe(A, "u", cid3);
  check("7.2 vídeo sem fala não gera legenda", /Não detectei fala/.test(await rej(() => V.render(A, { creationId: cid3, channel: "instagram", topic: "x", subtitles: true }))));
  process.env.SUBTITLE_FONTS_DIR = path.join(tmpDir, "nada");
  check("7.3 sem fonte empacotada recusa com mensagem de cliente", /legenda na imagem não está disponível/i.test(await rej(() => V.render(A, { creationId: cid, channel: "instagram", topic: "x", subtitles: true }))));
  delete process.env.SUBTITLE_FONTS_DIR;

  // 8. marca: aviso, fala intacta
  await BrandDnaService.save(A, "u", { forbidden: ["coleção"] });
  const warn = await V.render(A, { creationId: cid, channel: "instagram", topic: "x", subtitles: true });
  check("8.1 termo que a marca não usa aparece como AVISO e a fala não é alterada", /coleção/.test(warn.note) && /sem alterá-la/.test(warn.note));
  check("8.2 isolamento: a marca de outra empresa não gera aviso", !/marca não usa/.test((await (async () => { const c = creation(B); T.provider = new StubSpeechToTextProvider({ text: "Olá coleção", language: "pt", durationSec: 6, segments: [{ startMs: 500, endMs: 2500, text: "Olá coleção" }], words: [] }); await T.transcribe(B, "u", c); return V.render(B, { creationId: c, channel: "instagram", topic: "x", subtitles: true }); })()).note));

  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
