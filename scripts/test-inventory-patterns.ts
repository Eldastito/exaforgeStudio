/**
 * TESTE — Detector de padrões de ESTOQUE (InventoryPatternMemory) sobre o motor
 * genérico (PatternMemoryService, ADR-142 generalizada).
 *
 * Sexto domínio sobre o mesmo motor. Sobre stock_movements reais:
 *   - produto_ruptura_recorrente: produto cujo saldo cruza para ≤ 0 com frequência
 *     na janela (reconstruído replayando entrada/saída/ajuste; conta só a BORDA).
 *   - o padrão validado vira sinal 'inventory' e entra no Pareto com ação;
 *   - gating por evidência mínima, opt-in por org e isolamento.
 *
 * Hypothesizer injetado (zero-token). Uso:  npm run test:inventory-patterns
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-inventory-patterns-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-inventory-patterns-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const noLLM = async () => ({});

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PatternMemoryService } = await import("../src/server/PatternMemoryService.js");
  const { InventoryPatternMemory } = await import("../src/server/InventoryPatternMemory.js");
  const { ImpactPrioritizationService } = await import("../src/server/ImpactPrioritizationService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const [org, name] of [[A, "A"], [B, "B"]] as const) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  PatternMemoryService.setEnabled(A, true);
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

  const mov = (org: string, pid: string, type: string, qty: number, day: number) =>
    db.prepare(`INSERT INTO stock_movements (id, organization_id, product_service_id, type, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), org, pid, type, qty, `${daysAgo(day)} 10:00:00`);

  // Produto que ROMPE recorrente: 4 ciclos entrada→saída que zeram o saldo (4 bordas).
  const rupProd = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Camisa Branca', 50, 1, 1)`).run(rupProd, A);
  for (let k = 0; k < 4; k++) {
    const base = 75 - k * 15;
    mov(A, rupProd, "entrada", 10, base);      // saldo 0→10
    mov(A, rupProd, "saida", 10, base - 2);    // saldo 10→0 (borda de ruptura)
  }

  // Produto que rompe só 2x (abaixo do mínimo) → não vira padrão.
  const okProd = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Calça Preta', 80, 1, 1)`).run(okProd, A);
  for (let k = 0; k < 2; k++) { const base = 60 - k * 15; mov(A, okProd, "entrada", 5, base); mov(A, okProd, "saida", 5, base - 2); }

  const rp = await InventoryPatternMemory.learnPass(A, { asOf: today, hypothesizer: noLLM });
  check("estoque aprende ruptura recorrente (validado)", rp.enabled === true && rp.detected === 1 && rp.validated === 1 && rp.published === 1, JSON.stringify(rp));

  const patterns = PatternMemoryService.list(A, { domain: "inventory" });
  check("só o produto que rompe ≥3x virou padrão", patterns.length === 1 && patterns[0].scope_id === rupProd, JSON.stringify(patterns.map((p: any) => p.scope_id)));
  const ev = (() => { try { return JSON.parse(patterns[0].evidence_json || "{}"); } catch { return {}; } })();
  check("evidência conta 4 rupturas", ev.stockouts === 4, JSON.stringify(ev));

  const sig = db.prepare(`SELECT * FROM business_signals WHERE organization_id=? AND domain='inventory' AND signal_type='produto_ruptura_recorrente' AND status='open'`).get(A) as any;
  check("ruptura recorrente virou sinal 'inventory'", !!sig && sig.source_service === "InventoryPatternMemory", JSON.stringify({ has: !!sig }));

  const pareto = ImpactPrioritizationService.prioritize(A, { globalLimit: 12 }).global;
  const pri = pareto.find((p: any) => p.signalType === "produto_ruptura_recorrente");
  check("ruptura entra no Pareto com ação de ponto de pedido", !!pri && /ponto de pedido|reposição/i.test(pri.recommendedAction), pri?.recommendedAction);

  // Fecha o loop no domínio estoque.
  const rec = PatternMemoryService.recordOutcome(A, patterns[0].id, { outcome: "worked" });
  check("recordOutcome no domínio estoque", rec.ok === true && rec.effectiveness === 1, JSON.stringify(rec));

  // Opt-in + isolamento.
  const rb = await InventoryPatternMemory.learnPass(B, { asOf: today, hypothesizer: noLLM });
  check("org B (desligada) não aprende", rb.enabled === false && rb.detected === 0);
  check("isolamento: org B sem padrões de estoque", PatternMemoryService.list(B, { domain: "inventory" }).length === 0);

  console.log("\n=== Detector de padrões de estoque (motor genérico) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
