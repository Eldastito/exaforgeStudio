/**
 * TESTE — PRD Fase 1, F1.3: política de estoque TOULON (fim de coleção) + diagnóstico do estoque negativo.
 * Prova: default = 'continuous_replenishment' (0-regressão: produto que rompe continua virando padrão/sinal de
 * recompra); em 'collection_sellout' produto que zera NÃO gera sugestão de recompra — EXCETO a peça com política
 * de estoque (a exceção do dono); a OPORTUNIDADE DE TRANSFERÊNCIA não é silenciada; estratégia inválida é
 * recusada; isolamento por org. Diagnóstico do negativo: classifica só o que os dados provam (transferência a
 * caminho · sem nenhuma entrada · saldo parado ≥30 dias), o resto é 'unknown', agrupado por causa × loja com o
 * resumo "N ocorrências em M lojas"; respeita filtro de loja e a trava de loja do usuário; isolamento.
 * Uso:  npm run test:retail-replenishment-strategy
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-replstrat-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-replstrat-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PatternMemoryService } = await import("../src/server/PatternMemoryService.js");
  const { InventoryPatternMemory } = await import("../src/server/InventoryPatternMemory.js");
  const { RetailReplenishmentStrategyService: R } = await import("../src/server/RetailReplenishmentStrategyService.js");
  const { RetailStockPolicyService } = await import("../src/server/RetailStockPolicyService.js");
  const { NegativeStockDiagnosisService: N } = await import("../src/server/NegativeStockDiagnosisService.js");

  const noLLM = async () => null;
  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  PatternMemoryService.setEnabled(A, true);
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const product = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', ?, 50, 1, 1)`).run(id, org, name); return id; };
  const mov = (org: string, pid: string, type: string, qty: number, day: number) =>
    db.prepare(`INSERT INTO stock_movements (id, organization_id, product_service_id, type, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, pid, type, qty, `${daysAgo(day)} 10:00:00`);
  const breaks = (org: string, pid: string) => { for (let k = 0; k < 4; k++) { const base = 75 - k * 15; mov(org, pid, "entrada", 10, base); mov(org, pid, "saida", 10, base - 2); } };

  // produto que zera 4x (ruptura recorrente) SEM meta e outro com meta (exceção)
  const basico = product(A, "Camisa Básica"), colecao = product(A, "Vestido Coleção");
  breaks(A, basico); breaks(A, colecao);
  RetailStockPolicyService.set(A, { productId: basico, minQty: 5, targetQty: 20 } as any);

  check("default = continuous_replenishment (0-regressão)", R.strategy(A) === "continuous_replenishment" && R.suggestsRepurchase(A, colecao) === true);
  const rDefault = await InventoryPatternMemory.learnPass(A, { asOf: today, hypothesizer: noLLM as any });
  check("default: os 2 produtos que rompem viram padrão (comportamento de sempre)", rDefault.detected === 2, JSON.stringify(rDefault));

  // limpa e troca de estratégia
  db.prepare(`DELETE FROM business_patterns WHERE organization_id = ?`).run(A);
  db.prepare(`DELETE FROM business_signals WHERE organization_id = ?`).run(A);
  R.setStrategy(A, "collection_sellout", "u1");
  check("estratégia persistida", R.strategy(A) === "collection_sellout" && R.strategy(B) === "continuous_replenishment");
  check("fim de coleção: produto SEM meta não sugere recompra; com meta (exceção) continua", R.suggestsRepurchase(A, colecao) === false && R.suggestsRepurchase(A, basico) === true);
  const rSell = await InventoryPatternMemory.learnPass(A, { asOf: today, hypothesizer: noLLM as any });
  const pats = PatternMemoryService.list(A, { domain: "inventory" });
  check("fim de coleção: só a peça com meta (exceção) vira padrão; o produto de coleção que zerou NÃO", rSell.detected === 1 && pats.length === 1 && pats[0].scope_id === basico, JSON.stringify([rSell.detected, pats.map((p: any) => p.scope_id)]));
  check("...e nenhum sinal de recompra do produto de coleção", !(db.prepare(`SELECT 1 FROM business_signals WHERE organization_id = ? AND signal_type = 'produto_ruptura_recorrente' AND source_entity_id = ?`).get(A, colecao)));

  let bad = false; try { R.setStrategy(A, "qualquer"); } catch { bad = true; }
  check("estratégia inválida é recusada", bad && R.strategy(A) === "collection_sellout");
  R.setStrategy(A, "continuous_replenishment");
  check("voltar ao contínuo reativa a sugestão (reversível)", R.suggestsRepurchase(A, colecao) === true);

  // a oportunidade de transferência NÃO depende da estratégia (serviço separado e intocado)
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/RetailFloorReplenishmentService.ts"), "utf8");
  check("guardrail: a oportunidade de transferência não consulta a estratégia (zerou+sobra em outra loja segue valendo)", !/RetailReplenishmentStrategyService|collection_sellout/.test(src));

  // ── diagnóstico do negativo ──
  const store = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, name.slice(0, 4)); return id; };
  const carioca = store(A, "Carioca"), bangu = store(A, "Bangu"), grande = store(A, "Grande Rio"), so = store(B, "Loja B");
  const neg = (org: string, st: string, pid: string, qty: number, updated = "now") =>
    db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, variant_id, quantity_available, updated_at) VALUES (?, ?, ?, ?, '', ?, ${updated === "now" ? "CURRENT_TIMESTAMP" : "?"})`).run(...[randomUUID(), org, st, pid, qty, ...(updated === "now" ? [] : [updated])]);
  const pTransit = product(A, "P em trânsito"), pNoEntry = product(A, "P sem entrada"), pStale = product(A, "P parado"), pUnknown = product(A, "P sem pista");
  for (const p of [pTransit, pStale, pUnknown]) mov(A, p, "entrada", 10, 40);      // têm entrada registrada; pNoEntry não tem nenhuma
  // transferência a caminho pro Carioca com pTransit
  const tid = randomUUID();
  db.prepare(`INSERT INTO retail_stock_transfers (id, organization_id, origin_store_id, dest_store_id, status) VALUES (?, ?, ?, ?, 'in_transit')`).run(tid, A, bangu, carioca);
  db.prepare(`INSERT INTO retail_stock_transfer_items (id, organization_id, transfer_id, product_service_id, quantity_sent) VALUES (?, ?, ?, ?, 3)`).run(randomUUID(), A, tid, pTransit);
  neg(A, carioca, pTransit, -2);                 // → transfer_in_transit
  neg(A, carioca, pNoEntry, -1); neg(A, grande, pNoEntry, -4);   // → no_entry_registered (2 lojas)
  neg(A, grande, pStale, -1, "2026-01-01 10:00:00");             // → stale_balance
  neg(A, bangu, pUnknown, -1);                                   // → unknown (tem entrada, saldo recente, sem transferência)
  db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, '', 7)`).run(randomUUID(), A, bangu, pUnknown + "x");  // positivo: ignorado
  neg(B, so, product(B, "P B"), -9);

  const dg = N.diagnose(A, { now: new Date("2026-09-30T12:00:00Z") });
  const by = (c: string) => dg.byCause.find((x: any) => x.cause === c);
  check("total e lojas corretos (5 ocorrências em 3 lojas; positivo e outra org ignorados)", dg.total === 5 && dg.storeCount === 3, JSON.stringify([dg.total, dg.storeCount]));
  check("transferência a caminho identificada (Carioca)", by("transfer_in_transit")?.count === 1 && by("transfer_in_transit")?.stores[0].storeName === "Carioca");
  check("sem nenhuma entrada identificada, agrupada por loja (2 lojas)", by("no_entry_registered")?.count === 2 && by("no_entry_registered")?.stores.length === 2);
  check("saldo parado ≥30 dias identificado", by("stale_balance")?.count === 1);
  check("sem evidência = 'unknown' (não chuta causa) e vem por último", by("unknown")?.count === 1 && dg.byCause[dg.byCause.length - 1].cause === "unknown");
  check("3 causas identificadas (unknown não conta) e resumo em linguagem do gestor, na MESMA unidade (ocorrências: 4 com causa + 1 sem = 5)", dg.causeCount === 3 && /^5 ocorrências em 3 lojas · 4 com causa identificada · 1 sem causa provada$/.test(dg.headline || ""), dg.headline || "");
  const onlyCarioca = N.diagnose(A, { storeId: carioca });
  check("filtro de loja: só as ocorrências da loja", onlyCarioca.total === 2 && onlyCarioca.storeCount === 1);
  const scoped = N.diagnose(A, { restrictStoreIds: [grande] });
  check("trava de loja do usuário: só enxerga as lojas permitidas", scoped.total === 2 && scoped.byCause.every((c: any) => c.stores.every((s: any) => s.storeId === grande)));
  check("sem negativo = vazio e sem resumo", N.diagnose(`org_vazia_${randomUUID().slice(0, 4)}`).total === 0 && N.diagnose(`org_vazia_${randomUUID().slice(0, 4)}`).headline === null);
  check("isolamento: a org B vê só o dela", N.diagnose(B).total === 1 && N.diagnose(B).byCause[0].stores[0].storeName === "Loja B");

  console.log("\n=== PRD Fase 1 · F1.3: estratégia de reposição + diagnóstico do negativo ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
