/**
 * TESTE — Módulo Clínica Fatia 49: Scheduler pass do ClinicRenewalTaskService
 * (ADR-145 Fase 5 / RN-014).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - Scheduler.clinicRenewalTaskPass publica sinais nas orgs com módulo
 *     `clinica` habilitado e ciclos vivos (renewal_due/pending_auth/active
 *     no threshold).
 *   - Isolamento multi-tenant: org SEM módulo `clinica` habilitado NÃO
 *     recebe sinais (mesmo com ciclos que caberiam na fila).
 *   - Idempotência: rodar 2x não duplica (dedup por dedupe_key).
 *   - Isolamento cross-tenant: sinais da org A não vazam pra org B.
 *   - Org sem ciclo vivo é silenciosamente pulada (não quebra o loop).
 *
 * Uso:  npm run test:clinic-renewal-scheduler
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-renewal-sched-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-renewal-scheduler";

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
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { Scheduler } = await import("../src/server/Scheduler.js");

  function seedOrg(tag: string, enableClinic: boolean) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status, enabled_modules)
       VALUES (?, ?, ?, 'active', ?)`
    ).run(
      randomUUID(),
      orgId,
      `Clínica ${tag}`,
      enableClinic ? JSON.stringify(["clinica"]) : JSON.stringify([]),
    );
    const actorId = `user_${tag}`;
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
    db.prepare(
      `INSERT INTO channels (id, organization_id, provider, name, identifier, status)
       VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`
    ).run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkProf = (name: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO clinic_professionals (id, organization_id, name, active) VALUES (?, ?, ?, 1)`).run(id, orgId, name);
      return id;
    };
    const mkContact = (name: string) => {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`
      ).run(id, orgId, channelId, name, `wa_${tag}_${randomUUID().slice(0, 4)}`);
      return id;
    };
    return { orgId, actorId, channelId, mkProf, mkContact };
  }

  // Org A: módulo `clinica` habilitado + 1 ciclo que cai na fila (pending_authorization).
  const A = seedOrg("A", true);
  const psicoA = ClinicSpecialtyService.create(A.orgId, { name: "Psicologia", defaultCycleSessions: 10 }, A.actorId);
  const drAnaA = A.mkProf("Dra. Ana");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAnaA, [{ specialtyId: psicoA.id, isPrimary: true }], A.actorId);
  const patMariaA = A.mkContact("Maria");
  const epMariaA = ClinicCareEpisodeService.open(A.orgId, patMariaA, {
    specialtyId: psicoA.id, primaryProfessionalId: drAnaA,
  }, A.actorId);
  ClinicTreatmentCycleService.create(A.orgId, epMariaA.id, {
    plannedSessions: 10,
    requiresGuide: true, // vira pending_authorization → sinal `cycle_pending_authorization`
  }, A.actorId);

  // Org B: módulo `clinica` DESABILITADO. Mesmo com ciclo vivo, o pass NÃO
  // deve publicar sinal (gate de ModuleService.isEnabled no scheduler).
  const B = seedOrg("B", false);
  const psicoB = ClinicSpecialtyService.create(B.orgId, { name: "Psicologia", defaultCycleSessions: 10 }, B.actorId);
  const drBrunoB = B.mkProf("Dr. Bruno");
  ClinicSpecialtyService.setProfessionalSpecialties(B.orgId, drBrunoB, [{ specialtyId: psicoB.id, isPrimary: true }], B.actorId);
  const patCarlosB = B.mkContact("Carlos");
  const epCarlosB = ClinicCareEpisodeService.open(B.orgId, patCarlosB, {
    specialtyId: psicoB.id, primaryProfessionalId: drBrunoB,
  }, B.actorId);
  ClinicTreatmentCycleService.create(B.orgId, epCarlosB.id, {
    plannedSessions: 10,
    requiresGuide: true,
  }, B.actorId);

  // Org C: módulo habilitado mas SEM ciclo vivo. Só serve pra provar que
  // o loop não quebra em orgs sem ciclos (é filtrada pela query do pass).
  const C = seedOrg("C", true);

  // ── Roda o pass do Scheduler (aciona ClinicRenewalTaskService.run em cada org) ─
  Scheduler.clinicRenewalTaskPass();

  const sigsA = BusinessSignalService.list(A.orgId, { domain: "clinic", status: "open" });
  const sigsB = BusinessSignalService.list(B.orgId, { domain: "clinic", status: "open" });
  const sigsC = BusinessSignalService.list(C.orgId, { domain: "clinic", status: "open" });

  check("Scheduler pass: org A com clinica ON recebe sinal", sigsA.length === 1,
    `sigsA=${sigsA.length}`);
  check("Scheduler pass: sinal de A é cycle_pending_authorization",
    sigsA[0]?.signal_type === "cycle_pending_authorization",
    `signal_type=${sigsA[0]?.signal_type}`);
  check("Scheduler pass: severidade do pending_auth = attention",
    sigsA[0]?.severity === "attention", `severity=${sigsA[0]?.severity}`);
  check("Isolamento: org B com clinica OFF NÃO recebe sinal (gate de módulo)",
    sigsB.length === 0, `sigsB=${sigsB.length}`);
  check("Loop resiliente: org C sem ciclo vivo não quebra o pass",
    sigsC.length === 0);

  // ── Idempotência: 2ª rodada não duplica ─────────────────────────────
  Scheduler.clinicRenewalTaskPass();
  const sigsA2 = BusinessSignalService.list(A.orgId, { domain: "clinic", status: "open" });
  check("Idempotência: 2ª rodada mantém 1 sinal (dedup por dedupe_key)",
    sigsA2.length === 1, `sigsA2=${sigsA2.length}`);

  // ── Cross-tenant: sinal de A não aparece em B ─────────────────────────
  const sigsBAfter = BusinessSignalService.list(B.orgId, { domain: "clinic", status: "open" });
  check("Cross-tenant: sinais de A não vazam pra B", sigsBAfter.length === 0);

  // ── Sumário ─────────────────────────────────────────────────────────
  console.log("\n== test:clinic-renewal-scheduler ==");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks OK\n`);

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro fatal no teste:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
});
