/**
 * TEST — Prazos processuais / motor de dias úteis (ADR-191 F5). DB-backed, det.
 * A borda MAIS crítica: perder prazo é erro profissional. Prova a CONTAGEM em dias
 * úteis (CPC 219/224) com FERIADOS, o modo corrido (protração), a honestidade
 * (holidaysLoaded), a materialização em tarefa e o sinal de prazo FATAL na espinha.
 *
 * Uso: npm run test:legal-deadline
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-legaldl-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-legaldl-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegalDeadlineService: D } = await import("../src/server/LegalDeadlineService.js");
  const { LegalCaseService: C } = await import("../src/server/LegalCaseService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Silva Adv', 'active', 'advocacia')`).run(randomUUID(), A);

  // ── 1. Contagem em dias úteis (sem feriado): 2025-06-02 (segunda) + 5 dias úteis ──
  // Ter 03, Qua 04, Qui 05, Sex 06, [Sáb/Dom pulados], Seg 09 → 2025-06-09.
  const r1 = D.computeDeadline(A, "2025-06-02", 5, "business");
  check("1.1 5 dias úteis pulam fim de semana → 2025-06-09", r1.dueDate === "2025-06-09");
  check("1.2 sem calendário carregado → holidaysLoaded false (honesto)", r1.holidaysLoaded === false);

  // ── 2. Feriado no meio empurra o prazo ──
  D.addHoliday(A, "2025-06-04", "Feriado teste", "local"); // Qua 04 vira não-útil
  const r2 = D.computeDeadline(A, "2025-06-02", 5, "business");
  check("2.1 feriado no meio empurra 1 dia → 2025-06-10", r2.dueDate === "2025-06-10");
  check("2.2 dia útil detecta feriado", D.isBusinessDay(A, "2025-06-04") === false && D.isBusinessDay(A, "2025-06-05") === true);
  check("2.3 sábado/domingo não são úteis", D.isBusinessDay(A, "2025-06-07") === false && D.isBusinessDay(A, "2025-06-08") === false);

  // ── 3. Modo corrido (calendar): +5 corridos protrai vencimento p/ dia útil (224 §1) ──
  // 2025-06-02 + 5 = 2025-06-07 (sábado) → protrai p/ 2025-06-09 (segunda).
  const r3 = D.computeDeadline(A, "2025-06-02", 5, "calendar");
  check("3.1 corrido cai em sábado → protrai p/ 2025-06-09", r3.dueDate === "2025-06-09");

  // ── 4. Seed do calendário forense (nacionais fixos + móveis via Páscoa + recesso) ──
  const seed = D.seedNationalHolidays(A, 2025);
  check("4.1 seed criou feriados", seed.created > 0);
  const hset = new Set(D.listHolidays(A, 2025).map((h: any) => h.date));
  check("4.2 Sexta-feira Santa 2025 = 2025-04-18 (Páscoa 20/04)", hset.has("2025-04-18"));
  check("4.3 Natal + recesso forense", hset.has("2025-12-25") && hset.has("2025-12-20"));
  check("4.4 após seed → holidaysLoaded true", D.computeDeadline(A, "2025-06-02", 5, "business").holidaysLoaded === true);
  check("4.5 seed idempotente (2ª vez não recria)", D.seedNationalHolidays(A, 2025).created === 0);

  // ── 5. Criar prazo → materializa TAREFA + persiste data-fim ──
  const clientId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente', ?)`).run(clientId, A, "5511" + Math.floor(Math.random() * 1e9));
  const proc = C.open(A, { contactId: clientId, title: "Ação X" }, "u1");
  const dl = D.create(A, { caseId: proc.id, title: "Contestação", publicationDate: "2025-06-02", termDays: 15, countingMode: "business", isFatal: true }, "u1");
  check("5.1 prazo criado com data-fim derivada + fatal", dl.status === "open" && dl.is_fatal === 1 && /^2025-06-/.test(dl.due_date));
  check("5.2 materializou tarefa (task_id)", !!dl.task_id);
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(dl.task_id) as any;
  check("5.3 tarefa com título de prazo + due_at na data-fim", !!task && String(task.title).startsWith("Prazo:") && String(task.due_at).startsWith(dl.due_date));
  check("5.4 listar por processo", D.list(A, { caseId: proc.id }).length === 1);

  // ── 6. Sinal de prazo FATAL na espinha (perto/vencido) + self-heal ao concluir ──
  const near = D.create(A, { title: "Recurso urgente", publicationDate: "2025-06-02", termDays: 1, countingMode: "business", isFatal: true }, "u1");
  // força o vencimento pra ontem (prazo vencido) pra o signal disparar deterministicamente
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  db.prepare(`UPDATE legal_deadlines SET due_date = ? WHERE id = ?`).run(yesterday, near.id);
  const sig = await D.signalFatal(A, 3);
  check("6.1 signalFatal publicou o prazo vencido", sig.signaled >= 1);
  const item = BusinessSignalService.attention(A).items.find((i: any) => i.type === "deadline_due");
  check("6.2 sinal na espinha (domain legal, critical p/ vencido)", !!item && item.severity === "critical" && item.domain === "legal");
  D.complete(A, near.id, "u1");
  await new Promise((r) => setTimeout(r, 20)); // deixa o resolveByDedupe (import dinâmico) rodar
  check("6.3 concluir resolve o sinal (self-healing)", !BusinessSignalService.attention(A).items.some((i: any) => i.type === "deadline_due" && i.id.includes(near.id)));

  // ── 7. Validação de entrada (nunca conta lixo) ──
  let threwDate = false; try { D.computeDeadline(A, "02/06/2025", 5); } catch { threwDate = true; }
  check("7.1 data malformada rejeitada", threwDate);
  let threwDays = false; try { D.computeDeadline(A, "2025-06-02", 0); } catch { threwDays = true; }
  check("7.2 prazo de dias inválido rejeitado", threwDays);

  // ── 8. Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Outro', 'active', 'advocacia')`).run(randomUUID(), B);
  check("8.1 org B sem feriados/prazos de A", D.listHolidays(B).length === 0 && D.list(B).length === 0);
  check("8.2 contagem de B ignora feriado de A (só pula fim de semana)", D.computeDeadline(B, "2025-06-02", 5, "business").dueDate === "2025-06-09");

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legal-deadline: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
