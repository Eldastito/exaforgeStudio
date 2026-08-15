/**
 * TEST — BEAUTY-010 (ADR-169 F10): composição look→serviço→profissional→
 * disponibilidade→agendamento.
 *
 * FECHA O CICLO da Beauty AI: a simulação escolhida vira um horário reservado
 * na agenda canônica, com a profissional certa. Este é o teste que prova o
 * §7/§46 do PRD ponta-a-ponta (menos os handlers proativos F11+).
 *
 * Checks-âncora:
 *  - `availability` só aceita consulta em `selected` (após F7 `select`).
 *  - `availability` valida serviço no catálogo do tenant (F4, F9 — nunca inventa).
 *  - `availability` retorna APENAS profissionais habilitados via
 *    `professional_services` (F4 — RN-BS-11).
 *  - `book` cria appointment via porta canônica `AppointmentService.create`
 *    (respeita duração do serviço — F4).
 *  - `book` popula `professional_id` + `professional_name_snapshot` +
 *    `product_service_id` no appointment.
 *  - `book` move consulta pra `scheduled` + popula `scheduled_appointment_id`.
 *  - `book` é idempotente: 2ª chamada devolve o mesmo appointment.
 *  - `book` REJEITA profissional sem link (RN-BS-11 nunca infere capacidade).
 *  - `book` REJEITA slot em conflito com outro appointment do mesmo pro.
 *  - `consultationForAppointment` deriva o snapshot visual pela FK (RN-004).
 *  - Cross-tenant DURO: consulta/serviço/pro de outra org → not_found.
 *
 * Uso: npm run test:beauty-look-to-appointment
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-l2a-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-l2a-1234567890abcdef";
process.env.BEAUTY_HAIR_SIMULATION_PROVIDER = "stub";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));

  const sharp = (await import("sharp")).default;
  const { BeautyVisualConsultationService } = await import(
    "../src/server/BeautyVisualConsultationService.js"
  );
  const { BeautyHairSimulationService } = await import(
    "../src/server/BeautyHairSimulationService.js"
  );
  const { ProfessionalServiceService } = await import(
    "../src/server/ProfessionalServiceService.js"
  );
  const { BeautyLookToAppointmentService } = await import(
    "../src/server/BeautyLookToAppointmentService.js"
  );

  const seedOrg = () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`,
    ).run(randomUUID(), orgId);
    return orgId;
  };
  const seedContact = (orgId: string, name = "Cliente") => {
    const id = `c_${randomUUID().slice(0, 6)}`;
    db.prepare(
      `INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', ?, ?)`,
    ).run(id, orgId, name, `${orgId}:${id}`);
    return id;
  };
  const seedService = (
    orgId: string,
    name: string,
    opts: { price?: number; duration?: number; type?: string; active?: boolean } = {},
  ) => {
    const id = `s_${randomUUID().slice(0, 6)}`;
    db.prepare(
      `INSERT INTO products_services (id, organization_id, type, name, description, price, currency, active, duration_minutes) VALUES (?, ?, ?, ?, '', ?, 'BRL', ?, ?)`,
    ).run(
      id,
      orgId,
      opts.type || "service",
      name,
      opts.price ?? 100,
      opts.active === false ? 0 : 1,
      opts.duration ?? 60,
    );
    return id;
  };
  const seedProfessional = (orgId: string, name: string, active = true) => {
    const id = `p_${randomUUID().slice(0, 6)}`;
    db.prepare(
      `INSERT INTO clinic_professionals (id, organization_id, name, active) VALUES (?, ?, ?, ?)`,
    ).run(id, orgId, name, active ? 1 : 0);
    return id;
  };
  const prepareSelected = async (orgId: string, contactId: string) => {
    BeautyVisualConsultationService.grantConsent(orgId, contactId, "hair_simulation");
    const cons = BeautyVisualConsultationService.startConsultation(orgId, {
      contactId,
      goal: "mechas",
    });
    const photo = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 128, g: 64, b: 32 } },
    })
      .jpeg()
      .toBuffer();
    const up = await BeautyVisualConsultationService.uploadReferencePhoto(orgId, cons.id, photo);
    BeautyVisualConsultationService.approveAsset(orgId, (up as any).assetId);
    const sim = BeautyHairSimulationService.requestSimulation(orgId, cons.id, {
      simulationType: "color",
      parameters: { color: "morena_iluminada" },
    });
    // Aguarda o job (setImmediate) processar; retry curto se ainda PROCESSING.
    for (let i = 0; i < 20; i++) {
      const s = BeautyHairSimulationService.getSimulation(orgId, (sim as any).simulationId);
      if (s && s.status === "SUCCEEDED") break;
      await new Promise((r) => setTimeout(r, 30));
    }
    // Move a consulta pra 'selected' manualmente (a rota /select faz isso).
    db.prepare(
      `UPDATE beauty_visual_consultations
          SET status = 'selected', selected_simulation_id = ?, selected_at = CURRENT_TIMESTAMP
        WHERE id = ? AND organization_id = ?`,
    ).run((sim as any).simulationId, cons.id, orgId);
    return {
      consultationId: cons.id,
      simulationId: (sim as any).simulationId,
    };
  };

  // ---- Fixtures ----
  const orgA = seedOrg();
  const ana = seedContact(orgA, "Ana");
  const bia = seedContact(orgA, "Bia");
  const svcColor = seedService(orgA, "Coloração completa", { price: 250, duration: 120 });
  const svcCorte = seedService(orgA, "Corte feminino", { price: 80, duration: 45 });
  const svcSemDuracao = seedService(orgA, "Consultoria", { price: 100, duration: 0 });
  const svcInativo = seedService(orgA, "Coloração antiga", { active: false });
  const proMaria = seedProfessional(orgA, "Maria");
  const proJoana = seedProfessional(orgA, "Joana");
  const proInativa = seedProfessional(orgA, "Ex-funcionária", false);

  // Habilita profissionais aos serviços.
  ProfessionalServiceService.link(orgA, proMaria, svcColor, { isPrimary: true });
  ProfessionalServiceService.link(orgA, proJoana, svcColor);
  ProfessionalServiceService.link(orgA, proMaria, svcCorte);
  ProfessionalServiceService.link(orgA, proInativa, svcColor); // link ativo, pro inativa → não aparece

  const { consultationId } = await prepareSelected(orgA, ana);

  // ===== 1. Availability: happy path =====
  const fromMs = Date.parse("2027-01-04T00:00:00Z"); // segunda-feira, longe pra evitar conflito real
  const av = BeautyLookToAppointmentService.availability(orgA, consultationId, {
    serviceId: svcColor,
    fromMs,
    days: 3,
  });
  check("availability happy path → ok=true", (av as any).ok === true);
  const avOk = av as any;
  check("availability retorna serviceName", avOk.serviceName === "Coloração completa");
  check("availability retorna durationMinutes=120", avOk.durationMinutes === 120);
  check("availability retorna 2 profissionais capazes (Maria + Joana)", avOk.professionals.length === 2);
  const proIds = avOk.professionals.map((p: any) => p.professionalId);
  check("availability inclui Maria", proIds.includes(proMaria));
  check("availability inclui Joana", proIds.includes(proJoana));
  check("availability NÃO inclui pro inativa", !proIds.includes(proInativa));
  check(
    "availability primary vem primeiro (Maria, is_primary=1)",
    avOk.professionals[0].professionalId === proMaria &&
      avOk.professionals[0].isPrimary === true,
  );
  const maria = avOk.professionals.find((p: any) => p.professionalId === proMaria);
  check(
    "cada slot da Maria tem startISO/endISO/durationMinutes=120",
    maria.slots.length > 0 &&
      maria.slots.every(
        (s: any) => s.startISO && s.endISO && s.durationMinutes === 120,
      ),
  );

  // ===== 2. Availability: erros tipados =====
  const avNotFound = BeautyLookToAppointmentService.availability(orgA, "cons_x", {
    serviceId: svcColor,
  });
  check(
    "availability consulta inexistente → consultation_not_found",
    (avNotFound as any).ok === false && (avNotFound as any).reason === "consultation_not_found",
  );

  // Consulta em draft (não selected)
  const consDraft = BeautyVisualConsultationService.startConsultation(orgA, {
    contactId: bia,
  });
  const avDraft = BeautyLookToAppointmentService.availability(orgA, consDraft.id, {
    serviceId: svcColor,
  });
  check(
    "availability consulta em draft → consultation_not_selected",
    (avDraft as any).ok === false && (avDraft as any).reason === "consultation_not_selected",
  );

  const avSvcInv = BeautyLookToAppointmentService.availability(orgA, consultationId, {
    serviceId: "svc_x",
  });
  check(
    "availability serviço inexistente → service_not_found",
    (avSvcInv as any).ok === false && (avSvcInv as any).reason === "service_not_found",
  );

  const avSvcInativo = BeautyLookToAppointmentService.availability(orgA, consultationId, {
    serviceId: svcInativo,
  });
  check(
    "availability serviço inativo → service_not_found",
    (avSvcInativo as any).ok === false && (avSvcInativo as any).reason === "service_not_found",
  );

  const avSemDur = BeautyLookToAppointmentService.availability(orgA, consultationId, {
    serviceId: svcSemDuracao,
  });
  check(
    "availability serviço sem duração → service_missing_duration",
    (avSemDur as any).ok === false && (avSemDur as any).reason === "service_missing_duration",
  );

  // Serviço sem profissional capaz
  const svcNovo = seedService(orgA, "Novidade", { duration: 60 });
  const avNoPro = BeautyLookToAppointmentService.availability(orgA, consultationId, {
    serviceId: svcNovo,
    fromMs,
    days: 3,
  });
  check(
    "availability serviço sem profissional capaz → no_capable_professional",
    (avNoPro as any).ok === false &&
      (avNoPro as any).reason === "no_capable_professional",
  );

  // ===== 3. Book: happy path =====
  const slotMaria = maria.slots[0];
  const book = BeautyLookToAppointmentService.book(
    orgA,
    consultationId,
    { serviceId: svcColor, professionalId: proMaria, startISO: slotMaria.startISO },
    "actor_test",
  );
  check("book happy path → ok=true", (book as any).ok === true);
  const bkOk = book as any;
  check("book retorna appointmentId", typeof bkOk.appointmentId === "string" && bkOk.appointmentId.length > 0);
  check("book retorna scheduledStart correto", bkOk.scheduledStart === slotMaria.startISO);
  check("book retorna scheduledEnd correto (start+120min)", bkOk.scheduledEnd === slotMaria.endISO);
  check("book retorna professionalName", bkOk.professionalName === "Maria");
  check("book retorna durationMinutes=120", bkOk.durationMinutes === 120);

  // Verifica no banco
  const apptRow = db
    .prepare(
      `SELECT id, organization_id, contact_id, professional_id, professional_name_snapshot,
              product_service_id, scheduled_start, scheduled_end
         FROM appointments WHERE id = ? AND organization_id = ?`,
    )
    .get(bkOk.appointmentId, orgA) as any;
  check("appointment gravado no DB", apptRow != null);
  check("appointment.contact_id = ana", apptRow.contact_id === ana);
  check("appointment.professional_id = Maria", apptRow.professional_id === proMaria);
  check(
    "appointment.professional_name_snapshot = 'Maria'",
    apptRow.professional_name_snapshot === "Maria",
  );
  check("appointment.product_service_id = svcColor", apptRow.product_service_id === svcColor);
  check("appointment.scheduled_start = slot start", apptRow.scheduled_start === slotMaria.startISO);
  check("appointment.scheduled_end = slot end", apptRow.scheduled_end === slotMaria.endISO);

  // Consulta agora 'scheduled' + FK populada
  const consAfter = BeautyVisualConsultationService.getConsultation(orgA, consultationId);
  check("consulta agora status='scheduled'", consAfter?.status === "scheduled");
  check(
    "consulta.scheduledAppointmentId = novo appt",
    consAfter?.scheduledAppointmentId === bkOk.appointmentId,
  );

  // ===== 4. Idempotência =====
  const book2 = BeautyLookToAppointmentService.book(
    orgA,
    consultationId,
    { serviceId: svcColor, professionalId: proMaria, startISO: slotMaria.startISO },
    "actor_test",
  );
  check("book idempotente → ok=true", (book2 as any).ok === true);
  check(
    "book idempotente → mesmo appointmentId",
    (book2 as any).appointmentId === bkOk.appointmentId,
  );

  const apptCount = (
    db.prepare(`SELECT COUNT(*) c FROM appointments WHERE organization_id = ?`).get(orgA) as any
  ).c;
  check("book idempotente NÃO cria appointment duplicado", apptCount === 1);

  // ===== 5. Book: erros tipados =====
  const { consultationId: cons2 } = await prepareSelected(orgA, bia);

  const bkPropNotCap = BeautyLookToAppointmentService.book(
    orgA,
    cons2,
    { serviceId: svcCorte, professionalId: proJoana, startISO: "2027-01-05T10:00:00.000Z" },
    null,
  );
  check(
    "book profissional sem link → professional_not_capable",
    (bkPropNotCap as any).ok === false &&
      (bkPropNotCap as any).reason === "professional_not_capable",
  );

  const bkInv = BeautyLookToAppointmentService.book(
    orgA,
    cons2,
    { serviceId: svcColor, professionalId: proMaria, startISO: "isso não é data" },
    null,
  );
  check(
    "book startISO inválido → invalid_start",
    (bkInv as any).ok === false && (bkInv as any).reason === "invalid_start",
  );

  const bkSvcInv = BeautyLookToAppointmentService.book(
    orgA,
    cons2,
    { serviceId: "svc_x", professionalId: proMaria, startISO: "2027-01-05T10:00:00.000Z" },
    null,
  );
  check(
    "book serviço inexistente → service_not_found",
    (bkSvcInv as any).ok === false && (bkSvcInv as any).reason === "service_not_found",
  );

  // Slot em conflito: já reservamos slotMaria pra ana; tentar reservar sobrepondo com bia.
  const conflictStart = slotMaria.startISO; // mesmo horário do primeiro booking
  const bkConflict = BeautyLookToAppointmentService.book(
    orgA,
    cons2,
    { serviceId: svcColor, professionalId: proMaria, startISO: conflictStart },
    null,
  );
  check(
    "book slot conflitante com mesma pro → slot_conflict",
    (bkConflict as any).ok === false && (bkConflict as any).reason === "slot_conflict",
  );

  // Book em consulta ainda draft
  const consDraft2 = BeautyVisualConsultationService.startConsultation(orgA, {
    contactId: seedContact(orgA, "Carla"),
  });
  const bkDraft = BeautyLookToAppointmentService.book(
    orgA,
    consDraft2.id,
    { serviceId: svcColor, professionalId: proMaria, startISO: "2027-01-07T10:00:00.000Z" },
    null,
  );
  check(
    "book consulta em draft → consultation_not_selected",
    (bkDraft as any).ok === false && (bkDraft as any).reason === "consultation_not_selected",
  );

  // ===== 6. consultationForAppointment (RN-004 — derivado) =====
  const derived = BeautyLookToAppointmentService.consultationForAppointment(orgA, bkOk.appointmentId);
  check(
    "consultationForAppointment retorna a consulta original",
    derived != null && derived!.consultationId === consultationId,
  );
  check(
    "derived.selectedSimulationId != null (snapshot visual pela FK)",
    derived != null && derived!.selectedSimulationId != null,
  );
  check(
    "consultationForAppointment appt inexistente → null",
    BeautyLookToAppointmentService.consultationForAppointment(orgA, "appt_x") === null,
  );

  // ===== 7. Cross-tenant DURO =====
  const orgB = seedOrg();
  const clarita = seedContact(orgB, "Clarita");
  const proOrgB = seedProfessional(orgB, "Pro OrgB");
  const svcOrgB = seedService(orgB, "Coloração OrgB", { duration: 60 });
  ProfessionalServiceService.link(orgB, proOrgB, svcOrgB);

  // A consulta da orgA NÃO existe pra orgB
  const crossAv = BeautyLookToAppointmentService.availability(orgB, consultationId, {
    serviceId: svcColor,
  });
  check(
    "cross-tenant availability orgB p/ consulta orgA → consultation_not_found",
    (crossAv as any).ok === false && (crossAv as any).reason === "consultation_not_found",
  );

  // Serviço orgB não existe pra orgA
  const { consultationId: cons3 } = await prepareSelected(orgB, clarita);
  const crossSvc = BeautyLookToAppointmentService.availability(orgA, cons3, {
    serviceId: svcOrgB,
  });
  check(
    "cross-tenant availability orgA p/ consulta orgB → consultation_not_found (não vaza)",
    (crossSvc as any).ok === false && (crossSvc as any).reason === "consultation_not_found",
  );

  // Book com pro de outra org
  const bkCrossPro = BeautyLookToAppointmentService.book(
    orgA,
    cons2,
    { serviceId: svcColor, professionalId: proOrgB, startISO: "2027-01-08T10:00:00.000Z" },
    null,
  );
  check(
    "book cross-tenant (pro de outra org) → professional_not_capable",
    (bkCrossPro as any).ok === false &&
      (bkCrossPro as any).reason === "professional_not_capable",
  );

  const derivedCross = BeautyLookToAppointmentService.consultationForAppointment(orgB, bkOk.appointmentId);
  check("consultationForAppointment cross-tenant → null (isolado)", derivedCross === null);

  // ===== 8. Zero hardcoded (§17/§65) =====
  const forbiddenNeedles = [
    "studio_marcia",
    "studio de beleza márcia",
    "marcia_studio",
    "\"marcia\"",
    "'marcia'",
  ];
  let hardcoded: string | null = null;
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx)$/.test(f.name)) {
        try {
          const s = fs.readFileSync(p, "utf8").toLowerCase();
          for (const n of forbiddenNeedles) if (s.includes(n)) { hardcoded = `${p}: ${n}`; return; }
        } catch { /* skip */ }
      }
    }
  };
  try {
    walk(path.join(process.cwd(), "src", "server"));
    if (!hardcoded) walk(path.join(process.cwd(), "src", "features"));
  } catch { /* skip */ }
  check(
    "nenhum hardcoded do Studio Márcia em src/server ou src/features (§17/§65)",
    hardcoded === null,
    hardcoded || undefined,
  );

  // --- Relatório ---
  console.log("\n=== TEST: Look → Agendamento (ADR-169 F10 / BEAUTY-010) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Ciclo fechado: Beauty AI → sim escolhida → serviço do catálogo → profissional habilitada → horário na agenda.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
