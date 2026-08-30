/**
 * TESTE — VisualGenerationKernel: gateway de EDIÇÃO multi-imagem (DUP-004).
 * ------------------------------------------------------------------------------
 * Prova que o kernel é o ponto único de edição de imagem (provador Fashion,
 * simulador Beauty, look da vitrine): roteia para o provider certo (OpenAI vs
 * Google), repassa imagens/prompt/opts fielmente, e que o reset volta ao
 * provider real (que, sem API key, lança — como esperado).
 *
 * Uso:  npm run test:visual-kernel-edit-routing
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vgk-edit-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-vgk-edit-1234567890";
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { VisualGenerationKernel: K } = await import("../src/server/VisualGenerationKernel.js");

  let openaiArgs: any = null;
  let googleArgs: any = null;
  K.configureEditProviders({
    openai: async (images: any, prompt: string, opts: any) => { openaiArgs = { images, prompt, opts }; return "OPENAI_B64"; },
    google: async (images: any, prompt: string) => { googleArgs = { images, prompt }; return "GOOGLE_B64"; },
  });

  // ===== 1. editImages roteia p/ o provider OpenAI, fiel =====
  const r1 = await K.editImages([{ buffer: Buffer.from("x"), name: "avatar.jpg", mime: "image/jpeg" }], "prompt-provador", { inputFidelity: "high", quality: "high", size: "1024x1536" });
  check("1.1 editImages devolve o que o provider OpenAI retornou", r1 === "OPENAI_B64");
  check("1.2 repassa o prompt fielmente", openaiArgs?.prompt === "prompt-provador");
  check("1.3 repassa as opts (inputFidelity=high, size=retrato)", openaiArgs?.opts?.inputFidelity === "high" && openaiArgs?.opts?.size === "1024x1536");
  check("1.4 repassa as imagens (1 avatar)", Array.isArray(openaiArgs?.images) && openaiArgs.images.length === 1);

  // ===== 2. editImagesGoogle roteia p/ o provider Google, fiel =====
  const r2 = await K.editImagesGoogle([{ buffer: Buffer.from("y"), mime: "image/jpeg" }], "prompt-google");
  check("2.1 editImagesGoogle devolve o que o provider Google retornou", r2 === "GOOGLE_B64");
  check("2.2 repassa o prompt fielmente", googleArgs?.prompt === "prompt-google");
  check("2.3 OpenAI NÃO foi chamado no caminho Google", openaiArgs?.prompt === "prompt-provador"); // inalterado

  // ===== 3. reset volta ao provider real (sem key → lança) =====
  K.resetEditProviders();
  let threw = false;
  try { await K.editImages([{ buffer: Buffer.from("z"), name: "a.jpg", mime: "image/jpeg" }], "p"); }
  catch { threw = true; }
  check("3.1 após reset, sem API key, o provider real lança (não silencia)", threw);

  console.log("\n=== TEST: VisualGenerationKernel — gateway de edição (DUP-004) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
