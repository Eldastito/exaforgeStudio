/**
 * TESTE — Estoque negativo: clareza de leitura (itens × peças, ciclo único, dias em aberto).
 *
 * Origem: a TOULON trabalha cada coleção UMA vez (compra→recebe→vende→fim de ciclo). O aviso "303 un" era a CONTAGEM
 * de itens (cor/tamanho) rotulada como unidades, e o "recorrente" não faz sentido em ciclo único.
 *   1. sinal de ruptura: unidade "items" + evidência items/pieces (peças = soma do saldo negativo) — nunca "units";
 *   2. estratégia "fim de coleção" → evidência singleCycle e leitura "recebimento lançado depois da venda";
 *   3. padrão "estoque negativo recorrente" NÃO nasce em ciclo único (nasce na reposição contínua);
 *   4. `first_detected_at` sobrevive à ressincronização (detected_at não) e reinicia após resolver/reabrir;
 *   5. `listNegative` devolve `days_open` (null quando a data é desconhecida — nunca inventa).
 *
 * Uso:  npm run test:stock-negative-clarity
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-stock-neg-clarity-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-stock-neg-clarity-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailInventoryService } = await import("../src/server/RetailInventoryService.js");
  const { RetailOpsSignalPublisher } = await import("../src/server/RetailOpsSignalPublisher.js");
  const { RetailReplenishmentStrategyService } = await import("../src/server/RetailReplenishmentStrategyService.js");
  const { RetailPatternMemoryService } = await import("../src/server/RetailPatternMemoryService.js");
  const { presentSignal } = await import("../src/server/SignalLanguage.js");

  const today = new Date().toISOString().slice(0, 10);
  const mkOrg = (n: string) => {
    const id = `org_${n}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), id, n);
    return id;
  };
  const A = mkOrg("A"), B = mkOrg("B");
  const store = RetailStoreService.create(A, { name: "Loja 1", code: "1" });
  const prods = [randomUUID(), randomUUID(), randomUUID()];
  prods.forEach((p, i) => db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', ?, 100, 1)`).run(p, A, `Peça ${i + 1}`));
  // 3 itens negativos: -2, -5, -3 → 3 itens, 10 peças.
  RetailInventoryService.setQuantity(A, store.id, prods[0], null, -2);
  RetailInventoryService.setQuantity(A, store.id, prods[1], null, -5);
  RetailInventoryService.setQuantity(A, store.id, prods[2], null, -3);

  // ===== 1. unidade "items" + peças =====
  RetailOpsSignalPublisher.run(A, { asOf: today, windowDays: 3650 });
  const sig = () => db.prepare(`SELECT impact_amount, impact_unit, evidence_json FROM business_signals WHERE organization_id=? AND signal_type='retail_store_stockout' AND status='open'`).get(A) as any;
  const s1 = sig(); const ev1 = s1 ? JSON.parse(s1.evidence_json || "{}") : {};
  check("ruptura: unidade é 'items' (nunca 'units' — não são peças)", s1?.impact_unit === "items", JSON.stringify(s1));
  check("ruptura: impacto = 3 itens", Number(s1?.impact_amount) === 3);
  check("ruptura: evidência traz peças = soma do saldo negativo (10)", ev1.items === 3 && ev1.pieces === 10, JSON.stringify(ev1));
  check("reposição contínua (default): singleCycle=false", ev1.singleCycle === false);
  const p1 = presentSignal({ signalType: "retail_store_stockout", domain: "inventory", evidence: ev1 });
  check("texto: 3 itens (cor/tamanho) e 10 peças a menos", /3 itens \(cor\/tamanho\)/.test(p1.meaning) && /10 peças/.test(p1.meaning), p1.meaning);
  check("texto contínuo NÃO fala em ciclo único", !/uma vez só/.test(p1.meaning));
  const pNoEv = presentSignal({ signalType: "retail_store_stockout", domain: "inventory", evidence: {} });
  check("sem números na evidência → texto fixo antigo (não inventa)", /em geral é venda sem entrada/.test(pNoEv.meaning) && !/itens \(cor/.test(pNoEv.meaning));

  // ===== 2. ciclo único =====
  RetailReplenishmentStrategyService.setStrategy(A, "collection_sellout");
  RetailOpsSignalPublisher.run(A, { asOf: today, windowDays: 3650 });
  const ev2 = JSON.parse(sig().evidence_json || "{}");
  check("fim de coleção → evidência singleCycle=true", ev2.singleCycle === true, JSON.stringify(ev2));
  const p2 = presentSignal({ signalType: "retail_store_stockout", domain: "inventory", evidence: ev2 });
  check("texto de ciclo único: recebimento lançado depois da venda", /uma vez só/.test(p2.meaning) && /recebimento/.test(p2.meaning), p2.meaning);
  check("ação de ciclo único: conferir recebimento", /recebimento/.test(p2.actionWillDo), p2.actionWillDo);

  // ===== 3. padrão recorrente só em reposição contínua =====
  db.prepare(`UPDATE retail_stock_alerts SET detected_at = '2026-07-05 10:00:00' WHERE organization_id = ?`).run(A);
  RetailPatternMemoryService.setEnabled(A, true);
  await RetailPatternMemoryService.learnPass(A, { asOf: "2026-07-24" });
  const patSingle = db.prepare(`SELECT id FROM retail_store_patterns WHERE organization_id=? AND pattern_type='estoque_negativo_recorrente'`).get(A);
  check("ciclo único: padrão 'estoque negativo recorrente' NÃO nasce", !patSingle);
  RetailReplenishmentStrategyService.setStrategy(A, "continuous_replenishment");
  await RetailPatternMemoryService.learnPass(A, { asOf: "2026-07-24" });
  const patCont = db.prepare(`SELECT id FROM retail_store_patterns WHERE organization_id=? AND pattern_type='estoque_negativo_recorrente'`).get(A);
  check("reposição contínua: o padrão nasce (0-regressão)", !!patCont);

  // ===== 4. first_detected_at =====
  const alert = () => db.prepare(`SELECT first_detected_at, detected_at FROM retail_stock_alerts WHERE organization_id=? AND product_service_id=?`).get(A, prods[0]) as any;
  db.prepare(`UPDATE retail_stock_alerts SET first_detected_at = datetime('now','-5 days'), detected_at = datetime('now','-5 days') WHERE organization_id=? AND product_service_id=?`).run(A, prods[0]);
  const first = alert().first_detected_at;
  RetailInventoryService.setQuantity(A, store.id, prods[0], null, -4); // ressincroniza ainda negativo
  const after = alert();
  check("ressincronizar mantém first_detected_at (a data real do início)", after.first_detected_at === first, JSON.stringify(after));
  check("…mas detected_at é reescrito (por isso não serve p/ 'há quantos dias')", after.detected_at !== first);
  RetailInventoryService.setQuantity(A, store.id, prods[0], null, 1);   // resolve
  RetailInventoryService.setQuantity(A, store.id, prods[0], null, -1);  // reabre
  check("resolver e reabrir reinicia a contagem de dias", alert().first_detected_at !== first);

  // ===== 5. days_open na listagem =====
  db.prepare(`UPDATE retail_stock_alerts SET first_detected_at = datetime('now','-5 days') WHERE organization_id=? AND product_service_id=?`).run(A, prods[1]);
  db.prepare(`UPDATE retail_stock_alerts SET first_detected_at = NULL WHERE organization_id=? AND product_service_id=?`).run(A, prods[2]);
  const list = RetailInventoryService.listNegative(A, {}).items;
  const byProd = (p: string) => list.find((i: any) => i.product_service_id === p);
  check("listNegative: days_open = 5 para o negativo de 5 dias", byProd(prods[1])?.days_open === 5, String(byProd(prods[1])?.days_open));
  check("listNegative: sem data conhecida → days_open null (não inventa)", byProd(prods[2])?.days_open === null);
  check("listNegative: negativo recém-aberto → 0 dias", byProd(prods[0])?.days_open === 0, String(byProd(prods[0])?.days_open));

  // ===== 6. isolamento =====
  check("isolamento: org B sem negativos nem sinal", RetailInventoryService.listNegative(B, {}).total === 0 && !db.prepare(`SELECT 1 FROM business_signals WHERE organization_id=? AND signal_type='retail_store_stockout'`).get(B));
}

main().then(() => {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${!r.ok && r.detail ? "  → " + r.detail : ""}`);
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
