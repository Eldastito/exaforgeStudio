/**
 * TEST — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 5, RF-12) — mensagens honestas.
 * Determinístico, sem DB. Prova que formatSyncOutcome:
 *   1. runStatus='success' → severity='ok', title='Sincronização concluída'
 *   2. runStatus='partial_failure' → 'partial', 'Sincronização parcial'
 *   3. runStatus='failed' → 'failed', 'Sincronização falhou'
 *   4. runStatus='cancelled' → 'partial'
 *   5. Sem ledger + summary com skips > 0 → 'partial' (heurística)
 *   6. Sem ledger + summary limpo → 'ok'
 *   7. detail inclui pulados por motivo (loja/produto correspondente)
 *   8. detail traz totals do catálogo quando presente
 *   9. detail traz bits do PDV (fechamentos, vendas, clientes, comissão)
 *  10. Nunca fabrica "concluída" com skips positivos sem ledger
 *
 * Uso: npm run test:alterdata-golive-sync-message
 */
let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { formatSyncOutcome } = await import("../src/server/AlterdataSyncMessage.js");

  const clean = {
    referencias: 100, variantes: 200, totalProdutos: 500, totalVariantes: 1500,
    saldos: { applied: 50, skippedNoStore: 0, skippedNoProduct: 0, sampleNoProduct: [] },
    precos: { applied: 30, skippedNoProduct: 0, sampleNoProduct: [] },
    caixas: { applied: 5, skippedNoStore: 0, errors: 0 },
    vendas: { imported: 20 }, clientes: { imported: 0 }, erpComissao: { imported: 0 },
  };

  // ═══════ 1-4. ledgerStatus manda ═══════
  const ok1 = formatSyncOutcome(clean, "success");
  check("1.1 success → severity=ok", ok1.severity === "ok");
  check("1.2 success → title 'Sincronização concluída'", ok1.title === "Sincronização concluída");

  const partial = formatSyncOutcome(clean, "partial_failure");
  check("2.1 partial_failure → severity=partial", partial.severity === "partial");
  check("2.2 partial_failure → title 'Sincronização parcial'", partial.title === "Sincronização parcial");

  const failed = formatSyncOutcome(clean, "failed");
  check("3.1 failed → severity=failed", failed.severity === "failed");
  check("3.2 failed → title 'Sincronização falhou'", failed.title === "Sincronização falhou");

  const cancelled = formatSyncOutcome(clean, "cancelled");
  check("4.1 cancelled → severity=partial", cancelled.severity === "partial");

  // ═══════ 5-6. Heurística sem ledger ═══════
  const withSkips = {
    ...clean,
    saldos: { applied: 40, skippedNoStore: 3, skippedNoProduct: 2, sampleNoProduct: ["ABC-1"] },
  };
  const heurPartial = formatSyncOutcome(withSkips);
  check("5.1 sem ledger + skips > 0 → severity=partial",
    heurPartial.severity === "partial",
    `got: ${heurPartial.severity}`);

  const heurOk = formatSyncOutcome(clean);
  check("6.1 sem ledger + summary limpo → severity=ok",
    heurOk.severity === "ok");

  // ═══════ 7. Detail com pulados ═══════
  const dt = formatSyncOutcome(withSkips).detail;
  check("7.1 detail cita 'saldo(s) sem loja cadastrada'",
    dt.includes("saldo(s) sem loja cadastrada"));
  check("7.2 detail cita 'saldo(s) sem produto correspondente'",
    dt.includes("saldo(s) sem produto correspondente"));
  check("7.3 detail cita a amostra (ex.: ABC-1)",
    dt.includes("ABC-1"));

  // ═══════ 8. Totals do catálogo ═══════
  check("8.1 detail traz totals do catálogo",
    formatSyncOutcome(clean).detail.includes("catálogo: 500 produtos, 1500 variantes"));

  // ═══════ 9. PDV bits ═══════
  const dpdv = formatSyncOutcome({
    ...clean,
    caixas: { applied: 5, skippedNoStore: 0, errors: 0 },
    vendas: { imported: 20 },
    clientes: { imported: 15 },
    erpComissao: { imported: 3 },
  }).detail;
  check("9.1 detail traz fechamento(s) PDV",
    dpdv.includes("5 fechamento(s) PDV"));
  check("9.2 detail traz venda(s) PDV", dpdv.includes("20 venda(s) PDV"));
  check("9.3 detail traz cliente(s) PDV", dpdv.includes("15 cliente(s) PDV"));
  check("9.4 detail traz comissão do ERP", dpdv.includes("3 comissão(ões) do ERP"));

  // ═══════ 10. Sem "concluída" com skips ═══════
  const shouldBeHonest = formatSyncOutcome(withSkips);
  check("10.1 sem ledger + skips > 0 nunca diz 'concluída'",
    !shouldBeHonest.title.toLowerCase().includes("concluída"));

  // Edge: null summary
  const edge = formatSyncOutcome(null);
  check("11.1 summary null não crasha", edge.severity === "ok" && !!edge.title);

  // Edge: caixas.errors > 0 → partial (heurística)
  const withCaixaErr = { ...clean, caixas: { applied: 5, skippedNoStore: 0, errors: 2 } };
  check("11.2 caixas.errors > 0 conta como skip",
    formatSyncOutcome(withCaixaErr).severity === "partial");

  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) {
    const line = `  ${r.ok ? "✓" : "✗"} ${r.name}`;
    console.log(r.ok ? line : `${line} — ${r.detail ?? ""}`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
