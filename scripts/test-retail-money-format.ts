/**
 * TESTE — Campo de cota como VALOR MONETÁRIO (MONEY-FMT-001).
 *
 * Pedido do lojista: os campos de cota semanal eram texto puro ("20000") e
 * deixavam dúvida se era valor. Agora são monetários: exibem "20.000,00" e a
 * digitação estilo calculadora reconhece as casas decimais.
 *
 * Uso:  npm run test:retail-money-format
 */
let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { formatMoneyBR, maskMoneyBRInput, parseMoneyBR } = await import("../src/features/retailMoney.js");

  // ===== 1. exibição (valor em reais → BR) =====
  check("1.1 20000 → '20.000,00'", formatMoneyBR(20000) === "20.000,00", formatMoneyBR(20000));
  check("1.2 12165 → '12.165,00'", formatMoneyBR(12165) === "12.165,00", formatMoneyBR(12165));
  check("1.3 1266.67 → '1.266,67'", formatMoneyBR(1266.67) === "1.266,67", formatMoneyBR(1266.67));
  check("1.4 vazio → '' (célula em branco = derivada)", formatMoneyBR("") === "" && formatMoneyBR(null) === "");
  check("1.5 0 → '' (sem cota)", formatMoneyBR(0) === "");

  // ===== 2. máscara de digitação estilo calculadora =====
  check("2.1 '2000000' → '20.000,00'", maskMoneyBRInput("2000000") === "20.000,00", maskMoneyBRInput("2000000"));
  check("2.2 '5' → '0,05'", maskMoneyBRInput("5") === "0,05", maskMoneyBRInput("5"));
  check("2.3 '150' → '1,50'", maskMoneyBRInput("150") === "1,50", maskMoneyBRInput("150"));
  check("2.4 já formatado + tecla: '20.000,00'+'5' → '200.000,05'", maskMoneyBRInput("20.000,005") === "200.000,05", maskMoneyBRInput("20.000,005"));
  check("2.5 vazio → ''", maskMoneyBRInput("") === "" && maskMoneyBRInput("abc") === "");

  // ===== 3. round-trip: o que salva bate com o que aparece =====
  check("3.1 parse('20.000,00') = 20000 (salva certo)", parseMoneyBR("20.000,00") === 20000, String(parseMoneyBR("20.000,00")));
  check("3.2 parse('1.266,67') = 1266.67", parseMoneyBR("1.266,67") === 1266.67, String(parseMoneyBR("1.266,67")));
  check("3.3 format→parse ida e volta", parseMoneyBR(formatMoneyBR(15000)) === 15000);

  console.log("\n=== TEST: Cota como valor monetário ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
