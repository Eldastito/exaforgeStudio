/**
 * TEST — Espinha Única F3.1 (ADR-158 D5): Impact Ledger UNIFICADO (derivado).
 *
 * Prova, determinístico e sem IA:
 *   - reúne os outcomes atados a decisões (fonte 'action_ledger') no ledger
 *     unificado, por CATEGORIA;
 *   - agrega DENTRO da categoria (mesma unidade) e NUNCA entre categorias
 *     (sem total geral inflado — ADR-085 D4 / PRD §32);
 *   - unidades corretas (BRL vs minutes);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:impact-ledger-unified
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-impact-ledger-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-impact-ledger-123456";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { DecisionActionService: D } = await import("../src/server/DecisionActionService.js");
  const { UnifiedImpactLedgerService: L } = await import("../src/server/UnifiedImpactLedgerService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  // Ação de baixo risco (tasks/create_task) já nasce aprovada → concluir direto.
  const doneWith = (orgId: string, title: string, cat: any, resultAmount?: number) => {
    const a = D.propose(orgId, { domain: "tasks", actionType: "create_task", title });
    D.complete(orgId, a.id, { resultAmount: resultAmount ?? null, categoryOutcomes: cat });
    return a.id;
  };

  const orgA = mkOrg();
  doneWith(orgA, "recuperou 3800", { revenueRecovered: 3800 }, 3800);
  doneWith(orgA, "recuperou +200", { revenueRecovered: 200 }, 200);
  doneWith(orgA, "economizou tempo+custo", { timeSavedMinutes: 120, costAvoided: 500 });
  doneWith(orgA, "evitou perda", { lossPrevented: 900 });

  const led = L.build(orgA);

  // ===== 1. Categorias presentes, agregadas dentro da categoria =====
  check("revenueRecovered soma dentro da categoria (3800+200=4000)", led.categories.revenueRecovered?.total === 4000);
  // 1 linha = 1 FONTE (action_ledger já soma os outcomes internamente); F3.2+
  // adicionam novas linhas (Comigo/Retail/RIC) à mesma categoria.
  check("revenueRecovered tem 1 linha (1 fonte: action_ledger)", led.categories.revenueRecovered?.lines.length === 1);
  check("revenueRecovered unidade BRL", led.categories.revenueRecovered?.unit === "BRL");
  check("costAvoided = 500", led.categories.costAvoided?.total === 500);
  check("lossPrevented = 900", led.categories.lossPrevented?.total === 900);
  check("timeSaved = 120, unidade minutes", led.categories.timeSaved?.total === 120 && led.categories.timeSaved?.unit === "minutes");

  // ===== 2. Fonte rotulada + rastreável =====
  check("fonte 'action_ledger' listada", led.sources.includes("action_ledger"));
  check("linha carrega a fonte", led.categories.revenueRecovered?.lines[0].source === "action_ledger");

  // ===== 3. NUNCA soma entre categorias (sem total geral) =====
  check("sem total geral inflado (nenhuma chave total/grandTotal no topo)",
    !("total" in led) && !("grandTotal" in (led as any)));
  check("disclaimer de não-soma presente", typeof led.disclaimer === "string" && led.disclaimer.includes("nunca somadas"));

  // ===== 4. Isolamento multi-tenant =====
  const orgB = mkOrg();
  const ledB = L.build(orgB);
  check("isolamento: org B tem ledger vazio", Object.keys(ledB.categories).length === 0 && ledB.sources.length === 0);

  console.log("\n=== TEST: Impact Ledger Unificado (ADR-158 F3.1) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Impact Ledger Unificado (F3.1) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
