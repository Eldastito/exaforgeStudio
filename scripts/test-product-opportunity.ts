/**
 * TEST — Inventory/Product Opportunity (PRD 11 / ADR-168 F11). DB-backed, determinístico.
 * Prova: produto em estoque + alta margem + vendendo pouco → candidato → sinal em
 * business_signals (D7, sem tabela paralela); dinheiro role-gated (sinal só qualitativo,
 * candidates() traz absoluto); grounding (sem custo/estoque não entra); idempotência; isolamento.
 *
 * Uso: npm run test:product-opportunity
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-prodopp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-prodopp-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProductOpportunityService: PO } = await import("../src/server/ProductOpportunityService.js");

  const org = `org_po_${randomUUID().slice(0, 8)}`;
  const orgB = `org_po_${randomUUID().slice(0, 8)}`;
  for (const o of [org, orgB]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);

  const product = (o: string, name: string, price: number) => { const id = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', ?, ?, 1)`).run(id, o, name, price); return id; };
  const stock = (o: string, pid: string, qty: number, avgCost: number) => db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), o, pid, qty, avgCost);
  const sell = (o: string, pid: string, times: number) => { const oid = randomUUID(); db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'pago', 100)`).run(oid, o); for (let i = 0; i < times; i++) db.prepare(`INSERT INTO order_items (id, order_id, organization_id, product_service_id, name_snapshot, unit_price, quantity, line_total) VALUES (?, ?, ?, ?, 'x', 100, 1, 100)`).run(randomUUID(), oid, o, pid); };

  const pHigh = product(org, "Camisa linho premium", 100); stock(org, pHigh, 10, 40);   // margem 60% em estoque, sem venda
  const pSelling = product(org, "Best-seller", 100); stock(org, pSelling, 10, 40); sell(org, pSelling, 3); // alta margem MAS vende
  const pLow = product(org, "Comodite", 100); stock(org, pLow, 10, 90);              // margem 10% → baixa
  const pNoCost = product(org, "Sem custo", 100); stock(org, pNoCost, 10, 0);         // custo desconhecido
  const pNoStock = product(org, "Esgotado", 100); stock(org, pNoStock, 0, 40);        // sem estoque

  // ── 1. Candidatos: só o alta-margem em estoque e sem venda ──
  const cands = PO.candidates(org);
  const ids = cands.map((c: any) => c.productId);
  check("1.1 pHigh é candidato", ids.includes(pHigh));
  check("1.2 pSelling NÃO (está vendendo)", !ids.includes(pSelling));
  check("1.3 pLow NÃO (margem baixa)", !ids.includes(pLow));
  check("1.4 pNoCost NÃO (custo desconhecido — grounding)", !ids.includes(pNoCost));
  check("1.5 pNoStock NÃO (sem estoque)", !ids.includes(pNoStock));
  const hc = cands.find((c: any) => c.productId === pHigh)!;
  check("1.6 candidates() traz números ABSOLUTOS (role-gated)", hc.margin === 60 && hc.marginPct === 0.6 && hc.marginBand === "high");

  // ── 2. match publica na espinha (business_signals) sem R$ no sinal (RN-CG-06) ──
  const m = PO.match(org, { publish: true });
  check("2.1 publicou 1 oportunidade", m.matched === 1 && m.opportunities[0].productId === pHigh);
  const sig = db.prepare(`SELECT signal_type, impact_amount, evidence_json, basis FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(org, `product_opportunity:${pHigh}`) as any;
  check("2.2 sinal product_opportunity na espinha", sig?.signal_type === "product_opportunity");
  check("2.3 NUNCA inventa dinheiro (impact null)", sig?.impact_amount === null);
  check("2.4 basis hypothesis (PUBLISHED≠RESULTADO)", sig?.basis === "hypothesis");
  check("2.5 sinal carrega marginBand qualitativo, NÃO o R$ absoluto", /marginBand/.test(sig?.evidence_json || "") && !/avgCost|"margin":|"price":/.test(sig?.evidence_json || ""));

  // ── 3. Idempotência (dedupe — não duplica sinal) ──
  PO.match(org, { publish: true });
  const cnt = db.prepare(`SELECT COUNT(*) AS n FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(org, `product_opportunity:${pHigh}`) as any;
  check("3.1 re-match não duplica o sinal", Number(cnt.n) === 1);

  // ── 4. dry-run (sem publish) não escreve sinal ──
  const org2 = orgB;
  const p2 = product(org2, "Alta margem B", 200); stock(org2, p2, 5, 50); // 75% margem
  const dry = PO.match(org2, { publish: false });
  check("4.1 dry-run devolve candidato", dry.matched === 1 && dry.opportunities[0].signalId === "");
  check("4.2 dry-run não escreve sinal", Number((db.prepare(`SELECT COUNT(*) AS n FROM business_signals WHERE organization_id = ?`).get(org2) as any).n) === 0);

  // ── 5. Isolamento multi-tenant ──
  check("5.1 org B não vê produto de A", !PO.candidates(org2).some((c: any) => c.productId === pHigh));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} product-opportunity: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
