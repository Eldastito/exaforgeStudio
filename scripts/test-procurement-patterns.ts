/**
 * TESTE — Detector de padrões de COMPRAS (ProcurementPatternMemory) sobre o motor
 * genérico (PatternMemoryService, ADR-142 generalizada).
 *
 * Segunda prova de que a extração pegou: o domínio de compras "aprende" só com os
 * seus detectores. Sobre dados reais (purchase_orders + goods_receipts):
 *   - fornecedor_divergencia_recorrente: fornecedor com divergências recorrentes;
 *   - fornecedor_atraso_recorrente: fornecedor entregando fora do prazo;
 *   - os padrões validados viram sinais 'procurement' e entram no Pareto com ação;
 *   - opt-in por org + isolamento.
 *
 * Hypothesizer injetado (zero-token). Uso:  npm run test:procurement-patterns
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-procurement-patterns-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-procurement-patterns-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const noLLM = async () => ({});

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PatternMemoryService } = await import("../src/server/PatternMemoryService.js");
  const { ProcurementPatternMemory } = await import("../src/server/ProcurementPatternMemory.js");
  const { ImpactPrioritizationService } = await import("../src/server/ImpactPrioritizationService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const [org, name] of [[A, "A"], [B, "B"]] as const) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  PatternMemoryService.setEnabled(A, true);

  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const supplier = randomUUID();

  // Helper: cria uma PO recebida e o seu goods_receipt (com/sem divergência, no/atrasada).
  const mkPO = (opts: { i: number; diverge: boolean; late: boolean }) => {
    const poId = randomUUID();
    const confirmed = daysAgo(30 - opts.i);          // confirmada
    const promisedDays = 5;
    // received: no prazo (confirmed+3) ou atrasada (confirmed+12)
    const recvOffset = opts.late ? 12 : 3;
    const received = daysAgo(30 - opts.i - recvOffset < 0 ? 0 : 30 - opts.i - recvOffset);
    db.prepare(`INSERT INTO purchase_orders (id, organization_id, requisition_id, quote_id, supplier_contact_id, supplier_name, status, delivery_days, confirmed_at, received_at, created_at)
                VALUES (?, ?, ?, ?, ?, 'Fornecedor Atlas', 'received', ?, ?, ?, ?)`)
      .run(poId, A, randomUUID(), randomUUID(), supplier, promisedDays, `${confirmed} 09:00:00`, `${received} 15:00:00`, `${confirmed} 08:00:00`);
    db.prepare(`INSERT INTO goods_receipts (id, organization_id, purchase_order_id, kind, invoice_present, has_divergence, created_at)
                VALUES (?, ?, ?, 'complete', 1, ?, ?)`)
      .run(randomUUID(), A, poId, opts.diverge ? 1 : 0, `${received} 15:30:00`);
  };

  // 4 pedidos do mesmo fornecedor: todos divergentes E atrasados (evidência forte → valida já).
  for (let i = 0; i < 4; i++) mkPO({ i, diverge: true, late: true });
  // 1 pedido ok (não divergente, no prazo) — para o denominador.
  mkPO({ i: 5, diverge: false, late: false });

  const rp = await ProcurementPatternMemory.learnPass(A, { asOf: today, hypothesizer: noLLM });
  check("compras aprende (2 detectores, validados)", rp.enabled === true && rp.detected === 2 && rp.validated === 2 && rp.published === 2, JSON.stringify(rp));

  const patterns = PatternMemoryService.list(A, { domain: "procurement" });
  const types = new Set(patterns.map((p: any) => p.pattern_type));
  check("padrão de divergência aprendido", types.has("fornecedor_divergencia_recorrente"));
  check("padrão de atraso aprendido", types.has("fornecedor_atraso_recorrente"));
  check("padrões validados e por fornecedor", patterns.every((p: any) => p.status === "validated" && p.scope_id === supplier), JSON.stringify(patterns.map((p: any) => p.status)));

  // Viram sinais 'procurement' abertos.
  const sigs = db.prepare(`SELECT signal_type FROM business_signals WHERE organization_id=? AND domain='procurement' AND status='open' AND source_service='ProcurementPatternMemory'`).all(A) as any[];
  check("2 sinais de compras publicados", sigs.length === 2, JSON.stringify(sigs.map((s) => s.signal_type)));

  // Entram no Pareto com ação recomendada específica.
  const pareto = ImpactPrioritizationService.prioritize(A, { globalLimit: 12 }).global;
  const div = pareto.find((p: any) => p.signalType === "fornecedor_divergencia_recorrente");
  const late = pareto.find((p: any) => p.signalType === "fornecedor_atraso_recorrente");
  check("divergência entra no Pareto com ação de conferência", !!div && /conferência|cobrar/i.test(div.recommendedAction), div?.recommendedAction);
  check("atraso entra no Pareto com ação de renegociar", !!late && /renegociar|alternativo/i.test(late.recommendedAction), late?.recommendedAction);

  // Fecha o loop: desfecho ajusta a eficácia do tipo de compras.
  const divPattern = patterns.find((p: any) => p.pattern_type === "fornecedor_divergencia_recorrente");
  const rec = PatternMemoryService.recordOutcome(A, divPattern.id, { outcome: "worked", realizedImpact: 0 });
  check("recordOutcome no domínio compras", rec.ok === true && rec.effectiveness === 1, JSON.stringify(rec));
  const ts = PatternMemoryService.typeStats(A, "procurement", "fornecedor_divergencia_recorrente");
  check("type-stats isolado por (domínio, tipo)", !!ts && ts.acted === 1, JSON.stringify(ts));

  // Opt-in + isolamento.
  const rb = await ProcurementPatternMemory.learnPass(B, { asOf: today, hypothesizer: noLLM });
  check("org B (desligada) não aprende", rb.enabled === false && rb.detected === 0);
  check("isolamento: org B sem padrões de compras", PatternMemoryService.list(B, { domain: "procurement" }).length === 0);

  console.log("\n=== Detector de padrões de compras (motor genérico) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
