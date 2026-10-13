/**
 * FfmpegService — ÚNICO ponto de execução do ffmpeg (ADR-207 F13b). Ninguém mais faz `spawn("ffmpeg")`.
 *
 * Binário: pacote `ffmpeg-static` (optionalDependency — se o download do binário falhar no build, a instalação NÃO falha;
 * o app sobe sem processamento de vídeo e `available()` diz isso). `FFMPEG_PATH` sobrepõe (binário do sistema).
 *
 * Segurança/robustez: `spawn` com ARRAY de argumentos (nunca string de shell → sem injeção/escape de espaços); timeout
 * com kill do processo; limites de tamanho de entrada/saída e de jobs simultâneos (semáforo — um processo só, sem 2ª fila);
 * trabalho em pasta temporária por job, SEMPRE removida; entrada nunca é alterada; saída só é entregue se existir e couber
 * no limite. Erros viram códigos controlados (`ffmpeg_unavailable`, `input_not_found`, `input_too_large`, `timeout`,
 * `ffmpeg_failed`, `output_too_large`, `busy`) — o chamador traduz para linguagem de cliente. Log sem conteúdo do arquivo.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type FfmpegErrorCode = "invalid_media" | "ffmpeg_unavailable" | "input_not_found" | "input_too_large" | "timeout" | "ffmpeg_failed" | "output_too_large" | "busy";
export class FfmpegError extends Error {
  constructor(public code: FfmpegErrorCode, message?: string) { super(message || code); this.name = "FfmpegError"; }
}

export interface FfmpegLimits { maxInputBytes: number; maxOutputBytes: number; timeoutMs: number; maxConcurrentJobs: number }
const DEFAULT_LIMITS: FfmpegLimits = {
  maxInputBytes: Number(process.env.FFMPEG_MAX_INPUT_BYTES) || 200 * 1024 * 1024,
  maxOutputBytes: Number(process.env.FFMPEG_MAX_OUTPUT_BYTES) || 200 * 1024 * 1024,
  timeoutMs: Number(process.env.FFMPEG_TIMEOUT_MS) || 120_000,
  maxConcurrentJobs: Number(process.env.FFMPEG_MAX_CONCURRENT) || 2,
};

export interface MediaInfo { durationMs: number; width: number | null; height: number | null; videoCodec: string | null; audioCodec: string | null; hasVideo: boolean; hasAudio: boolean; fps: number | null }

/** Lê a saída de `ffmpeg -i` (stderr). Pura — testável sem ffmpeg. Sem stream de vídeo → hasVideo=false (nunca inventa). */
export function parseMediaInfo(stderr: string): MediaInfo {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const durationMs = d ? Math.round(((+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3])) * 1000) : 0;
  const v = /Stream #\d+:\d+[^\n]*?: Video: ([a-z0-9_]+)[^\n]*/i.exec(stderr);
  const a = /Stream #\d+:\d+[^\n]*?: Audio: ([a-z0-9_]+)/i.exec(stderr);
  const dim = v ? /,\s*(\d{2,5})x(\d{2,5})/.exec(v[0]) : null;
  const fps = v ? /(\d+(?:\.\d+)?)\s*fps/.exec(v[0]) : null;
  return {
    durationMs, hasVideo: !!v, hasAudio: !!a, videoCodec: v ? v[1].toLowerCase() : null, audioCodec: a ? a[1].toLowerCase() : null,
    width: dim ? +dim[1] : null, height: dim ? +dim[2] : null, fps: fps ? parseFloat(fps[1]) : null,
  };
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export interface JobLog { jobId: string; organizationId: string | null; operation: string; inputBytes: number; outputBytes: number | null; elapsedMs: number; ok: boolean; errorCode?: string }

// import() dinâmico (e não require/import.meta): o build do servidor é CJS via esbuild e o pacote é opcional.
async function resolveBinary(): Promise<string | null> {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const m: any = await import("ffmpeg-static");
    const p = m?.default ?? m;
    return typeof p === "string" && p ? p : null;
  } catch { return null; }
}

export class FfmpegService {
  static limits: FfmpegLimits = { ...DEFAULT_LIMITS };
  static logger: (l: JobLog) => void = (l) => { try { console.log(`[ffmpeg] ${JSON.stringify(l)}`); } catch { /* noop */ } };
  private static active = 0;
  private static avail: { available: boolean; reason?: string; version?: string } | null = null;

