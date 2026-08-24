/**
 * TEST — Projeção de resultado hardening (ADR-188 F4). Doc-of-record EXECUTÁVEL de dupla função:
 * (A) codifica RN-RP-1..7 como REGRESSÃO sobre os serviços REAIS F1–F3;
 * (B) verifica a FIAÇÃO de produção (pass no Scheduler, rota montada, card na UI, testes wired, runbook/ADR).
 *
 * Uso: npm run test:result-projection-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rphard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rphard-123456";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ResultProjectionService: RP } = await import("../src/server/ResultProjectionService.js");

  const mkOrg = () => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o); return o; };
  const mkSale = (org: string, revenue: number, cost: number, day = "10") => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', ?, ?)`).run(oid, org, revenue, `2026-06-${day} 10:00:00`);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', ?, 1, ?, ?)`).run(randomUUID(), oid, org, revenue, revenue, cost);
  };
  const mkPayable = (org: string, amount: number, recurrence: "none" | "monthly") =>
    db.prepare(`INSERT INTO payables (id, organization_id, description, amount, due_date, recurrence, status) VALUES (?, ?, 'D', ?, '2026-06-05', ?, 'open')`).run(randomUUID(), org, amount, recurrence);
  const sig = (org: string) => db.prepare(`SELECT status FROM business_signals WHERE organization_id=? AND dedupe_key='result_projection:below_breakeven'`).get(org) as any;

  // ── RN-RP-3: ASSIMETRIA fixo × variável — só receita/variável run-rated; custo fixo NÃO escalona ──
  const A = mkOrg();
  mkSale(A, 1000, 400); mkPayable(A, 100, "none"); mkPayable(A, 300, "monthly");
  const a15 = RP.project(A, { period: "2026-06", asOf: "2026-06-15" }); // runRate 2 → receita 2000
  const a10 = RP.project(A, { period: "2026-06", asOf: "2026-06-10" }); // runRate 3 → receita 3000
  check("RN-3 receita run-rated muda com os dias (2000 no 15, 3000 no 10)", a15.projected.receita === 2000 && a10.projected.receita === 3000);
  check("RN-3 custo fixo NÃO escalona: resultado = receita×0,5 − 300 (700 e 1200)", a15.projected.resultado === 700 && a10.projected.resultado === 1200);

  // ── RN-RP-1: nunca inventa dinheiro — sem receita → razão/breakEven/projeção null, nunca 0/∞ ──
  const B = mkOrg(); mkPayable(B, 300, "monthly");
  const b = RP.project(B, { period: "2026-06", asOf: "2026-06-15" });
  check("RN-1 sem receita → null (nunca 0/∞) + no_revenue", b.contributionRatio === null && b.breakEvenRevenue === null && b.projected.resultado === null && b.confidence === "no_revenue");

  // ── RN-RP-2: premissa + confiança explícitas; poucos dias → insufficient_elapsed ──
  const a3 = RP.project(A, { period: "2026-06", asOf: "2026-06-03" });
  check("RN-2 premissas explícitas + poucos dias → insufficient_elapsed", a3.assumptions.length === 3 && a3.confidence === "insufficient_elapsed");

  // ── RN-RP-4: DERIVADO (RN-004) — muda o dado, muda a projeção (não é flag mutável) ──
  const before = a15.projected.resultado;
  mkSale(A, 2000, 800); // + receita
  const aAfter = RP.project(A, { period: "2026-06", asOf: "2026-06-15" });
  check("RN-4 derivado por query (nova venda muda a projeção)", aAfter.projected.resultado !== before);

  // ── RN-RP-5: ADVISORY — o sinal publica mas NUNCA cria decision_action ──
  const C = mkOrg(); mkSale(C, 200, 80); mkPayable(C, 20, "none"); mkPayable(C, 300, "monthly");
  RP.publishResultProjectionSignal(C, { period: "2026-06", asOf: "2026-06-15" });
  const daC = (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(C) as any).n;
  check("RN-5 sinal advisory: publica mas zero decision_action", !!sig(C) && daC === 0);

  // ── RN-RP-6: determinístico/isolado (asOf explícito → reprodutível; C ≠ A) ──
  check("RN-6 determinístico (2 chamadas iguais)", JSON.stringify(RP.project(C, { period: "2026-06", asOf: "2026-06-15" })) === JSON.stringify(RP.project(C, { period: "2026-06", asOf: "2026-06-15" })));
  check("RN-6 isolado (C tem sinal, A/B não)", !!sig(C) && !sig(A) && !sig(B));

  // ── RN-RP-7: reusa o motor de DRE — sem 2º motor, sem custo hard-coded no service ──
  const src = fs.readFileSync(path.join(ROOT, "src/server/ResultProjectionService.ts"), "utf8");
  check("RN-7 reusa ManagerialDreService (motor de DRE)", src.includes("ManagerialDreService.monthly"));
  check("RN-7 sem custo/alíquota hard-coded (deriva do DRE)", !/despesasFixas\s*=\s*\d{3,}/.test(src));

  // ── (B) FIAÇÃO DE PRODUÇÃO ──
  const scheduler = fs.readFileSync(path.join(ROOT, "src/server/Scheduler.ts"), "utf8");
  check("wiring: ResultProjectionService.pass no Scheduler", scheduler.includes("ResultProjectionService.pass"));
  const route = fs.readFileSync(path.join(ROOT, "src/server/routes/dre.ts"), "utf8");
  check("wiring: rota GET /result-projection montada", route.includes('"/result-projection"') && route.includes("ResultProjectionService.project"));
  const panel = fs.readFileSync(path.join(ROOT, "src/features/ReportsPanel.tsx"), "utf8");
  check("wiring: card na UI (consome /api/dre/result-projection)", panel.includes("/api/dre/result-projection") && panel.includes("ResultProjectionCard"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const needed = ["test:result-projection", "test:result-projection-signal", "test:result-projection-hardening"];
  check("wiring: 3 testes de projeção wired", needed.every((t) => pkg.scripts[t]));
  check("wiring: runbook presente", fs.existsSync(path.join(ROOT, "docs/runbook/projecao-resultado-operacao.md")));
  check("wiring: ADR-188 presente", fs.existsSync(path.join(ROOT, "docs/adr/ADR-188-projecao-resultado-mes.md")));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} result-projection-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
