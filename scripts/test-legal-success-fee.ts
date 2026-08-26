/**
 * TEST — Honorário de êxito / success fee (ADR-191 F12). DB-backed, determinístico.
 * Prova o acordo percentual (pending, sem valor), RN-ADV-07 (amount NULL até o HUMANO
 * informar o proveito econômico — a IA nunca arbitra o valor da causa), a confirmação
 * que vira honorário FIXO (reuso F8 → receivable), a prévia e o cancelamento.
 *
 * Uso: npm run test:legal-success-fee
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-legalsf-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-legalsf-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegalSuccessFeeService: S } = await import("../src/server/LegalSuccessFeeService.js");
  const { LegalFeeService: F } = await import("../src/server/LegalFeeService.js");
  const { LegalCaseService: C } = await import("../src/server/LegalCaseService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Silva Adv', 'active', 'advocacia')`).run(randomUUID(), A);
  const clientId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente', ?)`).run(clientId, A, "5511" + Math.floor(Math.random() * 1e9));
  const proc = C.open(A, { contactId: clientId, title: "Ação de Cobrança" }, "u1");

  // ── 1. Acordar êxito (percentual) → pending, sem valor ──
  const sf = S.agree(A, { caseId: proc.id, percent: 20, description: "Êxito na cobrança" }, "u1");
  check("1.1 acordo criado pending, cliente derivado do processo", sf.status === "pending" && sf.contact_id === clientId && sf.percent === 20);
  check("1.2 RN-ADV-07: base_amount e amount NULL até confirmar (nunca inventa)", sf.base_amount === null && sf.amount === null);

  // ── 2. Validações ──
  let e1 = false; try { S.agree(A, { caseId: proc.id, percent: 0 }, "u1"); } catch { e1 = true; }
  check("2.1 percentual inválido (0) rejeitado", e1);
  let e2 = false; try { S.agree(A, { caseId: proc.id, percent: 150 }, "u1"); } catch { e2 = true; }
  check("2.2 percentual > 100 rejeitado", e2);
  let e3 = false; try { S.agree(A, { caseId: randomUUID(), percent: 20 }, "u1"); } catch { e3 = true; }
  check("2.3 processo inexistente rejeitado", e3);

  // ── 3. Prévia (sem persistir) — proveito × percent ──
  const pv = S.preview(A, sf.id, 50000);
  check("3.1 prévia: 20% de 50000 = 10000", pv.amount === 10000 && pv.baseAmount === 50000 && pv.percent === 20);
  check("3.2 prévia NÃO persiste (segue pending, valores NULL)", S.get(A, sf.id).amount === null);
  let e4 = false; try { S.preview(A, sf.id, 0); } catch { e4 = true; }
  check("3.3 prévia com proveito inválido rejeitada", e4);

  // ── 4. RN-ADV-07: confirmar EXIGE o proveito econômico (humano informa) ──
  let e5 = false; try { S.confirm(A, sf.id, { baseAmount: 0, dueDate: "2025-12-31" }, "u1"); } catch { e5 = true; }
  check("4.1 confirmar sem proveito econômico é rejeitado (nunca arbitra o valor da causa)", e5);

  // ── 5. Confirmar → vira honorário FIXO (reuso F8) ──
  const confirmed = S.confirm(A, sf.id, { baseAmount: 50000, dueDate: "2025-12-31" }, "u1");
  check("5.1 confirmado com base e amount derivado", confirmed.status === "confirmed" && confirmed.base_amount === 50000 && confirmed.amount === 10000);
  check("5.2 gerou honorário FIXO (F8)", !!confirmed.fee_id);
  const fee = F.list(A, { caseId: proc.id }).find((x: any) => x.id === confirmed.fee_id);
  check("5.3 honorário fixo de 10000 no F8", !!fee && fee.fee_type === "fixo" && fee.amount === 10000);
  const rec = db.prepare(`SELECT amount, source_type FROM receivables WHERE organization_id = ? AND id = ?`).get(A, fee.receivable_id) as any;
  check("5.4 recebível de 10000 no razão (source legal_fee)", rec?.amount === 10000 && rec?.source_type === "legal_fee");

  // ── 6. Confirmar é idempotente; cancelar confirmado é barrado ──
  check("6.1 re-confirmar retorna o mesmo (idempotente)", S.confirm(A, sf.id, { baseAmount: 999, dueDate: "2025-12-31" }, "u1").amount === 10000);
  let e6 = false; try { S.cancel(A, sf.id, "u1"); } catch { e6 = true; }
  check("6.2 cancelar acordo já confirmado é barrado", e6);

  // ── 7. Cancelar acordo pendente (resultado desfavorável) ──
  const sf2 = S.agree(A, { caseId: proc.id, percent: 30 }, "u1");
  const canc = S.cancel(A, sf2.id, "u1");
  check("7.1 acordo pendente cancelado (preserva histórico)", canc.status === "cancelled" && !!S.get(A, sf2.id));
  let e7 = false; try { S.confirm(A, sf2.id, { baseAmount: 1000, dueDate: "2025-12-31" }, "u1"); } catch { e7 = true; }
  check("7.2 acordo cancelado não pode ser confirmado", e7);

  // ── 8. Extrato F8 reflete o honorário de êxito confirmado ──
  const st = F.statement(A, { caseId: proc.id });
  check("8.1 extrato do processo tem os 10000 do êxito em aberto", st.agreedTotal === 10000 && st.openTotal === 10000);

  // ── 9. Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Outro', 'active', 'advocacia')`).run(randomUUID(), B);
  check("9.1 org B não enxerga honorários de êxito de A", S.list(B).length === 0 && S.get(B, sf.id) === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legal-success-fee: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
