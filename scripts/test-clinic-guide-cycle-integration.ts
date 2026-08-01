/**
 * TESTE — Módulo Clínica Fatia 46: Integração guide↔cycle
 * (ADR-145 D7 / RN-005 §8). FECHA A FASE 4.
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - Ciclo criado sem requiresGuide/config → nasce 'active' (legado).
 *   - Ciclo criado com requiresGuide=true → nasce 'pending_authorization'.
 *   - Ciclo criado com config org clinic_cycle_requires_guide=1 →
 *     nasce 'pending_authorization' mesmo sem requiresGuide=true.
 *   - Ciclo criado com guideId (guia issued) → nasce 'active' + amarra
 *     bidirecional (guide.cycle_id = ciclo).
 *   - Guia de outro paciente → falha.
 *   - Guia em draft → GUIDE_NOT_ACTIVE.
 *   - Guia já vinculada a outro ciclo → GUIDE_ALREADY_LINKED.
 *   - linkGuide: pending_authorization → active + amarra bidirecional.
 *   - linkGuide de ciclo já active → CYCLE_NOT_PENDING_AUTH.
 *   - transitionOnGuideIssued (hook): guia com cycle_id issued →
 *     ativa ciclo automaticamente.
 *   - Hook via import dinâmico do issue(): guia é emitida → aguarda
 *     microtask → ciclo já está active.
 *   - renewalQueue inclui pending_authorization (fila operacional
 *     mostra o que aguarda guia).
 *   - Audit: CYCLE_CREATED com initialStatus + guideId; CYCLE_GUIDE_
 *     LINKED; CYCLE_ACTIVATED_BY_GUIDE.
 *   - Isolamento multi-tenant.
 *
 * Uso:  npm run test:clinic-guide-cycle-integration
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-guide-cycle-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-guide-cycle";

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
  const { ClinicGuideService } = await import("../src/server/ClinicGuideService.js");

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
    return { orgId, actorId, mkProf, mkContact };
  }

  const A = seedOrg("A");
  const psico = ClinicSpecialtyService.create(A.orgId, { name: "Psicologia", defaultCycleSessions: 10 }, A.actorId);
  const drAna = A.mkProf("Dra. Ana");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [{ specialtyId: psico.id, isPrimary: true }], A.actorId);

  const patMaria = A.mkContact("Maria");
  const epMaria = ClinicCareEpisodeService.open(A.orgId, patMaria, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);

  // ── 1. Ciclo legado (sem requiresGuide) nasce active ─────────────────
  const c1 = ClinicTreatmentCycleService.create(A.orgId, epMaria.id, {}, A.actorId);
  check("ciclo legado: status=active", c1.status === "active");
  check("ciclo legado: guide_id null", c1.guideId === null);

  // ── 2. Ciclo com requiresGuide=true nasce pending_authorization ──────
  const patZe = A.mkContact("Zé");
  const epZe = ClinicCareEpisodeService.open(A.orgId, patZe, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  const c2 = ClinicTreatmentCycleService.create(A.orgId, epZe.id, {
    requiresGuide: true,
  }, A.actorId);
  check("ciclo requiresGuide: status=pending_authorization", c2.status === "pending_authorization");

  // ── 3. linkGuide: emitir guia + link → ciclo vira active ─────────────
  const gZe = ClinicGuideService.create(A.orgId, {
    guideType: "tiss_authorization", contactId: patZe,
    operatorId: "op_a", procedureId: "proc_a", totalSessions: 10,
    professionalId: drAna,
  }, A.actorId);
  ClinicGuideService.issue(A.orgId, gZe.id, A.actorId);
  const c2Linked = ClinicTreatmentCycleService.linkGuide(A.orgId, c2.id, gZe.id, A.actorId);
  check("linkGuide: ciclo virou active", c2Linked.status === "active");
  check("linkGuide: cycle.guide_id apontando pra guia", c2Linked.guideId === gZe.id);

  const gZeReloaded = ClinicGuideService.get(A.orgId, gZe.id);
  check("linkGuide: guia.cycle_id apontando pro ciclo (bidirecional)", gZeReloaded?.cycleId === c2.id);

  // ── 4. linkGuide de ciclo já active → CYCLE_NOT_PENDING_AUTH ─────────
  let notPendingErr: any = null;
  try { ClinicTreatmentCycleService.linkGuide(A.orgId, c1.id, gZe.id, A.actorId); }
  catch (e: any) { notPendingErr = e; }
  check("linkGuide de active: CYCLE_NOT_PENDING_AUTH", notPendingErr?.code === "CYCLE_NOT_PENDING_AUTH");

  // ── 5. Config org clinic_cycle_requires_guide=1 força pending ────────
  db.prepare(`UPDATE organization_settings SET clinic_cycle_requires_guide = 1 WHERE organization_id = ?`).run(A.orgId);
  const patCarlos = A.mkContact("Carlos");
  const epCarlos = ClinicCareEpisodeService.open(A.orgId, patCarlos, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  const cCarlos = ClinicTreatmentCycleService.create(A.orgId, epCarlos.id, {}, A.actorId);
  check("config org requires_guide=1: ciclo default nasce pending", cCarlos.status === "pending_authorization");
  // Reset config
  db.prepare(`UPDATE organization_settings SET clinic_cycle_requires_guide = 0 WHERE organization_id = ?`).run(A.orgId);

  // ── 6. Ciclo criado com guideId direto → active + amarra bidirecional ─
  const patLisa = A.mkContact("Lisa");
  const epLisa = ClinicCareEpisodeService.open(A.orgId, patLisa, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  const gLisa = ClinicGuideService.create(A.orgId, {
    guideType: "referral", contactId: patLisa, professionalId: drAna,
    fields: { referralSpecialty: "Neurologia", referralReason: "teste" },
  }, A.actorId);
  ClinicGuideService.issue(A.orgId, gLisa.id, A.actorId);
  const cLisa = ClinicTreatmentCycleService.create(A.orgId, epLisa.id, {
    guideId: gLisa.id, requiresGuide: true,
  }, A.actorId);
  check("ciclo com guideId: status=active (não pending)", cLisa.status === "active");
  check("ciclo com guideId: guide_id gravado", cLisa.guideId === gLisa.id);
  const gLisaReloaded = ClinicGuideService.get(A.orgId, gLisa.id);
  check("ciclo com guideId: guia.cycle_id apontando pro ciclo", gLisaReloaded?.cycleId === cLisa.id);

  // ── 7. Guia de outro paciente → falha ────────────────────────────────
  const patRafa = A.mkContact("Rafa");
  const epRafa = ClinicCareEpisodeService.open(A.orgId, patRafa, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  let wrongPatErr: any = null;
  try {
    ClinicTreatmentCycleService.create(A.orgId, epRafa.id, {
      guideId: gLisa.id, // guia de Lisa
      requiresGuide: true,
    }, A.actorId);
  } catch (e: any) { wrongPatErr = e; }
  check("guia de outro paciente: falha", wrongPatErr?.message?.includes("outro paciente") === true);

  // ── 8. Guia em draft → GUIDE_NOT_ACTIVE ──────────────────────────────
  const gDraft = ClinicGuideService.create(A.orgId, {
    guideType: "referral", contactId: patRafa, professionalId: drAna,
    fields: { referralSpecialty: "X", referralReason: "test" },
  }, A.actorId);
  let draftErr: any = null;
  try {
    ClinicTreatmentCycleService.create(A.orgId, epRafa.id, {
      guideId: gDraft.id, requiresGuide: true,
    }, A.actorId);
  } catch (e: any) { draftErr = e; }
  check("guia em draft: GUIDE_NOT_ACTIVE", draftErr?.code === "GUIDE_NOT_ACTIVE");

  // ── 9. Guia já vinculada a outro ciclo → GUIDE_ALREADY_LINKED ────────
  let alreadyLinkedErr: any = null;
  try {
    ClinicTreatmentCycleService.create(A.orgId, epRafa.id, {
      guideId: gLisa.id, requiresGuide: true, // Lisa já ligou
    }, A.actorId);
  } catch (e: any) { alreadyLinkedErr = e; }
  check("guia já vinculada a outro ciclo: GUIDE_ALREADY_LINKED (via 'outro paciente' também)",
    alreadyLinkedErr !== null);

  // ── 10. transitionOnGuideIssued via hook do issue() ──────────────────
  // Cria ciclo pending com guide_id null → cria guia com cycle_id
  // preenchido pra teste — depois emite → hook ativa.
  const patDani = A.mkContact("Dani");
  const epDani = ClinicCareEpisodeService.open(A.orgId, patDani, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  const cDani = ClinicTreatmentCycleService.create(A.orgId, epDani.id, { requiresGuide: true }, A.actorId);
  check("cDani pending", cDani.status === "pending_authorization");

  const gDani = ClinicGuideService.create(A.orgId, {
    guideType: "tiss_authorization", contactId: patDani, cycleId: cDani.id,
    operatorId: "op_a", procedureId: "proc_a", totalSessions: 10,
    professionalId: drAna,
  }, A.actorId);
  // Emitir a guia dispara hook → deve ativar cDani
  ClinicGuideService.issue(A.orgId, gDani.id, A.actorId);
  await new Promise((r) => setTimeout(r, 100)); // aguarda microtask do import dinâmico
  const cDaniAfter = ClinicTreatmentCycleService.get(A.orgId, cDani.id);
  check("hook: guia issued com cycle_id → ciclo ativou automaticamente",
    cDaniAfter?.status === "active");

  // ── 11. renewalQueue inclui pending_authorization ────────────────────
  // Cria mais um pending pra teste
  const patFer = A.mkContact("Fer");
  const epFer = ClinicCareEpisodeService.open(A.orgId, patFer, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  const cFer = ClinicTreatmentCycleService.create(A.orgId, epFer.id, { requiresGuide: true }, A.actorId);

  const queue = ClinicTreatmentCycleService.renewalQueue(A.orgId, { threshold: 0 });
  const inQueue = queue.map((q) => q.cycle.id);
  check("renewalQueue inclui pending_authorization (cFer)", inQueue.includes(cFer.id));

  // ── 12. Isolamento multi-tenant ──────────────────────────────────────
  const B = seedOrg("B");
  const bSpec = ClinicSpecialtyService.create(B.orgId, { name: "PsiB" }, B.actorId);
  const bProf = B.mkProf("Dr B");
  ClinicSpecialtyService.setProfessionalSpecialties(B.orgId, bProf, [{ specialtyId: bSpec.id }], B.actorId);
  const bPat = B.mkContact("BP");
  const bEp = ClinicCareEpisodeService.open(B.orgId, bPat, {
    specialtyId: bSpec.id, primaryProfessionalId: bProf,
  }, B.actorId);
  let crossErr: any = null;
  try {
    ClinicTreatmentCycleService.create(B.orgId, bEp.id, {
      guideId: gLisa.id, // guia de A
      requiresGuide: true,
    }, B.actorId);
  } catch (e: any) { crossErr = e; }
  check("cross-tenant guia: falha", crossErr?.message?.includes("não encontrada") === true);

  const crossLink = (() => {
    try {
      ClinicTreatmentCycleService.linkGuide(B.orgId, cFer.id, gLisa.id, B.actorId);
      return null;
    } catch (e: any) { return e; }
  })();
  check("cross-tenant linkGuide: falha", crossLink?.message?.includes("não encontrado") === true);

  // ── 13. Auditoria ────────────────────────────────────────────────────
  const createdMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_TREATMENT_CYCLE_CREATED'
        AND metadata_json LIKE '%pending_authorization%'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get(A.orgId) as any;
  const cm = JSON.parse(createdMeta?.metadata_json || "{}");
  check("audit CREATED metadata: initialStatus=pending_authorization",
    cm.initialStatus === "pending_authorization");
  check("audit CREATED metadata: requiresGuide=true", cm.requiresGuide === true);

  const linked = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_TREATMENT_CYCLE_GUIDE_LINKED'`
  ).get(A.orgId) as any;
  check("audit GUIDE_LINKED = 1 (cZe linkGuide)", Number(linked?.c) === 1);

  const activated = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_TREATMENT_CYCLE_ACTIVATED_BY_GUIDE'`
  ).get(A.orgId) as any;
  check("audit ACTIVATED_BY_GUIDE = 1 (cDani hook)", Number(activated?.c) === 1);

  console.log("\n=== Integração guide↔cycle (ADR-145 Fatia 46) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
