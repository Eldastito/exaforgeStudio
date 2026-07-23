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

  // ===== 4. Isolamento =====
  check("isolamento: outra org sem vendas não simula", D.hire(mkOrg(), { monthlyCost: 5000 }).ok === false);

  console.log("\n=== TEST: Simulador de Decisões (ADR-133) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Simulador de Decisões OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
