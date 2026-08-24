/**
 * TEST — Apropriação de despesa a centro de custo hardening (ADR-185 F4). Doc-of-record EXECUTÁVEL
 * de dupla função: (A) codifica RN-CC-1..7 como REGRESSÃO sobre os serviços REAIS F1–F3;
 * (B) verifica a FIAÇÃO de produção (pass no Scheduler, rotas montadas, testes wired, runbook/ADR).
 *
 * Uso: npm run test:cost-center-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cchard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-cchard-123456";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const PERIOD = "2026-06";

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FinancialLedgerService: FIN } = await import("../src/server/FinancialLedgerService.js");
  const { CostCenterService: CC } = await import("../src/server/CostCenterService.js");
  const { CostCenterStatementService: STMT } = await import("../src/server/CostCenterStatementService.js");
  const { CostCenterExpenseSignalService: SIG } = await import("../src/server/CostCenterExpenseSignalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o);
  const loja = CC.create(A, { name: "Loja" });
  const inativo = CC.create(A, { name: "Extinto" }); CC.setActive(A, inativo.id, false);
  const ccB = CC.create(B, { name: "Centro B" });

  // ── RN-CC-1: apropriação por TAG explícita, nunca inventada ──
  const p = FIN.addPayable(A, { description: "Aluguel", amount: 500, dueDate: "2026-06-10" });
  check("RN-1 sem tag → cost_center_id null (unallocated), não chuta", (db.prepare(`SELECT cost_center_id FROM payables WHERE id=?`).get((p as any).id) as any).cost_center_id === null);

  // ── RN-CC-2: centro validado (existe/org/ativo) ──
  check("RN-2 centro inativo → invalid_cost_center", (FIN.addPayable(A, { description: "x", amount: 10, dueDate: "2026-06-10", costCenterId: inativo.id }) as any).error === "invalid_cost_center");
  check("RN-2 centro de outra org → invalid (isolamento)", (FIN.addPayable(A, { description: "x", amount: 10, dueDate: "2026-06-10", costCenterId: ccB.id }) as any).error === "invalid_cost_center");
  FIN.setPayableCostCenter(A, (p as any).id, loja.id);

  // ── RN-CC-3: unallocated SEMPRE visível ──
  FIN.addPayable(A, { description: "Serviço solto", amount: 800, dueDate: "2026-06-12" });
  const rep = FIN.expensesByCostCenter(A, { from: "2026-06-01", to: "2026-06-30" });
  check("RN-3 unallocated exposto (800) + apropriado (500)", rep.unallocated === 800 && rep.items.find((i) => i.costCenterId === loja.id)?.total === 500);

  // ── RN-CC-4: consumo (qtd) e despesa (R$) NUNCA somados ──
  const st = STMT.statement(A, loja.id, { from: "2026-06-01", to: "2026-06-30" })!;
  check("RN-4 extrato separa despesa (R$) e consumo (qtd), sem total único", st.expense.currency === "BRL" && Array.isArray(st.consumption.items) && /NUNCA somadas/.test(st.note));

  // ── RN-CC-5: read-only/derivado — relatório não muta payables ──
  const before = (db.prepare(`SELECT COUNT(*) n FROM payables WHERE organization_id=?`).get(A) as any).n;
  FIN.expensesByCostCenter(A, { from: "2026-06-01", to: "2026-06-30" }); STMT.statement(A, loja.id, {});
  check("RN-5 read-only (payables intactos)", (db.prepare(`SELECT COUNT(*) n FROM payables WHERE organization_id=?`).get(A) as any).n === before);

  // ── RN-CC-6: 0-regressão — sinal advisory, zero decision_action ──
  SIG.publishUnallocatedExpenseSignal(A, PERIOD);
  check("RN-6 sinal advisory, zero decision_action", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n === 0);

  // ── RN-CC-7: isolado/honesto — B sem despesa → total 0; centro inexistente → statement null ──
  check("RN-7 B isolado (expensesByCostCenter total 0)", FIN.expensesByCostCenter(B, { from: "2026-06-01", to: "2026-06-30" }).total === 0);
  check("RN-7 centro inexistente → statement null", STMT.statement(A, "nao_existe", {}) === null);

  // ── (B) FIAÇÃO DE PRODUÇÃO ──
  const scheduler = fs.readFileSync(path.join(ROOT, "src/server/Scheduler.ts"), "utf8");
  check("wiring: CostCenterExpenseSignalService.pass no Scheduler", scheduler.includes("CostCenterExpenseSignalService.pass"));
  const cashRoutes = fs.readFileSync(path.join(ROOT, "src/server/routes/cash.ts"), "utf8");
  check("wiring: rota de tag + relatório de despesa por centro", cashRoutes.includes("/payables/:id/cost-center") && cashRoutes.includes("/expenses/by-cost-center"));
  const controlerRoutes = fs.readFileSync(path.join(ROOT, "src/server/routes/controler.ts"), "utf8");
  check("wiring: rota de extrato do centro", controlerRoutes.includes("/cost-centers/:id/statement"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const needed = ["test:cost-center-expense", "test:cost-center-statement", "test:cost-center-signal", "test:cost-center-hardening"];
  check("wiring: 4 testes de centro de custo wired", needed.every((t) => pkg.scripts[t]));
  check("wiring: runbook presente", fs.existsSync(path.join(ROOT, "docs/runbook/centro-de-custo-operacao.md")));
  check("wiring: ADR-185 presente", fs.existsSync(path.join(ROOT, "docs/adr/ADR-185-apropriacao-despesa-centro-de-custo.md")));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} cost-center-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
