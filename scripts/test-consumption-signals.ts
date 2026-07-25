/**
 * TESTE — CONTROLER Fatia 2b: ConsumptionSignalPublisher (PRD-E-007, §20.1).
 *
 * Liga o consumo ao kernel. Sobre o ledger de consumo + saldos por local, prova:
 *   - consumo_cobertura_baixa (saldo cobre poucos dias no ritmo atual);
 *   - consumo_acima_padrao (consumo recente >> média);
 *   - consumo_estoque_parado (saldo sem nenhuma saída na janela);
 *   - só itens com controle de consumo entram; entram no Pareto com ação;
 *   - auto-resolve quando a condição some; isolamento por org.
 *
 * Uso:  npm run test:consumption-signals
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-consumo-signals-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-consumo-signals-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function daysAgo(n: number) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return ymd(d); }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ConsumptionSignalPublisher } = await import("../src/server/ConsumptionSignalPublisher.js");
  const { ConsumptionLedgerService } = await import("../src/server/ConsumptionLedgerService.js");
  const { InventoryLocationService } = await import("../src/server/InventoryLocationService.js");
  const { ImpactPrioritizationService } = await import("../src/server/ImpactPrioritizationService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const [org, name] of [[A, "A"], [B, "B"]] as const) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  const loc = InventoryLocationService.create(A, { name: "Almox", type: "almoxarifado" }, "u1");
  const today = ymd(new Date());

  const mkItem = (name: string, controlled: boolean) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, consumption_control_enabled, default_uom) VALUES (?, ?, 'product', ?, 10, 1, ?, 'folha')`)
      .run(id, A, name, controlled ? 1 : 0);
    return id;
  };
  const consume = (pid: string, qty: number, day: number, dir: "out" | "in" = "out") =>
    ConsumptionLedgerService.record(A, { productId: pid, quantity: qty, direction: dir, occurredAt: daysAgo(day), sourceType: "manual" });

  // P1 — cobertura baixa: saldo 5, consumo 30 em 30 dias (média 1/dia) → cobertura 5.
  const p1 = mkItem("Papel (cobertura baixa)", true);
  InventoryLocationService.receive(A, { locationId: loc.id, productId: p1, quantity: 5 }, "u1");
  consume(p1, 30, 15);

  // P2 — acima do padrão: base ~1/dia, recente ~3/dia; saldo alto (sem cobertura baixa).
  const p2 = mkItem("Toner (pico)", true);
  InventoryLocationService.receive(A, { locationId: loc.id, productId: p2, quantity: 1000 }, "u1");
  consume(p2, 30, 20); // base (janela 8-37 dias)
  consume(p2, 21, 3);  // recente (últimos 7 dias)

  // P3 — estoque parado: saldo 50, nenhuma saída.
  const p3 = mkItem("Cartucho (parado)", true);
  InventoryLocationService.receive(A, { locationId: loc.id, productId: p3, quantity: 50 }, "u1");

  // P4 — saudável: saldo alto, consumo baixo e estável → nenhum sinal.
  const p4 = mkItem("Caneta (ok)", true);
  InventoryLocationService.receive(A, { locationId: loc.id, productId: p4, quantity: 1000 }, "u1");
  consume(p4, 3, 15);

  // P5 — NÃO controlado: tudo "errado", mas fora do escopo do CONTROLER.
  const p5 = mkItem("Camisa (não controlada)", false);
  InventoryLocationService.receive(A, { locationId: loc.id, productId: p5, quantity: 2 }, "u1");

  // ===== Passe de sinais =====
  const run = ConsumptionSignalPublisher.run(A, { asOf: today });
  check("publica 3 sinais (cobertura, acima, parado)", run.published === 3, JSON.stringify(run));

  const sigType = (pid: string, type: string) => db.prepare(`SELECT * FROM business_signals WHERE organization_id=? AND domain='consumption' AND signal_type=? AND source_entity_id=? AND status='open'`).get(A, type, pid) as any;
  check("P1 → cobertura baixa (severidade risco)", !!sigType(p1, "consumo_cobertura_baixa") && sigType(p1, "consumo_cobertura_baixa").severity === "risk", JSON.stringify(sigType(p1, "consumo_cobertura_baixa")?.severity));
  check("P2 → consumo acima do padrão", !!sigType(p2, "consumo_acima_padrao"));
  check("P3 → estoque parado", !!sigType(p3, "consumo_estoque_parado"));
  check("P4 (saudável) → sem sinal", !db.prepare(`SELECT 1 FROM business_signals WHERE organization_id=? AND source_entity_id=? AND status='open'`).get(A, p4));
  check("P5 (não controlado) → ignorado", !db.prepare(`SELECT 1 FROM business_signals WHERE organization_id=? AND source_entity_id=? AND status='open'`).get(A, p5));

  // ===== Pareto com ação =====
  const pareto = ImpactPrioritizationService.prioritize(A, { globalLimit: 20 }).global;
  const find = (t: string) => pareto.find((p: any) => p.signalType === t);
  check("cobertura baixa no Pareto (ação de repor)", /repor|cobertura/i.test(find("consumo_cobertura_baixa")?.recommendedAction || ""), find("consumo_cobertura_baixa")?.recommendedAction);
  check("acima do padrão no Pareto (ação de investigar)", /investigar/i.test(find("consumo_acima_padrao")?.recommendedAction || ""));
  check("estoque parado no Pareto (ação de revisar)", /parado|capital|revisar/i.test(find("consumo_estoque_parado")?.recommendedAction || ""));

  // ===== Auto-resolve: repõe P1 → cobertura sobe → sinal resolvido =====
  InventoryLocationService.receive(A, { locationId: loc.id, productId: p1, quantity: 100 }, "u1"); // saldo 105 → cobertura 105
  const run2 = ConsumptionSignalPublisher.run(A, { asOf: today });
  check("re-passe resolve a cobertura de P1", run2.resolved >= 1 && !sigType(p1, "consumo_cobertura_baixa"), JSON.stringify(run2));
  check("idempotente: P3 continua um único sinal aberto", db.prepare(`SELECT COUNT(*) AS n FROM business_signals WHERE organization_id=? AND source_entity_id=? AND signal_type='consumo_estoque_parado' AND status='open'`).get(A, p3) && (db.prepare(`SELECT COUNT(*) AS n FROM business_signals WHERE organization_id=? AND source_entity_id=? AND signal_type='consumo_estoque_parado' AND status='open'`).get(A, p3) as any).n === 1);

  // ===== Isolamento =====
  const rb = ConsumptionSignalPublisher.run(B, { asOf: today });
  check("isolamento: org B não publica nada", rb.published === 0);
  check("isolamento: org B sem sinais de consumo", !db.prepare(`SELECT 1 FROM business_signals WHERE organization_id=? AND domain='consumption'`).get(B));

  console.log("\n=== CONTROLER Fatia 2b — ConsumptionSignalPublisher ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
