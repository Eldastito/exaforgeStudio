/**
 * TESTE — CSAT por ATENDIMENTO (salão/clínica opera em appointments, não orders).
 * ----------------------------------------------------------------------------
 * Gap: `SatisfactionService.create` só aceitava `orderId` e o `npsPass` só
 * pesquisava PEDIDOS pagos. Um negócio de serviço (salão, banho & tosa, clínica)
 * completa ATENDIMENTOS sem gerar `orders` — a métrica executiva
 * `customer_satisfaction` (derivada de `satisfaction_surveys`) ficava CEGA a ele.
 *
 * Esta fatia adiciona `appointment_id` à pesquisa + `dueAppointments` (seletor
 * read-only dos atendimentos realizados elegíveis, com dedup por atendimento).
 *
 * Prova:
 *  - `dueAppointments` só traz `completed` com conclusão conhecida já vencida;
 *  - NUNCA inventa data de conclusão (checkout_at/scheduled_end ambos nulos → fora);
 *  - dedup por appointment_id (pesquisa criada → não reaparece);
 *  - `create` persiste appointment_id; a pesquisa aparece no analytics CSAT;
 *  - isolamento multi-tenant.
 *
 * Uso:  npm run test:csat-appointment
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-csat-appt-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-csat-appt-1";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SatisfactionService } = await import("../src/server/SatisfactionService.js");

  const NOW = new Date("2026-09-10T12:00:00Z");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'T', 'active')`).run(randomUUID(), id);
  const mkChannel = (org: string) => { const id = randomUUID(); db.prepare(`INSERT INTO channels (id, organization_id, name, provider, status) VALUES (?, ?, 'WhatsApp', 'evolution', 'active')`).run(id, org); return id; };
  const mkContact = (org: string, ch: string, name: string, num: string) => { const id = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(id, org, ch, name, num); return id; };
  // appointment com status + timestamps controlados.
  const mkAppt = (org: string, contact: string, status: string, opts: { checkoutAt?: string | null; scheduledEnd?: string | null } = {}) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, status, scheduled_end, checkout_at) VALUES (?, ?, ?, 'Banho & Tosa', ?, ?, ?)`)
      .run(id, org, contact, status, opts.scheduledEnd ?? null, opts.checkoutAt ?? null);
    return id;
  };

  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const chA = mkChannel(A);
  const rex = mkContact(A, chA, "Rex Tutor", "5511999990001");
  const luna = mkContact(A, chA, "Luna Tutor", "5511999990002");
  const bob = mkContact(A, chA, "Bob Tutor", "5511999990003");

  // Concluído há 4h (checkout_at) → elegível.
  const done1 = mkAppt(A, rex, "completed", { checkoutAt: "2026-09-10 08:00:00" });
  // Concluído (só scheduled_end) há 3h → elegível (fallback de conclusão).
  const done2 = mkAppt(A, luna, "completed", { scheduledEnd: "2026-09-10 09:00:00" });
  // Concluído há 10min → dentro da janela, NÃO elegível ainda.
  const fresh = mkAppt(A, bob, "completed", { checkoutAt: "2026-09-10 11:50:00" });
  // Concluído SEM data de conclusão (ambos nulos) → nunca inventa, fora.
  const noTs = mkAppt(A, rex, "completed", {});
  // Ainda em atendimento → fora.
  const inProg = mkAppt(A, luna, "in_progress", { scheduledEnd: "2026-09-10 07:00:00" });

  // ── 1. dueAppointments: só realizados, conclusão conhecida e vencida ──
  const due = SatisfactionService.dueAppointments(A, 2, NOW);
  const dueIds = new Set(due.map((d) => d.id));
  check("1.1 concluído há 4h (checkout) elegível", dueIds.has(done1));
  check("1.2 concluído há 3h (scheduled_end) elegível", dueIds.has(done2));
  check("1.3 concluído há 10min NÃO elegível", !dueIds.has(fresh));
  check("1.4 sem data de conclusão NÃO elegível (não inventa)", !dueIds.has(noTs));
  check("1.5 em atendimento NÃO elegível", !dueIds.has(inProg));
  check("1.6 total elegível = 2", due.length === 2);
  const d1 = due.find((d) => d.id === done1);
  check("1.7 seletor traz número/nome do contato", d1?.contact_number === "5511999990001" && d1?.contact_name === "Rex Tutor");

  // ── 2. create com appointmentId persiste o vínculo ──
  const sid = SatisfactionService.create(A, { contactId: rex, appointmentId: done1 })!;
  const row = db.prepare(`SELECT appointment_id, order_id, contact_id, status FROM satisfaction_surveys WHERE id = ?`).get(sid) as any;
  check("2.1 pesquisa persiste appointment_id", row?.appointment_id === done1);
  check("2.2 order_id nulo (pesquisa de atendimento)", row?.order_id === null);
  check("2.3 nasce como 'sent'", row?.status === "sent");

  // ── 3. dedup por appointment_id: com pesquisa criada, some da fila ──
  const dueAfter = SatisfactionService.dueAppointments(A, 2, NOW);
  check("3.1 done1 saiu da fila (dedup)", !dueAfter.some((d) => d.id === done1));
  check("3.2 done2 ainda na fila", dueAfter.some((d) => d.id === done2));

  // ── 4. score respondido alimenta o analytics CSAT (independe de order) ──
  SatisfactionService.record(A, sid, 5);
  const { AnalyticsService } = await import("../src/server/AnalyticsService.js");
  const m = AnalyticsService.getMetrics(A, { period: "month" } as any) as any;
  check("4.1 analytics conta a resposta do atendimento", Number(m?.csat?.responses) >= 1);

  // ── 5. isolamento ──
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  const chB = mkChannel(B);
  const otherContact = mkContact(B, chB, "Outro", "5521888880001");
  mkAppt(B, otherContact, "completed", { checkoutAt: "2026-09-10 08:00:00" });
  check("5.1 fila de A não vaza atendimento de B", SatisfactionService.dueAppointments(A, 2, NOW).every((d) => d.contact_number !== "5521888880001"));
  check("5.2 fila de B só vê o próprio", SatisfactionService.dueAppointments(B, 2, NOW).length === 1);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} csat-appointment: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
