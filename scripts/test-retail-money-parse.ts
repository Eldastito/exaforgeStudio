/**
 * TESTE — parseMoneyBR (Fechamento diário): parser de dinheiro à prova do
 * separador de milhar. Corrige o bug do "Informado" que sumia/mudava ao salvar.
 *
 * Usa os valores REAIS das folhas do lojista (TOULON): 2.253,33 / 1.065,00 /
 * 6.056,50 / 389,50 etc. — que o parser antigo (`replace(',', '.')`) destruía.
 *
 * Uso:  npm run test:retail-money-parse
 */
let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

// O parser ANTIGO (bugado) — só pra provar que os casos realmente quebravam.
const brokenOld = (v: string) => Number(String(v || "").replace(",", ".")) || 0;

async function main() {
  const { parseMoneyBR } = await import("../src/features/retailMoney.js");

  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

  // ===== 1. valores reais da folha (milhar . / decimal ,) =====
  const casos: Array<[string, number]> = [
    ["2.253,33", 2253.33],
    ["1.065,00", 1065],
    ["6.056,50", 6056.5],
    ["3.318,80", 3318.8],
    ["2.076,90", 2076.9],
    ["389,50", 389.5],
    ["139,90", 139.9],
    ["399,70", 399.7],
    ["135,90", 135.9],
    ["R$ 1.234,50", 1234.5],
  ];
  for (const [inp, exp] of casos) check(`1.x "${inp}" → ${exp}`, near(parseMoneyBR(inp), exp), `got ${parseMoneyBR(inp)}`);

  // ===== 2. milhar SEM decimais (o caso que virava 1,5) =====
  check('2.1 "1.500" → 1500 (não 1,5)', parseMoneyBR("1.500") === 1500, `got ${parseMoneyBR("1.500")}`);
  check('2.2 "3.800" (cota) → 3800', parseMoneyBR("3.800") === 3800);
  check('2.3 "1.234.567" → 1234567', parseMoneyBR("1.234.567") === 1234567);

  // ===== 3. ponto como DECIMAL (teclado numérico) =====
  check('3.1 "399.70" → 399.7', near(parseMoneyBR("399.70"), 399.7));
  check('3.2 "389.5" → 389.5', near(parseMoneyBR("389.5"), 389.5));
  check('3.3 "12,5" → 12.5', near(parseMoneyBR("12,5"), 12.5));

  // ===== 4. vazios / lixo / número =====
  check('4.1 "" → 0', parseMoneyBR("") === 0);
  check('4.2 "0" → 0', parseMoneyBR("0") === 0);
  check('4.3 "abc" → 0', parseMoneyBR("abc") === 0);
  check("4.4 número 42 → 42", parseMoneyBR(42) === 42);
  check("4.5 null → 0", parseMoneyBR(null) === 0);
  check('4.6 "-5,50" → -5.5', near(parseMoneyBR("-5,50"), -5.5));

  // ===== 5. regressão: o parser ANTIGO realmente quebrava =====
  check('5.1 antigo destruía "2.253,33" (→ NaN→0)', brokenOld("2.253,33") === 0 && parseMoneyBR("2.253,33") === 2253.33);
  check('5.2 antigo lia "1.500" como 1,5', brokenOld("1.500") === 1.5 && parseMoneyBR("1.500") === 1500);

  // ===== 6. o total do dia agora fecha (soma dos meios de pagamento) =====
  const total = ["0", "135,90", "139,90", "389,50", "399,70"].reduce((a, s) => a + parseMoneyBR(s), 0);
  check("6.1 soma dinheiro+pix+cartões = 1.065,00", near(total, 1065), `got ${total}`);

  console.log("\n=== TEST: parseMoneyBR (Fechamento diário — bug do Informado) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
