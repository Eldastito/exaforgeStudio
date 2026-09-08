/**
 * TEST — Production hardening da Inteligência Financeira Conectada (ADR-200 F5). DB-backed.
 * Doc-of-record executável: (A) codifica os guardrails RN-FIN-1..8 tocando os serviços REAIS
 * (F1–F3) e (B) verifica a FIAÇÃO de produção (serviços importáveis, rotas montadas, pass no
 * Scheduler, testes wired, runbook presente). Fecha o ADR-200.
 *
 * Uso: npm run test:connected-financials-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-connfin-hard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-connfin-hard-123456";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ManagerialBalanceSheetService: BS } = await import("../src/server/ManagerialBalanceSheetService.js");
  const { ManagerialCashFlowService: CFlow } = await import("../src/server/ManagerialCashFlowService.js");
  const { ConnectedFinancialsService: CFn } = await import("../src/server/ManagerialCashFlowService.js").then(() => import("../src/server/ConnectedFinancialsService.js"));

  const mkOrg = (v = "moda") => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical) VALUES (?, 'O', 'active', ?)`).run(o, v); return o; };
  const mkOrder = (org: string, rev: number, cost: number) => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', ?, '2026-06-10 10:00:00')`).run(oid, org, rev);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', ?, 1, ?, ?)`).run(randomUUID(), oid, org, rev, rev, cost);
  };
  const mkPayablePaid = (org: string, amount: number) => db.prepare(`INSERT INTO payables (id, organization_id, description, amount, due_date, recurrence, status, paid_at, created_at) VALUES (?, ?, 'D', ?, '2026-06-05', 'monthly', 'paid', '2026-06-10', '2026-06-01 10:00:00')`).run(randomUUID(), org, amount);
  const mkReceivable = (org: string, amount: number) => db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status, created_at) VALUES (?, ?, 'R', ?, '2026-06-15', 'open', '2026-06-15 10:00:00')`).run(randomUUID(), org, amount);
  const mkCashEvent = (org: string, dir: "in" | "out", amount: number, date: string) => db.prepare(`INSERT INTO cash_events (id, organization_id, direction, amount, event_date) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, dir, amount, date);

  const P = "2026-06";
  const A = mkOrg("moda");
  mkOrder(A, 1000, 400); mkPayablePaid(A, 200); mkReceivable(A, 500);
  mkCashEvent(A, "in", 100, "2026-06-10"); mkCashEvent(A, "out", 500, "2026-06-20"); // caixa −400

  const bal = BS.snapshot(A, "2026-06-30");
  const cf = CFlow.indirect(A, P);
  const conn = CFn.assemble(A, P);

  // ── RN-FIN-1: disclaimer gerencial em todo demonstrativo ──
  check("RN-FIN-1 disclaimer no Balanço/Fluxo/Conexão", /contabilidade oficial/i.test(bal.disclaimer) && /contabilidade oficial/i.test(cf.disclaimer) && /contabilidade oficial/i.test(conn.disclaimer));

  // ── RN-FIN-3: identidade fecha + "a conciliar" existe (não forçado a zero) ──
  check("RN-FIN-3 identidade Ativo=Passivo+PL", bal.balances === true && bal.ativo.total === bal.passivo.total + bal.patrimonioLiquido.total);
  check("RN-FIN-3 'a conciliar' explícito (≠0 aqui, não forçado a zero)", bal.patrimonioLiquido.resultadoAConciliar !== 0);

  // ── RN-FIN-4: a ponte é o método indireto ──
  const esperado = Math.round((cf.resultado - cf.capitalDeGiro.deltaReceber - (cf.capitalDeGiro.deltaEstoque || 0) + cf.capitalDeGiro.deltaPagar) * 100) / 100;
  check("RN-FIN-4 fluxo operacional = resultado − Δreceber − Δestoque + Δpagar", cf.fluxoOperacional === esperado);

  // ── RN-FIN-5: não inventa — null≠0 (org sem estoque) + sinal impact null ──
  const B = mkOrg("servicos");
  mkCashEvent(B, "in", 300, "2026-06-10");
  const balB = BS.snapshot(B, "2026-06-30");
  const cfB = CFlow.indirect(B, P);
  check("RN-FIN-5 estoque null (não zero forjado) sem estoque", balB.ativo.estoque === null && cfB.capitalDeGiro.deltaEstoque === null);
  CFn.publishConnectionSignal(A, { period: P });
  const sigRow = db.prepare(`SELECT basis, impact_amount FROM business_signals WHERE organization_id=? AND dedupe_key='connected_financials:lucro_sem_caixa'`).get(A) as any;
  check("RN-FIN-5 sinal hipótese + impactAmount null", sigRow?.basis === "hypothesis" && sigRow?.impact_amount == null);

  // ── RN-FIN-7: isolamento ──
  check("RN-FIN-7 isolamento (B não vê o de A)", cfB.resultado === 0 && !db.prepare(`SELECT 1 FROM business_signals WHERE organization_id=? AND dedupe_key='connected_financials:lucro_sem_caixa'`).get(B));

  // ── RN-FIN-8: determinístico antes de LLM — sem IA, narrativa = determinística ──
  const nar = await CFn.narrateAsync(A, P);
  check("RN-FIN-8 sem IA → narrativa determinística (0-regressão)", nar.source === "deterministic" && nar.narrativa === conn.narrativa);

  // ── (B) FIAÇÃO DE PRODUÇÃO ─────────────────────────────────────────────────
  check("wiring: 4 serviços importáveis", !!BS.snapshot && !!CFlow.indirect && !!CFn.assemble && !!CFn.narrateAsync);
  const dreRoute = fs.readFileSync(path.join(ROOT, "src/server/routes/dre.ts"), "utf8");
  check("wiring: rotas montadas (/balance /cashflow /connected /connected/narrative)", /"\/balance"/.test(dreRoute) && /"\/cashflow"/.test(dreRoute) && /"\/connected"/.test(dreRoute) && /"\/connected\/narrative"/.test(dreRoute));
  const sched = fs.readFileSync(path.join(ROOT, "src/server/Scheduler.ts"), "utf8");
  check("wiring: ConnectedFinancialsService.pass no Scheduler", /ConnectedFinancialsService\.pass\(\)/.test(sched));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  check("wiring: testes da Frente 2 registrados", !!pkg.scripts["test:managerial-balance"] && !!pkg.scripts["test:managerial-cashflow"] && !!pkg.scripts["test:connected-financials"] && !!pkg.scripts["test:connected-financials-hardening"]);
  check("wiring: runbook presente", fs.existsSync(path.join(ROOT, "docs/runbook/financas-conectadas-operacao.md")));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} connected-financials-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
