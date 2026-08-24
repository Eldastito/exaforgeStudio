/**
 * TEST — Resultado consolidado hardening (ADR-186 F4). Doc-of-record EXECUTÁVEL de dupla função:
 * (A) codifica RN-CR-1..7 como REGRESSÃO sobre os serviços REAIS F1–F3;
 * (B) verifica a FIAÇÃO de produção (pass no Scheduler, snapshot expõe o bloco, testes wired, runbook/ADR).
 *
 * Uso: npm run test:consolidated-result-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-consolhard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-consolhard-123456";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const PERIOD = "2026-06";

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ConsolidatedResultService: CR } = await import("../src/server/ConsolidatedResultService.js");
  const { ManagerialDreService } = await import("../src/server/ManagerialDreService.js");
  const { FinancialLedgerService: FIN } = await import("../src/server/FinancialLedgerService.js");

  const mkOrg = () => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o); return o; };
  const mkCoreSale = (org: string, line: number, cost: number) => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', ?, '2026-06-10 10:00:00')`).run(oid, org, line);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', ?, 1, ?, ?)`).run(randomUUID(), oid, org, line, line, cost);
  };
  const mkStore = (org: string, margin: number | null) => { const sid = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active, gross_margin_percent) VALUES (?, ?, 'Loja', 1, ?)`).run(sid, org, margin); return sid; };
  const mkClosing = (org: string, sid: string, total: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total) VALUES (?, ?, ?, '2026-06-15', 'approved', ?)`).run(randomUUID(), org, sid, total);
  const mkFixed = (org: string, sid: string, cat: string, amt: number) => db.prepare(`INSERT INTO retail_store_fixed_costs (id, organization_id, store_id, category, amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, sid, cat, amt);

  const A = mkOrg();
  mkCoreSale(A, 1000, 400);
  FIN.addPayable(A, { description: "Compras", amount: 100, dueDate: "2026-06-05", category: "compras" });
  const sA = mkStore(A, 50); mkClosing(A, sA, 2000); mkFixed(A, sA, "aluguel", 300);
  const r = CR.monthly(A, PERIOD);
  const raw = ManagerialDreService.monthly(A, PERIOD) as any;

  // ── RN-CR-1: não muta o core (0-regressão) ──
  check("RN-1 core = resultadoOperacional do DRE (intacto)", r.core.resultadoOperacional === Math.round((raw.linhas.resultadoOperacional + Number.EPSILON) * 100) / 100);

  // ── RN-CR-2: escopo rotulado (core × all_channels) ──
  check("RN-2 escopos rotulados", r.core.scope === "core" && r.consolidated.scope === "all_channels");

  // ── RN-CR-3/6: custo de loja honesto-null → partial; nunca inventa lucro ──
  const B = mkOrg(); mkCoreSale(B, 500, 200); const sB = mkStore(B, null); mkClosing(B, sB, 3000);
  const rB = CR.monthly(B, PERIOD);
  check("RN-3/6 loja sem resultado → partial + consolidado = core (não inventa)", rB.consolidated.partial === true && rB.consolidated.resultadoOperacional === rB.core.resultadoOperacional);

  // ── RN-CR-4: dupla contagem DETECTADA (nunca subtrai 2× em silêncio) ──
  const C = mkOrg(); const sC = mkStore(C, 40); mkClosing(C, sC, 1000); mkFixed(C, sC, "aluguel", 200);
  FIN.addPayable(C, { description: "Aluguel loja", amount: 200, dueDate: "2026-06-05", category: "Aluguel loja 1" });
  const rC = CR.monthly(C, PERIOD);
  check("RN-4 doubleCountRisk detectado + sinal advisory (zero decision_action)", (() => {
    CR.publishDoubleCountSignal(C, PERIOD);
    const da = (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(C) as any).n;
    return rC.doubleCountRisk === true && rC.doubleCountCategories.includes("aluguel") && da === 0;
  })());

  // ── RN-CR-5: read-only — computar NÃO muta orders/payables/stores ──
  const before = (db.prepare(`SELECT COUNT(*) n FROM orders WHERE organization_id=?`).get(A) as any).n;
  CR.monthly(A, PERIOD); CR.monthly(A, PERIOD);
  check("RN-5 read-only (orders intactos)", (db.prepare(`SELECT COUNT(*) n FROM orders WHERE organization_id=?`).get(A) as any).n === before);

  // ── RN-CR-7: isolado/honesto — sem loja → consolidado = core ──
  const D = mkOrg(); mkCoreSale(D, 800, 300);
  const rD = CR.monthly(D, PERIOD);
  check("RN-7 sem loja → consolidado = core, all_channels, sem risco", rD.consolidated.resultadoOperacional === rD.core.resultadoOperacional && rD.doubleCountRisk === false);

  // ── (B) FIAÇÃO DE PRODUÇÃO ──
  const scheduler = fs.readFileSync(path.join(ROOT, "src/server/Scheduler.ts"), "utf8");
  check("wiring: ConsolidatedResultService.pass no Scheduler", scheduler.includes("ConsolidatedResultService.pass"));
  const adapter = fs.readFileSync(path.join(ROOT, "src/server/FinanceSnapshotAdapter.ts"), "utf8");
  check("wiring: snapshot expõe o bloco consolidated", adapter.includes("consolidated:") && adapter.includes("ConsolidatedResultService"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const needed = ["test:consolidated-result", "test:consolidated-snapshot", "test:consolidated-double-count-signal", "test:consolidated-result-hardening"];
  check("wiring: 4 testes do consolidado wired", needed.every((t) => pkg.scripts[t]));
  check("wiring: runbook presente", fs.existsSync(path.join(ROOT, "docs/runbook/resultado-consolidado-operacao.md")));
  check("wiring: ADR-186 presente", fs.existsSync(path.join(ROOT, "docs/adr/ADR-186-resultado-consolidado-all-channels.md")));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} consolidated-result-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
