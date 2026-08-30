/**
 * TESTE — P.A do ranking = Peças ÷ Atendimentos (RANK-PA-001).
 *
 * Pedido do lojista: no ranking por vendedor faltava o campo P.A. Ex.: 3
 * atendimentos e 5 peças → 5/3 = 1,67; 10 atendimentos e 30 peças → 30/10 = 3.
 *
 * Uso:  npm run test:retail-ranking-pa
 */
let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { paDe } = await import("../src/features/retailClosingForm.js");

  // ===== 1. exemplos do lojista =====
  check("1.1 5 peças / 3 AT = 1,67", paDe(5, 3) === 1.67, String(paDe(5, 3)));
  check("1.2 30 peças / 10 AT = 3", paDe(30, 10) === 3, String(paDe(30, 10)));
  check("1.3 1 peça / 1 AT = 1", paDe(1, 1) === 1, String(paDe(1, 1)));

  // ===== 2. bordas: sem AT ou sem peças → null (tela mostra —) =====
  check("2.1 AT 0 → null", paDe(5, 0) === null);
  check("2.2 peças 0 → null", paDe(0, 3) === null);
  check("2.3 ambos 0 → null", paDe(0, 0) === null);
  check("2.4 strings vazias → null", paDe("", "") === null);
  check("2.5 não numérico → null", paDe("abc", 3) === null);

  // ===== 3. aceita string (o estado do form é string) =====
  check("3.1 '5'/'2' = 2,5", paDe("5", "2") === 2.5, String(paDe("5", "2")));

  // ===== 4. arredonda em 2 casas =====
  check("4.1 7 peças / 3 AT = 2,33", paDe(7, 3) === 2.33, String(paDe(7, 3)));

  console.log("\n=== TEST: P.A do ranking (Peças ÷ AT) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
