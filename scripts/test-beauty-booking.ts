/**
 * TEST — BEAUTY-039 (ADR-169 F38): Agendar pela recepção (criar a fila).
 *
 * Prova o BeautyReceptionService.book/services — o que POVOA a fila (F34/F37):
 *   - services() lista o catálogo ativo (type='service') com duração;
 *   - book() cria o agendamento via porta canônica com profissional +
 *     snapshot do nome + serviço, status 'confirmed';
 *   - duração vem do serviço (F4) quando há; senão o slot da agenda;
 *   - serviço é OPCIONAL (título genérico);
 *   - conflito do mesmo profissional é rejeitado;
 *   - contato/profissional inexistente ou de outra org → rejeita (RN-BS-07);
 *   - o agendado aparece no dayBoard como aguardando (entra na fila);
 *   - fiação de rotas + UI (form de agendar no painel).
 *
 * Uso: npm run test:beauty-booking
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-book-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-book-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const { BeautyReceptionService } = await import("../src/server/BeautyReceptionService.js");
  const { AppointmentService } = await import("../src/server/AppointmentService.js");

  const seedOrg = () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`)
      .run(randomUUID(), orgId);
    return orgId;
  };
  const seedContact = (orgId: string, name: string) => {
    const id = `c_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', ?, ?)`)
      .run(id, orgId, name, "1199" + Math.floor(Math.random() * 1e7));
    return id;
  };
  const seedPro = (orgId: string, name: string, specialty: string | null = null, active = true) => {
    const id = `p_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO clinic_professionals (id, organization_id, name, specialty, active) VALUES (?, ?, ?, ?, ?)`)
      .run(id, orgId, name, specialty, active ? 1 : 0);
    return id;
  };
  const seedService = (orgId: string, name: string, durationMin: number | null) => {
    const id = `s_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO products_services (id, organization_id, name, type, active, duration_minutes) VALUES (?, ?, ?, 'service', 1, ?)`)
      .run(id, orgId, name, durationMin);
    return id;
  };

  // Data FUTURA (amanhã) em BRT — slots todos futuros, determinístico.
  const nowSp = new Date(Date.now() + 24 * 3600_000 - 3 * 3600_000);
  const date = `${nowSp.getUTCFullYear()}-${String(nowSp.getUTCMonth() + 1).padStart(2, "0")}-${String(nowSp.getUTCDate()).padStart(2, "0")}`;
  const iso = (hh: number, mm = 0) => `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-03:00`;

  const orgA = seedOrg();
  const orgB = seedOrg();
  AppointmentService.saveConfig(orgA, { openHour: 8, closeHour: 18, slotMin: 60 });

  const emily = seedContact(orgA, "Emily Souza");
  const maria = seedPro(orgA, "Maria", "Colorista");
  const svcColor = seedService(orgA, "Coloração", 90);
  const svcNoDur = seedService(orgA, "Sobrancelha", null);

  // ===== services() =====
  const svcs = BeautyReceptionService.services(orgA);
  check("services lista o catálogo ativo (2)", svcs.length === 2 && svcs.some((s) => s.name === "Coloração"));
  check("services traz a duração do serviço", svcs.find((s) => s.name === "Coloração")?.durationMinutes === 90);
  check("services cross-org: orgB vazio", BeautyReceptionService.services(orgB).length === 0);

  // ===== book() happy path — com serviço =====
  const r1: any = BeautyReceptionService.book(orgA, { contactId: emily, professionalId: maria, serviceId: svcColor, startISO: iso(10) });
  check("book com serviço → ok", r1.ok === true && !!r1.appointmentId);
  check("book usa o horário certo (10:00)", r1.startTime === "10:00");
  const appt1: any = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(r1.appointmentId);
  check("appointment tem professional_id + snapshot do nome", appt1.professional_id === maria && appt1.professional_name_snapshot === "Maria");
  check("appointment tem product_service_id + título do serviço", appt1.product_service_id === svcColor && appt1.title === "Coloração");
  check("appointment nasce 'confirmed' (entra na fila como aguardando)", appt1.status === "confirmed");
  // fim = início + 90min (duração do serviço, F4)
  const durMs = AppointmentService.ms(appt1.scheduled_end)! - AppointmentService.ms(appt1.scheduled_start)!;
  check("duração vem do serviço (90min)", durMs === 90 * 60000);

  // ===== book() sem serviço → slot padrão + título genérico =====
  const r2: any = BeautyReceptionService.book(orgA, { contactId: emily, professionalId: maria, startISO: iso(14) });
  check("book SEM serviço → ok", r2.ok === true);
  const appt2: any = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(r2.appointmentId);
  check("sem serviço: título genérico 'Atendimento'", appt2.title === "Atendimento" && appt2.product_service_id === null);
  const dur2 = AppointmentService.ms(appt2.scheduled_end)! - AppointmentService.ms(appt2.scheduled_start)!;
  check("sem serviço: duração = slot da agenda (60min)", dur2 === 60 * 60000);

  // serviço sem duração → cai no slot padrão (não quebra)
  const r2b: any = BeautyReceptionService.book(orgA, { contactId: emily, professionalId: maria, serviceId: svcNoDur, startISO: iso(16) });
  const appt2b: any = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(r2b.appointmentId);
  check("serviço sem duração usa slot padrão + nome do serviço", r2b.ok === true && appt2b.title === "Sobrancelha"
    && (AppointmentService.ms(appt2b.scheduled_end)! - AppointmentService.ms(appt2b.scheduled_start)!) === 60 * 60000);

  // ===== conflito do mesmo profissional =====
  const rc: any = BeautyReceptionService.book(orgA, { contactId: emily, professionalId: maria, startISO: iso(10, 30) });
  check("conflito com a Coloração (10:00–11:30) → rejeita", rc.ok === false && /horário/i.test(rc.error));

  // ===== validações + isolamento =====
  check("contato inexistente → rejeita", (BeautyReceptionService.book(orgA, { contactId: "nao", professionalId: maria, startISO: iso(9) }) as any).ok === false);
  check("profissional inexistente → rejeita", (BeautyReceptionService.book(orgA, { contactId: emily, professionalId: "nao", startISO: iso(9) }) as any).ok === false);
  check("horário no passado → rejeita",
    (BeautyReceptionService.book(orgA, { contactId: emily, professionalId: maria, startISO: "2020-01-01T10:00:00-03:00" }) as any).ok === false);
  check("cross-org: contato da orgA na orgB → rejeita",
    (BeautyReceptionService.book(orgB, { contactId: emily, professionalId: maria, startISO: iso(9) }) as any).ok === false);

  // ===== o agendado entra na fila (dayBoard do dia) =====
  const board = BeautyReceptionService.dayBoard(orgA, date);
  check("agendados aparecem no board do dia (>=3 confirmados)", board.appointments.filter((a) => a.status === "confirmed").length >= 3);
  check("board conta como aguardando (fila)", board.counts.waiting >= 3);

  // ===== Equipe (cadastro de profissional pela recepção) =====
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const teamBefore = BeautyReceptionService.team(orgA).length;
  const created = ClinicAgendaService.createProfessional(orgA, { name: "Joana", specialty: "Manicure" }) as any;
  check("createProfessional cria no roster com especialidade", !!created?.id && created.specialty === "Manicure");
  const teamAfter = BeautyReceptionService.team(orgA);
  check("team() lista a equipe ativa (subiu 1)", teamAfter.length === teamBefore + 1);
  check("team() traz nome + especialidade", teamAfter.some((p) => p.name === "Joana" && p.specialty === "Manicure"));
  check("team() cross-org: orgB não vê a equipe da orgA", BeautyReceptionService.team(orgB).length === 0);
  // agora dá pra agendar com a Joana recém-criada
  const rJoana: any = BeautyReceptionService.book(orgA, { contactId: emily, professionalId: created.id, startISO: iso(11) });
  check("agenda com a profissional recém-cadastrada", rJoana.ok === true && rJoana.professionalName === "Joana");

  // ===== fiação =====
  const routesSrc = fs.readFileSync(path.join(process.cwd(), "src/server/routes/beauty.ts"), "utf8");
  check("rotas /reception/services + POST /reception/appointments montadas",
    routesSrc.includes(`"/reception/services"`) && /post\(\s*"\/reception\/appointments"/.test(routesSrc));
  check("rota /reception/team + POST /reception/professionals (owner/admin) montadas",
    routesSrc.includes(`"/reception/team"`) && routesSrc.includes(`"/reception/professionals"`) && routesSrc.includes("createProfessional"));
  const panelSrc = fs.readFileSync(path.join(process.cwd(), "src/features/BeautyReceptionPanel.tsx"), "utf8");
  check("painel tem o form de agendar (doBook + POST /reception/appointments)",
    panelSrc.includes("doBook") && panelSrc.includes("/api/beauty/reception/appointments") && panelSrc.includes("Agendar"));
  check("painel tem o cadastro de equipe (addPro + Equipe do salão, gated por isManager)",
    panelSrc.includes("addPro") && panelSrc.includes("Equipe do salão") && panelSrc.includes("isManager"));

  // ===== Report =====
  console.log("\n=== TEST beauty-booking (ADR-169 F38) ===\n");
  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.note ? ` — ${x.note}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
