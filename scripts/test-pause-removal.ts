/**
 * TESTE — Remoção de pausas (ADR-207 F13b.6). ffmpeg real. Prova: parse do silencedetect, EDL (respiro, bordas, silêncio curto
 * preservado, limite de cortes, nunca esvazia o vídeo), remapeamento da legenda (monótono, sem sobreposição), e no render REAL:
 * a duração cai o esperado, o áudio cortado não tem mais pausa longa, vídeo e áudio continuam alinhados, a legenda cai no tempo
 * certo do vídeo cortado, sem pausas → sem cortes (dito), vídeo sem áudio recusado, original intacto, isolamento.
 * Uso: npm run test:pause-removal
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pause-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pause-1234567890";
let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FfmpegService: F } = await import("../src/server/FfmpegService.js");
  const P = await import("../src/server/PauseRemovalService.js");
  const { VideoPostProductionService: V } = await import("../src/server/VideoPostProductionService.js");
  const { VideoTranscriptionService: T } = await import("../src/server/VideoTranscriptionService.js");
  const { StubSpeechToTextProvider } = await import("../src/server/SpeechToTextProvider.js");
  const A = `org_pr_${randomUUID().slice(0, 8)}`, B = `org_pr_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  const rej = async (fn: () => Promise<any>) => { try { await fn(); return ""; } catch (e: any) { return String(e.message); } };
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

  // 1. parse do silencedetect
  const log = "[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 1.0012 | silence_duration: 1.0012\n[silencedetect @ 0x1] silence_start: 3.0\n[silencedetect @ 0x1] silence_end: 5.0 | silence_duration: 2\n[silencedetect @ 0x1] silence_start: 9.0\n";
  const sil = P.parseSilences(log, 10);
  check("1.1 parse: início, meio e silêncio ABERTO até o fim (usa a duração)", sil.length === 3 && sil[0].startSec === 0 && near(sil[0].endSec, 1.0012, 1e-6) && sil[2].startSec === 9 && sil[2].endSec === 10, JSON.stringify(sil));
  check("1.2 parse: saída sem silêncio / lixo → vazio", P.parseSilences("nada aqui", 10).length === 0 && P.parseSilences("", 10).length === 0);

  // 2. EDL
  const r = P.buildKeepSegments([{ startSec: 0, endSec: 1 }, { startSec: 3, endSec: 5 }, { startSec: 7, endSec: 7.4 }, { startSec: 9, endSec: 10 }], 10);
  check("2.1 trechos mantidos: respiro de 0,15 s junto da fala; bordas cortadas sem respiro", r.keep.length === 2 && near(r.keep[0].startSec, 0.85, 1e-6) && near(r.keep[0].endSec, 3.15, 1e-6) && near(r.keep[1].startSec, 4.85, 1e-6) && near(r.keep[1].endSec, 9.15, 1e-6), JSON.stringify(r.keep));
  check("2.2 silêncio curto (0,4 s < 0,6 s) é preservado", r.keep[1].startSec < 7 && r.keep[1].endSec > 7.4);
  check("2.3 contas: removido 3,4 s em 3 cortes; mantido 6,6 s; outStart acumulado", near(r.removedSec, 3.4, 0.01) && r.removedCount === 3 && near(r.keptSec, 6.6, 0.01) && near(r.keep[1].outStartSec, 2.3, 0.01));
  const none = P.buildKeepSegments([{ startSec: 2, endSec: 2.3 }], 10);
  check("2.4 sem silêncio longo → um trecho só, 0 cortes", none.removedCount === 0 && none.keep.length === 1 && none.keep[0].startSec === 0 && none.keep[0].endSec === 10 && none.removedSec === 0);
  const all = P.buildKeepSegments([{ startSec: 0, endSec: 10 }], 10);
  check("2.5 nunca esvazia o vídeo (tudo silêncio → não corta nada)", all.removedCount === 0 && all.keptSec === 10);
  const many: any[] = []; for (let i = 0; i < 120; i++) many.push({ startSec: 1 + i * 1, endSec: 1 + i * 1 + 0.7 + (i % 5) * 0.05 });
  const capd = P.buildKeepSegments(many, 130);
  check("2.6 limite de cortes (grafo de filtros): no máx. 80, ordenados e sem sobreposição", capd.removedCount === 80 && capd.keep.every((k, i) => k.endSec > k.startSec && (i === 0 || k.startSec >= capd.keep[i - 1].endSec)));
  const wide = P.buildKeepSegments([{ startSec: 3, endSec: 5 }], 10, { noiseDb: -35, minSilenceSec: 0.6, paddingSec: 0.5 });
  check("2.7 padding configurável muda o respiro", near(wide.keep[0].endSec, 3.5, 1e-6) && near(wide.keep[1].startSec, 4.5, 1e-6));

  // 3. remapeamento
  const keep = r.keep;
  check("3.1 remap de instantes: dentro do trecho, no corte (início→próximo trecho, fim→anterior) e fora", P.remapMs(1000, keep, "start") === 150 && P.remapMs(4000, keep, "start") === 2300 && P.remapMs(4000, keep, "end") === 2300 && P.remapMs(5000, keep, "start") === 2450 && P.remapMs(9900, keep, "start") === null && P.remapMs(0, keep, "end") === null);
  const cues = [{ startMs: 1000, endMs: 3000, lines: ["Primeira"] }, { startMs: 5000, endMs: 7000, lines: ["Segunda"] }, { startMs: 7400, endMs: 9000, lines: ["Terceira"] }];
  const rc = P.remapCues(cues, keep);
  check("3.2 cues remapeadas p/ o vídeo cortado (0,15–2,15 · 2,45–4,45 · 4,85–6,45)", rc.length === 3 && rc[0].startMs === 150 && rc[0].endMs === 2150 && rc[1].startMs === 2450 && rc[1].endMs === 4450 && rc[2].startMs === 4850 && rc[2].endMs === 6450, JSON.stringify(rc));
  const inCut = P.remapCues([{ startMs: 3300, endMs: 4700, lines: ["morta"] }, { startMs: 2500, endMs: 4000, lines: ["atravessa"] }], keep);
  check("3.3 cue inteira dentro do corte é descartada; a que atravessa é encurtada, não esticada", !inCut.some((c) => c.lines[0] === "morta") && inCut.find((c) => c.lines[0] === "atravessa")!.endMs === 2300 - 0 && inCut.every((c) => c.endMs > c.startMs));
  check("3.4 monotônico: cues que não se sobrepunham continuam sem sobreposição", rc.every((c, i) => i === 0 || c.startMs >= rc[i - 1].endMs));

  // 4. ffmpeg real
  const mediaDir = path.join(tmpDir, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  const gen = async (name: string, expr: string, dur: number) => (await F.run(["-y", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=15:duration=${dur}`, "-f", "lavfi", "-i", `aevalsrc=${expr}:s=16000:d=${dur}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(mediaDir, name)])).code === 0;
  const talk = "0.3*sin(2*PI*440*t)*(between(t\\,1\\,3)+between(t\\,5\\,7)+between(t\\,7.4\\,9))";
  check("4.0 fixtures: fala–pausa–fala (início e fim silenciosos, uma pausa de 2 s, uma curta de 0,4 s), tom contínuo e vídeo sem áudio",
    (await gen("talk.mp4", talk, 10)) && (await gen("tone.mp4", "0.3*sin(2*PI*440*t)", 6)) && (await F.run(["-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15:duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(mediaDir, "mute.mp4")])).code === 0);

  const det = await F.detectSilence(path.join(mediaDir, "talk.mp4"), { noiseDb: -35, minSilenceSec: 0.6, windowSec: 10 });
  check("4.1 detecção real acha as 3 pausas longas (início, meio, fim) e ignora a de 0,4 s", det.length === 3 && near(det[0].endSec, 1, 0.1) && near(det[1].startSec, 3, 0.1) && near(det[1].endSec, 5, 0.1) && near(det[2].startSec, 9, 0.1) && near(det[2].endSec, 10, 0.1), JSON.stringify(det));
  const detTone = await F.detectSilence(path.join(mediaDir, "tone.mp4"), { noiseDb: -35, minSilenceSec: 0.6, windowSec: 6 });
  check("4.2 tom contínuo (ou música) → nenhuma pausa", detTone.length === 0);
  check("4.3 sem áudio → erro claro", /não tem áudio/.test(await rej(() => P.PauseRemovalService.analyze(path.join(mediaDir, "mute.mp4"), 5))));
  const savedMax = F.limits.maxInputBytes; F.limits.maxInputBytes = 10;
  const tooBig = await F.detectSilence(path.join(mediaDir, "talk.mp4"), { noiseDb: -35, minSilenceSec: 0.6, windowSec: 10 }).then(() => "", (e: any) => e.code); F.limits.maxInputBytes = savedMax;
  check("4.4 detecção respeita as travas de entrada (arquivo grande demais; inexistente)", tooBig === "input_too_large" && (await F.detectSilence(path.join(mediaDir, "nada.mp4"), { noiseDb: -35, minSilenceSec: 0.6, windowSec: 5 }).then(() => "", (e: any) => e.code)) === "input_not_found");

  const creation = (org: string, file: string) => { const id = randomUUID(); db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status, source) VALUES (?, ?, 'video', 'p', ?, 'done', 'uploaded')").run(id, org, `/media/${file}`); return id; };
  const cid = creation(A, "talk.mp4");
  const base = await V.render(A, { creationId: cid, channel: "instagram", topic: "camisa de linho" });
  const cut = await V.render(A, { creationId: cid, channel: "instagram", topic: "camisa de linho", removePauses: true });
  check("5.1 sem o pedido nada muda (0-regressão: sem campo `pauses`, 'remoção de pausas' segue como não aplicada)", base.pauses === undefined && base.notApplied.includes("remoção de pausas") && base.applied.join() === "corte,enquadramento");
  check("5.2 com o pedido: aplicou, informa antes/depois e o que cortou", cut.applied.includes("remoção de pausas") && !cut.notApplied.includes("remoção de pausas") && cut.pauses!.removedCount === 3 && near(cut.pauses!.removedSec, 3.4, 0.05) && near(cut.pauses!.durationBeforeSec, 10, 0.1) && near(cut.pauses!.durationAfterSec, 6.6, 0.05), JSON.stringify(cut.pauses));
  const info = await F.probe(path.join(mediaDir, path.basename(cut.mediaUrl)));
  const infoBase = await F.probe(path.join(mediaDir, path.basename(base.mediaUrl)));
  check("5.3 o arquivo cortado REALMENTE tem a duração esperada (≈6,6 s) e o sem corte ≈10 s", near(info.durationMs / 1000, 6.6, 0.25) && near(infoBase.durationMs / 1000, 10, 0.25) && info.hasAudio && info.hasVideo, `${info.durationMs} / ${infoBase.durationMs}`);
  const after = await F.detectSilence(path.join(mediaDir, path.basename(cut.mediaUrl)), { noiseDb: -35, minSilenceSec: 0.6, windowSec: 7 });
  check("5.4 o áudio resultante não tem mais pausa ≥ 0,6 s (só o respiro de 2×0,15 s no encontro)", after.length === 0, JSON.stringify(after));
  check("5.5 original intacto e temporários limpos; nova criação marcada como editada", fs.existsSync(path.join(mediaDir, "talk.mp4")) && fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("zf-sub-") || n.startsWith("zf-ffmpeg-")).length === 0 && (db.prepare("SELECT source FROM studio_creations WHERE id = ?").get(cut.creationId) as any).source === "edited");

  // alinhamento vídeo×áudio: o quadro logo após a emenda é o do original em 4,85 s+
  const frame = async (file: string, t: number) => { const out = path.join(tmpDir, `f_${randomUUID()}.raw`); const x = await F.run(["-y", "-ss", String(t), "-i", path.join(mediaDir, path.basename(file)), "-frames:v", "1", "-vf", "scale=96:-2", "-f", "rawvideo", "-pix_fmt", "gray", out]); if (x.code !== 0) throw new Error(x.stderr.slice(-200)); const b = fs.readFileSync(out); fs.rmSync(out); return b; };
  const diff = (a: Buffer, b: Buffer) => { let n = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (Math.abs(a[i] - b[i]) > 40) n++; return n / Math.min(a.length, b.length); };
  const fCut = await frame(cut.mediaUrl, 2.9);                     // 2,9 s do cortado = 4,85 + 0,6 = 5,45 s do original
  const dRight = diff(fCut, await frame(base.mediaUrl, 5.45)), dWrong = diff(fCut, await frame(base.mediaUrl, 2.9));
  check("5.6 vídeo alinhado ao corte: o quadro em 2,9 s do cortado = o do original em 5,45 s (e NÃO o de 2,9 s)", dRight < 0.01 && dWrong > 0.04, `${dRight.toFixed(3)} / ${dWrong.toFixed(3)}`);

  // legenda remapeada
  T.provider = new StubSpeechToTextProvider({ text: "Primeira Segunda Terceira", language: "pt", durationSec: 10,
    segments: [{ startMs: 1000, endMs: 3000, text: "Primeira frase aqui." }, { startMs: 5000, endMs: 7000, text: "Segunda frase aqui." }, { startMs: 7400, endMs: 9000, text: "Terceira frase aqui." }], words: [] });
  await T.transcribe(A, "u", cid);
  const subCut = await V.render(A, { creationId: cid, channel: "instagram", topic: "camisa de linho", subtitles: true, removePauses: true });
  const bottom = async (u: string, t: number) => { const out = path.join(tmpDir, `b_${randomUUID()}.raw`); await F.run(["-y", "-ss", String(t), "-i", path.join(mediaDir, path.basename(u)), "-frames:v", "1", "-vf", "crop=iw:ih*0.5:0:ih*0.5", "-f", "rawvideo", "-pix_fmt", "gray", out]); const b = fs.readFileSync(out); fs.rmSync(out); return b; };
  const dd = async (t: number) => diff(await bottom(subCut.mediaUrl, t), await bottom(cut.mediaUrl, t));
  check("5.7 legenda+pausas: aplicou as duas coisas e a duração é a do corte", subCut.applied.join() === "corte,enquadramento,legenda,remoção de pausas" && near(subCut.durationSec, 6.6, 0.05));
  check("5.8 a legenda cai no tempo do vídeo CORTADO: aparece em 1,0 s, 3,5 s e 5,5 s (falas 1·2·3)", (await dd(1.0)) > 0.01 && (await dd(3.5)) > 0.01 && (await dd(5.5)) > 0.01);
  check("5.9 e some nos vãos do vídeo cortado (2,3 s entre as falas 1 e 2; 4,65 s entre 2 e 3)", (await dd(2.3)) < 0.0005 && (await dd(4.65)) < 0.0005, `${(await dd(2.3)).toFixed(5)} / ${(await dd(4.65)).toFixed(5)}`);

  // sem pausas / sem áudio / isolamento
  const cTone = creation(A, "tone.mp4");
  const flat = await V.render(A, { creationId: cTone, channel: "instagram", topic: "x", removePauses: true });
  const flatInfo = await F.probe(path.join(mediaDir, path.basename(flat.mediaUrl)));
  check("5.10 sem pausas claras → render normal, 0 cortes, dito ao cliente; não finge ter aplicado", flat.pauses!.removedCount === 0 && !flat.applied.includes("remoção de pausas") && /Não encontrei pausas claras/.test(flat.note) && near(flatInfo.durationMs / 1000, 6, 0.25));
  check("5.11 vídeo sem áudio → mensagem clara", /não tem áudio/.test(await rej(() => V.render(A, { creationId: creation(A, "mute.mp4"), channel: "instagram", topic: "x", removePauses: true }))));
  check("5.12 isolamento: outra empresa não edita o vídeo", /não encontrado/.test(await rej(() => V.render(B, { creationId: cid, channel: "instagram", topic: "x", removePauses: true }))));

  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