  private static bin: string | null | undefined;
  /** Resolve o binário de forma centralizada (null = indisponível). Cacheado. */
  static async binary(): Promise<string | null> {
    if (this.bin === undefined) this.bin = await resolveBinary();
    return this.bin;
  }

  /** Capability check: existe, executa e responde `-version` com sucesso. Cacheado. */
  static async available(force = false): Promise<{ available: boolean; reason?: string; version?: string }> {
    if (this.avail && !force) return this.avail;
    const bin = await this.binary();
    if (!bin) return (this.avail = { available: false, reason: "ffmpeg_unavailable" });
    try {
      const r = await this.run(["-version"], { timeoutMs: 5000 });
      if (r.code !== 0) return (this.avail = { available: false, reason: "ffmpeg_unavailable" });
      return (this.avail = { available: true, version: (r.stdout.split("\n")[0] || "").slice(0, 80) });
    } catch { return (this.avail = { available: false, reason: "ffmpeg_unavailable" }); }
  }
  private static filters: Set<string> | null = null;
  /** O binário tem este filtro (ex.: `ass`, que exige libass)? Descoberto via `-filters`, cacheado. Binário indisponível → false. */
  static async hasFilter(name: string): Promise<boolean> {
    if (!(await this.available()).available) return false;
    if (!this.filters) {
      try {
        const r = await this.run(["-hide_banner", "-filters"], { timeoutMs: 10_000 });
        this.filters = new Set(r.stdout.split("\n").map((l) => (/^\s*[A-Z.]{3}\s+(\S+)\s/.exec(l) || [])[1]).filter(Boolean) as string[]);
      } catch { this.filters = new Set(); }
    }
    return this.filters.has(name);
  }
  static resetCache(): void { this.avail = null; this.bin = undefined; this.filters = null; }

