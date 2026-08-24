/**
 * TEST — Sinal proativo de projeção de resultado (ADR-188 F2). DB-backed, determinístico.
 * Prova: publica business_signal (result_projection/below_breakeven) quando o mês PROJETA prejuízo
 * com dias suficientes; hipótese + impactAmount null; nunca decision_action; NÃO alerta no ruído de
 * poucos dias (RN-RP-2); self-healing (resolve ao voltar pro azul / reabre ao recorrer); dedupe;
 * pass() só orgs com receita no mês; isolamento.
 *
 * Uso: npm run test:result-projection-signal
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rpsig-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rpsig-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ResultProjectionService: RP } = await import("../src/server/ResultProjectionService.js");

  const mkOrg = () => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o); return o; };
  const mkSale = (org: string, revenue: number, cost: number, ym = "2026-06", day = "10") => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', ?, ?)`).run(oid, org, revenue, `${ym}-${day} 10:00:00`);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', ?, 1, ?, ?)`).run(randomUUID(), oid, org, revenue, revenue, cost);
  };
  const mkPayable = (org: string, amount: number, recurrence: "none" | "monthly", ym = "2026-06") =>
    db.prepare(`INSERT INTO payables (id, organization_id, description, amount, due_date, recurrence, status) VALUES (?, ?, 'D', ?, ?, ?, 'open')`).run(randomUUID(), org, amount, `${ym}-05`, recurrence);

  const sig = (org: string) => db.prepare(`SELECT status FROM business_signals WHERE organization_id=? AND domain='result_projection' AND dedupe_key='result_projection:below_breakeven'`).get(org) as any;

  // ── A: mês projeta PREJUÍZO (receita 200/cmv 80/var 20/fixo 300 → proj −100 no dia 15) → publica ──
  const A = mkOrg();
  mkSale(A, 200, 80);
  mkPayable(A, 20, "none");
  mkPayable(A, 300, "monthly");
  const r1 = RP.publishResultProjectionSignal(A, { period: "2026-06", asOf: "2026-06-15" });
  check("1.1 publicou (mês projeta abaixo do equilíbrio)", r1.published === true);
  const row = db.prepare(`SELECT basis, impact_amount, severity FROM business_signals WHERE organization_id=? AND dedupe_key='result_projection:below_breakeven'`).get(A) as any;
  check("1.2 hypothesis + impact null (não inventa dinheiro medido)", row.basis === "hypothesis" && row.impact_amount == null);
  check("1.3 severity attention", row.severity === "attention");

  // 2. Nunca cria decision_action.
  check("2.1 zero decision_action", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n === 0);

  // 3. Dedupe.
  RP.publishResultProjectionSignal(A, { period: "2026-06", asOf: "2026-06-15" });
  check("3.1 dedupe (1 linha)", (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id=? AND dedupe_key='result_projection:below_breakeven'`).get(A) as any).n === 1);

  // 4. NÃO alerta no ruído de poucos dias (RN-RP-2): dia 3 → insufficient_elapsed → não publica.
  const B = mkOrg();
  mkSale(B, 200, 80); mkPayable(B, 20, "none"); mkPayable(B, 300, "monthly");
  const r4 = RP.publishResultProjectionSignal(B, { period: "2026-06", asOf: "2026-06-03" });
  check("4.1 poucos dias → não publica (não alerta no ruído)", r4.published === false && !sig(B));

  // 5. Self-healing: o mês vira AZUL (receita sobe) → resolve.
  mkSale(A, 5000, 1000); // agora projeta lucro
  const r5 = RP.publishResultProjectionSignal(A, { period: "2026-06", asOf: "2026-06-15" });
  check("5.1 voltou pro azul → resolved", r5.published === false && sig(A)?.status === "resolved");

  // 6. Recorre: some a receita boa → volta o prejuízo → reabre.
  db.prepare(`DELETE FROM orders WHERE organization_id=? AND total_amount=5000`).run(A);
  db.prepare(`DELETE FROM order_items WHERE organization_id=? AND line_total=5000`).run(A);
  const r6 = RP.publishResultProjectionSignal(A, { period: "2026-06", asOf: "2026-06-15" });
  check("6.1 recorre → republica/reabre", r6.published === true && sig(A)?.status !== "resolved");

  // 7. Org que projeta LUCRO nunca sinaliza.
  const C = mkOrg();
  mkSale(C, 1000, 400); mkPayable(C, 100, "none"); mkPayable(C, 300, "monthly");
  const r7 = RP.publishResultProjectionSignal(C, { period: "2026-06", asOf: "2026-06-15" });
  check("7.1 projeta lucro → não publica", r7.published === false && !sig(C));

  // 8. pass() não quebra e org SEM receita no mês corrente não é sinalizada.
  const D = mkOrg(); // sem venda alguma
  RP.pass();
  check("8.1 pass() roda; org sem receita não sinalizada", !sig(D));

  // 9. Isolamento.
  check("9.1 isolado (A tem, C/D não)", !!sig(A) && !sig(C) && !sig(D));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} result-projection-signal: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
