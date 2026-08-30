/**
 * TESTE — resolveMatriculaByName: casa o NOME lido pela IA na folha manuscrita
 * (ranking do fechamento) → matrícula do cadastro de vendedores.
 *
 * Cobre o 3º problema relatado pelo lojista: "a IA não pega o vendedor". A
 * grafia manuscrita difere de acento/caixa/sobrenome, então o match exato por
 * nome (`.toLowerCase()`) falhava e a venda ficava sem matrícula. Aqui garantimos:
 * tolerância a acento/caixa/pontuação, fallback pelo PRIMEIRO nome, e NUNCA
 * chutar em ambiguidade (RN-SELL-1).
 *
 * Uso:  npm run test:retail-name-match
 */
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retail-name-match-"));
process.env.DATA_DIR = tmp;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { resolveMatriculaByName } = await import("../src/server/RetailOpsService.js");

  // Cadastro fictício estilo Toulon.
  const sellers = [
    { matricula: "1001", name: "José da Silva" },
    { matricula: "1002", name: "Thamyres Oliveira" },
    { matricula: "1003", name: "Ana Paula Souza" },
    { matricula: "1004", name: "Ana Carolina Lima" }, // dois "Ana" → primeiro nome ambíguo
    { matricula: "1005", name: "MARIA CLARA" },
  ];

  // ===== 1. match exato (nome completo idêntico) =====
  check('1.1 "José da Silva" → 1001', resolveMatriculaByName(sellers, "José da Silva") === "1001");
  check('1.2 "Thamyres Oliveira" → 1002', resolveMatriculaByName(sellers, "Thamyres Oliveira") === "1002");

  // ===== 2. insensível a acento e caixa =====
  check('2.1 "jose da silva" (sem acento/minúsculo) → 1001', resolveMatriculaByName(sellers, "jose da silva") === "1001");
  check('2.2 "JOSÉ DA SILVA" (maiúsculo) → 1001', resolveMatriculaByName(sellers, "JOSÉ DA SILVA") === "1001");
  check('2.3 "maria clara" → 1005 (cadastro em maiúsculo)', resolveMatriculaByName(sellers, "maria clara") === "1005");
  check('2.4 pontuação "José, da Silva." → 1001', resolveMatriculaByName(sellers, "José, da Silva.") === "1001");

  // ===== 3. fallback pelo PRIMEIRO nome (folha traz só o primeiro) =====
  check('3.1 "Thamyres" → 1002 (só primeiro nome, único)', resolveMatriculaByName(sellers, "Thamyres") === "1002");
  check('3.2 "José" → 1001 (primeiro nome único)', resolveMatriculaByName(sellers, "José") === "1001");
  check('3.3 "Thamyres Silva" (sobrenome errado) → 1002 via primeiro nome', resolveMatriculaByName(sellers, "Thamyres Silva") === "1002");

  // ===== 4. ambiguidade → null (RN-SELL-1: nunca chuta) =====
  check('4.1 "Ana" (dois cadastros) → null', resolveMatriculaByName(sellers, "Ana") === null);
  check('4.2 "Ana Souza" bate completo? não; primeiro nome ambíguo → null', resolveMatriculaByName(sellers, "Ana Souza") === null);
  // mas o nome completo distinto resolve a ambiguidade:
  check('4.3 "Ana Paula Souza" → 1003 (completo desambigua)', resolveMatriculaByName(sellers, "Ana Paula Souza") === "1003");
  check('4.4 "Ana Carolina Lima" → 1004 (completo desambigua)', resolveMatriculaByName(sellers, "Ana Carolina Lima") === "1004");

  // ===== 5. vazio / inexistente / lixo =====
  check('5.1 "" → null', resolveMatriculaByName(sellers, "") === null);
  check("5.2 null → null", resolveMatriculaByName(sellers, null) === null);
  check("5.3 undefined → null", resolveMatriculaByName(sellers, undefined) === null);
  check('5.4 "Fulano Inexistente" → null', resolveMatriculaByName(sellers, "Fulano Inexistente") === null);
  check("5.5 cadastro vazio → null", resolveMatriculaByName([], "José") === null);

  // ===== 6. matrícula devolvida é string (usada no INSERT) =====
  check("6.1 tipo do retorno é string", typeof resolveMatriculaByName(sellers, "José da Silva") === "string");

  console.log("\n=== TEST: resolveMatriculaByName (OCR folha manuscrita → matrícula) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
