/**
 * TEST — Simulador de Decisões (ADR-133 Fatia 1: "posso contratar?").
 * Determinístico, sem chave de IA.
 *
 * Uso: npm run test:decision-simulator
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-decsim-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-decsim-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { DecisionSimulatorService: D } = await import("../src/server/DecisionSimulatorService.js");

  const mkOrg = () => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id);
    return id;
  };
  // Vendas com margem 50% (preço 40, custo 20) — 3 pedidos.
  const seedSale = (orgId: string) => {
    const oid = randomUUID();
    db.prepare("INSERT INTO comigo_orders (id, organization_id, status, total) VALUES (?, ?, 'paid', 40)").run(oid, orgId);
    db.prepare("INSERT INTO comigo_order_items (id, order_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, 'Item', 1, 40, 20)").run(randomUUID(), oid);
  };

  // ===== 1. Sem margem: não simula (pede dados) =====
  const orgEmpty = mkOrg();
  const noData = D.hire(orgEmpty, { monthlyCost: 5000 });
  check("sem margem, o simulador pede dados (não inventa)", noData.ok === false && noData.reason === "sem_margem");

  // ===== 2. Custo inválido =====
  const orgA = mkOrg();
  for (let i = 0; i < 3; i++) seedSale(orgA);
  check("custo <= 0 é rejeitado", D.hire(orgA, { monthlyCost: 0 }).ok === false && D.hire(orgA, { monthlyCost: 0 }).reason === "custo_invalido");

  // ===== 3. Cálculo: extraReceita = custo / margem =====
  const r = D.hire(orgA, { monthlyCost: 5000 });
  check("simula com margem detectada (50%)", r.ok === true && r.marginPct === 50);
  check("venda a mais = custo / margem (5000/0,5 = 10000)", Math.abs(r.extraRevenueNeeded - 10000) < 0.01);
  check("ticket médio detectado (40) e vendas/dia calculadas", r.avgTicket === 40 && r.extraTicketsPerDay === Math.ceil(10000 / 30 / 40));
  check("veredito textual presente", typeof r.veredito === "string" && r.veredito.length > 10);

  // Custo maior → exige mais venda (monotônico).
  const r2 = D.hire(orgA, { monthlyCost: 10000 });
  check("dobrar o custo dobra a venda necessária", Math.abs(r2.extraRevenueNeeded - 20000) < 0.01);

  // ===== 4. "Posso comprar esse estoque?" (Fatia 2) =====
  // Vendas do mês: 3 pedidos de R$1000 (margem 50%) → receita 3000, CMV 1500, CMV/dia 50.
  const orgBuy = mkOrg();
  for (let i = 0; i < 3; i++) {
    const oid = randomUUID();
    db.prepare("INSERT INTO comigo_orders (id, organization_id, status, total) VALUES (?, ?, 'paid', 1000)").run(oid, orgBuy);
    db.prepare("INSERT INTO comigo_order_items (id, order_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, 'Item', 1, 1000, 500)").run(randomUUID(), oid);
  }
  // Estoque: pA 20×100=2000 COM saída recente (gira); pB 10×100=1000 sem saída (parado).
  db.prepare("INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, 'pA', 20, 100)").run(randomUUID(), orgBuy);
  db.prepare("INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, 'pB', 10, 100)").run(randomUUID(), orgBuy);
  db.prepare("INSERT INTO stock_movements (id, organization_id, product_service_id, type, quantity) VALUES (?, ?, 'pA', 'saida', 5)").run(randomUUID(), orgBuy);

  const bInvalid = D.buyStock(orgBuy, { amount: 0 });
  check("compra: valor <= 0 é rejeitado", bInvalid.ok === false && bInvalid.reason === "valor_invalido");

  const b = D.buyStock(orgBuy, { amount: 1500 });
  check("compra: cobertura conhecida (tem margem+vendas+estoque)", b.ok === true && b.coverageKnown === true);
  check("compra: cobertura atual = capital/CMVdia (3000/50 = 60)", b.currentCoverageDays === 60);
  check("compra: nova cobertura inclui a compra ((3000+1500)/50 = 90)", b.newCoverageDays === 90);
  check("compra: parado estimado usa a fração sem giro (1000/3000 ≈ 33% → ~R$500)", b.slowPct === 33 && Math.abs(b.estIdle - 500) < 0.01);

  // Sem vendas: não estima cobertura, mas ainda alerta o parado pelo padrão.
  const orgNoVel = mkOrg();
  db.prepare("INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, 'pX', 10, 100)").run(randomUUID(), orgNoVel);
  const bNoVel = D.buyStock(orgNoVel, { amount: 1000 });
  check("compra sem velocidade de venda: coverageKnown=false, mas responde", bNoVel.ok === true && bNoVel.coverageKnown === false);

  // ===== 5. "Posso retirar mais?" (Fatia 3) — what-if do caixa =====
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const orgW = mkOrg();
  F.recordEvent(orgW, { direction: "in", amount: 3000 }); // caixa 3000
  const wInvalid = D.withdraw(orgW, { amount: 0 });
  check("retirada: valor <= 0 é rejeitado", wInvalid.ok === false && wInvalid.reason === "valor_invalido");
  const w1 = D.withdraw(orgW, { amount: 1000 });
  check("retirada projeta o caixa (3000 - 1000 = 2000)", w1.ok === true && w1.caixaAtual === 3000 && w1.caixaAfter === 2000);
  check("retirada tem veredito e nível", typeof w1.veredito === "string" && ["ok", "atencao", "excesso"].includes(w1.nivel));
  const wOver = D.withdraw(orgW, { amount: 5000 });
  check("retirar mais que o caixa é excesso (não há caixa)", wOver.ok === true && wOver.caixaAfter < 0 && wOver.nivel === "excesso");
  // Sem resultado no mês, qualquer retirada descapitaliza.
  check("retirada com resultado zerado é excesso", D.withdraw(orgW, { amount: 500 }).nivel === "excesso");

  // ===== 6. Isolamento =====
  check("isolamento: outra org sem vendas não simula contratação", D.hire(mkOrg(), { monthlyCost: 5000 }).ok === false);

  console.log("\n=== TEST: Simulador de Decisões (ADR-133) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Simulador de Decisões OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
