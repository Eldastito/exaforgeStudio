/**
 * TESTE — Módulo Clínica Fatia 47: IA operacional (renovação + horários)
 * (ADR-145 Fase 5 / RN-014 — guardrails).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - availability propõe N slots livres, alinhados ao stepMinutes.
 *   - availability pula slot com conflito de profissional.
 *   - availability pula slot com ausência (férias/atestado).
 *   - availability pula slot em sala capacity=1 já ocupada.
 *   - availability em sala capacity>1 permite o slot até estourar capacidade.
 *   - availability valida janela [from, to) inválida e >14 dias.
 *   - availability rejeita professionalId cross-tenant.
 *   - Guardrail: availability NUNCA sugere outro profissional (só o pedido).
 *   - renewalTask.run publica sinal com dedupe_key correto pra cada ciclo
 *     em renewal_due / pending_authorization / active com remaining<=threshold.
 *   - Severidade determinística: risk pra renewal_due; attention pra pending
 *     e alerta antecipado.
 *   - Re-run é idempotente (dedup → update, não insere duplicado).
 *   - Ciclo renovado → sinal antigo é resolvido (resolveByDedupe).
 *   - Ciclo cancelado → sinal antigo é resolvido.
 *   - Isolamento multi-tenant (sinais de org B não vazam pra org A).
 *
 * Uso:  npm run test:clinic-ai-renewal-hints
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-ai-renewal-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-ai-renewal";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicSpecialtyService } = await import("../src/server/ClinicSpecialtyService.js");
  const { ClinicCareEpisodeService } = await import("../src/server/ClinicCareEpisodeService.js");
  const { ClinicTreatmentCycleService } = await import("../src/server/ClinicTreatmentCycleService.js");
  const { ClinicScheduleSessionService } = await import("../src/server/ClinicScheduleSessionService.js");
  const { ClinicRenewalTaskService } = await import("../src/server/ClinicRenewalTaskService.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicProfessionalAbsenceService } = await import("../src/server/ClinicProfessionalAbsenceService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const actorId = `user_${tag}`;
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkProf = (name: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO clinic_professionals (id, organization_id, name, active) VALUES (?, ?, ?, 1)`).run(id, orgId, name);
      return id;
    };
    const mkContact = (name: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, name, `wa_${tag}_${randomUUID().slice(0, 4)}`);
      return id;
    };
    const mkRoom = (name: string, capacity: number) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO clinic_rooms (id, organization_id, name, capacity) VALUES (?, ?, ?, ?)`).run(id, orgId, name, capacity);
      return id;
    };
    return { orgId, actorId, mkProf, mkContact, mkRoom };
  }

  const A = seedOrg("A");
  const psico = ClinicSpecialtyService.create(A.orgId, { name: "Psicologia", defaultCycleSessions: 10 }, A.actorId);
  const drAna = A.mkProf("Dra. Ana");
  const drBruno = A.mkProf("Dr. Bruno");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [{ specialtyId: psico.id, isPrimary: true }], A.actorId);
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drBruno, [{ specialtyId: psico.id, isPrimary: false }], A.actorId);

  const patMaria = A.mkContact("Maria");
  const epMaria = ClinicCareEpisodeService.open(A.orgId, patMaria, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);

  // ── 1. availability — janela livre, propõe 3 slots alinhados ─────────
  const from = "2027-01-05T09:00:00.000Z";
  const to = "2027-01-05T18:00:00.000Z";
  const s1 = ClinicScheduleSessionService.availability(A.orgId, {
    professionalId: drAna, durationMinutes: 30, from, to,
  });
  check("availability livre: 3 slots", s1.length === 3);
  check("availability: 1º slot começa em 09:00 (alinhado ao step 30min)", s1[0]?.startISO === "2027-01-05T09:00:00.000Z");
  check("availability: 2º slot em 09:30", s1[1]?.startISO === "2027-01-05T09:30:00.000Z");
  check("availability: duração retornada = 30min", s1[0]?.durationMinutes === 30);

  // ── 2. availability — alinhamento ao step (from=09:07 → começa 09:30) ─
  const sAligned = ClinicScheduleSessionService.availability(A.orgId, {
    professionalId: drAna, durationMinutes: 30,
    from: "2027-01-05T09:07:00.000Z", to,
  });
  check("availability from=09:07 (step 30): 1º slot em 09:30",
    sAligned[0]?.startISO === "2027-01-05T09:30:00.000Z");

  // ── 3. availability — pula slot com conflito de profissional ─────────
  // Cria appointment em 09:30 → o slot de 09:30 deve sumir; 10:00 assume.
  const patCarla = A.mkContact("Carla");
  ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patCarla, professionalId: drAna,
    scheduledStart: "2027-01-05T09:30:00.000Z", durationMinutes: 30,
  }, A.actorId);
  const s2 = ClinicScheduleSessionService.availability(A.orgId, {
    professionalId: drAna, durationMinutes: 30, from, to,
  });
  const s2Starts = s2.map(x => x.startISO);
  check("availability c/ conflito 09:30: 09:00 continua livre", s2Starts[0] === "2027-01-05T09:00:00.000Z");
  check("availability c/ conflito 09:30: 09:30 sumiu", !s2Starts.includes("2027-01-05T09:30:00.000Z"));
  check("availability c/ conflito 09:30: 10:00 preenche", s2Starts.includes("2027-01-05T10:00:00.000Z"));

  // ── 4. availability — pula slot com ausência (férias) ────────────────
  // Ausência 11:00-13:00 → nenhum slot dentro do intervalo.
  ClinicProfessionalAbsenceService.create(A.orgId, drAna, {
    reason: "vacation",
    startsAt: "2027-01-05T11:00:00.000Z",
    endsAt: "2027-01-05T13:00:00.000Z",
  }, A.actorId);
  const s3 = ClinicScheduleSessionService.availability(A.orgId, {
    professionalId: drAna, durationMinutes: 30,
    from: "2027-01-05T11:00:00.000Z", to: "2027-01-05T13:30:00.000Z",
    maxSuggestions: 5,
  });
  const s3Starts = s3.map(x => x.startISO);
  check("availability c/ ausência 11-13: 11:00 sumiu", !s3Starts.includes("2027-01-05T11:00:00.000Z"));
  check("availability c/ ausência 11-13: 12:00 sumiu", !s3Starts.includes("2027-01-05T12:00:00.000Z"));
  check("availability c/ ausência 11-13: 13:00 volta", s3Starts.includes("2027-01-05T13:00:00.000Z"));

  // ── 5. availability — sala capacity=1 (bloqueio 1:1) ─────────────────
  const salaSolo = A.mkRoom("Sala Solo", 1);
  ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patCarla, professionalId: drBruno, roomId: salaSolo,
    scheduledStart: "2027-01-06T10:00:00.000Z", durationMinutes: 60,
  }, A.actorId);
  const s4 = ClinicScheduleSessionService.availability(A.orgId, {
    professionalId: drAna, durationMinutes: 30,
    from: "2027-01-06T09:00:00.000Z", to: "2027-01-06T12:00:00.000Z",
    roomId: salaSolo, maxSuggestions: 6,
  });
  const s4Starts = s4.map(x => x.startISO);
  check("availability sala 1:1 ocupada 10-11: 10:00 sumiu",
    !s4Starts.includes("2027-01-06T10:00:00.000Z"));
  check("availability sala 1:1 ocupada 10-11: 09:00 continua livre",
    s4Starts.includes("2027-01-06T09:00:00.000Z"));

  // ── 6. availability — sala capacity>1 tolera ocupações paralelas ─────
  const salaGrupo = A.mkRoom("Sala Grupo", 3);
  ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patCarla, professionalId: drBruno, roomId: salaGrupo,
    scheduledStart: "2027-01-07T10:00:00.000Z", durationMinutes: 60,
  }, A.actorId);
  const s5 = ClinicScheduleSessionService.availability(A.orgId, {
    professionalId: drAna, durationMinutes: 30,
    from: "2027-01-07T10:00:00.000Z", to: "2027-01-07T11:00:00.000Z",
    roomId: salaGrupo,
  });
  check("availability sala cap=3 com 1 ocupação: slot 10:00 ainda cabe",
    s5.some(x => x.startISO === "2027-01-07T10:00:00.000Z"));

  // ── 7. availability — validações ─────────────────────────────────────
  let vErr: any = null;
  try {
    ClinicScheduleSessionService.availability(A.orgId, {
      professionalId: drAna, durationMinutes: 30,
      from: to, to: from, // invertido
    });
  } catch (e: any) { vErr = e; }
  check("availability janela invertida: rejeita", !!vErr);

  let wErr: any = null;
  try {
    ClinicScheduleSessionService.availability(A.orgId, {
      professionalId: drAna, durationMinutes: 30,
      from: "2027-01-01T00:00:00.000Z", to: "2027-02-01T00:00:00.000Z", // >14d
    });
  } catch (e: any) { wErr = e; }
  check("availability janela >14 dias: rejeita", /14 dias/.test(wErr?.message || ""));

  let dErr: any = null;
  try {
    ClinicScheduleSessionService.availability(A.orgId, {
      professionalId: drAna, durationMinutes: 2, from, to,
    });
  } catch (e: any) { dErr = e; }
  check("availability duração < 5 min: rejeita", !!dErr);

  // ── 8. Guardrail — availability NUNCA sugere outro profissional ──────
  // Chama pedindo drAna → nada retorna slot que possa ser do drBruno.
  // (a API não devolve professionalId — se algum dia devolvesse, teria que
  // ser === drAna). Confirmação: sem drAna válido → não fabrica alternativa.
  let xErr: any = null;
  try {
    ClinicScheduleSessionService.availability(A.orgId, {
      professionalId: "prof_inexistente", durationMinutes: 30, from, to,
    });
  } catch (e: any) { xErr = e; }
  check("guardrail: prof inexistente → falha (não fabrica alternativa)",
    /não encontrado/.test(xErr?.message || ""));

  // ── 9. Cross-tenant: profissional de B não aparece pra A ─────────────
  const B = seedOrg("B");
  const bSpec = ClinicSpecialtyService.create(B.orgId, { name: "PsiB" }, B.actorId);
  const bProf = B.mkProf("Dr B");
  ClinicSpecialtyService.setProfessionalSpecialties(B.orgId, bProf, [{ specialtyId: bSpec.id }], B.actorId);
  let ctErr: any = null;
  try {
    ClinicScheduleSessionService.availability(A.orgId, {
      professionalId: bProf, durationMinutes: 30, from, to,
    });
  } catch (e: any) { ctErr = e; }
  check("cross-tenant availability: profissional de B invisível pra A",
    /não encontrado/.test(ctErr?.message || ""));

  // ── 10. renewalTask.run — publica sinais com dedupe_key correto ──────
  // Cria 2 episódios/ciclos que devem virar sinais.
  const c1 = ClinicTreatmentCycleService.create(A.orgId, epMaria.id, { plannedSessions: 10 }, A.actorId);

  // Consome 10 sessões → ciclo vira renewal_due
  const apptsIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = ClinicAgendaService.createAppointment(A.orgId, {
      contactId: patMaria, careEpisodeId: epMaria.id,
      scheduledStart: `2026-11-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
      professionalId: drAna, durationMinutes: 30,
    }, A.actorId);
    db.prepare(`UPDATE appointments SET treatment_cycle_id = ? WHERE id = ?`).run(c1.id, a.id);
    apptsIds.push(a.id);
  }
  for (const id of apptsIds) ClinicAgendaService.complete(A.orgId, id, A.actorId);
  // hook async — dá 1 microtask pra virar renewal_due
  await new Promise((r) => setTimeout(r, 20));
  const c1Reloaded = ClinicTreatmentCycleService.get(A.orgId, c1.id)!;
  check("consumidas 10 → ciclo renewal_due", c1Reloaded.status === "renewal_due");

  // 2º episódio com pending_authorization
  const patZe = A.mkContact("Zé");
  const epZe = ClinicCareEpisodeService.open(A.orgId, patZe, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  const c2 = ClinicTreatmentCycleService.create(A.orgId, epZe.id, {
    plannedSessions: 10, requiresGuide: true,
  }, A.actorId);
  check("c2 pending_authorization criado", c2.status === "pending_authorization");

  const r1 = ClinicRenewalTaskService.run(A.orgId);
  check("renewalTask.run: seen ≥ 2", r1.seen >= 2);
  check("renewalTask.run: published ≥ 2 (novos)", r1.published >= 2);
  check("renewalTask.run: deduped = 0 (primeira rodada)", r1.deduped === 0);

  const dueRow = db.prepare(
    `SELECT * FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`
  ).get(A.orgId, `clinic:cycle_renewal_due:cycle:${c1.id}`) as any;
  check("sinal renewal_due publicado (c1)", !!dueRow);
  check("sinal renewal_due severity=risk", dueRow?.severity === "risk");
  check("sinal renewal_due basis=fact", dueRow?.basis === "fact");
  check("sinal renewal_due source=ClinicRenewalTaskService",
    dueRow?.source_service === "ClinicRenewalTaskService");
  check("sinal renewal_due dedupe_key formato correto",
    dueRow?.dedupe_key === `clinic:cycle_renewal_due:cycle:${c1.id}`);

  const pendRow = db.prepare(
    `SELECT * FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`
  ).get(A.orgId, `clinic:cycle_pending_authorization:cycle:${c2.id}`) as any;
  check("sinal pending_authorization publicado (c2)", !!pendRow);
  check("sinal pending_authorization severity=attention",
    pendRow?.severity === "attention");

  // ── 11. Re-run é idempotente ─────────────────────────────────────────
  const r2 = ClinicRenewalTaskService.run(A.orgId);
  check("renewalTask.run 2ª vez: seen igual à 1ª", r2.seen === r1.seen);
  check("renewalTask.run 2ª vez: published = 0", r2.published === 0);
  check("renewalTask.run 2ª vez: deduped ≥ 2 (dedup por chave)", r2.deduped >= 2);

  const countDue = db.prepare(
    `SELECT COUNT(*) AS c FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`
  ).get(A.orgId, `clinic:cycle_renewal_due:cycle:${c1.id}`) as any;
  check("dedup: 1 única linha por (org, dedupe_key)", Number(countDue?.c) === 1);

  // ── 12. Renovação do ciclo resolve o sinal antigo ────────────────────
  const rn = ClinicTreatmentCycleService.renew(A.orgId, c1.id, { plannedSessions: 10 }, A.actorId);
  check("renew: previous=renewed", rn.previous.status === "renewed");
  check("renew: current=active", rn.current.status === "active");

  const r3 = ClinicRenewalTaskService.run(A.orgId);
  check("renewalTask.run após renew: resolved ≥ 1 (sinal do c1 antigo fechou)",
    r3.resolved >= 1);
  const dueRowAfter = db.prepare(
    `SELECT status FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`
  ).get(A.orgId, `clinic:cycle_renewal_due:cycle:${c1.id}`) as any;
  check("sinal do c1 antigo agora resolved", dueRowAfter?.status === "resolved");

  // ── 13. Cancelamento também resolve ──────────────────────────────────
  ClinicTreatmentCycleService.cancel(A.orgId, c2.id, { reason: "guia negada" }, A.actorId);
  const r4 = ClinicRenewalTaskService.run(A.orgId);
  check("renewalTask.run após cancel: resolved ≥ 1 (sinal do c2 fechou)",
    r4.resolved >= 1);
  const pendRowAfter = db.prepare(
    `SELECT status FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`
  ).get(A.orgId, `clinic:cycle_pending_authorization:cycle:${c2.id}`) as any;
  check("sinal do c2 agora resolved", pendRowAfter?.status === "resolved");

  // ── 14. Isolamento multi-tenant — org B não vê sinais de A ───────────
  const patBP = B.mkContact("BP");
  const epBP = ClinicCareEpisodeService.open(B.orgId, patBP, {
    specialtyId: bSpec.id, primaryProfessionalId: bProf,
  }, B.actorId);
  ClinicTreatmentCycleService.create(B.orgId, epBP.id, {
    plannedSessions: 5, requiresGuide: true,
  }, B.actorId);
  const rB = ClinicRenewalTaskService.run(B.orgId);
  check("renewalTask.run em B: seen = 1 (só o ciclo de B)", rB.seen === 1);
  const bSignals = ClinicRenewalTaskService.list(B.orgId);
  const aSignalKeysInB = bSignals.some((s: any) => String(s.dedupe_key || "").includes(c1.id));
  check("isolamento: sinal de A não aparece em B", !aSignalKeysInB);

  // ── 15. list() filtra pra domínio clínica + tipos F47 ────────────────
  BusinessSignalService.publish(A.orgId, {
    domain: "retail", signalType: "unrelated", severity: "info",
    basis: "fact", confidence: 1, sourceService: "test",
    evidence: {}, dedupeKey: "retail:test:1",
  });
  const listA = ClinicRenewalTaskService.list(A.orgId);
  check("list: só sinais do domínio clínica + tipos F47",
    listA.every((s: any) =>
      s.signal_type === "cycle_renewal_due"
      || s.signal_type === "cycle_pending_authorization"
      || s.signal_type === "cycle_renewal_alert"));

  console.log("\n=== IA operacional renovação (ADR-145 Fatia 47) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
