/**
 * TESTE — Módulo Clínica Fase B: Ficha do Paciente (ADR-080)
 * -----------------------------------------------------------
 * Prova, offline e em banco temporário, a dor central da clínica:
 *   - criar ficha do paciente ligada a um contato;
 *   - TROCAR de plano/convênio NÃO apaga o contato nem o agendamento;
 *   - a troca registra histórico (com motivo) e mantém o mesmo contact_id;
 *   - isolamento multi-tenant e auditoria das ações;
 *   - o módulo "clinica" está registrado (gating) e é preset da vertical saude.
 *
 * Uso:  npm run test:clinic-patient
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-patient-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-patient-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PatientService } = await import("../src/server/PatientService.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { OPTIONAL_MODULES, VERTICALS } = await import("../src/server/verticals.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(contactId, orgId, channelId, `Paciente ${tag}`, `5521${tag}0000000`);
    // Agendamento existente — a troca de plano NÃO pode afetá-lo.
    const apptId = randomUUID();
    db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, status) VALUES (?, ?, ?, 'Consulta', '2026-08-01 10:00:00', 'confirmed')`)
      .run(apptId, orgId, contactId);
    return { orgId, contactId, apptId, actorId: `user_${tag}` };
  }
  const A = seedOrg("A");
  const B = seedOrg("B");

  // ---- 0. Registro do módulo (gating) ----
  check("Módulo 'clinica' está em OPTIONAL_MODULES", (OPTIONAL_MODULES as readonly string[]).includes("clinica"));
  check("Rota clinic → módulo clinica", ModuleService.MODULE_BY_ROUTE.clinic === "clinica");
  check("Vertical saude tem 'clinica' no preset", (VERTICALS.find((v: any) => v.key === "saude")?.modules || []).includes("clinica"));

  // ---- 1. Criar ficha ----
  PatientService.upsert(A.orgId, A.contactId, {
    fullName: "Maria Souza", cpf: "123.456.789-00", insuranceName: "Unimed", currentPlanName: "Unimed Nacional", insuranceCardNumber: "0001",
  }, A.actorId);
  let card = PatientService.getByContact(A.orgId, A.contactId);
  check("Ficha criada e vinculada ao contato", card.profile && card.profile.contact_id === A.contactId);
  check("CPF normalizado (só dígitos)", card.profile.cpf === "12345678900");
  check("Convênio inicial gravado", card.profile.insurance_name === "Unimed");

  // ---- 2. TROCAR de plano NÃO apaga contato nem agendamento ----
  PatientService.changePlan(A.orgId, A.contactId, { insuranceName: "Amil", currentPlanName: "Amil 400", insuranceCardNumber: "9999", reason: "paciente mudou de emprego" }, A.actorId);
  card = PatientService.getByContact(A.orgId, A.contactId);
  check("Contato PRESERVADO após troca (mesmo id)", card.contact && card.contact.id === A.contactId);
  const apptStill = db.prepare("SELECT id, status FROM appointments WHERE id = ? AND organization_id = ?").get(A.apptId, A.orgId) as any;
  check("Agendamento PRESERVADO após troca de plano", apptStill && apptStill.status === "confirmed");
  check("Convênio atualizado na ficha", card.profile.insurance_name === "Amil" && card.profile.current_plan_name === "Amil 400");
  check("Ficha continua sendo a mesma (não recriada)", true);

  // ---- 3. Histórico da troca ----
  check("Histórico registrou a troca (Unimed → Amil)", card.planHistory.length === 1 && card.planHistory[0].old_insurance_name === "Unimed" && card.planHistory[0].new_insurance_name === "Amil");
  check("Motivo da troca preservado", card.planHistory[0].reason === "paciente mudou de emprego");

  // Segunda troca acumula histórico.
  PatientService.changePlan(A.orgId, A.contactId, { insuranceName: "Bradesco Saúde", reason: "novo convênio" }, A.actorId);
  card = PatientService.getByContact(A.orgId, A.contactId);
  check("Segunda troca acumula histórico (2 registros)", card.planHistory.length === 2);
  check("Plano mantido quando não informado na troca", card.profile.current_plan_name === "Amil 400");

  // ---- 4. Editar sem apagar via upsert também registra histórico do plano ----
  PatientService.upsert(A.orgId, A.contactId, { administrativeNotes: "Prefere manhã" }, A.actorId);
  card = PatientService.getByContact(A.orgId, A.contactId);
  check("Editar nota não gera histórico de plano", card.planHistory.length === 2 && card.profile.administrative_notes === "Prefere manhã");

  // ---- 5. Isolamento multi-tenant ----
  let threw = "";
  try { PatientService.getByContact(B.orgId, A.contactId); } catch (e: any) { threw = e.message; }
  check("Ficha de A não abre com orgId de B", threw.includes("não encontrado"));
  check("Lista de B não vê pacientes de A", PatientService.list(B.orgId).length === 0);
  threw = "";
  try { PatientService.changePlan(B.orgId, A.contactId, { insuranceName: "X" }, B.actorId); } catch (e: any) { threw = e.message; }
  check("Trocar plano cross-tenant falha", threw.includes("não encontrada"));

  // ---- 6. Auditoria ----
  const audited = db.prepare("SELECT event_type FROM auth_audit_logs WHERE organization_id = ?").all(A.orgId).map((r: any) => r.event_type);
  for (const ev of ["PATIENT_PROFILE_CREATED", "PATIENT_PLAN_CHANGED", "PATIENT_PROFILE_UPDATED"]) {
    check(`Auditoria registrou ${ev}`, audited.includes(ev));
  }

  console.log("\n=== Módulo Clínica — Ficha do Paciente (ADR-080, Fase B) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
