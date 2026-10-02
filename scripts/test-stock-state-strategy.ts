/**
 * TESTE — PRD Fase 1 §5–§6 (S2): UM resolvedor do estado do saldo (>0 em ciclo · =0 fim de ciclo · <0 anomalia ·
 * ausente=unknown) e TODOS os detectores respeitando a estratégia da empresa. Prova: `stockState`/`classify` nas duas
 * estratégias (zero = ruptura só em reposição contínua; negativo = anomalia sempre; null≠zero); Radar de Oportunidades
 * (`stock_out`) e Requisição de Compra não sugerem recompra de peça que zerou em fim de coleção (exceto peça com meta);
 * o snapshot do Diretor IA não chama saldo zero de "ruptura" em fim de coleção e separa fim de ciclo × negativo;
 * default continua igual (0-regressão); isolamento por org.
 * Uso:  npm run test:stock-state-strategy
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-stockstate-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-stockstate-1234567890";

let failures = 0;
function check(name: string, ok: boolean) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailReplenishmentStrategyService: R } = await import("../src/server/RetailReplenishmentStrategyService.js");
  const { RetailStockPolicyService } = await import("../src/server/RetailStockPolicyService.js");
  const { OpportunityRadarService } = await import("../src/server/OpportunityRadarService.js");
  const { PurchaseRequisitionService } = await import("../src/server/PurchaseRequisitionService.js");
  const { InventorySnapshotAdapter } = await import("../src/server/BusinessSnapshotAdapters.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);

  // ── resolvedor puro ──
  check("saldo > 0 = in_cycle; 0 = cycle_end; < 0 = negative", R.stockState(5) === "in_cycle" && R.stockState(0) === "cycle_end" && R.stockState(-3) === "negative");
  check("saldo ausente/NaN = unknown (null ≠ zero)", R.stockState(null) === "unknown" && R.stockState(undefined) === "unknown" && R.stockState(NaN) === "unknown" && R.stockState("abc" as any) === "unknown");
  check("continuous: zero é problema (ruptura); negativo é problema; em ciclo não", R.classify(A, 0).problem === true && R.classify(A, -1).problem === true && R.classify(A, 4).problem === false);
  R.setStrategy(A, "collection_sellout", "u1");
  const z = R.classify(A, 0);
  check("collection_sellout: zero NÃO é problema (fim de ciclo normal) e o rótulo diz isso", z.problem === false && z.state === "cycle_end" && /normal/i.test(z.label) && !/ruptura/i.test(z.label));
  check("collection_sellout: negativo continua anomalia a investigar; sem dado nunca vira 'zerou'", R.classify(A, -2).problem === true && /investigar/i.test(R.classify(A, -2).label) && R.classify(A, null).problem === false && R.classify(A, null).state === "unknown");
  check("a estratégia da org B não muda com a da A (isolamento)", R.classify(B, 0).problem === true && R.strategy(B) === "continuous_replenishment");
  R.setStrategy(A, "continuous_replenishment", "u1");

  // ── dados: 2 produtos que o Radar vê como 'reposto >= 2x' e abaixo do mínimo na requisição ──
  const product = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'produto', ?, 100, 1, 1)`).run(id, org, name); return id; };
  const mov = (org: string, pid: string) => { for (let k = 0; k < 3; k++) db.prepare(`INSERT INTO stock_movements (id, organization_id, product_service_id, type, quantity, created_at) VALUES (?, ?, ?, 'entrada', 5, datetime('now', '-${k + 1} days'))`).run(randomUUID(), org, pid); };
  const inv = (org: string, pid: string, qty: number, thr: number) => db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, quantity_reserved, low_stock_threshold) VALUES (?, ?, ?, ?, 0, ?)`).run(randomUUID(), org, pid, qty, thr);
  const colecao = product(A, "Vestido Coleção"), basico = product(A, "Camisa Básica"), negativo = product(A, "Calça Divergente");
  const pB = product(B, "Produto da B");
  for (const p of [colecao, basico, negativo]) mov(A, p);
  mov(B, pB);
  inv(A, colecao, 0, 3); inv(A, basico, 0, 3); inv(A, negativo, -4, 3); inv(B, pB, 0, 3);
  RetailStockPolicyService.set(A, { productId: basico, minQty: 5, targetQty: 20 } as any);

  const radarNames = (org: string) => OpportunityRadarService.list(org, { status: "all", category: "stock_out" }).map((o: any) => String(o.title));
  const reqNames = (org: string) => (PurchaseRequisitionService.itemsBelowThreshold(org) as any[]).map((i) => String(i.name));

  // default (continuous) — 0-regressão
  OpportunityRadarService.scan(A, 30);
  check("DEFAULT: Radar sugere reposição dos 3 produtos (comportamento de sempre)", radarNames(A).length === 3);
  check("DEFAULT: Requisição de compra lista os 3 abaixo do mínimo", reqNames(A).length === 3);

  // fim de coleção
  db.prepare(`DELETE FROM disguised_opportunities WHERE organization_id = ?`).run(A);
  R.setStrategy(A, "collection_sellout", "u1");
  OpportunityRadarService.scan(A, 30);
  const rn = radarNames(A);
  check("fim de coleção: Radar NÃO sugere recompra do que zerou sem meta (Vestido) e do negativo", !rn.some((t) => /Vestido/.test(t)) && !rn.some((t) => /Calça/.test(t)));
  check("fim de coleção: peça COM meta (exceção) continua sugerida no Radar", rn.some((t) => /Camisa Básica/.test(t)) && rn.length === 1);
  const rq = reqNames(A);
  check("fim de coleção: Requisição de compra só traz a peça com meta", rq.length === 1 && /Camisa Básica/.test(rq[0]));
  check("a org B (continuous) segue recebendo tudo", (OpportunityRadarService.scan(B, 30), radarNames(B).length === 1) && reqNames(B).length === 1);

  // ── snapshot do Diretor IA ──
  const sa = InventorySnapshotAdapter.build(A);
  check("snapshot (fim de coleção): 'rupturas' NÃO conta zero como ruptura (n/a), expõe fim de ciclo e negativo separados", sa.rupturas.itens === null && sa.rupturas.basis === "n/a" && sa.fimDeCiclo.itens === 2 && sa.saldoNegativo.itens === 1);
  const sb = InventorySnapshotAdapter.build(B);
  check("snapshot (continuous): 'rupturas' = zerados + negativos como sempre; sem fim de ciclo", sb.rupturas.itens === 1 && sb.fimDeCiclo.itens === null && sb.saldoNegativo.itens === 0);
  R.setStrategy(A, "continuous_replenishment", "u1");
  check("voltando pra continuous o snapshot da A volta a contar ruptura (3 = 2 zerados + 1 negativo)", InventorySnapshotAdapter.build(A).rupturas.itens === 3);

  console.log(failures ? `\n${failures} FALHA(S)` : "\nTodas as verificações OK");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
