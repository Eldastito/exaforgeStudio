/**
 * TESTE — Módulo Clínica Fatia 35: Especialidades normalizadas
 * (ADR-145 Fase 1).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - CRUD de especialidade: create trima nome; create de nome existente
 *     devolve existente (idempotente); update rejeita rename pra nome
 *     em uso; active=0 esconde da list padrão; includeInactive=1 mostra.
 *   - Duração 5..480 (default 60); cycles 1..200 (default 10); valores
 *     inválidos caem no default.
 *   - Vínculos N:N: setProfessionalSpecialties é atômico; ausentes viram
 *     active=0 sem apagar; upsert; isPrimary garante no máximo 1;
 *     specialtyId de outra org → erro; professionalId inexistente → erro.
 *   - Listagem: listProfessionalsForSpecialty faz join com clinic_
 *     professionals; activeOnly=1 esconde profissional inativo;
 *     listSpecialtiesForProfessional ordena primary primeiro.
 *   - Backfill idempotente: cria specialty + vínculo a partir de
 *     clinic_professionals.specialty; 2ª chamada não duplica (unique +
 *     UPDATE); reativa vínculo previamente desativado; primeiro vínculo
 *     do profissional vira primary; profissional inativo entra também;
 *     campo vazio/null é ignorado.
 *   - Isolamento multi-tenant: specialty da org B invisível pra org A;
 *     set... de profissional de B a partir de A → erro; backfill de A
 *     não toca profissional de B.
 *   - Auditoria: CLINIC_SPECIALTY_CREATED/UPDATED/LINKED/BACKFILL_RUN
 *     gravados com metadata correto.
 *
 * Uso:  npm run test:clinic-specialties
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-specialties-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-specialties-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicSpecialtyService } = await import("../src/server/ClinicSpecialtyService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const actorId = `user_${tag}`;
    const mkProf = (name: string, specialty?: string | null, active = 1) => {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO clinic_professionals (id, organization_id, name, specialty, active) VALUES (?, ?, ?, ?, ?)`
      ).run(id, orgId, name, specialty ?? null, active);
      return id;
    };
    return { orgId, actorId, mkProf };
  }

  const A = seedOrg("A");

  // ── 1. Create trima nome + idempotente por (org, name) ─────────────────
  const s1 = ClinicSpecialtyService.create(A.orgId, { name: "  Psicologia  " }, A.actorId);
  check("create: name trimado", s1.name === "Psicologia");
  check("create: defaultDurationMinutes = 60", s1.defaultDurationMinutes === 60);
  check("create: defaultCycleSessions = 10", s1.defaultCycleSessions === 10);
  check("create: active = true", s1.active === true);

  const s1b = ClinicSpecialtyService.create(A.orgId, { name: "Psicologia" }, A.actorId);
  check("create idempotente: devolve mesmo id", s1b.id === s1.id);

  // ── 2. Validação de duração/cycles ─────────────────────────────────────
  const s2 = ClinicSpecialtyService.create(A.orgId, {
    name: "Fonoaudiologia", defaultDurationMinutes: 45, defaultCycleSessions: 20,
  }, A.actorId);
  check("create com duration/cycles válidos", s2.defaultDurationMinutes === 45 && s2.defaultCycleSessions === 20);

  const s3 = ClinicSpecialtyService.create(A.orgId, {
    name: "Fisioterapia", defaultDurationMinutes: 9999, defaultCycleSessions: -5,
  }, A.actorId);
  check("create com valores fora do range cai no default", s3.defaultDurationMinutes === 60 && s3.defaultCycleSessions === 10);

  // ── 3. Update ──────────────────────────────────────────────────────────
  const s2u = ClinicSpecialtyService.update(A.orgId, s2.id, { color: "#ff00aa", defaultCycleSessions: 6 }, A.actorId);
  check("update: color atualizado", s2u?.color === "#ff00aa");
  check("update: cycles atualizado", s2u?.defaultCycleSessions === 6);

  // Rename pra nome existente
  let renameErr: any = null;
  try { ClinicSpecialtyService.update(A.orgId, s2.id, { name: "Psicologia" }, A.actorId); }
  catch (e: any) { renameErr = e; }
  check("update: rename pra nome existente falha", renameErr?.message?.includes("Já existe") === true);

  // Nome vazio
  let emptyErr: any = null;
  try { ClinicSpecialtyService.update(A.orgId, s2.id, { name: "   " }, A.actorId); }
  catch (e: any) { emptyErr = e; }
  check("update: nome vazio falha", emptyErr !== null);

  // ── 4. Active toggle ───────────────────────────────────────────────────
  ClinicSpecialtyService.update(A.orgId, s3.id, { active: false }, A.actorId);
  const listActive = ClinicSpecialtyService.list(A.orgId);
  const listAll = ClinicSpecialtyService.list(A.orgId, { includeInactive: true });
  check("list default esconde inativa", !listActive.find((x) => x.id === s3.id));
  check("list includeInactive mostra tudo", listAll.find((x) => x.id === s3.id)?.active === false);

  // ── 5. Vínculos profissional↔especialidade (set atômico) ───────────────
  const drAna = A.mkProf("Dra. Ana Silva", "Psicologia");
  const drBruno = A.mkProf("Dr. Bruno Costa", "Fonoaudiologia");
  const drCarla = A.mkProf("Dra. Carla", null); // sem specialty legada

  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [
    { specialtyId: s1.id, isPrimary: true },
    { specialtyId: s2.id, isPrimary: true }, // 2ª isPrimary é ignorada
  ], A.actorId);

  const anaSpecs = ClinicSpecialtyService.listSpecialtiesForProfessional(A.orgId, drAna);
  check("set: 2 specialties vinculadas", anaSpecs.length === 2);
  const primaryCount = anaSpecs.filter((x) => x.isPrimary).length;
  check("set: apenas 1 primary", primaryCount === 1);
  check("set: primary é a primeira do input (Psicologia)",
    anaSpecs.find((x) => x.isPrimary)?.specialtyId === s1.id);
  check("set: ordena primary primeiro", anaSpecs[0].isPrimary === true);

  // Remove Fono da Ana (só deixa Psicologia)
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [
    { specialtyId: s1.id, isPrimary: true },
  ], A.actorId);
  const anaAfter = ClinicSpecialtyService.listSpecialtiesForProfessional(A.orgId, drAna);
  check("set: reduzido pra 1", anaAfter.length === 1);
  const anaAll = ClinicSpecialtyService.listSpecialtiesForProfessional(A.orgId, drAna, { activeOnly: false });
  check("set: vínculo removido foi soft-off (não deletado)", anaAll.length === 2);
  check("set: vínculo removido tem linkActive=false",
    anaAll.find((x) => x.specialtyId === s2.id)?.linkActive === false);

  // Reativa Fono
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [
    { specialtyId: s1.id, isPrimary: true },
    { specialtyId: s2.id },
  ], A.actorId);
  const anaReactivate = ClinicSpecialtyService.listSpecialtiesForProfessional(A.orgId, drAna);
  check("set: reativou vínculo desativado sem duplicar", anaReactivate.length === 2);

  // ── 6. Erros de vínculo ────────────────────────────────────────────────
  let profErr: any = null;
  try { ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, "prof_inexistente", [{ specialtyId: s1.id }], A.actorId); }
  catch (e: any) { profErr = e; }
  check("set: profissional inexistente falha", profErr?.message?.includes("não encontrado") === true);

  let specErr: any = null;
  try { ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drBruno, [{ specialtyId: "spec_inexistente" }], A.actorId); }
  catch (e: any) { specErr = e; }
  check("set: specialty inexistente falha", specErr?.message?.includes("Especialidade não encontrada") === true);

  // ── 7. listProfessionalsForSpecialty com join ──────────────────────────
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drBruno, [{ specialtyId: s1.id }], A.actorId);
  const profsInPsico = ClinicSpecialtyService.listProfessionalsForSpecialty(A.orgId, s1.id);
  check("listProfessionalsForSpecialty: 2 profs (Ana + Bruno)", profsInPsico.length === 2);
  const anaRow = profsInPsico.find((p) => p.professionalId === drAna);
  check("list...: name veio do join", anaRow?.name === "Dra. Ana Silva");

  // Desativa Ana como profissional
  db.prepare(`UPDATE clinic_professionals SET active = 0 WHERE id = ?`).run(drAna);
  const profsActive = ClinicSpecialtyService.listProfessionalsForSpecialty(A.orgId, s1.id);
  check("list... activeOnly esconde profissional inativo", profsActive.length === 1);
  const profsAll = ClinicSpecialtyService.listProfessionalsForSpecialty(A.orgId, s1.id, { activeOnly: false });
  check("list... activeOnly=false mostra inativo", profsAll.length === 2);

  // ── 8. Backfill idempotente ────────────────────────────────────────────
  const B = seedOrg("B");
  const bAna = B.mkProf("Dra. Bete", "Nutrição");
  const bCarlos = B.mkProf("Dr. Carlos", "Nutrição"); // mesma specialty
  const bDenis = B.mkProf("Dr. Denis", "Neurologia");
  const bEmpty = B.mkProf("Dr. Empty", ""); // vazio ignorado
  const bNull = B.mkProf("Dr. Null", null);
  const bInactive = B.mkProf("Dr. Inativo", "Cardiologia", 0);

  const bf1 = ClinicSpecialtyService.backfillFromLegacy(B.orgId, B.actorId);
  check("backfill: specialtiesCreated = 3 (Nutrição + Neuro + Cardio)", bf1.specialtiesCreated === 3, JSON.stringify(bf1));
  check("backfill: linksCreated = 4 (Bete + Carlos + Denis + Inativo)", bf1.linksCreated === 4);
  check("backfill: linksAlreadyExisted = 0", bf1.linksAlreadyExisted === 0);

  const beteSpecs = ClinicSpecialtyService.listSpecialtiesForProfessional(B.orgId, bAna, { activeOnly: false });
  check("backfill: primeiro vínculo do profissional vira primary", beteSpecs[0]?.isPrimary === true);

  // 2ª execução idempotente
  const bf2 = ClinicSpecialtyService.backfillFromLegacy(B.orgId, B.actorId);
  check("backfill 2x: specialtiesCreated = 0", bf2.specialtiesCreated === 0);
  check("backfill 2x: linksCreated = 0", bf2.linksCreated === 0);
  check("backfill 2x: linksAlreadyExisted = 4", bf2.linksAlreadyExisted === 4);

  // Desativa manualmente um vínculo e re-roda backfill → reativa
  const denisSpecs = ClinicSpecialtyService.listSpecialtiesForProfessional(B.orgId, bDenis);
  const denisLinkId = denisSpecs[0]?.linkId;
  db.prepare(`UPDATE clinic_professional_specialties SET active = 0 WHERE id = ?`).run(denisLinkId);
  const bf3 = ClinicSpecialtyService.backfillFromLegacy(B.orgId, B.actorId);
  const denisAfter = ClinicSpecialtyService.listSpecialtiesForProfessional(B.orgId, bDenis);
  check("backfill: reativou vínculo desativado", denisAfter.length === 1);

  // Cardiologia foi criada apesar do prof inativo
  const cardio = ClinicSpecialtyService.list(B.orgId, { includeInactive: true }).find((s) => s.name === "Cardiologia");
  check("backfill: specialty criada mesmo com prof inativo", !!cardio);

  // ── 9. Isolamento multi-tenant ─────────────────────────────────────────
  const listA = ClinicSpecialtyService.list(A.orgId);
  const listB = ClinicSpecialtyService.list(B.orgId);
  const namesA = listA.map((s) => s.name).sort();
  const namesB = listB.map((s) => s.name).sort();
  check("isolamento: A tem Psicologia+Fonoaudiologia (Fisio desativada)",
    namesA.includes("Psicologia") && namesA.includes("Fonoaudiologia") && !namesA.includes("Nutrição"),
    JSON.stringify(namesA));
  check("isolamento: B tem Nutrição+Neurologia (Cardio desativada não, ativa)",
    namesB.includes("Nutrição") && namesB.includes("Neurologia") && !namesB.includes("Psicologia"),
    JSON.stringify(namesB));

  // get de specialty de A a partir de B → null
  const cross = ClinicSpecialtyService.get(B.orgId, s1.id);
  check("isolamento: get de A a partir de B → null", cross === null);

  // update de A a partir de B → null (rota devolveria 404)
  const crossUpd = ClinicSpecialtyService.update(B.orgId, s1.id, { color: "#000" }, B.actorId);
  check("isolamento: update de A a partir de B → null", crossUpd === null);

  // set... cross-tenant (profissional de A com specialty de A a partir de B) → erro
  let crossErr: any = null;
  try { ClinicSpecialtyService.setProfessionalSpecialties(B.orgId, drAna, [{ specialtyId: s1.id }], B.actorId); }
  catch (e: any) { crossErr = e; }
  check("isolamento: set de profissional de A a partir de B falha", crossErr !== null);

  // ── 10. Auditoria ──────────────────────────────────────────────────────
  const created = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_SPECIALTY_CREATED'`
  ).get(A.orgId) as any;
  check("audit CLINIC_SPECIALTY_CREATED ≥ 3 (Psico + Fono + Fisio)", Number(created?.c) >= 3, String(created?.c));

  const updated = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_SPECIALTY_UPDATED'`
  ).get(A.orgId) as any;
  check("audit CLINIC_SPECIALTY_UPDATED ≥ 3 (color + active + rename tentativa passou por outros)", Number(updated?.c) >= 2, String(updated?.c));

  const linked = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_PROFESSIONAL_SPECIALTY_LINKED'`
  ).get(A.orgId) as any;
  check("audit CLINIC_PROFESSIONAL_SPECIALTY_LINKED ≥ 4", Number(linked?.c) >= 4, String(linked?.c));

  const backfill = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_SPECIALTY_BACKFILL_RUN'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get(B.orgId) as any;
  const meta = JSON.parse(backfill?.metadata_json || "{}");
  check("audit BACKFILL_RUN metadata: specialtiesCreated=3", meta.specialtiesCreated === 3);
  check("audit BACKFILL_RUN metadata: linksCreated=4", meta.linksCreated === 4);

  console.log("\n=== Especialidades normalizadas (ADR-145 Fatia 35) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
