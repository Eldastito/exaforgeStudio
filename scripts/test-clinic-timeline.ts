/**
 * TESTE — Módulo Clínica Fatia 21: Timeline unificada do paciente
 * (ADR-080 extensão 2026-07).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário, que a timeline agrega os
 * eventos das fases anteriores (agenda, encounter, addendum, docs,
 * anexos, envio) em uma cronologia única e correta:
 *   - Mistura de kinds numa mesma consulta (appointment + encounter
 *     opened + signed + prescription + certificate + attachment +
 *     addendum + document_sent) aparece com ids consistentes.
 *   - Ordenação DESC por `at`; tiebreaker narrativo dentro do mesmo
 *     timestamp (opened antes de signed antes de addendum).
 *   - LGPD Art.11: sem consent → LGPD_CONSENT_REQUIRED (403). Revoke
 *     bloqueia leitura inteira; re-grant restaura.
 *   - Contact inexistente → LGPD_CONSENT_REQUIRED (mesma semântica
 *     de listByPatient: nada a expor sobre id que não existe).
 *   - Filtro `from`/`to` respeita janela inclusiva; `kinds` restringe.
 *   - `limit` clipa o array (default 100, min 1, max 500);
 *     `totalBeforeLimit` reporta o pré-clipping.
 *   - Paciente sem eventos → `items:[], count:0` (após consent).
 *   - Isolamento multi-tenant: eventos de A NÃO aparecem em B mesmo
 *     com mesmo contactId (impossível na prática, mas defensivo).
 *
 * Uso:  npm run test:clinic-timeline
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-timeline-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-timeline-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicEncounterService } = await import("../src/server/ClinicEncounterService.js");
  const { ClinicDocumentsService } = await import("../src/server/ClinicDocumentsService.js");
  const { ClinicAttachmentService } = await import("../src/server/ClinicAttachmentService.js");
  const { ClinicDocumentDeliveryService } = await import("../src/server/ClinicDocumentDeliveryService.js");
  const { ClinicPatientTimelineService } = await import("../src/server/ClinicPatientTimelineService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkContact = (n: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, n, `55${tag}${Math.floor(Math.random() * 1e8)}`);
      return id;
    };
    return { orgId, actorId: `user_${tag}`, channelId, patient: mkContact("Paciente") };
  }

  // === Cenário base — 1 paciente, 1 profissional, 2 consultas com riqueza
  const A = seedOrg("A");
  const draAna = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Ana" }, A.actorId);
  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { channel: "in_person", actorId: A.actorId });
  LgpdService.grantConsent(A.orgId, A.patient, "comunicacoes", { actorId: A.actorId });

  // Consulta 1: passada, com prontuário signed + prescription + certificate +
  // attachment + addendum + document_sent.
  const apt1 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient,
    title: "Consulta inicial",
    scheduledStart: "2026-06-15T09:00:00-03:00",
    professionalId: draAna.id,
    durationMinutes: 30,
  }, A.actorId);
  const enc1 = ClinicEncounterService.open(A.orgId, apt1.id, A.actorId);
  ClinicEncounterService.update(A.orgId, enc1.id, A.actorId, { subjective: "dor de cabeça", plan: "dipirona" });
  const signed1 = ClinicEncounterService.finalize(A.orgId, enc1.id, A.actorId);

  const rx1 = ClinicDocumentsService.createPrescription(A.orgId, enc1.id, {
    items: [{ drug: "Dipirona 500mg", dosage: "1 cp", quantity: "20 cp", instructions: "de 8 em 8h" }],
  }, A.actorId);
  ClinicDocumentsService.issuePrescription(A.orgId, rx1.id, A.actorId);

  const cert1 = ClinicDocumentsService.createCertificate(A.orgId, enc1.id, { days: 2 }, A.actorId);
  ClinicDocumentsService.issueCertificate(A.orgId, cert1.id, A.actorId);

  const att1 = ClinicAttachmentService.add(A.orgId, enc1.id, {
    buffer: Buffer.from("fake png bytes"),
    mime: "image/png",
    originalFilename: "raio-x.png",
    label: "Raio-X",
  }, A.actorId);

  const addendum1 = ClinicEncounterService.addAddendum(A.orgId, signed1.id, A.actorId, {
    note: "Resultado do hemograma chegou normal.",
    actorName: "Dra. Ana",
  });

  // Envio pra WhatsApp: sender injetado (não chama rede)
  const fakeSender = async () => ({ messages: [{ id: `wamid_${randomUUID().slice(0, 6)}` }] });
  await ClinicDocumentDeliveryService.send(A.orgId, "prescription", rx1.id, A.actorId, { sender: fakeSender });

  // Consulta 2: futura, só agendada (sem prontuário ainda)
  const apt2 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient,
    title: "Retorno",
    scheduledStart: "2026-08-20T10:00:00-03:00",
    professionalId: draAna.id,
    durationMinutes: 30,
  }, A.actorId);

  // Consulta 3: cancelada — deve aparecer com suffix
  const apt3 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient,
    title: "Cancelada",
    scheduledStart: "2026-05-10T08:00:00-03:00",
    professionalId: draAna.id,
    durationMinutes: 30,
  }, A.actorId);
  ClinicAgendaService.cancel(A.orgId, apt3.id, { cancelledBy: "staff", reason: "reagendou" }, A.actorId);

  // ── 1. Timeline mistura tudo, ordenada DESC ─────────────────────────────
  const tl = ClinicPatientTimelineService.getTimeline(A.orgId, A.patient);
  check("count > 0", tl.count > 0, String(tl.count));

  // Deve ter (2 appts com scheduled_start=null seriam ignorados; todos têm):
  // 3 appointment_scheduled + 1 encounter_opened + 1 encounter_signed +
  // 1 addendum + 1 rx issued + 1 cert issued + 1 attachment + 1 delivery = 10.
  check("total esperado (10 eventos)", tl.count === 10, `got=${tl.count}`);

  const kinds = tl.items.map((i) => i.kind);
  check("contém appointment_scheduled", kinds.includes("appointment_scheduled"));
  check("contém encounter_opened", kinds.includes("encounter_opened"));
  check("contém encounter_signed", kinds.includes("encounter_signed"));
  check("contém encounter_addendum", kinds.includes("encounter_addendum"));
  check("contém prescription_issued", kinds.includes("prescription_issued"));
  check("contém certificate_issued", kinds.includes("certificate_issued"));
  check("contém attachment_added", kinds.includes("attachment_added"));
  check("contém document_sent", kinds.includes("document_sent"));

  // Ordenação DESC: primeiro item deve ser o de `at` maior. O apt2 (agosto)
  // é o mais no futuro (2026-08-20).
  const first = tl.items[0];
  check("primeiro item é o mais recente (apt2 agosto)",
    first.kind === "appointment_scheduled" && first.appointmentId === apt2.id,
    `${first.kind}/${first.appointmentId}`);

  // Última posição deve ser o apt3 (cancelada em 2026-05-10, mais antigo).
  const last = tl.items[tl.items.length - 1];
  check("último item é o mais antigo (apt3 maio, cancelada)",
    last.kind === "appointment_scheduled" && last.appointmentId === apt3.id,
    `${last.kind}/${last.appointmentId}`);
  check("apt cancelado tem sufixo (cancelado) no summary", last.summary.includes("(cancelado)"));

  // ── 2. Payload rico: refId, encounterId, actorName preenchidos ──────────
  const addItem = tl.items.find((i) => i.kind === "encounter_addendum")!;
  check("addendum tem refId = id do addendum", addItem.refId === addendum1.id);
  check("addendum tem encounterId = enc1", addItem.encounterId === enc1.id);
  check("addendum tem actorName snapshot", addItem.actorName === "Dra. Ana");
  check("addendum summary tem preview da nota", addItem.summary.includes("hemograma"));

  const rxItem = tl.items.find((i) => i.kind === "prescription_issued")!;
  check("prescription tem refId = id da rx", rxItem.refId === rx1.id);
  check("prescription tem encounterId = enc1", rxItem.encounterId === enc1.id);
  check("prescription actorName = snapshot do prof (null quando não gravado)",
    rxItem.actorName === null || typeof rxItem.actorName === "string");

  const attItem = tl.items.find((i) => i.kind === "attachment_added")!;
  check("attachment tem refId = id do anexo", attItem.refId === att1.id);
  check("attachment summary tem label", attItem.summary.includes("Raio-X"));

  const dlvItem = tl.items.find((i) => i.kind === "document_sent")!;
  check("document_sent summary indica 'Receita enviada'", dlvItem.summary.includes("Receita"));

  // ── 3. LGPD gate ────────────────────────────────────────────────────────
  LgpdService.revokeConsent(A.orgId, A.patient, "dados_sensiveis", A.actorId);
  let threwLgpd: any = null;
  try { ClinicPatientTimelineService.getTimeline(A.orgId, A.patient); } catch (e) { threwLgpd = e; }
  check("timeline após revoke → LGPD_CONSENT_REQUIRED", threwLgpd?.code === "LGPD_CONSENT_REQUIRED", String(threwLgpd?.code));

  // Re-grant restaura
  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { channel: "in_person", actorId: A.actorId });
  check("re-grant restaura leitura", ClinicPatientTimelineService.getTimeline(A.orgId, A.patient).count === 10);

  // ── 4. Contact inexistente / cross-tenant → LGPD_CONSENT_REQUIRED ───────
  const fakeContact = randomUUID();
  let threwFake: any = null;
  try { ClinicPatientTimelineService.getTimeline(A.orgId, fakeContact); } catch (e) { threwFake = e; }
  check("contact inexistente → LGPD_CONSENT_REQUIRED (nada a expor)",
    threwFake?.code === "LGPD_CONSENT_REQUIRED", String(threwFake?.code));

  // ── 5. Filtro `from`/`to` ───────────────────────────────────────────────
  const win = ClinicPatientTimelineService.getTimeline(A.orgId, A.patient, {
    from: "2026-06-01T00:00:00-03:00",
    to: "2026-07-01T00:00:00-03:00",
  });
  const winKinds = win.items.map((i) => i.kind);
  // Deve conter só eventos da consulta 1 (junho); nada de apt2 (ago) nem apt3 (mai)
  check("janela junho: NÃO contém apt2 (agosto)",
    !win.items.some((i) => i.appointmentId === apt2.id));
  check("janela junho: NÃO contém apt3 (maio)",
    !win.items.some((i) => i.appointmentId === apt3.id));
  check("janela junho: contém apt1", win.items.some((i) => i.appointmentId === apt1.id));

  // ── 6. Filtro `kinds` ───────────────────────────────────────────────────
  const onlyDocs = ClinicPatientTimelineService.getTimeline(A.orgId, A.patient, {
    kinds: ["prescription_issued", "certificate_issued"],
  });
  check("kinds filtra pra 2 tipos", onlyDocs.count === 2, String(onlyDocs.count));
  check("todos os itens são doc-issued",
    onlyDocs.items.every((i) => i.kind === "prescription_issued" || i.kind === "certificate_issued"));

  // ── 7. Limit + totalBeforeLimit ─────────────────────────────────────────
  const clipped = ClinicPatientTimelineService.getTimeline(A.orgId, A.patient, { limit: 3 });
  check("limit=3 clipa items", clipped.count === 3);
  check("totalBeforeLimit reflete o total real (10)", clipped.totalBeforeLimit === 10, String(clipped.totalBeforeLimit));

  // ── 8. Paciente sem eventos ─────────────────────────────────────────────
  const emptyPatientId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
    .run(emptyPatientId, A.orgId, A.channelId, "Sem Eventos", "5511900000000");
  LgpdService.grantConsent(A.orgId, emptyPatientId, "dados_sensiveis", { channel: "in_person", actorId: A.actorId });
  const emptyTl = ClinicPatientTimelineService.getTimeline(A.orgId, emptyPatientId);
  check("paciente sem eventos → count 0", emptyTl.count === 0);
  check("paciente sem eventos → items []", emptyTl.items.length === 0);
  check("paciente sem eventos → totalBeforeLimit 0", emptyTl.totalBeforeLimit === 0);

  // ── 9. Tiebreaker narrativo dentro do mesmo timestamp ───────────────────
  // Casamos manualmente created_at do encounter_history: enc.created_at pode
  // coincidir com o próprio scheduled_start em bancos rápidos. Testamos a
  // regra escrevendo dois eventos com `at` idêntico no DB direto.
  const sharedAt = "2026-04-01T12:00:00.000Z";
  const sharedApt = randomUUID();
  db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, status) VALUES (?, ?, ?, 'Ponto A', ?, 'confirmed')`)
    .run(sharedApt, A.orgId, A.patient, sharedAt);
  const sharedEncId = randomUUID();
  db.prepare(`INSERT INTO clinical_encounters (id, organization_id, appointment_id, contact_id, status, created_at, signed_at)
              VALUES (?, ?, ?, ?, 'signed', ?, ?)`)
    .run(sharedEncId, A.orgId, sharedApt, A.patient, sharedAt, sharedAt);
  const tlTie = ClinicPatientTimelineService.getTimeline(A.orgId, A.patient, { from: sharedAt, to: sharedAt });
  // Regra: no mesmo `at`, `encounter_signed` (KIND_ORDER 6) > `encounter_opened`
  // (1) > `appointment_scheduled` (0). No DESC, ordem esperada: signed, opened, appt.
  const kindsTie = tlTie.items.map((i) => i.kind);
  check("tiebreaker: signed antes de opened dentro do mesmo at",
    kindsTie.indexOf("encounter_signed") < kindsTie.indexOf("encounter_opened"),
    JSON.stringify(kindsTie));
  check("tiebreaker: opened antes de appointment dentro do mesmo at",
    kindsTie.indexOf("encounter_opened") < kindsTie.indexOf("appointment_scheduled"),
    JSON.stringify(kindsTie));

  // ── 10. Isolamento multi-tenant ─────────────────────────────────────────
  const B = seedOrg("B");
  LgpdService.grantConsent(B.orgId, A.patient, "dados_sensiveis", { channel: "in_person", actorId: B.actorId });
  const bTl = ClinicPatientTimelineService.getTimeline(B.orgId, A.patient);
  check("org B com mesmo contactId não vê eventos de A", bTl.count === 0, String(bTl.count));

  console.log("\n=== Timeline unificada do paciente (ADR-080 Fase 21) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