  /** Executa o ffmpeg com argumentos em array (sem shell) e timeout. Não lança em exit ≠ 0 — devolve o resultado. */
  static async run(args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<RunResult> {
    const bin = await this.binary();
    if (!bin) throw new FfmpegError("ffmpeg_unavailable");
    const timeoutMs = opts.timeoutMs ?? this.limits.timeoutMs;
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, cwd: opts.cwd }); }
      catch { return reject(new FfmpegError("ffmpeg_unavailable")); }
      let stdout = "", stderr = "", timedOut = false, done = false;
      const cap = (s: string, chunk: Buffer) => (s.length > 64 * 1024 ? s : s + chunk.toString());
      child.stdout.on("data", (c: Buffer) => { stdout = cap(stdout, c); });
      child.stderr.on("data", (c: Buffer) => { stderr = cap(stderr, c); });
      const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* noop */ } }, timeoutMs);
      child.on("error", () => { if (done) return; done = true; clearTimeout(timer); reject(new FfmpegError("ffmpeg_unavailable")); });
      child.on("close", (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    });
  }

  /**
   * Job de mídia: copia a entrada para tmp/<job>/input, roda o ffmpeg com `buildArgs(input, output)`, valida a saída e
   * ENTREGA o arquivo em `finalOutPath`. A pasta temporária é sempre removida. Lança `FfmpegError` com código controlado.
   */
  static async process(opts: { orgId?: string | null; operation: string; inputPath: string; finalOutPath: string; outExt: string; buildArgs: (input: string, output: string) => string[]; workFiles?: Record<string, string> }): Promise<{ outputBytes: number; elapsedMs: number }> {
    const jobId = randomUUID();
    const t0 = Date.now();
    let inputBytes = 0, outputBytes: number | null = null;
    const log = (ok: boolean, errorCode?: string) => this.logger({ jobId, organizationId: opts.orgId ?? null, operation: opts.operation, inputBytes, outputBytes, elapsedMs: Date.now() - t0, ok, errorCode });
    let tmp: string | null = null;
    let slot = false;
    try {
      const av = await this.available();
      if (!av.available) throw new FfmpegError("ffmpeg_unavailable");
      let st: fs.Stats;
      try { st = fs.statSync(opts.inputPath); if (!st.isFile()) throw new Error("x"); } catch { throw new FfmpegError("input_not_found"); }
      inputBytes = st.size;
      if (inputBytes > this.limits.maxInputBytes) throw new FfmpegError("input_too_large");
      if (this.active >= this.limits.maxConcurrentJobs) throw new FfmpegError("busy");
      this.active++; slot = true;

      tmp = fs.mkdtempSync(path.join(os.tmpdir(), `zf-ffmpeg-${jobId.slice(0, 8)}-`));
      const input = path.join(tmp, "input");
      const output = path.join(tmp, `output.${opts.outExt}`);
      fs.copyFileSync(opts.inputPath, input);
      // Arquivos auxiliares (ex.: legenda .ass, pasta de fontes) são copiados p/ a pasta do job e o ffmpeg roda NELA:
      // o filtro usa só nomes relativos simples (sem escapar caminhos do servidor/usuário dentro da expressão do filtro).
      for (const [name, srcPath] of Object.entries(opts.workFiles || {})) {
        if (!/^[a-z0-9_.-]+$/i.test(name)) throw new FfmpegError("ffmpeg_failed");
        const dst = path.join(tmp, name);
        if (fs.statSync(srcPath).isDirectory()) fs.cpSync(srcPath, dst, { recursive: true }); else fs.copyFileSync(srcPath, dst);
      }
      const r = await this.run(opts.buildArgs(input, output), { cwd: tmp });
      if (r.timedOut) throw new FfmpegError("timeout");
      if (r.code !== 0) throw new FfmpegError("ffmpeg_failed");
      let os_: fs.Stats;
      try { os_ = fs.statSync(output); } catch { throw new FfmpegError("ffmpeg_failed"); }
      outputBytes = os_.size;
      if (outputBytes <= 0) throw new FfmpegError("ffmpeg_failed");
      if (outputBytes > this.limits.maxOutputBytes) throw new FfmpegError("output_too_large");
      fs.mkdirSync(path.dirname(opts.finalOutPath), { recursive: true });
      fs.copyFileSync(output, opts.finalOutPath);
      log(true);
      return { outputBytes, elapsedMs: Date.now() - t0 };
    } catch (e: any) {
      const code = e instanceof FfmpegError ? e.code : "ffmpeg_failed";
      log(false, code);
      throw e instanceof FfmpegError ? e : new FfmpegError("ffmpeg_failed");
    } finally {
      if (slot) this.active--;
      if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } }
    }
  }

  /** Metadados REAIS do arquivo (não confia em extensão/MIME). Arquivo ilegível → `invalid_media`. */
  static async probe(inputPath: string): Promise<MediaInfo> {
    const av = await this.available();
    if (!av.available) throw new FfmpegError("ffmpeg_unavailable");
    let st: fs.Stats;
    try { st = fs.statSync(inputPath); if (!st.isFile()) throw new Error("x"); } catch { throw new FfmpegError("input_not_found"); }
    const r = await this.run(["-hide_banner", "-i", inputPath], { timeoutMs: 15_000 });
    if (r.timedOut) throw new FfmpegError("timeout");
    const info = parseMediaInfo(r.stderr);
    if (!info.hasVideo && !info.hasAudio) throw new FfmpegError("invalid_media");
    return info;
  }

  // ── Operações (argumentos centralizados) ──
  static thumbnail(orgId: string | null, inputPath: string, finalOutPath: string, atSec = 1) {
    return this.process({ orgId, operation: "thumbnail", inputPath, finalOutPath, outExt: "jpg", buildArgs: (i, o) => ["-y", "-ss", String(Math.max(0, atSec)), "-i", i, "-frames:v", "1", "-q:v", "3", o] });
  }
  /** Extrai o áudio em WAV mono 16 kHz (entrada padrão de speech-to-text). Vídeo sem áudio → `ffmpeg_failed` (use `probe` antes). */
  static extractAudio(orgId: string | null, inputPath: string, finalOutPath: string) {
    return this.process({ orgId, operation: "extract_audio", inputPath, finalOutPath, outExt: "wav", buildArgs: (i, o) => ["-y", "-i", i, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", o] });
  }
  /**
   * Detecta silêncios do áudio na janela [0, windowSec] (filtro `silencedetect`). Só leitura: não gera arquivo.
   * Mesmas travas de entrada do `process` (existência, tamanho, concorrência, timeout).
   */
  static async detectSilence(inputPath: string, p: { noiseDb: number; minSilenceSec: number; windowSec: number }): Promise<{ startSec: number; endSec: number }[]> {
    const av = await this.available();
    if (!av.available) throw new FfmpegError("ffmpeg_unavailable");
    let st: fs.Stats;
    try { st = fs.statSync(inputPath); if (!st.isFile()) throw new Error("x"); } catch { throw new FfmpegError("input_not_found"); }
    if (st.size > this.limits.maxInputBytes) throw new FfmpegError("input_too_large");
    if (this.active >= this.limits.maxConcurrentJobs) throw new FfmpegError("busy");
    const { parseSilences } = await import("./PauseRemovalService.js");
    this.active++;
    try {
      const noise = Math.min(-10, Math.max(-80, Number(p.noiseDb) || -35)), dur = Math.min(10, Math.max(0.1, Number(p.minSilenceSec) || 0.6));
      const win = Math.max(0.1, Number(p.windowSec) || 0.1);
      const r = await this.run(["-hide_banner", "-nostats", "-t", String(win), "-i", inputPath, "-vn", "-af", `silencedetect=noise=${noise}dB:d=${dur}`, "-f", "null", "-"]);
      if (r.timedOut) throw new FfmpegError("timeout");
      if (r.code !== 0) throw new FfmpegError("ffmpeg_failed");
      return parseSilences(r.stderr, win);
    } finally { this.active--; }
  }
  /**
   * Corta e enquadra (crop central) na proporção `aspect`; H.264/AAC. Sem `keep`: trecho [startSec, startSec+durationSec].
   * Com `keep` (remoção de pausas): concatena SÓ os trechos mantidos (tempos absolutos do original) e depois enquadra/legenda.
   */
  static trimReframe(orgId: string | null, inputPath: string, finalOutPath: string, p: { startSec: number; durationSec: number; aspect: "9:16" | "1:1" | "16:9"; subtitles?: { assPath: string; fontsDir: string }; keep?: { startSec: number; endSec: number }[] }) {
    const [w, h] = p.aspect.split(":").map(Number);
    // crop central pela proporção pedida (dimensões pares), sem esticar. Legenda DEPOIS do enquadramento (queimada no quadro final).
    let vf = `crop='min(iw,ih*${w}/${h})':'min(ih,iw*${h}/${w})',scale=trunc(iw/2)*2:trunc(ih/2)*2`;
    if (p.subtitles) vf += `,ass=filename=sub.ass:fontsdir=fonts`;
    const workFiles = p.subtitles ? { "sub.ass": p.subtitles.assPath, fonts: p.subtitles.fontsDir } : undefined;
    const operation = (p.keep ? "cut_pauses_" : "") + (p.subtitles ? "trim_reframe_subtitles" : "trim_reframe");
    const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-c:a", "aac", "-movflags", "+faststart"];
    if (p.keep && p.keep.length) {
      const n = (x: number) => (Math.round(Math.max(0, Number(x)) * 1000) / 1000).toFixed(3);   // só números entram no grafo de filtros
      const parts = p.keep.map((k, i) => `[0:v]trim=start=${n(k.startSec)}:end=${n(k.endSec)},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=start=${n(k.startSec)}:end=${n(k.endSec)},asetpts=PTS-STARTPTS[a${i}]`);
      const join = p.keep.map((_, i) => `[v${i}][a${i}]`).join("");
      const graph = `${parts.join(";")};${join}concat=n=${p.keep.length}:v=1:a=1[cv][ca];[cv]${vf}[vout]`;
      return this.process({ orgId, operation, inputPath, finalOutPath, outExt: "mp4", workFiles, buildArgs: (i, o) => ["-y", "-i", i, "-filter_complex", graph, "-map", "[vout]", "-map", "[ca]", ...enc, o] });
    }
    return this.process({ orgId, operation, inputPath, finalOutPath, outExt: "mp4", workFiles, buildArgs: (i, o) => ["-y", "-ss", String(Math.max(0, p.startSec)), "-i", i, "-t", String(Math.max(1, p.durationSec)), "-vf", vf, ...enc, o] });
  }
}

export default FfmpegService;
