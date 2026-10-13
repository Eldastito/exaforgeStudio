/**
 * TESTE — Prontidão de produção do vídeo (ADR-207 F13b.10). O que dá para provar SEM a imagem Docker real:
 * ordem de resolução do ffmpeg (FFMPEG_PATH → ffmpeg-static → indisponível) e o que o app enxerga em cada caso (capabilities/recusa),
 * o smoke do operador (3 códigos de saída, por causa), o MESMO smoke empacotado em CJS como no `npm run build` (o app roda CJS em produção),
 * e a fiação do deploy (ffmpeg-static precisa sobreviver ao `npm prune --omit=dev`; assets/fonts vai para a imagem; runbook cobre todas as variáveis).
 * NÃO prova: o download do ffmpeg-static no build real, a imagem final, nem o Whisper real (ver docs/runbook/video-operacao.md).
 * Uso: npm run test:video-production-readiness
 */
import os from "os"; import path from "path"; import fs from "fs"; import { spawnSync } from "child_process"; import { createRequire } from "module"; import { fileURLToPath } from "url"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vprod-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-vprod-1234567890";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");

function smoke(env: Record<string, string | undefined>, cmd: "tsx" | "node" = "tsx", file = "scripts/video-smoke.cli.ts") {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, DATA_DIR: tmpDir, ...env })) if (v !== undefined) e[k] = v as string;
  const r = cmd === "tsx" ? spawnSync(tsx, [file, "--json"], { cwd: repoRoot, env: e, encoding: "utf8", timeout: 120000 }) : spawnSync("node", [file, "--json"], { cwd: repoRoot, env: e, encoding: "utf8", timeout: 120000 });
  let out: any = null; try { out = JSON.parse(r.stdout); } catch { /* noop */ }
  return { status: r.status, out, stderr: r.stderr };
}

