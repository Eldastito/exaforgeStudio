/**
 * TESTE — FfmpegService (ADR-207 F13b): ponto único do ffmpeg, binário empacotado (`ffmpeg-static`).
 * Prova: binário localizado e `-version` exit 0; capability check; indisponível sem quebrar (FFMPEG_PATH inválido);
 * erro controlado p/ arquivo inexistente; nome com espaços; argumentos NÃO passam por shell (metacaracteres inertes);
 * timeout mata o processo; pasta temporária sempre removida; limites (entrada/saída/concorrência); log sem conteúdo;
 * operações reais: MP4 → thumbnail JPG, corte + enquadramento (9:16) com dimensões e duração conferidas.
 * Uso: npm run test:ffmpeg-service
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ffsvc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production";
let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { FfmpegService: F, FfmpegError } = await import("../src/server/FfmpegService.js");
  const err = async (fn: () => Promise<any>) => { try { await fn(); return ""; } catch (e: any) { return e instanceof FfmpegError ? e.code : "other:" + e.message; } };
  const tmpLeft = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("zf-ffmpeg-")).length;
  const logs: any[] = []; F.logger = (l) => logs.push(l);

  // 1. binário e capability
  const bin = await F.binary();
  check("1.1 binário empacotado localizado", !!bin && fs.existsSync(bin as string));
  const r0 = await F.run(["-version"]);
  check("1.2 -version executa com exit code 0", r0.code === 0 && /ffmpeg version/.test(r0.stdout) && !r0.timedOut);
  const av = await F.available();
  check("1.3 capability check: disponível, com versão", av.available === true && /ffmpeg version/.test(av.version || ""));

  // 2. fixture: vídeo minúsculo gerado (320x240, 3s, com áudio) — nome com espaços
  const dir = path.join(tmpDir, "media dir com espaço"); fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, "vídeo bruto.mp4");
  const gen = await F.run(["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
  check("2.1 fixture gerada (nome com acento e espaços)", gen.code === 0 && fs.statSync(src).size > 0);
  const info = async (f: string) => { const r = await F.run(["-i", f]); const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(r.stderr); const d = /Video:[^\n]*?(\d{2,5})x(\d{2,5})/.exec(r.stderr); return { dur: m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0, w: d ? +d[1] : 0, h: d ? +d[2] : 0 }; };

  // 3. operações reais
  const thumb = path.join(tmpDir, "out dir", "capa.jpg");
  const tr = await F.thumbnail("org-1", src, thumb, 1);
  const jb = fs.readFileSync(thumb);
  check("3.1 MP4 → thumbnail JPG (assinatura JPEG, tamanho > 0)", tr.outputBytes === jb.length && jb[0] === 0xff && jb[1] === 0xd8);
  const out916 = path.join(tmpDir, "out dir", "reels.mp4");
  await F.trimReframe("org-1", src, out916, { startSec: 0, durationSec: 2, aspect: "9:16" });
  const i916 = await info(out916);
  check("3.2 corte + enquadramento 9:16: duração ~2s e proporção 9:16 (sem esticar)", Math.abs(i916.dur - 2) < 0.5 && i916.w > 0 && Math.abs(i916.w / i916.h - 9 / 16) < 0.03, JSON.stringify(i916));
  const out11 = path.join(tmpDir, "out dir", "quad.mp4");
  await F.trimReframe("org-1", src, out11, { startSec: 1, durationSec: 1, aspect: "1:1" });
  const i11 = await info(out11);
  check("3.3 enquadramento 1:1 com início deslocado", Math.abs(i11.w - i11.h) <= 1 && i11.dur > 0.5 && i11.dur < 1.6, JSON.stringify(i11));
  check("3.4 a entrada nunca é alterada", fs.statSync(src).size > 0 && (await info(src)).dur > 2.5);

  // 4. erros controlados
  check("4.1 arquivo inexistente → input_not_found", (await err(() => F.thumbnail("o", path.join(tmpDir, "nada.mp4"), path.join(tmpDir, "x.jpg")))) === "input_not_found");
  const junk = path.join(dir, "lixo.mp4"); fs.writeFileSync(junk, "isto não é um vídeo");
  check("4.2 arquivo corrompido → ffmpeg_failed (sem vazar stderr)", (await err(() => F.thumbnail("o", junk, path.join(tmpDir, "x.jpg")))) === "ffmpeg_failed");
  check("4.3 nenhuma pasta temporária sobrou após sucesso e falhas", tmpLeft() === 0, String(tmpLeft()));
  const lim0 = { ...F.limits };
  F.limits = { ...lim0, maxInputBytes: 10 };
  check("4.4 entrada acima do limite → input_too_large", (await err(() => F.thumbnail("o", src, path.join(tmpDir, "x.jpg")))) === "input_too_large");
  F.limits = { ...lim0, maxOutputBytes: 10 };
  check("4.5 saída acima do limite → output_too_large (e não entregue)", (await err(() => F.thumbnail("o", src, path.join(tmpDir, "grande.jpg")))) === "output_too_large" && !fs.existsSync(path.join(tmpDir, "grande.jpg")));
  F.limits = { ...lim0 };

  // 5. shell/injeção, timeout, concorrência
  const mk = `zf_pwned_${process.pid}`; const marker = path.join(process.cwd(), mk);
  const evil = path.join(dir, `a; touch ${mk}; $(touch ${mk}) \`touch ${mk}\` b.mp4`); fs.copyFileSync(src, evil);
  await F.thumbnail("o", evil, path.join(tmpDir, "inj.jpg"), 0);
  check("5.1 metacaracteres de shell no nome são inertes (nada executado)", !fs.existsSync(marker) && !fs.existsSync(path.join(dir, mk)) && fs.existsSync(path.join(tmpDir, "inj.jpg")));
  const t0 = Date.now();
  const slow = await F.run(["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=600", "-f", "null", "-"], { timeoutMs: 700 });
  check("5.2 timeout mata o processo", slow.timedOut === true && Date.now() - t0 < 5000);
  F.limits = { ...lim0, timeoutMs: 1 };
  check("5.3 timeout dentro de um job → 'timeout', e tmp limpo", (await err(() => F.trimReframe("o", src, path.join(tmpDir, "t.mp4"), { startSec: 0, durationSec: 2, aspect: "9:16" }))) === "timeout" && tmpLeft() === 0);
  F.limits = { ...lim0, maxConcurrentJobs: 1 };
  const [a, b] = await Promise.all([err(() => F.thumbnail("o", src, path.join(tmpDir, "c1.jpg"))), err(() => F.thumbnail("o", src, path.join(tmpDir, "c2.jpg")))]);
  check("5.4 concorrência limitada: o 2º simultâneo recebe 'busy'", [a, b].sort().join() === ",busy", `${a}|${b}`);
  F.limits = { ...lim0 };
  check("5.5 depois que libera, volta a aceitar", (await err(() => F.thumbnail("o", src, path.join(tmpDir, "c3.jpg")))) === "");

  // 6. log
  const okLog = logs.find((l) => l.operation === "thumbnail" && l.ok);
  check("6.1 log estruturado sem conteúdo do arquivo", !!okLog && okLog.organizationId === "org-1" && okLog.inputBytes > 0 && okLog.outputBytes > 0 && typeof okLog.elapsedMs === "number" && !JSON.stringify(okLog).includes("vídeo bruto") && logs.some((l) => !l.ok && l.errorCode === "input_not_found"));

  // 7. indisponível não quebra
  process.env.FFMPEG_PATH = "/nonexistent/ffmpeg"; F.resetCache();
  const avN = await F.available();
  check("7.1 binário inválido → available:false, reason ffmpeg_unavailable (sem lançar)", avN.available === false && avN.reason === "ffmpeg_unavailable");
  check("7.2 operações devolvem 'ffmpeg_unavailable' controlado", (await err(() => F.thumbnail("o", src, path.join(tmpDir, "z.jpg")))) === "ffmpeg_unavailable" && tmpLeft() === 0);
  delete process.env.FFMPEG_PATH; F.resetCache();
  check("7.3 restaurado: volta a funcionar", (await F.available()).available === true);

  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
