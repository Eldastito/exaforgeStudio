/**
 * TESTE — VisualGenerationKernel (DUP-004): reuso de imagem idêntica.
 * ------------------------------------------------------------------------------
 * Prova, offline (provider fake, sem bater no Google/OpenAI):
 *   - hash canônico determinístico (mesma entrada = mesmo hash; muda = muda);
 *   - REUSO: entrada idêntica na mesma org NÃO chama o provider de novo
 *     (reused=true, mesma mídia); provider chamado 1x para N repetições;
 *   - entradas diferentes → geram de novo;
 *   - isolamento por org (mesma entrada, org diferente = geração própria);
 *   - arquivo sumiu do disco → regenera (não devolve mídia quebrada).
 *
 * Uso:  npm run test:visual-generation-kernel
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vgk-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-vgk-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeIVWUcAAAAASUVORK5CYII=";

async function main() {
  await import("../src/server/db.js");
  const { VisualGenerationKernel: K } = await import("../src/server/VisualGenerationKernel.js");

  let calls = 0;
  K.configureProvider(async () => { calls++; return PNG_1x1; });

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  const base = { orgId: A, prompt: "billboard 3d de um tênis", size: "1024x1024" as const, recipeKey: "BILLBOARD_3D" };

  // ===== 1. hash canônico =====
  const h1 = K.canonicalHash({ operation: "generate", prompt: "abc", size: "1024x1024" });
  const h2 = K.canonicalHash({ operation: "generate", prompt: "abc", size: "1024x1024" });
  const h3 = K.canonicalHash({ operation: "generate", prompt: "abc", size: "1536x1024" });
  check("1.1 hash determinístico (mesma entrada = mesmo hash)", h1 === h2);
  check("1.2 hash muda com o size", h1 !== h3);
  check("1.3 hash tem cara de sha256 (64 hex)", /^[0-9a-f]{64}$/.test(h1));

  // ===== 2. reuso =====
  const g1 = await K.generate(base);
  check("2.1 1ª geração: chama provider, reused=false", g1.reused === false && calls === 1);
  const g2 = await K.generate(base);
  check("2.2 2ª geração idêntica: REUSO (não chama provider)", g2.reused === true && calls === 1);
  check("2.3 reuso devolve a MESMA mídia", g2.mediaUrl === g1.mediaUrl);
  const g3 = await K.generate(base);
  check("2.4 3ª idêntica: ainda 1 chamada de provider no total", calls === 1 && g3.reused === true);
  const stReuse = K.stats(A);
  check("2.5 stats conta os reaproveitamentos (hits = 2)", stReuse.reusedHits === 2, `hits=${stReuse.reusedHits}`);

  // ===== 3. entrada diferente gera de novo =====
  const gDiff = await K.generate({ ...base, prompt: "billboard 3d de uma bolsa" });
  check("3.1 prompt diferente → gera de novo (provider chamado)", calls === 2 && gDiff.reused === false);
  check("3.2 mídia diferente da anterior", gDiff.mediaUrl !== g1.mediaUrl);

  // ===== 4. isolamento por org =====
  const gB = await K.generate({ ...base, orgId: B });
  check("4.1 mesma entrada, org diferente → geração própria", calls === 3 && gB.reused === false);
  check("4.2 org B não reaproveita a mídia da org A", gB.mediaUrl !== g1.mediaUrl);

  // ===== 5. arquivo sumiu → regenera =====
  fs.rmSync(path.join(tmpDir, "media", path.basename(g1.mediaUrl)), { force: true });
  const gRegen = await K.generate(base);
  check("5.1 arquivo ausente → regenera (não devolve mídia quebrada)", calls === 4 && gRegen.reused === false);
  check("5.2 arquivo novo existe no disco", fs.existsSync(path.join(tmpDir, "media", path.basename(gRegen.mediaUrl))));

  // ===== 6. stats =====
  const st = K.stats(A);
  check("6.1 stats conta as entradas em cache da org", st.cached >= 2);

  K.resetProvider();
  console.log("\n=== TEST: VisualGenerationKernel (reuso de imagem idêntica) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
