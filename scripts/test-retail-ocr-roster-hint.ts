/**
 * TESTE — sellerRosterHint: a dica de "vendedores cadastrados da loja" que
 * vai no prompt da IA (ideia do lojista) para casar o NOME manuscrito com o
 * cadastro. Sem lista → string vazia (a IA lê como antes). Com lista → inclui
 * os nomes de referência e a instrução de pegar o MAIS PARECIDO.
 *
 * Uso:  npm run test:retail-ocr-roster-hint
 */
let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { sellerRosterHint } = await import("../src/server/llm.js");

  // ===== 1. vazio / lixo → "" =====
  check("1.1 lista vazia → ''", sellerRosterHint([]) === "");
  check("1.2 só vazios/espaços → ''", sellerRosterHint(["", "   ", null, undefined]) === "");

  // ===== 2. com nomes → inclui referência + instrução =====
  const h = sellerRosterHint(["José da Silva", "Thamyres", "Ana Paula"]);
  check("2.1 menciona os vendedores cadastrados", /VENDEDORES CADASTRADOS/i.test(h));
  check("2.2 inclui José da Silva", h.includes("José da Silva"));
  check("2.3 inclui Thamyres", h.includes("Thamyres"));
  check("2.4 inclui Ana Paula", h.includes("Ana Paula"));
  check("2.5 instrui pegar o mais parecido", /MAIS PARECIDO/i.test(h));

  // ===== 3. dedup + trim, preservando grafia =====
  const h2 = sellerRosterHint([" Ana ", "Ana", "Bruno"]);
  const anaCount = (h2.match(/Ana/g) || []).length;
  check("3.1 dedup: 'Ana' aparece uma vez só", anaCount === 1, `apareceu ${anaCount}x`);
  check("3.2 mantém Bruno", h2.includes("Bruno"));

  // ===== 4. não-array → "" (defensivo) =====
  check("4.1 não-array → ''", sellerRosterHint(null as any) === "");

  console.log("\n=== TEST: sellerRosterHint (roster da loja no prompt da OCR) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
