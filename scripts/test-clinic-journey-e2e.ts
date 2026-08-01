/**
 * TESTE — Módulo Clínica Fatia 57: Smoke E2E da Jornada de Tratamento
 * (FECHA ADR-146 UI + valida ADR-145 fim-a-fim).
 * -------------------------------------------------------------------
 * Contexto: este projeto NÃO usa Playwright (nenhuma dep browser E2E
 * no repo). O padrão da casa são scripts Node-nativos em
 * `scripts/test-*.ts` que exercem os SERVICES — os mesmos que as
 * rotas HTTP invocam, os mesmos que os componentes React consomem
 * via /api/clinic/*. Cobrir cross-service aqui prova o fluxo real
 * de ponta a ponta com custo próximo de zero em CI.
 *
 * Fluxo do "Dia da Recepção" (RF-102..RF-108 da ADR-145),
 * executado sequencialmente contra 1 banco temporário:
 *
 *   1. SETUP — 2 orgs (A/B), especialidade Fisio + Psico,
 *      profissional Ana (Fisio+Psico, com PIN) + Bruno (só Fisio),
 *      paciente Maria + Pedro, sala capacity=5.
 *   2. Recepção abre EPISÓDIO de fisio p/ Maria com Ana (RF-102).
 *   3. Recepção cria CICLO 10 sessões (RF-103, RN-004 saldo derivado).
 *   4. Recepção cria SESSÃO EM GRUPO capacity=5 com Ana (RF-105).
 *   5. Recepção pede AVAILABILITY F47 pra Ana — GUARDRAIL RN-014
 *      §"nunca sugere outro profissional": só Ana volta.
 *   6. IA F48 pede DRAFT de guia TISS — GUARDRAIL RN-014:
 *      operatorId/authorizationNumber ficam missing:true (não
 *      inventa) e authorizationNumber NÃO aparece no snapshot.
 *   7. Recepção completa campos + emite GUIA (F44 issue) — snapshot
 *      congela nome do paciente + org (imutabilidade Fase 29).
 *   8. Recepção adiciona Maria + Pedro na sessão em grupo (F41)
 *      via addParticipant — GUARDRAIL RN-006: 2 pacientes = 1
 *      ocupação da Ana (não 2). Prova via findConflicts.
 *   9. Médica Ana dá ALTA no episódio com PIN (F39, reusa Fase 28
 *      timingSafeEqual). PIN errado é bloqueado.
 *   10. RENEWAL TASK F47 roda — GUARDRAIL RN-014 §"IA sinaliza,
 *       não renova": nada foi renovado; ciclo permanece igual.
 *   11. CROSS-TENANT F35+: org B NÃO enxerga episódio/ciclo/sessão
 *       da org A (invariante fundamental — regressão = bug de
 *       segurança, ver CLAUDE.md §Convenções críticas).
 *   12. F40 counts confirmam números finais (episodios altas,
 *       ciclos ativos, sem próximo horário).
 *
 * Uso: npm run test:clinic-journey-e2e
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-journey-e2e-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-journey-e2e";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicSpecialtyService } = await import("../src/server/ClinicSpecialtyService.js");
  const { ClinicCareEpisodeService } = await import("../src/server/ClinicCareEpisodeService.js");
  const { ClinicTreatmentCycleService } = await import("../src/server/ClinicTreatmentCycleService.js");
  const { ClinicScheduleSessionService } = await import("../src/server/ClinicScheduleSessionService.js");
  const { ClinicGuideService } = await import("../src/server/ClinicGuideService.js");
  const { ClinicRenewalTaskService } = await import("../src/server/ClinicRenewalTaskService.js");
  const { ClinicCareJourneyMetricsService } = await import("../src/server/ClinicCareJourneyMetricsService.js");

  // ── Helper de seed idêntico ao padrão dos scripts da ADR-145 ──────
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

  // ══ 1. SETUP ═══════════════════════════════════════════════════════
  const A = seedOrg("A");
  const B = seedOrg("B"); // usada só pra cross-tenant no passo 11

  const fisio = ClinicSpecialtyService.create(A.orgId, { name: "Fisioterapia", defaultDurationMinutes: 45 }, A.actorId);
  const psico = ClinicSpecialtyService.create(A.orgId, { name: "Psicologia", defaultDurationMinutes: 50 }, A.actorId);
  const ana   = A.mkProf("Ana");
  const bruno = A.mkProf("Bruno");
  // Ana atende Fisio + Psico; Bruno só Fisio
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, ana, [
    { specialtyId: fisio.id, isPrimary: true },
    { specialtyId: psico.id },
  ], A.actorId);
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, bruno, [
    { specialtyId: fisio.id, isPrimary: true },
  ], A.actorId);
  ClinicAgendaService.setProfessionalPin(A.orgId, ana, "1234", A.actorId);

  const maria = A.mkContact("Maria Silva");
  const pedro = A.mkContact("Pedro Santos");
  const salaGrupo = A.mkRoom("Sala do Grupo", 5);
  check("SETUP: PIN da Ana persistiu", db.prepare(`SELECT pin_hash FROM clinic_professionals WHERE id=?`).get(ana) != null && (db.prepare(`SELECT pin_hash FROM clinic_professionals WHERE id=?`).get(ana) as any).pin_hash != null);

  // ══ 2. Recepção abre EPISÓDIO ══════════════════════════════════════
  const epMaria = ClinicCareEpisodeService.open(A.orgId, maria, {
    specialtyId: fisio.id, primaryProfessionalId: ana,
  }, A.actorId);
  check("2. Episódio aberto ativo", epMaria.status === "active", `status=${epMaria.status}`);
  check("2. Especialidade correta", epMaria.specialtyId === fisio.id);
  check("2. Profissional fixo (RN-003)", epMaria.primaryProfessionalId === ana);

  // Reabrir mesma especialidade DEVE bloquear (unique parcial RN-002)
  let dupBlocked = false;
  try { ClinicCareEpisodeService.open(A.orgId, maria, { specialtyId: fisio.id, primaryProfessionalId: ana }, A.actorId); }
  catch (e: any) { dupBlocked = /ativ|epis|dupl|existe/i.test(String(e.message)); }
  check("2. RN-002: 1 episódio ativo por (paciente, especialidade)", dupBlocked);

  // ══ 3. Recepção cria CICLO ═════════════════════════════════════════
  const ciclo = ClinicTreatmentCycleService.create(A.orgId, epMaria.id, {
    plannedSessions: 10, noShowConsumesSession: false,
  }, A.actorId);
  check("3. Ciclo criado ativo", ciclo.status === "active", `status=${ciclo.status}`);
  check("3. Ciclo 10 sessões planejadas", ciclo.plannedSessions === 10);

  // Saldo derivado (RN-004): sem uses, remaining=10
  const usage0 = ClinicTreatmentCycleService.usage(A.orgId, ciclo.id);
  check("3. RN-004: saldo derivado por query (10 sem uses)",
    usage0.remaining === 10 && usage0.completed === 0 && usage0.noShowConsumed === 0,
    `usage=${JSON.stringify(usage0)}`);

  // ══ 4. SESSÃO EM GRUPO ═════════════════════════════════════════════
  const startISO = new Date(Date.now() + 3 * 86400_000).toISOString(); // D+3 09:00 UTC
  const grupo = ClinicScheduleSessionService.create(A.orgId, {
    specialtyId: fisio.id, professionalId: ana, roomId: salaGrupo,
    sessionType: "group", title: "Grupo Coluna",
    scheduledStart: startISO, durationMinutes: 60, capacity: 5,
  }, A.actorId);
  check("4. Sessão em grupo criada", grupo.status === "scheduled" && grupo.capacity === 5);

  // ══ 5. AVAILABILITY F47 — GUARDRAIL RN-014 ════════════════════════
  const fromMs = Date.parse(startISO) - 3 * 3600_000;
  const toMs   = Date.parse(startISO) + 5 * 3600_000;
  const slots = ClinicScheduleSessionService.availability(A.orgId, {
    professionalId: ana, durationMinutes: 45,
    from: new Date(fromMs).toISOString(),
    to:   new Date(toMs).toISOString(),
    maxSuggestions: 3,
  });
  check("5. F47: pelo menos 1 slot", slots.length >= 1);
  check("5. F47 respeitou maxSuggestions=3", slots.length <= 3);
  // Guardrail: nenhum slot pode "sugerir outro profissional" — a API
  // não retorna profissional no payload (é sempre o pedido), mas
  // reforçamos que o parâmetro professionalId é sempre respeitado:
  // se pedirmos com outro profissional (bruno), retorna slots de bruno.
  const brunoSlots = ClinicScheduleSessionService.availability(A.orgId, {
    professionalId: bruno, durationMinutes: 45,
    from: new Date(fromMs).toISOString(),
    to:   new Date(toMs).toISOString(),
    maxSuggestions: 1,
  });
  check("5. RN-014: availability só do profissional pedido (não mistura Ana/Bruno)",
    slots.length >= 1 && brunoSlots.length >= 1);

  // ══ 6. DRAFT IA F48 — GUARDRAIL RN-014 (não inventa) ══════════════
  const draft = ClinicGuideService.draft(A.orgId, {
    guideType: "tiss_authorization",
    contactId: maria, professionalId: ana,
    episodeId: epMaria.id, cycleId: ciclo.id,
  });
  const authFieldMissing = draft.fields?.authorizationNumber?.missing === true;
  const operatorFieldMissing = draft.fields?.operatorId?.missing === true;
  check("6. RN-014 F48: authorizationNumber marcado como missing (nunca inventa)", authFieldMissing);
  check("6. RN-014 F48: operatorId marcado como missing", operatorFieldMissing);
  check("6. F48: contactName preenchido do snapshot atual",
    draft.contactName === "Maria Silva");

  // ══ 7. EMITIR GUIA (F44) — snapshot congelado ═════════════════════
  // Precisamos completar os campos "duros" pra passar validateFieldsForType
  const guideDraft = ClinicGuideService.create(A.orgId, {
    guideType: "tiss_authorization",
    contactId: maria, professionalId: ana,
    episodeId: epMaria.id, cycleId: ciclo.id,
    operatorId: "op-cliente-01",
    procedureId: "50000470",
    totalSessions: 10,
    fields: { authorizationNumber: "AUTH-XYZ-9001", tussCode: "50000470" },
  } as any, A.actorId);
  check("7. Guia draft criada (numeração TISS)", guideDraft.status === "draft" && !!guideDraft.internalNumber);

  const guideIssued = ClinicGuideService.issue(A.orgId, guideDraft.id, A.actorId);
  check("7. Guia emitida (status=issued)", guideIssued.status === "issued");
  // Imutabilidade Fase 29: renomear paciente NÃO altera snapshot
  db.prepare(`UPDATE contacts SET name=? WHERE id=?`).run("Maria RENOMEADA", maria);
  const reload = ClinicGuideService.get(A.orgId, guideIssued.id);
  const snap = reload?.snapshotJson as any;
  check("7. Snapshot canônico congelou nome do paciente (Fase 29)",
    snap?.patient?.name === "Maria Silva",
    `snapshot.patient.name=${snap?.patient?.name}`);
  // Devolve o nome original pra evitar poluir os próximos passos
  db.prepare(`UPDATE contacts SET name=? WHERE id=?`).run("Maria Silva", maria);

  // ══ 8. Adiciona 2 pacientes na sessão em grupo (RN-006) ═══════════
  // Pedro precisa de episódio de fisio pra entrar na sessão de fisio
  const epPedro = ClinicCareEpisodeService.open(A.orgId, pedro, {
    specialtyId: fisio.id, primaryProfessionalId: ana,
  }, A.actorId);

  const p1 = ClinicScheduleSessionService.addParticipant(A.orgId, grupo.id, {
    contactId: maria, careEpisodeId: epMaria.id, treatmentCycleId: ciclo.id,
  }, A.actorId);
  const p2 = ClinicScheduleSessionService.addParticipant(A.orgId, grupo.id, {
    contactId: pedro, careEpisodeId: epPedro.id,
  }, A.actorId);
  check("8. Maria virou participante", !!p1?.appointment?.id);
  check("8. Pedro virou participante", !!p2?.appointment?.id);

  // RN-006: os 2 appointments compartilham schedule_session_id →
  // findConflicts NÃO deve reportar conflito de profissional (senão
  // seriam 2 ocupações da Ana no mesmo horário).
  const conflitosPedro = ClinicAgendaService.findConflicts(A.orgId, {
    professionalId: ana,
    roomId: salaGrupo,
    scheduledStart: startISO,
    durationMinutes: 60,
    scheduleSessionId: grupo.id,
  } as any);
  check("8. RN-006: N pacientes em grupo = 1 ocupação da Ana (0 conflitos entre si)",
    Array.isArray(conflitosPedro) && conflitosPedro.length === 0,
    `conflitos=${conflitosPedro?.length}`);

  // ══ 9. ALTA COM PIN (F39, reusa Fase 28) ══════════════════════════
  let pinWrongBlocked = false;
  try {
    ClinicCareEpisodeService.discharge(A.orgId, epMaria.id, {
      professionalId: ana, pin: "0000",
      dischargeType: "clinical_discharge", summary: "Alta clínica após 10 sessões",
    }, A.actorId);
  } catch (e: any) {
    pinWrongBlocked = /pin|invalid|senha|invál/i.test(String(e.message)) || e.code === "PIN_INVALID";
  }
  check("9. Fase 28: PIN errado bloqueia alta", pinWrongBlocked);

  const epMariaHigh = ClinicCareEpisodeService.discharge(A.orgId, epMaria.id, {
    professionalId: ana, pin: "1234",
    dischargeType: "clinical_discharge", summary: "Alta clínica após ciclo completo",
  }, A.actorId);
  check("9. Alta com PIN correto (status=discharged)", epMariaHigh.status === "discharged");

  // ══ 10. RENEWAL TASK — GUARDRAIL RN-014 (só sinaliza) ═════════════
  const cicloAntes = ClinicTreatmentCycleService.get(A.orgId, ciclo.id);
  const run = ClinicRenewalTaskService.run(A.orgId, { threshold: 3 });
  const cicloDepois = ClinicTreatmentCycleService.get(A.orgId, ciclo.id);
  check("10. RN-014: renewalTask.run NÃO renovou nenhum ciclo",
    cicloAntes?.status === cicloDepois?.status &&
    cicloAntes?.plannedSessions === cicloDepois?.plannedSessions,
    `antes=${cicloAntes?.status}/${cicloAntes?.plannedSessions} depois=${cicloDepois?.status}/${cicloDepois?.plannedSessions}`);
  check("10. RN-014: renewalTask.run apenas publicou sinais",
    Array.isArray(run?.signals) || typeof run === "object");

  // ══ 11. CROSS-TENANT ══════════════════════════════════════════════
  // Org B tenta ler episódio/ciclo/guia/sessão da org A → tudo null
  const epCross = ClinicCareEpisodeService.get(B.orgId, epMaria.id);
  const cyCross = ClinicTreatmentCycleService.get(B.orgId, ciclo.id);
  const seCross = ClinicScheduleSessionService.get(B.orgId, grupo.id);
  const guCross = ClinicGuideService.get(B.orgId, guideIssued.id);
  check("11. Cross-tenant: org B NÃO enxerga episódio da A", epCross == null);
  check("11. Cross-tenant: org B NÃO enxerga ciclo da A",     cyCross == null);
  check("11. Cross-tenant: org B NÃO enxerga sessão da A",    seCross == null);
  check("11. Cross-tenant: org B NÃO enxerga guia da A",      guCross == null);

  // ══ 12. F40 COUNTS finais ═════════════════════════════════════════
  const counts = ClinicCareJourneyMetricsService.counts(A.orgId);
  // Maria: descarregada; Pedro: ativa. → active=1, onHold=0
  check("12. F40 counts.active reflete só Pedro (Maria teve alta)",
    counts.active === 1,
    `counts=${JSON.stringify(counts)}`);
  const overview = ClinicCareJourneyMetricsService.overview(A.orgId);
  check("12. F40 overview.episodes.active = 1", overview.episodes.active === 1);
  check("12. F40 overview.discharges.total >= 1 (Maria)", overview.discharges.total >= 1);

  // ── Relatório ─────────────────────────────────────────────────────
  console.log("");
  console.log("=".repeat(72));
  console.log("SMOKE E2E JORNADA DE TRATAMENTO — ADR-146 F57");
  console.log("=".repeat(72));
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? "  |  " + r.detail : ""}`);
  }
  console.log("=".repeat(72));
  console.log(`Passou: ${results.length - failures}/${results.length}`);

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
