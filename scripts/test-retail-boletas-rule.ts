/**
 * TESTE — boletasEsperadas / boletasDeVendedor: regra da loja de 5 produtos
 * por boleta (talão de venda), arredondando POR vendedor.
 *
 * Cobre o pedido do lojista: "cinco produtos por boleto; mais que isso abre
 * outra boleta pro mesmo vendedor; 15 produtos = 3 boletas".
 *
 * Uso:  npm run test:retail-boletas-rule
 */
let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { boletasDeVendedor, boletasEsperadas, boletaFinalEsperada, PRODUTOS_POR_BOLETA } = await import("../src/features/retailBoletas.js");

  check("0.1 constante = 5", PRODUTOS_POR_BOLETA === 5);

  // ===== 1. por vendedor (ceil de produtos distintos/5) =====
  check("1.1 0 produtos → 0 boletas", boletasDeVendedor(0) === 0);
  check("1.2 1 produto → 1 boleta", boletasDeVendedor(1) === 1);
  check("1.3 5 produtos → 1 boleta", boletasDeVendedor(5) === 1);
  check("1.4 6 produtos → 2 boletas", boletasDeVendedor(6) === 2);
  check("1.5 10 produtos → 2 boletas", boletasDeVendedor(10) === 2);
  check("1.6 15 produtos → 3 boletas (caso do lojista)", boletasDeVendedor(15) === 3);
  check("1.7 11 produtos → 3 boletas", boletasDeVendedor(11) === 3);

  // ===== 2. arredonda POR vendedor, não no total =====
  check("2.1 [6,6] → 2+2 = 4 (não ceil(12/5)=3)", boletasEsperadas([6, 6]) === 4);
  check("2.2 [4,4] → 1+1 = 2", boletasEsperadas([4, 4]) === 2);
  check("2.3 [3,3] → 1+1 = 2 (não ceil(6/5)=2 por acaso; conferindo por vendedor)", boletasEsperadas([3, 3]) === 2);
  check("2.4 [15] → 3", boletasEsperadas([15]) === 3);
  check("2.5 [5,10,1] → 1+2+1 = 4", boletasEsperadas([5, 10, 1]) === 4);

  // ===== 3. entradas sujas (produtos vêm como string da UI) =====
  check('3.1 ["6","4"] → 2+1 = 3', boletasEsperadas(["6", "4"]) === 3);
  check('3.2 vendedor sem produtos ("") não conta', boletasEsperadas(["", "5"]) === 1);
  check("3.3 valores negativos/lixo → 0", boletasEsperadas([-3, "abc", null, undefined]) === 0);
  check("3.4 fração arredonda pra baixo antes (5.9 → 5 produtos → 1)", boletasDeVendedor(5.9) === 1);

  // ===== 4. lista vazia / não-array =====
  check("4.1 [] → 0", boletasEsperadas([]) === 0);
  check("4.2 não-array → 0", boletasEsperadas(null as any) === 0);

  // ===== 5. porBoleta customizado (defensivo) =====
  check("5.1 porBoleta=3: 7 → 3 boletas", boletasDeVendedor(7, 3) === 3);
  check("5.2 porBoleta inválido cai no default 5", boletasDeVendedor(6, 0) === 2);

  // ===== 6. boletaFinalEsperada (nova boleta a cada 5, a partir da inicial) =====
  check('6.1 "018050" + 3 boletas → "018052"', boletaFinalEsperada("018050", 3) === "018052");
  check('6.2 "018050" + 1 boleta → "018050" (mesma)', boletaFinalEsperada("018050", 1) === "018050");
  check('6.3 preserva largura dos zeros ("007" + 5 → "011")', boletaFinalEsperada("007", 5) === "011");
  check('6.4 vira a casa ("099" + 2 → "100")', boletaFinalEsperada("099", 2) === "100");
  check("6.5 0 boletas → null", boletaFinalEsperada("018050", 0) === null);
  check("6.6 inicial não-numérico → null", boletaFinalEsperada("abc", 3) === null);
  check("6.7 inicial vazio → null", boletaFinalEsperada("", 3) === null);
  check('6.8 aceita nº com traço ("A-100" + 2 → "101")', boletaFinalEsperada("A-100", 2) === "101");

  console.log("\n=== TEST: boletasEsperadas (regra 5 produtos/boleta) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
