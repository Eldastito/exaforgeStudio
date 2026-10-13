/**
 * Smoke test de VÍDEO para o operador (ADR-207 F13b.10). Roda no ambiente REAL (imagem de produção, sem tsx):
 *   docker exec <container> node dist/video-smoke.cjs        (ou: npm run smoke:video, em dev)
 *   --json  → saída em JSON.
 * Usa os MESMOS serviços do app (FfmpegService, legenda, pausas) — se isto passa, o app consegue editar vídeo aí.
 * Gera um clipe sintético (nada do cliente é lido nem alterado), trabalha numa pasta temporária e a remove.
 * Saída 0 = tudo certo · 2 = ffmpeg ok, mas falta legenda/título (libass ou fonte) · 1 = ffmpeg indisponível ou quebrado.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { FfmpegService as F } from "../src/server/FfmpegService.js";
import { VideoSubtitleService, toAss, buildCues, fontsDir, FONT_FILE } from "../src/server/VideoSubtitleService.js";
import { PauseRemovalService } from "../src/server/PauseRemovalService.js";

interface Step { name: string; critical: boolean; ok: boolean; ms: number; detail: string }
const steps: Step[] = [];
async function step(name: string, critical: boolean, fn: () => Promise<string>): Promise<boolean> {
  const t0 = Date.now();
  try { const detail = await fn(); steps.push({ name, critical, ok: true, ms: Date.now() - t0, detail }); return true; }
  catch (e: any) { steps.push({ name, critical, ok: false, ms: Date.now() - t0, detail: String(e?.code || e?.message || e).slice(0, 200) }); return false; }
}

async function main() {
  F.logger = () => {};   // o smoke tem relatório próprio; sem o JSON de log por operação
  const json = process.argv.includes("--json");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "zf-smoke-"));
  const clip = path.join(work, "clip.mp4");
  let ffmpegOk = false;
  try {
    ffmpegOk = await step("ffmpeg disponível", true, async () => {
      const s = await F.source(); const av = await F.available(true);
      if (!av.available) {
        const why = s.source === "env" ? `FFMPEG_PATH aponta para "${s.path}", que não executa` : s.source === "none" ? "nem FFMPEG_PATH nem o pacote ffmpeg-static (o download no build pode ter falhado)" : "o binário do ffmpeg-static não executa";
        throw new Error(why);
      }
      return `${av.version} · origem: ${s.source === "env" ? "FFMPEG_PATH" : "ffmpeg-static"} (${s.path})`;
    });
    if (ffmpegOk) {
      await step("filtros usados pelo app", true, async () => {
        const need = ["crop", "scale", "trim", "atrim", "concat", "silencedetect"]; const miss: string[] = [];
        for (const f of need) if (!(await F.hasFilter(f))) miss.push(f);
        if (miss.length) throw new Error("faltam: " + miss.join(", "));
        return need.join(", ");
      });
      await step("gerar clipe de teste (6 s com uma pausa)", true, async () => {
        const r = await F.run(["-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15:duration=6", "-f", "lavfi", "-i", "aevalsrc=0.3*sin(2*PI*440*t)*(between(t\\,0\\,2)+between(t\\,4\\,6)):s=16000:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
        if (r.code !== 0 || !fs.existsSync(clip)) throw new Error("encoder h264/aac indisponível: " + r.stderr.slice(-120).replace(/\s+/g, " "));
        return `${fs.statSync(clip).size} bytes`;
      });
      await step("ler metadados do vídeo", true, async () => {
        const i = await F.probe(clip);
        if (!i.hasVideo || !i.hasAudio) throw new Error("sem vídeo/áudio");
        return `${i.width}x${i.height} · ${(i.durationMs / 1000).toFixed(1)} s · ${i.videoCodec}/${i.audioCodec}`;
      });
      await step("cortar e enquadrar 9:16", true, async () => {
        const out = path.join(work, "reframe.mp4");
        const r = await F.trimReframe("smoke", clip, out, { startSec: 0, durationSec: 5, aspect: "9:16" });
        const i = await F.probe(out);
        if (!i.width || !i.height || Math.abs(i.width / i.height - 9 / 16) > 0.02) throw new Error(`proporção errada ${i.width}x${i.height}`);
        return `${i.width}x${i.height} em ${r.elapsedMs} ms`;
      });
      await step("detectar pausas", true, async () => {
        const s = await F.detectSilence(clip, { noiseDb: -35, minSilenceSec: 0.6, windowSec: 6 });
        if (s.length !== 1 || Math.abs(s[0].startSec - 2) > 0.2 || Math.abs(s[0].endSec - 4) > 0.2) throw new Error("esperava 1 pausa de 2 a 4 s, achou " + JSON.stringify(s));
        return "pausa de 2 s achada";
      });
      await step("cortar pausas (trim + concat)", true, async () => {
        const out = path.join(work, "nopause.mp4");
        const plan = await PauseRemovalService.analyze(clip, 6);
        if (!plan.removedCount) throw new Error("não achou pausa para cortar");
        await F.trimReframe("smoke", clip, out, { startSec: 0, durationSec: 6, aspect: "1:1", keep: plan.keep });
        const i = await F.probe(out);
        if (Math.abs(i.durationMs / 1000 - plan.keptSec) > 0.4) throw new Error(`duração ${i.durationMs / 1000} s, esperava ≈${plan.keptSec} s`);
        return `${plan.removedSec.toFixed(1)} s removidos → ${(i.durationMs / 1000).toFixed(1)} s`;
      });
      await step("miniatura", false, async () => {
        const out = path.join(work, "thumb.jpg"); await F.thumbnail("smoke", clip, out, 1);
        return `${fs.statSync(out).size} bytes`;
      });
      await step("legenda, título e CTA (libass + fonte empacotada)", false, async () => {
        const fd = fontsDir();
        if (!fs.existsSync(path.join(fd, FONT_FILE))) throw new Error(`fonte ${FONT_FILE} ausente em ${fd} (a pasta assets/ foi para a imagem? o app roda em /app?)`);
        if (!(await F.hasFilter("ass"))) throw new Error("este ffmpeg não tem o filtro de legenda (libass)");
        if (!(await VideoSubtitleService.available())) throw new Error("capacidade de legenda indisponível");
        const ass = path.join(work, "t.ass");
        fs.writeFileSync(ass, toAss(buildCues([{ startMs: 500, endMs: 1800, text: "Teste de legenda ção" }], { aspect: "9:16" }), { aspect: "9:16", overlays: [{ startMs: 0, endMs: 1500, kind: "title", lines: ["Título"] }, { startMs: 4000, endMs: 6000, kind: "cta", lines: ["Chame agora"] }] }));
        const out = path.join(work, "sub.mp4");
        await F.trimReframe("smoke", clip, out, { startSec: 0, durationSec: 6, aspect: "9:16", subtitles: { assPath: ass, fontsDir: fd } });
        const i = await F.probe(out);
        if (!i.hasVideo) throw new Error("saída sem vídeo");
        return `queimado em ${i.width}x${i.height}`;
      });
    }
    await step("pasta de mídia gravável (DATA_DIR)", true, async () => {
      const dir = path.join(process.env.DATA_DIR || process.cwd(), "media"); fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `.smoke-${randomUUID()}`); fs.writeFileSync(f, "ok"); fs.rmSync(f);
      return dir;
    });
  } finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* noop */ } }

  const critFail = steps.some((s) => s.critical && !s.ok);
  const softFail = steps.some((s) => !s.critical && !s.ok);
  const code = !ffmpegOk || critFail ? 1 : softFail ? 2 : 0;
  const verdict = code === 0 ? "TUDO CERTO — o app consegue editar vídeo aqui." : code === 2 ? "PARCIAL — corte e pausas funcionam, mas uma parte opcional (legenda/título/CTA ou miniatura) não." : "FALHOU — a edição de vídeo NÃO vai funcionar neste ambiente.";
  if (json) console.log(JSON.stringify({ code, verdict, steps }, null, 2));
  else {
    for (const s of steps) console.log(`${s.ok ? "✅" : s.critical ? "❌" : "⚠️ "} ${s.name} (${s.ms} ms) — ${s.detail}`);
    console.log(`\n${verdict}`);
  }
  process.exit(code);
}
main().catch((e) => { console.error("smoke quebrou:", e); process.exit(1); });
