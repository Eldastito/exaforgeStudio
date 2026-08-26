/**
 * TEST — Audiências/reuniões (ADR-191 F6). DB-backed, determinístico.
 * Prova a COMPOSIÇÃO sobre a agenda (`appointments` + `legal_case_id`/`hearing_type`),
 * o cliente/advogado DERIVADOS do processo, o conflito de agenda do advogado (reuso do
 * findConflicts), o ciclo remarcar/concluir/cancelar e o sinal de audiência próxima na
 * espinha (missar audiência = revelia) com self-heal.
 *
 * Uso: npm run test:legal-hearing
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-legalhear-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-legalhear-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegalHearingService: H } = await import("../src/server/LegalHearingService.js");
  const { LegalCaseService: C } = await import("../src/server/LegalCaseService.js");
  const { LegalPracticeService: P } = await import("../src/server/LegalPracticeService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Silva Adv', 'active', 'advocacia')`).run(randomUUID(), A);
  const clientId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente', ?)`).run(clientId, A, "5511" + Math.floor(Math.random() * 1e9));
  const lawyer = P.createLawyer(A, { name: "Dra. Ana", oabUf: "SP", oabNumber: "123456" }, "u1");
  const proc = C.open(A, { contactId: clientId, title: "Ação Trabalhista", responsibleLawyerId: lawyer.id }, "u1");

  // ── 1. Agendar audiência amarrada ao processo ──
  const h1 = H.schedule(A, { caseId: proc.id, hearingType: "audiencia", start: "2025-09-10T14:00:00.000Z", durationMinutes: 60 }, "u1");
  check("1.1 audiência criada como appointment amarrado ao processo", !!h1 && h1.legal_case_id === proc.id && h1.hearing_type === "audiencia");
  check("1.2 cliente DERIVADO do processo (nunca inventado)", h1.contact_id === clientId);
  check("1.3 advogado default = responsável pelo processo", h1.professional_id === lawyer.id && h1.professional_name_snapshot === "Dra. Ana");
  check("1.4 título default derivado do tipo + processo", String(h1.title).startsWith("Audiência") && String(h1.title).includes("Ação Trabalhista"));
  check("1.5 status confirmado + fim = início + duração", h1.status === "confirmed" && h1.scheduled_end === "2025-09-10T15:00:00.000Z");

  // ── 2. Validações (nunca agenda lixo) ──
  let e1 = false; try { H.schedule(A, { caseId: proc.id, hearingType: "banho", start: "2025-09-10T14:00:00.000Z" }, "u1"); } catch { e1 = true; }
  check("2.1 tipo de compromisso inválido rejeitado", e1);
  let e2 = false; try { H.schedule(A, { caseId: proc.id, start: "amanhã" }, "u1"); } catch { e2 = true; }
  check("2.2 data/hora inválida rejeitada", e2);
  let e3 = false; try { H.schedule(A, { caseId: randomUUID(), start: "2025-09-10T14:00:00.000Z" }, "u1"); } catch { e3 = true; }
  check("2.3 processo inexistente rejeitado", e3);

  // ── 3. Conflito de agenda do advogado (reuso do findConflicts) ──
  let conflicted = false, code = "";
  try { H.schedule(A, { caseId: proc.id, hearingType: "reuniao", start: "2025-09-10T14:30:00.000Z", durationMinutes: 60 }, "u1"); }
  catch (e: any) { conflicted = true; code = e?.code; }
  check("3.1 sobreposição do mesmo advogado bloqueia (CONFLICT)", conflicted && code === "CONFLICT");
  const forced = H.schedule(A, { caseId: proc.id, hearingType: "reuniao", start: "2025-09-10T14:30:00.000Z", durationMinutes: 60, force: true }, "u1");
  check("3.2 force=true mantém mesmo com conflito", !!forced && forced.id !== h1.id);

  // ── 4. Listagens ──
  check("4.1 listar por processo traz os 2 compromissos", H.list(A, { caseId: proc.id }).length === 2);
  check("4.2 listar confirmados", H.list(A, { status: "confirmed" }).length === 2);

  // ── 5. Encerramento de processo bloqueia novo agendamento ──
  C.close(A, proc.id, "acordo", "u1");
  let e4 = false; try { H.schedule(A, { caseId: proc.id, start: "2025-10-01T14:00:00.000Z" }, "u1"); } catch { e4 = true; }
  check("5.1 processo encerrado não aceita novo compromisso", e4);
  C.reopen(A, proc.id, "u1");

  // ── 6. Remarcar / concluir / cancelar ──
  const re = H.reschedule(A, h1.id, "2025-09-11T09:00:00.000Z", 90, "u1");
  check("6.1 remarcar atualiza início e fim", re.scheduled_start === "2025-09-11T09:00:00.000Z" && re.scheduled_end === "2025-09-11T10:30:00.000Z");
  const done = H.complete(A, forced.id, "u1");
  check("6.2 concluir marca completed", done.status === "completed");
  const canc = H.cancel(A, h1.id, "adiada", "u1");
  check("6.3 cancelar marca cancelled + motivo", canc.status === "cancelled" && canc.cancellation_reason === "adiada");

  // ── 7. Sinal de audiência na espinha (passada sem baixa = critical) + self-heal ──
  const past = H.schedule(A, { caseId: proc.id, hearingType: "audiencia", start: new Date(Date.now() - 86400000).toISOString(), durationMinutes: 30 }, "u1");
  const sig = await H.signalUpcoming(A, 2);
  check("7.1 signalUpcoming publicou a audiência passada", sig.signaled >= 1);
  const item = BusinessSignalService.attention(A).items.find((i: any) => i.type === "hearing_upcoming");
  check("7.2 sinal na espinha (domain legal, critical p/ passada)", !!item && item.severity === "critical" && item.domain === "legal");
  H.complete(A, past.id, "u1");
  await new Promise((r) => setTimeout(r, 20)); // deixa o resolveByDedupe (import dinâmico) rodar
  check("7.3 concluir resolve o sinal (self-healing)", !BusinessSignalService.attention(A).items.some((i: any) => i.type === "hearing_upcoming" && String(i.id).includes(past.id)));

  // ── 8. Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Outro', 'active', 'advocacia')`).run(randomUUID(), B);
  check("8.1 org B não enxerga compromissos de A", H.list(B).length === 0);
  check("8.2 get de A por org B → null", H.get(B, past.id) === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legal-hearing: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
