/**
 * TEST — Inteligência Financeira Conectada (ADR-200 F3). DB-backed, determinístico.
 * Prova: assemble junta DRE + Balanço + Fluxo; a ponte "lucro ≠ caixa" (gap = lucro − caixa gerado)
 * + narrativa; sinal `connected_financials/lucro_sem_caixa` quando material (lucrou mas o dinheiro
 * não veio), hipótese + impact null, self-healing; NÃO sinaliza quando o caixa acompanha ou sem
 * lucro; isolamento.
 *
 * Uso: npm run test:connected-financials
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-connfin-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-connfin-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ConnectedFinancialsService: CFn } = await import("../src/server/ConnectedFinancialsService.js");

  const mkOrg = (v = "moda") => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical) VALUES (?, 'O', 'active', ?)`).run(o, v); return o; };
  const mkOrder = (org: string, rev: number, cost: number, date: string) => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', ?, ?)`).run(oid, org, rev, `${date} 10:00:00`);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', ?, 1, ?, ?)`).run(randomUUID(), oid, org, rev, rev, cost);
  };
  const mkPayablePaid = (org: string, amount: number) => db.prepare(`INSERT INTO payables (id, organization_id, description, amount, due_date, recurrence, status, paid_at, created_at) VALUES (?, ?, 'D', ?, '2026-06-05', 'monthly', 'paid', '2026-06-10', '2026-06-01 10:00:00')`).run(randomUUID(), org, amount);
  const mkReceivable = (org: string, amount: number) => db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status, created_at) VALUES (?, ?, 'R', ?, '2026-06-15', 'open', '2026-06-15 10:00:00')`).run(randomUUID(), org, amount);
  const mkCashEvent = (org: string, dir: "in" | "out", amount: number, date: string) => db.prepare(`INSERT INTO cash_events (id, organization_id, direction, amount, event_date) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, dir, amount, date);
  const sig = (org: string) => db.prepare(`SELECT status, basis, impact_amount FROM business_signals WHERE organization_id=? AND dedupe_key='connected_financials:lucro_sem_caixa'`).get(org) as any;

  const P = "2026-06";

  // ── A: LUCRO SEM CAIXA — lucrou 400 mas o caixa foi −400 (travou em recebível) ──
  const A = mkOrg("moda");
  mkOrder(A, 1000, 400, "2026-06-10");     // margem bruta 600
  mkPayablePaid(A, 200);                    // despesa paga → DRE 200 → resultado 400
  mkReceivable(A, 500);                     // vendeu fiado → Δreceber 500
  mkCashEvent(A, "in", 100, "2026-06-10");
  mkCashEvent(A, "out", 500, "2026-06-20"); // variação real = −400

  const a = CFn.assemble(A, P);
  check("1.1 os três demonstrativos presentes", !!a.dre?.linhas && !!a.balance?.ativo && !!a.cashflow?.capitalDeGiro);
  check("1.2 ponte: lucro 400, caixa gerado −400, gap 800", a.ponte.lucro === 400 && a.ponte.caixaGerado === -400 && a.ponte.gap === 800);
  check("1.3 lucroSemCaixa = true", a.ponte.lucroSemCaixa === true);
  check("1.4 preso reflete o recebível (500)", a.ponte.preso === 500);
  check("1.5 narrativa fala de lucro e caixa", /lucrou/i.test(a.narrativa) && /caixa/i.test(a.narrativa));
  check("1.6 decomposição traz Δreceber 500", a.ponte.decomposicao.deltaReceber === 500);

  const r1 = CFn.publishConnectionSignal(A, { period: P });
  check("2.1 publica sinal lucro_sem_caixa", r1.published === true);
  const row = sig(A);
  check("2.2 hypothesis + impact null", row.basis === "hypothesis" && row.impact_amount == null);
  CFn.publishConnectionSignal(A, { period: P });
  check("2.3 dedupe (1 linha)", (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id=? AND dedupe_key='connected_financials:lucro_sem_caixa'`).get(A) as any).n === 1);
  check("2.4 nunca cria decision_action", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n === 0);

  // ── 3: self-healing — entra caixa forte → caixa acompanha → resolve ──
  mkCashEvent(A, "in", 2000, "2026-06-25"); // variação real vira +1600
  const a2 = CFn.assemble(A, P);
  check("3.1 caixa acompanhou → lucroSemCaixa false", a2.ponte.lucroSemCaixa === false);
  const r3 = CFn.publishConnectionSignal(A, { period: P });
  check("3.2 resolve o sinal", r3.published === false && sig(A)?.status === "resolved");

  // ── 4: lucro COM caixa → nunca sinaliza ──
  const B = mkOrg("moda");
  mkOrder(B, 1000, 400, "2026-06-10"); mkPayablePaid(B, 200); // resultado 400
  mkCashEvent(B, "in", 500, "2026-06-10");                    // caixa 500 ≥ lucro 400
  const b = CFn.assemble(B, P);
  check("4.1 caixa acompanha → lucroSemCaixa false", b.ponte.lucroSemCaixa === false);
  check("4.2 não publica", CFn.publishConnectionSignal(B, { period: P }).published === false && !sig(B));

  // ── 5: sem lucro → não é o caso do CFO ──
  const C = mkOrg("servicos");
  mkOrder(C, 100, 50, "2026-06-10"); mkPayablePaid(C, 200);   // resultado negativo
  const c = CFn.assemble(C, P);
  check("5.1 lucro ≤ 0 → lucroSemCaixa false", c.ponte.lucro <= 0 && c.ponte.lucroSemCaixa === false);
  check("5.2 não publica", CFn.publishConnectionSignal(C, { period: P }).published === false && !sig(C));

  // ── 6: pass() roda + isolamento ──
  CFn.pass();
  check("6.1 pass roda sem quebrar; isolamento (A resolvido, B/C sem sinal)", sig(A)?.status === "resolved" && !sig(B) && !sig(C));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} connected-financials: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
