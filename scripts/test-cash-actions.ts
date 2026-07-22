/**
 * TEST — Motor de Caixa: alerta → ação → medição (ADR-125 Fatia 3).
 *
 * Fecha o ciclo executar→medir: sugere ações ancoradas em dado real para cobrir
 * a ruptura, o lojista aprova (nada executa sozinho) e o Impact Ledger mede
 * esperado × realizado. Roda sem chave de IA.
 *
 * Uso: npm run test:cash-actions
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cashact-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-cashact-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

function fmt(dt: Date) { return dt.toISOString().slice(0, 10); }
function mondayOf(d: Date) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const dow = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dow); return x; }
function addDays(dt: Date, n: number) { const x = new Date(dt); x.setUTCDate(x.getUTCDate() + n); return x; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { CashActionService: A } = await import("../src/server/CashActionService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);
  const week0 = mondayOf(new Date());
  const inWeek = (w: number) => fmt(addDays(week0, w * 7 + 2));

  // Cenário de ruptura: caixa 1000; conta de 3000 na semana 2; 800 a receber na semana 1.
  F.recordEvent(orgId, { direction: "in", amount: 1000 });
  F.addPayable(orgId, { description: "Aluguel", amount: 3000, dueDate: inWeek(2) });
  F.addReceivable(orgId, { description: "Cliente A", amount: 800, dueDate: inWeek(1), probability: 1 });

  // ===== 1. Sugestões cobrem a ruptura, ancoradas em dado real =====
  const sug = A.suggest(orgId, 0);
  check("há ruptura detectada", !!sug.firstRisk);
  check("rombo (shortfall) positivo", sug.shortfall > 0);
  check("sugere cobrar recebível (dado real)", sug.actions.some((a: any) => a.kind === "cobrar_receber" && a.grounded && a.expectedImpact > 0));
  check("sugere postergar conta a pagar", sug.actions.some((a: any) => a.kind === "postergar_pagar" && a.grounded));
  check("no máximo 3 ações", sug.actions.length <= 3);

  // Org sem ruptura → sem ações.
  const ok = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), ok);
  F.recordEvent(ok, { direction: "in", amount: 5000 });
  check("sem ruptura → nenhuma ação sugerida", A.suggest(ok, 0).actions.length === 0 && A.suggest(ok, 0).firstRisk === null);

  // ===== 2. Aprovação humana: criar não executa nada (caixa intacto) =====
  const caixaAntes = F.cashOnHand(orgId);
  const act = A.create(orgId, { kind: "cobrar_receber", title: "Cobrar 800", expectedImpact: 800, baselineShortfall: sug.shortfall }) as any;
  check("ação registrada (aceita)", act.ok && typeof act.id === "string");
  check("registrar ação NÃO mexe no caixa", near(F.cashOnHand(orgId), caixaAntes));

  // ===== 3. Impact Ledger: esperado × realizado =====
  let led = A.ledger(orgId);
  check("ledger conta o esperado (800)", near(led.expected, 800) && led.open === 1 && led.done === 0);
  check("ledger ainda sem realizado", near(led.realized, 0));

  A.complete(orgId, act.id, 600); // recebeu 600 dos 800
  led = A.ledger(orgId);
  check("concluir registra o realizado medido (600)", near(led.realized, 600) && led.done === 1);
  check("concluir de novo é recusado", A.complete(orgId, act.id, 100).ok === false);

  // ===== 4. Dispensar =====
  const act2 = A.create(orgId, { kind: "campanha", title: "Campanha", expectedImpact: 500 }) as any;
  check("dispensar remove do ledger ativo", A.dismiss(orgId, act2.id).ok && A.ledger(orgId).items.every((i: any) => i.id !== act2.id));

  // ===== 5. Isolamento =====
  check("isolamento: outra org sem ações", A.ledger(ok).items.length === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Motor de Caixa — alerta→ação→medição (ADR-125 Fatia 3) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Ações de caixa (Impact Ledger) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
