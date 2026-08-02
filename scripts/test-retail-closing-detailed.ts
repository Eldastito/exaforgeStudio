/**
 * TESTE — Fechamento noturno completo (ADR-083 Fase C2, padrão da folha).
 * ---------------------------------------------------------------------------
 * A rotina real da loja: à noite, no fechamento, a equipe preenche a FOLHA —
 * dinheiro/PIX, crédito e débito POR BANDEIRA, despesas, ranking por vendedor
 * (valor / AT / peças), cadastros, boleta inicial/final, malote — e grampeia o
 * resumo do POS. Prova:
 *   - bandeiras default (as da folha) e configuráveis por loja;
 *   - submitDetailed deriva o total (dinheiro+pix+bandeiras), calcula desvio
 *     vs cota e grava as conferências: ranking × total (linha LOJA) e
 *     POS × cartões (comprovante grampeado) — divergência NÃO bloqueia;
 *   - na APROVAÇÃO, o ranking vira retail_seller_sales (source='closing') com
 *     AT — a mesma base da comissão/corrida — idempotente e sem tocar nos
 *     lançamentos manuais; matrícula resolvida por nome único;
 *   - scan por foto (extrator injetável) com a extração RICA (bandeiras/
 *     ranking/despesas/boletas/POS) pré-preenche o details_json;
 *   - audit + isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-closing-detailed
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-closing-det-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-closing-detailed-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const round2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailQuotaService, RetailClosingService, __setClosingExtractorForTests } = await import("../src/server/RetailOpsService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const loja = RetailStoreService.create(A, { name: "Nova Iguaçu", code: "2" });
  const DATE = "2026-07-31";
  RetailQuotaService.set(A, { storeId: loja.id, quotaDate: DATE, quotaAmount: 2300 }, "tester");

  // ── Bandeiras ──────────────────────────────────────────────────────────────
  const def = RetailClosingService.getCardBrands(A, loja.id);
  check("Bandeiras default = as da folha (crédito Amex/Master/Visa/Elo)", JSON.stringify(def.credito) === JSON.stringify(["Amex", "Master", "Visa", "Elo"]));
  check("Bandeiras default débito Redshop/Eletron/Elo", JSON.stringify(def.debito) === JSON.stringify(["Redshop", "Eletron", "Elo"]));
  RetailClosingService.setCardBrands(A, loja.id, { credito: ["Visa", "Master"], debito: ["Elo"] }, "tester");
  const cfg = RetailClosingService.getCardBrands(A, loja.id);
  check("Bandeiras configuráveis por loja", JSON.stringify(cfg.credito) === JSON.stringify(["Visa", "Master"]) && JSON.stringify(cfg.debito) === JSON.stringify(["Elo"]));
  let threw = false;
  try { RetailClosingService.setCardBrands(A, loja.id, { credito: [], debito: [] }, "tester"); } catch { threw = true; }
  check("Config vazia de bandeiras é rejeitada", threw);

  // ── submitDetailed — a folha do dia 31/07 (números reais da foto) ─────────
  const c = RetailClosingService.submitDetailed(A, loja.id, DATE, {
    dinheiro: 0, pix: 0,
    credito: { Visa: 1379.30 },
    debito: { Eletron: 469.80 },
    despesas: [{ descricao: "Água mineral", valor: 12.5 }, { descricao: "", valor: 99 }, { descricao: "sem valor", valor: 0 }],
    ranking: [
      { sellerName: "Rafaela", valor: 1199.40, atendimentos: 2, pecas: 3 },
      { sellerName: "Estefânio", valor: 449.80, atendimentos: 1, pecas: 2 },
      { sellerName: "Raissa", valor: 199.90, atendimentos: 1, pecas: 1 },
      { sellerName: "", valor: 999 },
    ],
    cadastros: 3, boletaInicial: "017752", boletaFinal: "017757", malote: "M-102",
    pos: { creditoValor: 1379.30, creditoQtd: 4, debitoValor: 469.80, debitoQtd: 2 },
  }, {}, "tester");
  const det = JSON.parse(c.details_json);
  check("Total derivado = crédito + débito (1.849,10)", Number(c.informed_total) === 1849.1, `informed=${c.informed_total}`);
  check("Desvio vs cota calculado (1.849,10 − 2.300 = −450,90)", round2(Number(c.variance_amount)) === -450.9, `var=${c.variance_amount}`);
  check("Status recebido (aguarda aprovação humana)", c.status === "received");
  check("Despesas: só linhas válidas entram (1 de 3)", det.despesas.length === 1 && det.derived.totalDespesas === 12.5, JSON.stringify(det.despesas));
  check("Ranking: linha sem nome é descartada (3 de 4)", det.ranking.length === 3);
  check("Conferência linha LOJA: ranking soma o total (gap 0)", det.derived.rankingGap === 0, `gap=${det.derived.rankingGap}`);
  check("Conferência POS: cartões batem (gaps 0)", det.derived.posGapCredito === 0 && det.derived.posGapDebito === 0, JSON.stringify(det.derived));
  check("Boletas/cadastros/malote preservados", det.boletaInicial === "017752" && det.boletaFinal === "017757" && det.cadastros === 3 && det.malote === "M-102");
  const items = db.prepare(`SELECT payment_method, informed_amount FROM retail_daily_closing_items WHERE closing_id = ? ORDER BY payment_method`).all(c.id) as any[];
  check("Items agregados por forma (credito+debito)", items.length === 2 && items.find((i) => i.payment_method === "credito")?.informed_amount === 1379.3, JSON.stringify(items));

  // Divergência ranking × total NÃO bloqueia, só marca.
  const c2 = RetailClosingService.submitDetailed(A, loja.id, DATE, {
    dinheiro: 100, credito: { Visa: 900 },
    ranking: [{ sellerName: "Rafaela", valor: 700 }],
  }, {}, "tester");
  const det2 = JSON.parse(c2.details_json);
  check("Divergência ranking × total vira flag (300), não erro", det2.derived.rankingGap === 300 && c2.status === "received", `gap=${det2.derived.rankingGap}`);

  // ── Aprovação → ranking vira vendas por vendedor (source='closing') ───────
  // Regrava a folha boa antes de aprovar (o submitDetailed é upsert do dia).
  RetailClosingService.submitDetailed(A, loja.id, DATE, {
    credito: { Visa: 1379.30 }, debito: { Eletron: 469.80 },
    ranking: [
      { sellerName: "Rafaela", valor: 1199.40, atendimentos: 2, pecas: 3 },
      { sellerName: "Estefânio", valor: 449.80, atendimentos: 1, pecas: 2 },
      { sellerName: "Raissa", valor: 199.90, atendimentos: 1, pecas: 1 },
    ],
  }, {}, "tester");
  // Vendedora cadastrada com nome único → matrícula resolvida; e um lançamento
  // MANUAL pré-existente que NÃO pode ser tocado pelo sync.
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'R1', 'Rafaela')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, valor, pecas, source) VALUES (?, ?, ?, ?, 'Lançamento Manual', 50, 1, 'manual')`).run(randomUUID(), A, loja.id, DATE);

  RetailClosingService.setStatus(A, c.id, "approved", "tester");
  const synced = RetailClosingService.syncRankingToSellerSales(A, c.id, "tester");
  check("Sync devolve as 3 linhas do ranking", synced === 3);
  const sales = db.prepare(`SELECT seller_name, matricula, valor, pecas, atendimentos, source FROM retail_seller_sales WHERE organization_id = ? AND store_id = ? AND sale_date = ? ORDER BY seller_name`).all(A, loja.id, DATE) as any[];
  check("4 linhas no dia: 3 do fechamento + 1 manual intocada", sales.length === 4 && sales.filter((s) => s.source === "closing").length === 3, JSON.stringify(sales.map((s) => s.source)));
  const raf = sales.find((s) => s.seller_name === "Rafaela");
  check("Rafaela com matrícula resolvida por nome único (R1) + AT", raf?.matricula === "R1" && raf?.atendimentos === 2 && raf?.valor === 1199.4, JSON.stringify(raf));
  const est = sales.find((s) => s.seller_name === "Estefânio");
  check("Estefânio sem cadastro → sem matrícula (não chuta)", est?.matricula == null);
  // Idempotência: re-sync não duplica.
  RetailClosingService.syncRankingToSellerSales(A, c.id, "tester");
  const salesAgain = db.prepare(`SELECT COUNT(*) n FROM retail_seller_sales WHERE organization_id = ? AND store_id = ? AND sale_date = ?`).get(A, loja.id, DATE) as any;
  check("Re-sync substitui (não duplica): continuam 4 linhas", Number(salesAgain.n) === 4, `n=${salesAgain.n}`);

  // ── Scan por foto com extração RICA (extrator injetável) ──────────────────
  const rich = {
    dinheiro: 0, pix: 0, credito: 1379.30, debito: 469.80, total: 1849.10,
    creditoBandeiras: { Visa: 1379.30 }, debitoBandeiras: { Eletron: 469.80 },
    despesas: [{ descricao: "Café", valor: 8 }],
    ranking: [{ nome: "Rafaela", valor: 1199.40, atendimentos: 2, pecas: 3 }],
    cadastros: 3, boletaInicial: "017752", boletaFinal: "017757", malote: null,
    pos: { creditoValor: 1379.30, creditoQtd: 4, debitoValor: 469.80, debitoQtd: 2 },
    confidence: 92,
  };
  __setClosingExtractorForTests(async () => JSON.stringify(rich));
  const DATE2 = "2026-08-01";
  RetailQuotaService.set(A, { storeId: loja.id, quotaDate: DATE2, quotaAmount: 3000 }, "tester");
  const scan = await RetailClosingService.submitFromImage(A, loja.id, DATE2, "fake64", "image/jpeg", { source: "image_ocr" }, "tester");
  check("Scan rico: status extracted (confiança 92)", scan?.closing?.status === "extracted", `status=${scan?.closing?.status}`);
  const detScan = JSON.parse(scan!.closing.details_json || "null");
  check("Scan rico grava details_json (bandeiras + ranking + POS)", detScan?.credito?.Visa === 1379.3 && detScan?.ranking?.[0]?.sellerName === "Rafaela" && detScan?.pos?.creditoQtd === 4, JSON.stringify(detScan?.derived));
  check("Scan rico: AT do ranking preservado", detScan?.ranking?.[0]?.atendimentos === 2);
  // Folha antiga (sem campos ricos) continua funcionando como antes.
  __setClosingExtractorForTests(async () => JSON.stringify({ dinheiro: 100, pix: 50, total: 150, confidence: 90 }));
  const DATE3 = "2026-08-02";
  const scanOld = await RetailClosingService.submitFromImage(A, loja.id, DATE3, "fake64", "image/jpeg", {}, "tester");
  check("Folha simples (sem campos ricos): sem details_json, totais ok", scanOld?.closing?.details_json == null && Number(scanOld?.closing?.informed_total) === 150, `det=${scanOld?.closing?.details_json}`);
  __setClosingExtractorForTests(null);

  // ── Audit ─────────────────────────────────────────────────────────────────
  const audit = db.prepare(`SELECT DISTINCT event_type FROM auth_audit_logs WHERE organization_id = ?`).all(A) as any[];
  const has = (t: string) => audit.some((a) => a.event_type === t);
  check("Audit: detailed, bandeiras e sync auditados", has("RETAIL_CLOSING_DETAILED") && has("RETAIL_CARD_BRANDS_SET") && has("RETAIL_CLOSING_RANKING_SYNCED"), JSON.stringify(audit.map((a) => a.event_type)));

  // ── Isolamento multi-tenant ───────────────────────────────────────────────
  check("Org B não lê bandeiras da loja da org A (cai no default)", JSON.stringify(RetailClosingService.getCardBrands(B, loja.id).credito) === JSON.stringify(["Amex", "Master", "Visa", "Elo"]));
  check("Org B não enxerga o fechamento da org A", RetailClosingService.get(B, c.id) == null);
  check("Org B não sincroniza ranking da org A", RetailClosingService.syncRankingToSellerSales(B, c.id, "tester") === 0);
  const salesB = db.prepare(`SELECT COUNT(*) n FROM retail_seller_sales WHERE organization_id = ?`).get(B) as any;
  check("Org B sem vendas por vendedor vazadas", Number(salesB.n) === 0);

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} PASS`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
