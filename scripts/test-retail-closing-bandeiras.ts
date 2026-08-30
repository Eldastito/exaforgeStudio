/**
 * TESTE — Bandeiras do fechamento: fim do "fantasma" (DEBITO-001).
 *
 * Bug real (Carioca 29/08): a IA leu a folha ("Electron 399,70") E a bandeira
 * do Clover ("Visa débito 399,70") — a MESMA venda — e o débito virou 799,40.
 * "Visa" não é bandeira cadastrada de débito da loja, então NÃO aparecia como
 * campo, mas ENTRAVA no subtotal (fantasma). A conferência acusava diferença
 * de 399,70 em todo lugar. Correção: só bandeiras cadastradas entram e o
 * subtotal soma só os campos visíveis.
 *
 * Uso:  npm run test:retail-closing-bandeiras
 */
let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { reconcileBandeiras, sumBandeiras } = await import("../src/features/retailClosingForm.js");
  // O MESMO parser de moeda que o formulário usa (dot-decimal da IA + BR).
  const { parseMoneyBR: parseBR } = await import("../src/features/retailMoney.js");

  const DEBITO_BRANDS = ["Redshop", "Eletron", "Elo"];
  const CREDITO_BRANDS = ["Amex", "Master", "Visa", "Elo"];

  // ===== 1. o caso Carioca 29/08 =====
  // IA devolveu Eletron (da folha) + Visa (do Clover, débito) = mesma venda.
  const deb = reconcileBandeiras({ "Eletron": 399.7, "Visa": 399.7 }, DEBITO_BRANDS);
  check("1.1 mantém só a bandeira cadastrada (Eletron)", JSON.stringify(deb.values) === JSON.stringify({ Eletron: "399.7" }), JSON.stringify(deb.values));
  check("1.2 Visa (não cadastrada no débito) vai pra ignorados", deb.ignored.includes("Visa"));
  check("1.3 subtotal débito = 399,70 (sem fantasma)", sumBandeiras(deb.values, DEBITO_BRANDS, parseBR) === 399.7, String(sumBandeiras(deb.values, DEBITO_BRANDS, parseBR)));

  // ===== 2. rótulo de TOTAL não é bandeira e não polui ignorados =====
  const deb2 = reconcileBandeiras({ "Débito": 399.7, "Eletron": 399.7 }, DEBITO_BRANDS);
  check("2.1 'Débito' (rótulo de total) é descartado", !("Débito" in deb2.values) && !("Debito" in deb2.values));
  check("2.2 rótulo de total NÃO entra em ignorados (não é bandeira)", !deb2.ignored.includes("Débito"));
  check("2.3 subtotal ainda 399,70", sumBandeiras(deb2.values, DEBITO_BRANDS, parseBR) === 399.7);

  // ===== 3. match sem acento / caixa =====
  const cred = reconcileBandeiras({ "master": 139.9, "VISA": 389.5 }, CREDITO_BRANDS);
  check("3.1 'master' casa com 'Master' (canônico)", cred.values["Master"] === "139.9");
  check("3.2 'VISA' casa com 'Visa' (canônico)", cred.values["Visa"] === "389.5");
  check("3.3 subtotal crédito = 529,40", sumBandeiras(cred.values, CREDITO_BRANDS, parseBR) === 529.4, String(sumBandeiras(cred.values, CREDITO_BRANDS, parseBR)));

  // ===== 4. Elo aparece nos dois grupos — casa no grupo certo =====
  const credElo = reconcileBandeiras({ "Elo": 50 }, CREDITO_BRANDS);
  const debElo = reconcileBandeiras({ "Elo": 70 }, DEBITO_BRANDS);
  check("4.1 Elo crédito", credElo.values["Elo"] === "50");
  check("4.2 Elo débito", debElo.values["Elo"] === "70");

  // ===== 5. bordas =====
  check("5.1 zero não pré-preenche", Object.keys(reconcileBandeiras({ "Eletron": 0 }, DEBITO_BRANDS).values).length === 0);
  check("5.2 valor não-numérico é ignorado silenciosamente", Object.keys(reconcileBandeiras({ "Eletron": "abc" as any }, DEBITO_BRANDS).values).length === 0);
  check("5.3 ocr nulo → vazio", reconcileBandeiras(null, DEBITO_BRANDS).values && Object.keys(reconcileBandeiras(null, DEBITO_BRANDS).values).length === 0);
  check("5.4 sumBandeiras ignora chave solta no estado (fantasma)", sumBandeiras({ Eletron: "399,70", Visa: "399,70" }, DEBITO_BRANDS, parseBR) === 399.7, String(sumBandeiras({ Eletron: "399,70", Visa: "399,70" }, DEBITO_BRANDS, parseBR)));

  // ===== 6. duplicada: fica com o maior (não perde valor) =====
  const dup = reconcileBandeiras({ "Eletron": 100, "eletron": 250 }, DEBITO_BRANDS);
  check("6.1 bandeira repetida fica com o maior", dup.values["Eletron"] === "250", JSON.stringify(dup.values));

  console.log("\n=== TEST: Bandeiras do fechamento (fim do fantasma) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
