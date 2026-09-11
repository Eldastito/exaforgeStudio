/**
 * TEST — Financial Recovery OS (PRD-ZF-UNIFIED-GAP-CLOSURE-03 F3, PR-5): Mapa da Dívida
 * (RecoveryDebtService) + quadro de recuperação (RecoveryAssessmentService).
 *
 * Cobre: CRUD + validação · RN-FR-1 (null≠0, nunca inventa) · retenção (cancel=UPDATE, não
 * DELETE) · summary agregado + dataCompleteness · gate opt-in · assessment compõe financeiro
 * + dívida + caveats · dinheiro role-gated (§73) · isolamento multi-tenant.
 *
 * Uso: npm run test:financial-recovery
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-frec-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-frec-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { RecoveryDebtService: D } = await import("../src/server/RecoveryDebtService.js");
  const { RecoveryAssessmentService: R } = await import("../src/server/RecoveryAssessmentService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), A);

  // ── 1. Gate opt-in (default OFF) ──
  check("1.1 módulo desligado por default", R.isEnabled(A) === false);
  R.setEnabled(A, true);
  check("1.2 setEnabled liga", R.isEnabled(A) === true);
  check("1.3 settings reflete", R.settings(A).enabled === true && R.settings(A).debtItems === 0);

  // ── 2. Create + validação + RN-FR-1 (null≠0) ──
  const d1 = D.create(A, { creditor: "Banco X", category: "loan", amountTotal: 50000, amountOverdue: 10000, monthlyPayment: 3000, interestRate: 2.5, legalRisk: "medium" }, "u1");
  check("2.1 create ok", !!d1?.id && d1.creditor === "Banco X" && d1.status === "open");
  check("2.2 campo desconhecido fica NULL (secured não informado)", d1.secured === null);
  check("2.3 due_date desconhecido NULL, não vazio", d1.due_date === null);
  let threw = false; try { D.create(A, { creditor: "X", category: "bogus" as any, amountTotal: 1 }); } catch { threw = true; }
  check("2.4 category inválida rejeitada", threw);
  threw = false; try { D.create(A, { creditor: "", category: "tax", amountTotal: 1 }); } catch { threw = true; }
  check("2.5 creditor vazio rejeitado", threw);
  threw = false; try { D.create(A, { creditor: "Y", category: "tax", amountTotal: -5 }); } catch { threw = true; }
  check("2.6 amountTotal negativo rejeitado", threw);

  // dívida sem parcela mensal (monthly_payment desconhecido)
  const d2 = D.create(A, { creditor: "Receita Federal", category: "tax", amountTotal: 20000, amountOverdue: 20000 }, "u1");
  check("2.7 monthly_payment ausente = NULL (não 0 — RN-FR-1)", d2.monthly_payment === null);

  // ── 3. Update + retenção (cancel = UPDATE, nunca DELETE) ──
  const up = D.update(A, d1.id, { status: "renegotiating", monthlyPayment: 2500 }, "u1");
  check("3.1 update patch aplica", up.status === "renegotiating" && Number(up.monthly_payment) === 2500);
  const cx = D.cancel(A, d2.id, "u1");
  check("3.2 cancel = status canceled", cx.status === "canceled");
  check("3.3 linha preservada (não deletada — RN-FR-9)", !!D.get(A, d2.id));
  check("3.4 list default esconde canceladas", D.list(A).every((r: any) => r.status !== "canceled"));
  check("3.5 includeCanceled traz de volta", D.list(A, { includeCanceled: true }).some((r: any) => r.id === d2.id));

  // ── 4. Summary agregado + dataCompleteness ──
  // ativos agora: d1 (loan, 50000, monthly 2500). d2 cancelada sai do summary.
  const s1 = D.summary(A);
  check("4.1 conta só ativas", s1.itemsCount === 1);
  check("4.2 totalKnown = 50000", s1.totalKnown === 50000);
  check("4.3 monthlyServiceKnown = 2500", s1.monthlyServiceKnown === 2500);
  check("4.4 dataCompleteness ok (parcela conhecida)", s1.dataCompleteness === "ok");
  // adiciona dívida sem parcela → partial
  D.create(A, { creditor: "Fornecedor Z", category: "supplier", amountTotal: 8000 }, "u1");
  const s2 = D.summary(A);
  check("4.5 partial quando falta parcela", s2.dataCompleteness === "partial" && s2.monthlyServiceMissingCount === 1);
  check("4.6 byCategory ordenado por total desc", s2.byCategory[0].category === "loan");
  // org sem dívida → empty
  const E = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Vazia', 'active')`).run(randomUUID(), E);
  check("4.7 empty sem dívida", D.summary(E).dataCompleteness === "empty");

  // ── 5. Assessment compõe financeiro + dívida + caveats ──
  const a1 = R.assess(A);
  check("5.1 available (tem dívida)", a1.available === true);
  check("5.2 bloco dívida presente", a1.debt.itemsCount === 2 && a1.debt.totalKnown === 58000);
  check("5.3 bloco financeiro presente", !!a1.finance);
  check("5.4 caveat de parcela faltante", a1.caveats.some((c) => c.includes("sem parcela")));
  const aE = R.assess(E);
  check("5.5 caveat de mapa vazio", aE.caveats.some((c) => c.includes("Nenhuma dívida")));

  // ── 6. Dinheiro role-gated (§73) ──
  const aR = R.assess(A, { includeMoney: false });
  check("6.1 BRL da dívida redigido", aR.debt.totalKnown === null && aR.debt.totalOverdue === null);
  check("6.2 contagem PRESERVADA (não é dinheiro)", aR.debt.itemsCount === 2 && aR.debt.monthlyServiceMissingCount === 1);
  check("6.3 categoria total redigido mas count preservado", aR.debt.byCategory[0].total === null && aR.debt.byCategory[0].count >= 1);
  check("6.4 marcado redacted", aR.redacted === true);
  check("6.5 default expõe R$", a1.debt.totalKnown === 58000);

  // ── 7. Isolamento multi-tenant ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Outra', 'active')`).run(randomUUID(), B);
  check("7.1 org B não vê dívidas de A", D.list(B).length === 0 && D.summary(B).itemsCount === 0);
  check("7.2 update cross-org falha", (() => { try { D.update(B, d1.id, { status: "settled" }); return false; } catch { return true; } })());

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} financial-recovery: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
