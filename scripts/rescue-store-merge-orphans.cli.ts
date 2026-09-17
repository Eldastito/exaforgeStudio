/**
 * RESGATE — dados órfãos de merges de loja feitos ANTES da correção do
 * RetailStoreService.remove (escala, malote, cotas, lotação, boletas, vendas,
 * custos, PDV… que ficaram apontando pro store_id apagado e "sumiram").
 *
 * Lê os eventos RETAIL_STORE_MERGED_DELETED do audit e re-aponta os órfãos
 * pra loja sobrevivente. NÃO apaga nada: conflito fica no lugar e sai no
 * relatório. Idempotente — rodar de novo encontra 0 órfãos.
 *
 * Uso (dev):       npm run rescue:store-merge-orphans            ← DRY-RUN (só relata)
 *                  npm run rescue:store-merge-orphans -- --apply ← grava
 * Uso (produção):  node dist/rescue-store-merge-orphans.cjs [--apply] [--org <id>]
 *                  (rodar no host com o MESMO DATA_DIR do servidor)
 */
async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const orgIdx = args.indexOf("--org");
  const organizationId = orgIdx >= 0 ? args[orgIdx + 1] || null : null;

  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const res = RetailStoreService.rescueMergeOrphans({ apply, organizationId });

  console.log(`\n=== Resgate de órfãos de merge de loja — ${apply ? "APPLY (gravando)" : "DRY-RUN (nada foi alterado)"} ===\n`);
  if (!res.merges.length) {
    console.log("Nenhum evento RETAIL_STORE_MERGED_DELETED no audit — nada a resgatar.");
    return;
  }
  for (const m of res.merges) {
    console.log(`Merge em ${m.mergedAt} · org ${m.orgId}`);
    console.log(`  loja apagada: ${m.oldName || "?"} (${m.oldId}) → sobrevivente: ${m.newName || "?"} (${m.newId})`);
    if (m.status !== "ok") { console.log(`  ${m.status}\n`); continue; }
    if (!m.tables.length) { console.log("  sem órfãos — nada a fazer.\n"); continue; }
    for (const t of m.tables) {
      const tail = apply ? ` → movidos ${t.moved}${t.leftover ? `, ficaram ${t.leftover} (conflito — nada apagado)` : ""}` : "";
      console.log(`  ${t.table}.${t.column}: ${t.orphans} órfão(s)${tail}`);
    }
    console.log(`  TOTAL: ${m.totalOrphans} órfão(s)${apply ? ` · movidos ${m.moved} · deixados ${m.leftover}` : " (rode com --apply pra mover)"}\n`);
  }
  if (!apply) console.log("Dry-run: confira o relatório acima e rode com --apply pra efetivar.");
}

main().catch((e) => { console.error(e); process.exit(1); });
