/**
 * TESTE — Transcrição de vídeo com tempo (ADR-207 F13b.4). ffmpeg real; provider de fala SIMULADO (sem rede).
 * Prova: o áudio extraído é WAV mono 16 kHz e o temporário é sempre apagado; texto+tempos normalizados e gravados à parte;
 * sem áudio / sem fala / provider fora / falha → mensagem de cliente e NADA gravado; 1 por criação (cache sem 2º custo),
 * `force` refaz e descarta edições; clique duplo = 1 só chamada; teto diário; edição de texto preserva tempos e original;
 * isolamento entre empresas; custo no ledger por minuto atribuído à org/`video:<id>`; rotas.
 * Uso: npm run test:video-transcription
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vtr-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-vtr-1234567890";
process.env.VIDEO_TRANSCRIBE_MAX_PER_DAY = "6";
let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const studio = (await import("../src/server/routes/studio.js")).default;
  const { FfmpegService: F } = await import("../src/server/FfmpegService.js");
  const { VideoTranscriptionService: T, TranscriptionError, normalizeSegments } = await import("../src/server/VideoTranscriptionService.js");
  const { StubSpeechToTextProvider, OpenAiWhisperProvider } = await import("../src/server/SpeechToTextProvider.js");
  const llm = await import("../src/server/llm.js");
  const { usageContext } = await import("../src/server/usageContext.js");
  const A = `org_vt_${randomUUID().slice(0, 8)}`, B = `org_vt_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  const mediaDir = path.join(tmpDir, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("zf-stt-") || n.startsWith("zf-ffmpeg-")).length;
  const mk = async (name: string, withAudio: boolean) => {
    const args = ["-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=4"]; if (withAudio) args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:a", "aac");
    const r = await F.run([...args, "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(mediaDir, name)]); if (r.code !== 0) throw new Error("fixture"); return `/media/${name}`;
  };
  const withAudio = await mk("studio_a.mp4", true), noAudio = await mk("studio_n.mp4", false);
  const creation = (org: string, url: string | null, kind = "video", status = "done") => { const id = randomUUID(); db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status, source) VALUES (?, ?, ?, 'p', ?, ?, 'uploaded')").run(id, org, kind, url, status); return id; };
  const rej = async (fn: () => Promise<any>) => { try { await fn(); return ""; } catch (e: any) { return e instanceof TranscriptionError ? e.message : "other:" + e.message; } };
  const MSG = (c: string) => new TranscriptionError(c).message;

  let calls = 0; let seenWav = ""; let seenInfo = "";
  const speech = { text: "Olá, esse é um teste. Vamos ver a coleção.", language: "pt", durationSec: 4,
    segments: [{ startMs: 1600, endMs: 3000, text: "Vamos ver a coleção." }, { startMs: 0, endMs: 1500, text: "Olá, esse é um teste." }, { startMs: 3500, endMs: 3400, text: "invertida" }, { startMs: 3600, endMs: 9000, text: "  passou do fim  " }, { startMs: 100, endMs: 200, text: "   " }], words: [] };
  T.provider = new StubSpeechToTextProvider(async (i) => {
    calls++; seenWav = i.mediaPath; const r = await F.run(["-i", i.mediaPath]); seenInfo = r.stderr + (fs.statSync(i.mediaPath).size > 0 ? " [nonempty]" : "");
    return speech as any;
  });

  // 1. fluxo feliz
  const c1 = creation(A, withAudio);
  const t1 = await T.transcribe(A, "u1", c1);
  check("1.1 áudio extraído é WAV mono 16 kHz e o provider recebe o arquivo", /16000 Hz, mono/.test(seenInfo) && seenWav.endsWith(".wav") && /nonempty/.test(seenInfo), seenInfo.slice(0, 200));
  check("1.2 temporário apagado depois", !fs.existsSync(seenWav) && leftovers() === 0, String(leftovers()));
  check("1.3 segmentos ordenados, vazios/invertidos descartados, fim clampado ao áudio", t1.segments.length === 3 && t1.segments[0].text === "Olá, esse é um teste." && t1.segments.every((s, i, a) => s.endMs > s.startMs && (i === 0 || s.startMs >= a[i - 1].startMs)) && t1.segments[2].endMs <= 4500 && t1.segments[2].text === "passou do fim", JSON.stringify(t1.segments));
  check("1.4 gravado à parte: texto, idioma, provider, fala detectada", t1.language === "pt" && t1.provider === "stub" && t1.speechDetected && !t1.edited && JSON.stringify(t1.effectiveSegments) === JSON.stringify(t1.segments));
  check("1.5 get devolve o mesmo", T.get(A, c1)?.text === t1.text);

  // 2. cache / force / concorrência
  const before = calls;
  const again = await T.transcribe(A, "u1", c1);
  check("2.1 segunda chamada reaproveita (cached, sem novo custo)", again.cached === true && calls === before);
  const c2 = creation(A, withAudio);
  await Promise.all([T.transcribe(A, "u1", c2), T.transcribe(A, "u1", c2), T.transcribe(A, "u1", c2)]);
  check("2.2 requisições simultâneas na mesma criação = 1 só chamada ao provider", calls === before + 1, String(calls - before));

  // 3. edição
  const ed = T.editText(A, c1, [{ index: 1, text: "Vamos ver a   coleção nova!\u0007" }, { index: 0, text: "" }]);
  check("3.1 edição troca só o texto: tempos iguais, original intacto, texto limpo", ed.edited && ed.editedSegments![1].text === "Vamos ver a coleção nova!" && ed.editedSegments![1].startMs === ed.segments[1].startMs && ed.segments[1].text === "Vamos ver a coleção." && ed.editedSegments![0].text === "");
  check("3.2 effectiveSegments usa o editado", ed.effectiveSegments[1].text === "Vamos ver a coleção nova!");
  check("3.3 índice inválido / sem edição / sem transcrição recusam", [await rej(async () => T.editText(A, c1, [{ index: 99, text: "x" }])), await rej(async () => T.editText(A, c1, [])), await rej(async () => T.editText(A, randomUUID(), [{ index: 0, text: "x" }]))].every((m) => m !== "" && !m.startsWith("other:")));
  const forced = await T.transcribe(A, "u1", c1, { force: true });
  check("3.4 force refaz a transcrição e descarta as edições", forced.edited === false && forced.cached !== true && calls === before + 2);

  // 4. recusas honestas (nada gravado)
  const cNo = creation(A, noAudio);
  const rows = () => (db.prepare("SELECT COUNT(*) n FROM video_transcripts WHERE organization_id = ?").get(A) as any).n;
  const n0 = rows(); const calls0 = calls;
  check("4.1 vídeo sem áudio → mensagem de cliente, provider não chamado, nada gravado", (await rej(() => T.transcribe(A, "u1", cNo))) === MSG("no_audio") && calls === calls0 && rows() === n0);
  check("4.2 imagem / criação inexistente / de outra empresa → não encontrado", [await rej(() => T.transcribe(A, null, creation(A, "/media/x.png", "image"))), await rej(() => T.transcribe(A, null, randomUUID())), await rej(() => T.transcribe(B, null, c1))].every((m) => m === MSG("not_found")));
  check("4.3 ainda processando / sem arquivo", (await rej(() => T.transcribe(A, null, creation(A, null, "video", "processing")))) === MSG("not_ready") && (await rej(() => T.transcribe(A, null, creation(A, "/media/../x.txt")))) === MSG("no_file"));
  const cFail = creation(A, withAudio);
  T.provider = new StubSpeechToTextProvider(async () => { throw new Error("401 invalid api key sk-SECRET"); });
  const failMsg = await rej(() => T.transcribe(A, null, cFail));
  check("4.4 provider falha → mensagem de cliente SEM vazar o erro técnico, nada gravado, tmp limpo", failMsg === MSG("failed") && !/sk-|401/.test(failMsg) && !T.get(A, cFail) && leftovers() === 0);
  T.provider = new StubSpeechToTextProvider(null, false);
  check("4.5 provider indisponível → mensagem de cliente, nada gravado", (await rej(() => T.transcribe(A, null, cFail))) === MSG("unavailable") && !T.get(A, cFail) && (await T.available()) === false);
  T.provider = new StubSpeechToTextProvider({ text: "", language: "pt", durationSec: 4, segments: [], words: [] });
  const silent = await T.transcribe(A, null, cFail);
  check("4.6 sem fala: registra speechDetected=false, texto vazio (não inventa)", silent.speechDetected === false && silent.text === "" && silent.segments.length === 0);

  // 5. teto diário
  T.provider = new StubSpeechToTextProvider();
  const used = rows();
  for (let k = used; k < 6; k++) await T.transcribe(A, null, creation(A, withAudio));
  check("5.1 teto diário por empresa bloqueia a próxima (e não gasta)", (await rej(() => T.transcribe(A, null, creation(A, withAudio)))) === MSG("daily_limit"));
  check("5.2 outra empresa não é afetada", (await T.transcribe(B, null, creation(B, withAudio))).segments.length === 2);

  // 6. ledger: custo por minuto, atribuído
  let sentArgs: any = null;
  const fake = { audio: { transcriptions: { create: async (a: any) => (sentArgs = a, { text: "oi", language: "portuguese", duration: 90, segments: [{ start: 0, end: 1.5, text: " oi " }], words: [{ word: "oi", start: 0, end: 0.4 }] }) } } };
  const cid = randomUUID();
  const tr = await usageContext.run({ orgId: A, userId: "u9", module: "studio", correlationId: `video:${cid}` }, () => llm.transcribeAudioTimed(Buffer.from("x"), "a.wav", "audio/wav", { client: fake }));
  const row = db.prepare("SELECT * FROM ai_usage_log WHERE organization_id = ? AND request_id = ?").get(A, `video:${cid}`) as any;
  const expectCents = Math.round(llm.whisperCostUsd(90) * 5.4 * 100);
  check("6.1 transcrição gera segmentos/palavras em ms", tr.segments[0].endMs === 1500 && tr.segments[0].text === "oi" && tr.words[0].endMs === 400 && tr.durationSec === 90);
  check("6.2 custo no ledger proporcional à duração (1,5 min), atribuído à org/módulo/criação", !!row && row.module === "studio" && row.user_id === "u9" && row.cost_cents === expectCents && Math.abs(llm.whisperCostUsd(90) - 1.5 * 0.006) < 1e-9, JSON.stringify(row));
  check("6.2b pede verbose_json com segmentos E palavras, no modelo com tempo e idioma pt", sentArgs?.response_format === "verbose_json" && sentArgs.timestamp_granularities.includes("word") && sentArgs.timestamp_granularities.includes("segment") && sentArgs.model === llm.TRANSCRIBE_TIMED_MODEL && sentArgs.language === "pt");
  check("6.3 duração inválida custa 0 (não inventa)", llm.whisperCostUsd(NaN) === 0 && llm.whisperCostUsd(-5) === 0);
  const saved = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  check("6.4 provider Whisper sem chave = indisponível", new OpenAiWhisperProvider().available() === false);
  if (saved) process.env.OPENAI_API_KEY = saved;
  check("6.5 normalizeSegments pura", normalizeSegments([{ startMs: 5, endMs: 5, text: "a" }, { startMs: 10, endMs: 20, text: "b\n" }], null).length === 1);

  // 7. rotas
  T.provider = new StubSpeechToTextProvider();
  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => { if (req.headers["x-org"]) req.organizationId = String(req.headers["x-org"]); next(); });
  app.use("/api/studio", studio);
  const server = http.createServer(app);
  const port: number = await new Promise((rs) => server.listen(0, () => rs((server.address() as any).port)));
  const call = async (org: string | null, method: string, p2: string, body?: any) => { const r = await fetch(`http://127.0.0.1:${port}/api/studio${p2}`, { method, headers: { "Content-Type": "application/json", ...(org ? { "x-org": org } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const cr = creation(B, withAudio);
  const g0 = await call(B, "GET", `/video-post/${cr}/transcript`);
  const p1 = await call(B, "POST", `/video-post/${cr}/transcribe`, {});
  const g1 = await call(B, "GET", `/video-post/${cr}/transcript`);
  const e1 = await call(B, "PUT", `/video-post/${cr}/transcript`, { edits: [{ index: 0, text: "Corrigido" }] });
  check("7.1 rotas: GET 404 antes; POST transcreve; GET lê; PUT edita", g0.status === 404 && p1.status === 200 && g1.status === 200 && e1.status === 200 && e1.body.editedSegments[0].text === "Corrigido");
  check("7.2 rotas: outra empresa → 404/400, sem login → 401, edição inválida → 400", (await call(A, "GET", `/video-post/${cr}/transcript`)).status === 404 && (await call(A, "POST", `/video-post/${cr}/transcribe`, {})).status === 400 && (await call(null, "POST", `/video-post/${cr}/transcribe`, {})).status === 401 && (await call(B, "PUT", `/video-post/${cr}/transcript`, { edits: [{ index: 50, text: "x" }] })).status === 400);
  server.close();

  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
