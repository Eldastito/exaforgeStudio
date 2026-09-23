/**
 * TESTE — Conferência de valores por loja/dia (caso Toulon, Av. Brasil 19/09/26).
 * ----------------------------------------------------------------------------
 * O dia real: Clover R$ 4.676,70 (débito 3.108,10 + crédito 1.178,90 + PIX
 * 389,70) + R$ 800,00 em dinheiro = R$ 5.476,70; a folha somou os vendedores
 * em R$ 5.476,80 (R$ 0,10 de diferença) e o gerente lançou crédito e débito
 * TROCADOS (as bandeiras de débito do comprovante escritas na coluna crédito
 * e vice-versa). Prova:
 *   - submitDetailed: linha "LOJA" fora do rankingTotal/rankingGap (o gap
 *     passa a acusar exatamente os R$ 0,10, não o dobro do total) e
 *     posSwapSuspect quando cada lado bate com o lado OPOSTO do POS;
 *   - RetailMoneyAuditService.day: deltas em centavos e indícios nomeados
 *     (fechamento_vs_alterdata, vendas_pdv_vs_resumo_caixa, ranking a R$ 0,10,
 *     credito_debito_trocados, filial órfã), sem gravar nada;
 *   - isolamento por organização.
 *
 * Uso:  npm run test:retail-money-audit
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-money-audit-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-money-audit-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailQuotaService, RetailClosingService } = await import("../src/server/RetailOpsService.js");
  const { RetailMoneyAuditService } = await import("../src/server/RetailMoneyAuditService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const loja = RetailStoreService.create(A, { name: "Avenida Brasil", code: "160" });
  const DATE = "2026-09-19";
  RetailQuotaService.set(A, { storeId: loja.id, quotaDate: DATE, quotaAmount: 5200 }, "tester");

  // ── 1. submitDetailed com os números REAIS da folha de 19/09 ──────────────
  // Crédito/débito lançados TROCADOS (como na folha) e comprovante POS certo.
  const c = RetailClosingService.submitDetailed(A, loja.id, DATE, {
    dinheiro: 800, pix: 389.70,
    credito: { Master: 1678.80, Visa: 1229.30, Elo: 200.00 },  // ← débito real do POS
    debito: { Redshop: 139.90, Eletron: 1039.00 },             // ← crédito real do POS
    despesas: [],
    ranking: [
      { sellerName: "Leandro", valor: 2169.30, atendimentos: 5, pecas: 15 },
      { sellerName: "Viny", valor: 1368.70, atendimentos: 5, pecas: 16 },
      { sellerName: "Luiz", valor: 1938.80, atendimentos: 5, pecas: 16 },
      { sellerName: "LOJA", valor: 5476.80, atendimentos: 15, pecas: 47 },  // linha de total da folha
    ],
    pos: { creditoValor: 1178.90, creditoQtd: 5, debitoValor: 3108.10, debitoQtd: 12 },
  }, { source: "manual" }, "tester");
  const derived = JSON.parse(c.details_json).derived;
  check("1.1 informado derivado = 5.476,70 (dinheiro+pix+cartões)", Number(c.informed_total) === 5476.70, `informed=${c.informed_total}`);
  check("1.2 linha LOJA fora do rankingTotal (5.476,80, não 10.953,60)", derived.rankingTotal === 5476.80, `rankingTotal=${derived.rankingTotal}`);
  check("1.3 rankingGap acusa exatamente os R$ 0,10 da folha", derived.rankingGap === -0.10, `gap=${derived.rankingGap}`);
  check("1.4 crédito×débito trocados detectado (cada lado bate com o oposto do POS)", derived.posSwapSuspect === true, JSON.stringify({ cred: derived.posGapCredito, deb: derived.posGapDebito }));
  const ranking = JSON.parse(c.details_json).ranking;
  check("1.5 linha LOJA não entra como vendedor no ranking salvo", Array.isArray(ranking) && ranking.length === 3 && !ranking.some((r: any) => /loja/i.test(r.sellerName)));
  check("1.6 sync não criou venda da linha LOJA", (db.prepare(`SELECT COUNT(*) n FROM retail_seller_sales WHERE organization_id = ? AND store_id = ? AND sale_date = ?`).get(A, loja.id, DATE) as any).n === 3);

  // POS digitado certo (sem troca) não dispara a suspeita.
  const ok = RetailClosingService.submitDetailed(A, loja.id, DATE, {
    dinheiro: 800, pix: 389.70,
    credito: { Visa: 1039.00, Master: 139.90 }, debito: { Master: 1678.80, Visa: 1229.30, Elo: 200.00 },
    despesas: [], ranking: [{ sellerName: "Leandro", valor: 5476.70, atendimentos: 15, pecas: 47 }],
    pos: { creditoValor: 1178.90, creditoQtd: 5, debitoValor: 3108.10, debitoQtd: 12 },
  }, { source: "manual" }, "tester");
  const derivedOk = JSON.parse(ok.details_json).derived;
  check("1.7 lançamento correto: sem falso positivo de troca", derivedOk.posSwapSuspect === false && Math.abs(derivedOk.posGapCredito) <= 0.01 && Math.abs(derivedOk.posGapDebito) <= 0.01, JSON.stringify(derivedOk));

  // ── 2. Conferência do dia (leitura Alterdata PARCIAL, como no caso real) ──
  // Reaplica a folha trocada (o cenário reclamado) e simula o resumo parcial.
  RetailClosingService.submitDetailed(A, loja.id, DATE, {
    dinheiro: 800, pix: 389.70,
    credito: { Master: 1678.80, Visa: 1229.30, Elo: 200.00 }, debito: { Redshop: 139.90, Eletron: 1039.00 },
    despesas: [],
    ranking: [
      { sellerName: "Leandro", valor: 2169.30, atendimentos: 5, pecas: 15 },
      { sellerName: "Viny", valor: 1368.70, atendimentos: 5, pecas: 16 },
      { sellerName: "Luiz", valor: 1938.80, atendimentos: 5, pecas: 16 },
      { sellerName: "LOJA", valor: 5476.80, atendimentos: 15, pecas: 47 },
    ],
    pos: { creditoValor: 1178.90, creditoQtd: 5, debitoValor: 3108.10, debitoQtd: 12 },
  }, { source: "manual" }, "tester");
  // "Total de Vendas" parcial do ResumoFecharMovimento (TEF ainda não caiu):
  // 800 + 389,70 + 1.178,90 = 2.368,60 — o número real do print da cliente.
  db.prepare(`UPDATE retail_daily_closings SET system_total = 2368.60, system_turnos_json = ? WHERE organization_id = ? AND store_id = ? AND closing_date = ?`)
    .run(JSON.stringify({ "1": 2368.60 }), A, loja.id, DATE);
  // Boletas do PDV do dia (a fonte granular conhece as vendas): 5.476,70 − 800 em dinheiro fora do terminal? Não — boletas cobrem o dia todo.
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor, status) VALUES (?, ?, '160', '1', ?, 'V1', 3000, 'N')`).run(randomUUID(), A, DATE);
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor, status) VALUES (?, ?, '160', '2', ?, 'V2', 2476.70, 'N')`).run(randomUUID(), A, DATE);
  // Filial órfã: boleta numa filial sem loja ativa cadastrada.
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor, status) VALUES (?, ?, '999', '9', ?, 'V9', 111.11, 'N')`).run(randomUUID(), A, DATE);

  const audit = RetailMoneyAuditService.day(A, DATE);
  const row = audit.stores.find((s: any) => s.storeId === loja.id);
  check("2.1 informado 5.476,70 × sistema 2.368,60 lado a lado", row.closing.informed === 5476.70 && row.closing.system === 2368.60, JSON.stringify(row.closing));
  check("2.2 delta informado−sistema = 3.108,10 (o débito ausente do resumo)", row.differences.informedVsSystem === 3108.10, `${row.differences.informedVsSystem}`);
  check("2.3 indício fechamento_vs_alterdata presente", row.issues.includes("fechamento_vs_alterdata"), row.issues.join(","));
  check("2.4 indício vendas_pdv_vs_resumo_caixa (boletas 5.476,70 ≠ resumo 2.368,60)", row.issues.includes("vendas_pdv_vs_resumo_caixa") && row.sources.pdv.total === 5476.70, JSON.stringify(row.sources.pdv));
  check("2.5 ranking da folha sem a linha LOJA e a R$ 0,10 do informado", row.closing.ranking === 5476.80 && row.differences.rankingVsInformed === 0.10 && row.issues.includes("ranking_vs_fechamento"), JSON.stringify({ r: row.closing.ranking, d: row.differences.rankingVsInformed }));
  check("2.6 indício credito_debito_trocados vindo do derived", row.issues.includes("credito_debito_trocados"), row.issues.join(","));
  check("2.7 sobreposição PDV × manual sinalizada", row.issues.includes("fontes_fisicas_sobrepostas"));
  check("2.8 cota do dia na linha", row.closing.quota === 5200);
  check("2.9 filial órfã 999 listada com o valor", audit.orphanFiliais.length === 1 && audit.orphanFiliais[0].filial === "999" && audit.orphanFiliais[0].total === 111.11, JSON.stringify(audit.orphanFiliais));

  // ── 3. Diferença de exatamente R$ 0,01 também gera indício ──
  const loja2 = RetailStoreService.create(A, { name: "Carioca", code: "159" });
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total, system_turnos_json) VALUES (?, ?, ?, ?, 'received', 100.01, 100.00, ?)`)
    .run(randomUUID(), A, loja2.id, DATE, JSON.stringify({ "1": 100.00 }));
  const row2 = RetailMoneyAuditService.day(A, DATE).stores.find((s: any) => s.storeId === loja2.id);
  check("3.1 R$ 0,01 de diferença não passa em branco", row2.differences.informedVsSystem === 0.01 && row2.issues.includes("fechamento_vs_alterdata"), JSON.stringify(row2.differences));

  // ── 4. Isolamento ──
  const auditB = RetailMoneyAuditService.day(B, DATE);
  check("4.1 org B vem vazia", auditB.stores.length === 0 && auditB.orphanFiliais.length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-money-audit: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
