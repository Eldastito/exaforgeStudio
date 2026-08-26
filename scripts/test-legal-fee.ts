/**
 * TEST — Honorários (ADR-191 F8). DB-backed, determinístico.
 * Prova a COMPOSIÇÃO sobre o financeiro: honorário FIXO vira `receivable`, AVENÇA vira
 * `subscription`, o extrato consolida acordado×recebido×aberto, RN-ADV-07 (nunca inventa
 * dinheiro: valor obrigatório; sem honorário → totais NULL, não R$ 0,00) e o cancelamento
 * propaga pro instrumento financeiro.
 *
 * Uso: npm run test:legal-fee
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-legalfee-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-legalfee-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegalFeeService: F } = await import("../src/server/LegalFeeService.js");
  const { LegalCaseService: C } = await import("../src/server/LegalCaseService.js");
  const { SubscriptionService } = await import("../src/server/SubscriptionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Silva Adv', 'active', 'advocacia')`).run(randomUUID(), A);
  const clientId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente', ?)`).run(clientId, A, "5511" + Math.floor(Math.random() * 1e9));
  const proc = C.open(A, { contactId: clientId, title: "Ação X" }, "u1");

  // ── 1. Sem honorário → extrato honesto (totais NULL, nunca R$ 0,00) — RN-ADV-07 ──
  const empty = F.statement(A, { caseId: proc.id });
  check("1.1 sem honorário → totais NULL (não inventa 0)", empty.agreedTotal === null && empty.receivedTotal === null && empty.openTotal === null && empty.fees.length === 0);

  // ── 2. Honorário FIXO → recebível ──
  const fx = F.createFixed(A, { caseId: proc.id, description: "Entrada do processo", amount: 3000, dueDate: "2025-09-30" }, "u1");
  check("2.1 fixo criado ligado ao recebível", fx.fee_type === "fixo" && !!fx.receivable_id && fx.contact_id === clientId);
  const rec = db.prepare(`SELECT * FROM receivables WHERE organization_id = ? AND id = ?`).get(A, fx.receivable_id) as any;
  check("2.2 recebível existe no razão (source_type legal_fee, aberto)", !!rec && rec.source_type === "legal_fee" && rec.status === "open" && rec.amount === 3000);

  // ── 3. RN-ADV-07: valor obrigatório (nunca inventa dinheiro) ──
  let e1 = false; try { F.createFixed(A, { caseId: proc.id, description: "Sem valor", amount: 0, dueDate: "2025-09-30" }, "u1"); } catch { e1 = true; }
  check("3.1 honorário sem valor é rejeitado", e1);

  // ── 4. Extrato reflete acordado/aberto; pagar move p/ recebido ──
  const st1 = F.statement(A, { caseId: proc.id });
  check("4.1 extrato mostra acordado=3000, aberto=3000, recebido=0", st1.agreedTotal === 3000 && st1.openTotal === 3000 && st1.receivedTotal === 0);
  F.markFixedPaid(A, fx.id, { date: "2025-09-25" }, "u1");
  const st2 = F.statement(A, { caseId: proc.id });
  check("4.2 após pagar: recebido=3000, aberto=0", st2.receivedTotal === 3000 && st2.openTotal === 0);

  // ── 5. Honorário de AVENÇA → plano + assinatura ──
  const av = F.createRetainer(A, { caseId: proc.id, description: "Consultoria mensal", amount: 800 }, "u1");
  check("5.1 avença criada ligada a plano+assinatura", av.fee_type === "avenca" && !!av.plan_id && !!av.subscription_id);
  const sub = db.prepare(`SELECT * FROM subscriptions WHERE organization_id = ? AND id = ?`).get(A, av.subscription_id) as any;
  check("5.2 assinatura ativa no valor mensal", !!sub && sub.status === "active" && sub.amount === 800);

  // ── 6. Extrato da avença soma faturas pagas × pendentes ──
  const inv = SubscriptionService.generateInvoice(A, av.subscription_id)!;
  const st3 = F.statement(A, { caseId: proc.id });
  check("6.1 fatura pendente entra no aberto da avença", st3.openTotal === 800);
  SubscriptionService.markInvoicePaid(A, inv.id);
  const st4 = F.statement(A, { caseId: proc.id });
  check("6.2 fatura paga entra no recebido (fixo 3000 + avença 800)", st4.receivedTotal === 3800 && st4.openTotal === 0);

  // ── 7. Cancelamento propaga pro instrumento financeiro ──
  const fx2 = F.createFixed(A, { caseId: proc.id, description: "Custas", amount: 500, dueDate: "2025-10-15" }, "u1");
  F.cancel(A, fx2.id, "u1");
  const rec2 = db.prepare(`SELECT status FROM receivables WHERE organization_id = ? AND id = ?`).get(A, fx2.receivable_id) as any;
  check("7.1 cancelar fixo cancela o recebível aberto", rec2?.status === "canceled");
  F.cancel(A, av.id, "u1");
  const sub2 = db.prepare(`SELECT status FROM subscriptions WHERE organization_id = ? AND id = ?`).get(A, av.subscription_id) as any;
  check("7.2 cancelar avença cancela a assinatura", sub2?.status === "cancelled");
  check("7.3 honorário pago NÃO some do extrato (só ativos), cancelados fora", F.list(A, { caseId: proc.id, status: "active" }).length === 1);

  // ── 8. Cliente sem processo (honorário avulso) ──
  const avulso = F.createFixed(A, { contactId: clientId, description: "Parecer avulso", amount: 1200, dueDate: "2025-11-01" }, "u1");
  check("8.1 honorário por cliente (sem processo) funciona", avulso.case_id === null && avulso.contact_id === clientId);
  let e2 = false; try { F.createFixed(A, { description: "Sem cliente nem processo", amount: 100, dueDate: "2025-11-01" }, "u1"); } catch { e2 = true; }
  check("8.2 sem cliente e sem processo → rejeitado", e2);

  // ── 9. Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Outro', 'active', 'advocacia')`).run(randomUUID(), B);
  check("9.1 org B não enxerga honorários de A", F.list(B).length === 0 && F.get(B, fx.id) === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legal-fee: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