async function main() {
  const { FfmpegService: F } = await import("../src/server/FfmpegService.js");
  const { VideoPostProductionService: V } = await import("../src/server/VideoPostProductionService.js");
  const db = (await import("../src/server/db.js")).default;
  const org = `org_vp_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${org}`, org);
  const saved = process.env.FFMPEG_PATH; delete process.env.FFMPEG_PATH;

  // ── 1. ordem de resolução ──
  F.resetCache();
  const s1 = await F.source(); const a1 = await F.available(true);
  check("1.1 sem FFMPEG_PATH usa o pacote ffmpeg-static (origem 'static', dentro de node_modules) e ele responde", s1.source === "static" && /node_modules[\\/]ffmpeg-static/.test(s1.path || "") && a1.available === true, JSON.stringify([s1, a1]));

  const fake = path.join(tmpDir, "fake-ffmpeg.sh");
  fs.writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffmpeg version fake-1.0"; exit 0; fi\nexit 1\n'); fs.chmodSync(fake, 0o755);
  process.env.FFMPEG_PATH = fake; F.resetCache();
  const s2 = await F.source(); const a2 = await F.available(true);
  check("1.2 FFMPEG_PATH explícito VENCE o pacote (origem 'env', caminho dele, versão dele)", s2.source === "env" && s2.path === fake && a2.available === true && /fake-1\.0/.test(a2.version || ""), JSON.stringify([s2, a2]));

  process.env.FFMPEG_PATH = path.join(tmpDir, "nao-existe"); F.resetCache();
  const s3 = await F.source(); const a3 = await F.available(true);
  check("1.3 FFMPEG_PATH errado NÃO cai em silêncio pro pacote: fica indisponível (config do operador é respeitada) e diz a origem", s3.source === "env" && a3.available === false && (await F.hasFilter("ass")) === false);

  process.env.FFMPEG_PATH = path.join(tmpDir, "fake-ffmpeg-quebrado.sh"); fs.writeFileSync(process.env.FFMPEG_PATH, "#!/bin/sh\nexit 3\n"); fs.chmodSync(process.env.FFMPEG_PATH, 0o755); F.resetCache();
  check("1.4 binário que existe mas não responde -version também é indisponível (não basta existir)", (await F.available(true)).available === false);

  // ── 2. o que o app enxerga ──
  process.env.FFMPEG_PATH = path.join(tmpDir, "nao-existe"); F.resetCache();
  const capBad = await V.capabilities();
  check("2.1 capabilities REAIS com ffmpeg indisponível: tudo falso e com aviso (a tela trava as opções)", capBad.ffmpeg === false && capBad.canRenderTrimReframe === false && capBad.canRenderCaptions === false && capBad.renderImplemented === false && capBad.notes.length > 0, JSON.stringify(capBad));
  const cid = randomUUID(); db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status, source) VALUES (?, ?, 'video', 'p', '/media/x.mp4', 'done', 'uploaded')").run(cid, org);
  fs.mkdirSync(path.join(tmpDir, "media"), { recursive: true }); fs.writeFileSync(path.join(tmpDir, "media", "x.mp4"), "nao e video");
  let msg = ""; try { await V.render(org, { creationId: cid, channel: "instagram", topic: "camisa" }); } catch (e: any) { msg = e.message; }
  check("2.2 render sem ffmpeg recusa com texto de cliente (nada técnico) — o app não cai", /não está disponível neste servidor/.test(msg) && !/spawn|ENOENT|FFMPEG_PATH|\//.test(msg), msg);
  delete process.env.FFMPEG_PATH; F.resetCache();
  const capOk = await V.capabilities();
  check("2.3 capabilities REAIS com o ffmpeg-static: corte e legenda liberados", capOk.ffmpeg === true && capOk.canRenderTrimReframe === true && capOk.canRenderCaptions === true, JSON.stringify(capOk));
  check("2.4 a resposta de capabilities não vaza caminho do servidor", !/node_modules|\/home\/|\/app\//.test(JSON.stringify(capOk)));

  // ── 3. smoke do operador ──
  const ok = smoke({ FFMPEG_PATH: undefined });
  check("3.1 smoke com tudo certo: saída 0, todos os passos ok, veredito 'TUDO CERTO'", ok.status === 0 && ok.out?.code === 0 && ok.out.steps.length >= 9 && ok.out.steps.every((s: any) => s.ok) && /TUDO CERTO/.test(ok.out.verdict), JSON.stringify(ok.out?.steps?.filter((s: any) => !s.ok)) + ok.stderr.slice(-200));
  const names = (ok.out?.steps || []).map((s: any) => s.name).join("|");
  check("3.2 o smoke cobre o que o app usa: ffmpeg, filtros, encoder, metadados, enquadrar, pausas (detectar+cortar), miniatura, legenda/título, pasta de mídia", ["ffmpeg disponível", "filtros", "gerar clipe", "metadados", "enquadrar", "detectar pausas", "cortar pausas", "miniatura", "legenda", "pasta de mídia"].every((n) => names.includes(n)), names);
  const bad = smoke({ FFMPEG_PATH: path.join(tmpDir, "nao-existe") });
  check("3.3 FFMPEG_PATH errado: saída 1, diz 'FFMPEG_PATH aponta para…' e NÃO tenta o resto", bad.status === 1 && bad.out?.code === 1 && /FFMPEG_PATH aponta para/.test(bad.out.steps[0].detail) && !bad.out.steps.some((s: any) => s.name.includes("gerar clipe")), JSON.stringify(bad.out?.steps?.[0]));
  const nofont = smoke({ FFMPEG_PATH: undefined, SUBTITLE_FONTS_DIR: path.join(tmpDir, "sem-fonte") });
  const failedNames = (nofont.out?.steps || []).filter((s: any) => !s.ok).map((s: any) => s.name);
  check("3.4 sem a fonte: saída 2 (parcial) — só legenda/título falham; corte e pausas seguem ok", nofont.status === 2 && failedNames.length === 1 && /legenda/.test(failedNames[0]) && /fonte .* ausente/.test(nofont.out.steps.find((s: any) => !s.ok).detail) && /PARCIAL/.test(nofont.out.verdict), JSON.stringify(failedNames));
  const fileAsDir = path.join(tmpDir, "um-arquivo"); fs.writeFileSync(fileAsDir, "x");
  const noWrite = smoke({ FFMPEG_PATH: undefined, DATA_DIR: fileAsDir });
  check("3.5 DATA_DIR não gravável: saída 1 e o passo 'pasta de mídia' aponta o problema", noWrite.status === 1 && noWrite.out?.steps.some((s: any) => s.name.includes("pasta de mídia") && !s.ok), JSON.stringify(noWrite.out?.steps?.filter((s: any) => !s.ok)));
  check("3.6 o smoke não toca dado de cliente: roda sem banco, e a pasta temporária some", !/better-sqlite3|zappflow\.db/.test(read("scripts/video-smoke.cli.ts")) && fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("zf-smoke-")).length === 0);

  // ── 4. empacotado em CJS como no build de produção ──
  const buildCmd = JSON.parse(read("package.json")).scripts.build as string;
  const seg = buildCmd.split("&&").map((x) => x.trim()).find((x) => x.includes("video-smoke.cli.ts"));
  check("4.1 o `npm run build` empacota o smoke (dist/video-smoke.cjs) com as mesmas flags dos outros entrypoints (CJS, packages external)", !!seg && /--platform=node/.test(seg) && /--format=cjs/.test(seg) && /--packages=external/.test(seg) && /--outfile=dist\/video-smoke\.cjs/.test(seg), String(seg));
  const outCjs = path.join(repoRoot, "dist", `video-smoke-test-${randomUUID().slice(0, 6)}.cjs`);
  fs.mkdirSync(path.join(repoRoot, "dist"), { recursive: true });
  // esbuild via API (não via node_modules/.bin): no CI o `.bin/esbuild` de topo pode não existir; o tsx — que roda este teste — sempre
  // traz o dele. Tenta o de topo e, se faltar, o do próprio tsx. Se nenhum resolver, FALHA com mensagem (não pula em silêncio).
  const reqRoot = createRequire(path.join(repoRoot, "package.json"));
  let esb: any = null; let esbFrom = "";
  try { esb = reqRoot("esbuild"); esbFrom = "topo"; } catch {
    try { esb = createRequire(reqRoot.resolve("tsx/package.json"))("esbuild"); esbFrom = "tsx"; } catch { /* sem esbuild */ }
  }
  check("4.1b esbuild utilizável para empacotar (de topo ou o que o tsx traz)", !!esb, "nenhum esbuild resolvível");
  try {
    if (!esb) throw new Error("sem esbuild");
    // mesmas opções do trecho do `npm run build` verificado em 4.1 (plataforma/formato/packages)
    await esb.build({ entryPoints: [path.join(repoRoot, "scripts/video-smoke.cli.ts")], bundle: true, platform: "node", format: "cjs", packages: "external", outfile: outCjs, logLevel: "silent" });
    const prod = smoke({ FFMPEG_PATH: undefined }, "node", path.relative(repoRoot, outCjs));
    check("4.2 o bundle CJS roda com `node` puro (sem tsx), acha o ffmpeg-static por import() dinâmico e passa tudo", prod.status === 0 && prod.out?.steps.every((s: any) => s.ok), (prod.stderr || "").slice(-300) + JSON.stringify(prod.out?.steps?.filter((s: any) => !s.ok)));
    check("4.3 e o bundle respeita as mesmas falhas (FFMPEG_PATH errado → 1)", smoke({ FFMPEG_PATH: path.join(tmpDir, "nao-existe") }, "node", path.relative(repoRoot, outCjs)).status === 1);
  } catch (e: any) {
    check("4.2 o bundle CJS roda com `node` puro", false, "falha ao empacotar/rodar: " + String(e?.message || e).slice(0, 200) + ` (esbuild de ${esbFrom || "?"})`);
  } finally { try { fs.rmSync(outCjs, { force: true }); } catch { /* noop */ } }

  // ── 5. fiação do deploy ──
  const pkg = JSON.parse(read("package.json")); const docker = read("Dockerfile"); const dignore = read(".dockerignore").split("\n").map((l) => l.trim());
  check("5.1 ffmpeg-static é dependência OPCIONAL (sobrevive ao `npm prune --omit=dev`; falha de download não derruba o build) e não está em dev", !!pkg.optionalDependencies?.["ffmpeg-static"] && !pkg.devDependencies?.["ffmpeg-static"] && !pkg.dependencies?.["ffmpeg-static"] && /npm prune --omit=dev/.test(docker));
  check("5.2 a fonte da legenda vai para a imagem: assets/ não está no .dockerignore, o Dockerfile copia o app todo, roda em /app e a fonte+licença existem", !dignore.some((l) => /^\/?assets\/?/.test(l)) && /COPY \. \./.test(docker) && /WORKDIR \/app/.test(docker) && fs.existsSync(path.join(repoRoot, "assets/fonts/DejaVuSans-Bold.ttf")) && fs.existsSync(path.join(repoRoot, "assets/fonts/DejaVu-LICENSE.txt")));
  check("5.3 o runtime roda o dist (CJS) como usuário node — o smoke entra em dist/ junto do resto", /CMD \["node", "dist\/supervisor\.cjs"\]/.test(docker) && /COPY --chown=node:node --from=builder \/app \/app/.test(docker));
  const rb = read("docs/runbook/video-operacao.md");
  const srcFiles = ["FfmpegService", "VideoUploadService", "VideoTranscriptionService", "SpeechToTextProvider", "VideoRenderJobService", "VideoSubtitleService"].map((f) => read(`src/server/${f}.ts`)).join("\n") + read("src/server/llm.ts");
  const envs = Array.from(new Set(Array.from(srcFiles.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)).map((m) => m[1]))).filter((n) => /^(FFMPEG|VIDEO|STT|SUBTITLE|OPENAI_TRANSCRIBE)/.test(n) || n === "OPENAI_API_KEY" || n === "DATA_DIR");
  const missing = envs.filter((n) => !rb.includes(n));
  check("5.4 o runbook documenta TODA variável de ambiente que o código de vídeo lê (anti-deriva)", envs.length >= 12 && missing.length === 0, "faltam: " + missing.join(", ") + " | lidas: " + envs.join(","));
  check("5.5 runbook: comando do smoke para o container, ordem do ffmpeg, FFMPEG_BINARIES_URL só no build, e o que NÃO foi provado", /docker exec .* node dist\/video-smoke\.cjs/.test(rb) && /FFMPEG_PATH → pacote ffmpeg-static → indisponível/.test(rb) && /FFMPEG_BINARIES_URL/.test(rb) && /Nunca foi verificado na imagem Docker/.test(rb));
  check("5.6 o app em execução NÃO lê FFMPEG_BINARIES_URL (é só espelho de build do ffmpeg-static)", !/process\.env\.FFMPEG_BINARIES_URL/.test(srcFiles) && !/process\.env\.FFMPEG_BINARIES_URL/.test(read("src/server/routes/studio.ts")));

  if (saved === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = saved;
  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
