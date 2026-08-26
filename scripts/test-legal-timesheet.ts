/**
 * TEST — Honorário por-hora / timesheet (ADR-191 F11). DB-backed, determinístico.
 * Prova o registro de horas, o amount DERIVADO (horas × valor-hora), a honestidade
 * RN-ADV-07 (sem tarifa → amount NULL, não faturável; resumo separa faturável de
 * pendente-de-tarifa), o faturamento que vira honorário FIXO (reuso F8 → receivable)
 * e a idempotência (hora faturada não fatura de novo).
 *
 * Uso: npm run test:legal-timesheet
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-legalts-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-legalts-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegalTimesheetService: T } = await import("../src/server/LegalTimesheetService.js");
  const { LegalFeeService: F } = await import("../src/server/LegalFeeService.js");
  const { LegalCaseService: C } = await import("../src/server/LegalCaseService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Silva Adv', 'active', 'advocacia')`).run(randomUUID(), A);
  const clientId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente', ?)`).run(clientId, A, "5511" + Math.floor(Math.random() * 1e9));
  const proc = C.open(A, { contactId: clientId, title: "Ação Trabalhista" }, "u1");

  // ── 1. Registrar horas → amount derivado (horas × valor-hora) ──
  const e1 = T.logTime(A, { caseId: proc.id, description: "Petição inicial", minutes: 120, ratePerHour: 300 }, "u1");
  check("1.1 lançamento criado com cliente derivado do processo", e1.contact_id === clientId && e1.minutes === 120);
  check("1.2 amount derivado = 2h × 300 = 600", e1.amount === 600);

  // ── 2. RN-ADV-07: sem tarifa → amount NULL, não faturável ──
  const e2 = T.logTime(A, { caseId: proc.id, description: "Reunião sem tarifa acordada", minutes: 60 }, "u1");
  check("2.1 sem valor-hora → amount NULL (nunca inventa)", e2.amount === null && e2.rate_per_hour === null);
  let bad = false; try { T.logTime(A, { caseId: proc.id, description: "x", minutes: 0 }, "u1"); } catch { bad = true; }
  check("2.2 duração inválida rejeitada", bad);
  let badRate = false; try { T.logTime(A, { caseId: proc.id, description: "x", minutes: 30, ratePerHour: -5 }, "u1"); } catch { badRate = true; }
  check("2.3 valor-hora inválido rejeitado", badRate);

  // ── 3. Resumo separa faturável (com tarifa) de pendente-de-tarifa ──
  const s1 = T.summary(A, { caseId: proc.id });
  check("3.1 resumo: faturável=600, pendente-de-tarifa=60min", s1.billableAmount === 600 && s1.pendingRateMinutes === 60 && s1.totalMinutes === 180);

  // ── 4. Faturar as horas COM tarifa → honorário FIXO (reuso F8) ──
  const bill = T.bill(A, { caseId: proc.id, dueDate: "2025-10-31" }, "u1");
  check("4.1 faturou 1 lançamento (só o com tarifa)", bill.entriesBilled === 1 && bill.amount === 600 && bill.hours === 2);
  check("4.2 gerou um honorário FIXO (F8)", bill.fee.fee_type === "fixo" && !!bill.fee.receivable_id);
  const rec = db.prepare(`SELECT amount, source_type, status FROM receivables WHERE organization_id = ? AND id = ?`).get(A, bill.fee.receivable_id) as any;
  check("4.3 recebível de 600 no razão (source legal_fee)", rec?.amount === 600 && rec?.source_type === "legal_fee");
  check("4.4 lançamento faturado marcado + amarrado ao honorário", T.get(A, e1.id).billed === 1 && T.get(A, e1.id).fee_id === bill.fee.id);

  // ── 5. Idempotência: não fatura de novo o que já foi faturado ──
  let noMore = false; try { T.bill(A, { caseId: proc.id, dueDate: "2025-11-30" }, "u1"); } catch { noMore = true; }
  check("5.1 sem novas horas faturáveis → recusa (não duplica)", noMore);

  // ── 6. Tarifa-default no faturamento aplica aos sem-tarifa (decisão humana explícita) ──
  const bill2 = T.bill(A, { caseId: proc.id, dueDate: "2025-11-30", defaultRatePerHour: 200 }, "u1");
  check("6.1 default aplica ao pendente: 1h × 200 = 200", bill2.amount === 200 && bill2.entriesBilled === 1);
  check("6.2 tarifa aplicada congela no lançamento (auditável)", T.get(A, e2.id).rate_per_hour === 200 && T.get(A, e2.id).billed === 1);

  // ── 7. Extrato do processo (F8) agora soma os dois honorários por-hora ──
  const st = F.statement(A, { caseId: proc.id });
  check("7.1 extrato do processo soma 600 + 200 = 800 em aberto", st.agreedTotal === 800 && st.openTotal === 800);

  // ── 8. Anular lançamento não faturado ──
  const e3 = T.logTime(A, { caseId: proc.id, description: "Trabalho a anular", minutes: 45, ratePerHour: 300 }, "u1");
  T.voidEntry(A, e3.id, "u1");
  check("8.1 anulado sai do faturável", T.get(A, e3.id).billable === 0);
  let cantVoid = false; try { T.voidEntry(A, e1.id, "u1"); } catch { cantVoid = true; }
  check("8.2 lançamento já faturado não pode ser anulado", cantVoid);

  // ── 9. Cliente avulso (sem processo) ──
  const eAvulso = T.logTime(A, { contactId: clientId, description: "Consulta avulsa", minutes: 30, ratePerHour: 400 }, "u1");
  check("9.1 timesheet por cliente sem processo funciona", eAvulso.case_id === null && eAvulso.amount === 200);
  let noClient = false; try { T.logTime(A, { description: "sem ninguém", minutes: 30 }, "u1"); } catch { noClient = true; }
  check("9.2 sem cliente e sem processo → rejeitado", noClient);

  // ── 10. Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Outro', 'active', 'advocacia')`).run(randomUUID(), B);
  check("10.1 org B não enxerga lançamentos de A", T.list(B).length === 0 && T.get(B, e1.id) === null);
  check("10.2 resumo de B sem horas → billableAmount NULL (não R$ 0,00)", T.summary(B, { caseId: proc.id }).billableAmount === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legal-timesheet: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
