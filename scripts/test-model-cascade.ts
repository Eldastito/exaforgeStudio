/**
 * TESTE — ADR-154 F1: cascata de modelo (seleção por NÍVEL no sink `chat()`).
 * ----------------------------------------------------------------------------
 * Gap: `chat()` chamava sempre o `CHAT_MODEL` fixo (caro). Esta fatia adiciona a
 * PRIMITIVA de seleção por nível (`pickChatModel`) + o parâmetro `tier` em
 * `chat()`, determinístico e via env, 0-regressão por construção.
 *
 * Prova (sem rede/sem API key — só a primitiva pura):
 *  - mapeamento economy/standard/premium determinístico;
 *  - nível ausente/desconhecido → standard = CHAT_MODEL (0-regressão);
 *  - premium NÃO configurado NÃO inventa modelo mais caro (cai no standard);
 *  - override por env respeitado (economy).
 *
 * Uso:  npm run test:model-cascade
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-model-cascade-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-model-cascade-1";
// Configura ANTES de importar (llm.ts lê env no load): economy explícito;
// standard e premium ficam UNSET para exercitar os defaults.
process.env.OPENAI_MODEL_ECONOMY = "gpt-4o-mini";
delete process.env.OPENAI_MODEL;
delete process.env.OPENAI_MODEL_PREMIUM;

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const llm = await import("../src/server/llm.js");
  const { pickChatModel, CHAT_MODEL, CHAT_MODEL_ECONOMY, CHAT_MODEL_PREMIUM } = llm;

  // ── 1. defaults ──
  check("1.1 CHAT_MODEL default = gpt-4o", CHAT_MODEL === "gpt-4o", CHAT_MODEL);
  check("1.2 economy respeita env", CHAT_MODEL_ECONOMY === "gpt-4o-mini", CHAT_MODEL_ECONOMY);
  check("1.3 premium não configurado cai no standard (não inventa mais caro)", CHAT_MODEL_PREMIUM === CHAT_MODEL, CHAT_MODEL_PREMIUM);

  // ── 2. mapeamento por nível ──
  check("2.1 economy → modelo econômico", pickChatModel("economy") === CHAT_MODEL_ECONOMY);
  check("2.2 standard → CHAT_MODEL", pickChatModel("standard") === CHAT_MODEL);
  check("2.3 premium → CHAT_MODEL_PREMIUM", pickChatModel("premium") === CHAT_MODEL_PREMIUM);

  // ── 3. 0-regressão: sem tier / tier desconhecido → standard ──
  check("3.1 sem tier → CHAT_MODEL", pickChatModel() === CHAT_MODEL);
  check("3.2 tier desconhecido → CHAT_MODEL", pickChatModel("qualquer" as any) === CHAT_MODEL);

  // ── 4. economia real: o econômico difere do standard (roteável) ──
  check("4.1 economy ≠ standard (há o que economizar)", CHAT_MODEL_ECONOMY !== CHAT_MODEL);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} model-cascade: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
