/**
 * TESTE — Módulo Clínica Fase E: Autorização assistida (ADR-080)
 * ---------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - operadora + credenciais CIFRADAS (nunca em texto no banco);
 *   - procedimento com TUSS (cadastrado à mão — a IA nunca inventa);
 *   - fluxo draft → prepare → ready → submit → retorno (approved/denied);
 *   - envio SÓ a partir de ready_to_submit (guardrail: humano no MVP);
 *   - snapshot IMUTÁVEL do plano no momento da criação (D6);
 *   - cada transição dispara a cadência clínica correspondente (Fase A);
 *   - isolamento multi-tenant e auditoria.
 *
 * Uso:  npm run test:clinic-authorization
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-auth-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-auth-1234567890";
process.env.ENCRYPTION_KEY = "chave-de-teste-para-cifrar-credenciais-operadora";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAuthorizationService } = await import("../src/server/ClinicAuthorizationService.js");
  const { PatientService } = await import("../src/server/PatientService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(contactId, orgId, channelId, `Paciente ${tag}`, `55${tag}999`);
    // Ticket aberto — para a cadência ter a quem notificar.
    const ticketId = randomUUID();
    db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage) VALUES (?, ?, ?, 'open', 'agendado')`).run(ticketId, orgId, contactId);
    // Cadência clínica (como a Fase A semeia) para o gatilho autorizacao_aprovada.
    const cadId = randomUUID();
    db.prepare(`INSERT INTO cadences (id, organization_id, name, trigger_stage, active) VALUES (?, ?, 'Autorização aprovada', 'autorizacao_aprovada', 1)`).run(cadId, orgId);
    db.prepare(`INSERT INTO cadence_steps (id, organization_id, cadence_id, step_order, delay_hours, message) VALUES (?, ?, ?, 1, 1, 'Oi! Sua autorização foi liberada.')`).run(randomUUID(), orgId, cadId);
    return { orgId, actorId: `user_${tag}`, contactId, ticketId };
  }
  const A = seedOrg("A");
  const B = seedOrg("B");

  // Ficha com plano (para o snapshot).
  PatientService.upsert(A.orgId, A.contactId, { insuranceName: "Unimed", currentPlanName: "Nacional", insuranceCardNumber: "0001" }, A.actorId);

  // ---- 1. Operadora + credenciais cifradas ----
  const op = ClinicAuthorizationService.createOperator(A.orgId, { name: "Unimed", ansRegistry: "123456" }, A.actorId);
  check("Operadora criada", !!op.id && op.name === "Unimed");
  ClinicAuthorizationService.setCredentials(A.orgId, op.id, { providerCode: "PRE123", username: "clinica@ex.com", password: "s3nha!" }, A.actorId);
  const credRow = db.prepare("SELECT username_encrypted, password_encrypted FROM health_plan_credentials WHERE organization_id = ? AND operator_id = ?").get(A.orgId, op.id) as any;
  check("Credenciais NÃO ficam em texto (username cifrado)", credRow.username_encrypted && !credRow.username_encrypted.includes("clinica@ex.com") && credRow.username_encrypted.startsWith("enc:"));
  check("Senha cifrada", credRow.password_encrypted && !credRow.password_encrypted.includes("s3nha!"));
  check("Status de credenciais sem expor segredo", ClinicAuthorizationService.credentialsStatus(A.orgId, op.id).configured === true);

  // ---- 2. Procedimento com TUSS ----
  const proc = ClinicAuthorizationService.createProcedure(A.orgId, { name: "Ressonância", tussCode: "40901114", requiresAuthorization: true }, A.actorId);
  check("Procedimento com TUSS criado", proc.tuss_code === "40901114");

  // ---- 3. Criar autorização + snapshot imutável do plano (D6) ----
  const auth = ClinicAuthorizationService.createAuthorization(A.orgId, { contactId: A.contactId, operatorId: op.id, procedureId: proc.id }, A.actorId);
  check("Autorização nasce em rascunho", auth.status === "draft");
  check("TUSS herdado do procedimento", auth.tuss_code === "40901114");
  const snap = JSON.parse(auth.plan_snapshot || "{}");
  check("Snapshot congelou o plano do momento", snap.insurance === "Unimed" && snap.plan === "Nacional");

  // Trocar o plano depois NÃO altera o snapshot já congelado.
  PatientService.changePlan(A.orgId, A.contactId, { insuranceName: "Amil", reason: "teste" }, A.actorId);
  const authReload = ClinicAuthorizationService.getAuthorization(A.orgId, auth.id);
  check("Snapshot permanece imutável após troca de plano", JSON.parse(authReload.plan_snapshot).insurance === "Unimed");

  // ---- 4. Guardrail: enviar antes de 'ready' é recusado ----
  check("Enviar rascunho é recusado", (() => { try { ClinicAuthorizationService.submit(A.orgId, auth.id, {}, A.actorId); return false; } catch (e: any) { return e.message.includes("ready_to_submit"); } })());

  // Preparar com pendência → pending_documents (dispara documentacao_pendente).
  ClinicAuthorizationService.prepare(A.orgId, auth.id, { pendingRequirements: "Falta pedido médico" }, A.actorId);
  check("Preparar com pendência → pending_documents", ClinicAuthorizationService.getAuthorization(A.orgId, auth.id).status === "pending_documents");

  // Preparar pronto → ready_to_submit; então submit.
  ClinicAuthorizationService.prepare(A.orgId, auth.id, { ready: true }, A.actorId);
  check("Preparar pronto → ready_to_submit", ClinicAuthorizationService.getAuthorization(A.orgId, auth.id).status === "ready_to_submit");
  ClinicAuthorizationService.submit(A.orgId, auth.id, { protocolNumber: "PROTO-9" }, A.actorId);
  const submitted = ClinicAuthorizationService.getAuthorization(A.orgId, auth.id);
  check("Enviado registra protocolo e submitted_at", submitted.status === "submitted" && submitted.protocol_number === "PROTO-9" && !!submitted.submitted_at);

  // ---- 5. Retorno aprovado → dispara cadência autorizacao_aprovada ----
  ClinicAuthorizationService.setManualStatus(A.orgId, auth.id, { status: "approved", authorizationNumber: "AUTH-777" }, A.actorId);
  const approved = ClinicAuthorizationService.getAuthorization(A.orgId, auth.id);
  check("Aprovado registra número e approved_at", approved.status === "approved" && approved.authorization_number === "AUTH-777" && !!approved.approved_at);
  const contactCadence = db.prepare("SELECT COUNT(*) n FROM contact_cadences WHERE organization_id = ? AND contact_id = ?").get(A.orgId, A.contactId) as any;
  check("Transição para aprovado disparou a cadência clínica", Number(contactCadence.n) >= 1);

  // ---- 6. Isolamento multi-tenant ----
  check("Org B não vê autorizações de A", ClinicAuthorizationService.listAuthorizations(B.orgId).length === 0);
  check("Autorização de A não abre com orgId de B", ClinicAuthorizationService.getAuthorization(B.orgId, auth.id) === null);
  check("Criar autorização em B com procedimento de A falha", (() => { try { ClinicAuthorizationService.createAuthorization(B.orgId, { contactId: B.contactId, procedureId: proc.id }, B.actorId); return false; } catch (e: any) { return e.message.includes("não encontrado"); } })());

  // ---- 7. Auditoria ----
  const audited = db.prepare("SELECT event_type FROM auth_audit_logs WHERE organization_id = ?").all(A.orgId).map((r: any) => r.event_type);
  for (const ev of ["CLINIC_OPERATOR_CREATED", "CLINIC_OPERATOR_CREDENTIALS_SET", "CLINIC_PROCEDURE_CREATED", "CLINIC_AUTHORIZATION_CREATED", "CLINIC_AUTHORIZATION_SUBMITTED", "CLINIC_AUTHORIZATION_STATUS"]) {
    check(`Auditoria registrou ${ev}`, audited.includes(ev));
  }

  console.log("\n=== Módulo Clínica — Autorização assistida (ADR-080, Fase E) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
