/**
 * TESTE — Módulo Clínica Fase F0: Onboarding de Conexão TISS (ADR-081)
 * --------------------------------------------------------------------
 * Prova, offline e em banco temporário, que o questionário self-service +
 * o cálculo de prontidão funcionam:
 *   - perfil da org salvo (com normalização de CNPJ/CNES);
 *   - itens BLOQUEANTES detectados (A1, CNES, registro do responsável);
 *   - certificado A3/none → operadora BLOQUEADA (só manual);
 *   - com A1 + dados completos → ready_to_homologate; teto = signed_xml
 *     (Nível 2) ou webservice (Nível 3) conforme a operadora aceita;
 *   - sugestão de piloto = a pronta de maior volume;
 *   - isolamento multi-tenant e auditoria.
 *
 * Uso:  npm run test:clinic-connection
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-conn-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-conn-1234567890";
process.env.ENCRYPTION_KEY = "chave-de-teste-conexao-tiss-onboarding-abc";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicConnectionService } = await import("../src/server/ClinicConnectionService.js");
  const { ClinicAuthorizationService } = await import("../src/server/ClinicAuthorizationService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    return { orgId, actorId: `user_${tag}` };
  }
  const A = seedOrg("A");
  const B = seedOrg("B");

  // ---- 1. Perfil + normalização ----
  ClinicConnectionService.saveProfile(A.orgId, { legalName: "Clínica A LTDA", cnpj: "12.345.678/0001-90", cnes: "1234567", certificateType: "a1", responsibleName: "Dra. Ana", responsibleRegistry: "CRM 12345/RJ", monthlyAuthorizations: 200 }, A.actorId);
  const prof = ClinicConnectionService.getProfile(A.orgId);
  check("Perfil salvo com CNPJ normalizado", prof.cnpj === "12345678000190");
  check("Tipo de certificado A1 gravado", prof.certificate_type === "a1");

  // ---- 2. Operadoras + prontidão ----
  const amil = ClinicAuthorizationService.createOperator(A.orgId, { name: "Amil" }, A.actorId);
  const brad = ClinicAuthorizationService.createOperator(A.orgId, { name: "Bradesco Saúde" }, A.actorId);

  // Amil: totalmente pronta, aceita WebService, volume alto.
  ClinicConnectionService.setOperatorReadiness(A.orgId, amil.id, { credentialed: true, providerCode: "AM-001", hasHomologAccess: true, tissVersion: "4.01.00", acceptsWebservice: true, monthlyVolume: 300 }, A.actorId);
  ClinicAuthorizationService.setCredentials(A.orgId, amil.id, { username: "u", password: "p" }, A.actorId);
  // Bradesco: pronta mas só portal (Nível 2), volume menor.
  ClinicConnectionService.setOperatorReadiness(A.orgId, brad.id, { credentialed: true, providerCode: "BR-002", hasHomologAccess: true, tissVersion: "4.01.00", acceptsWebservice: false, monthlyVolume: 120 }, A.actorId);
  ClinicAuthorizationService.setCredentials(A.orgId, brad.id, { username: "u", password: "p" }, A.actorId);

  let r = ClinicConnectionService.readiness(A.orgId);
  check("Sem bloqueio de nível org (A1 + CNES + registro presentes)", r.orgBlocking.length === 0);
  const amilR = r.operators.find((o: any) => o.name === "Amil");
  const bradR = r.operators.find((o: any) => o.name === "Bradesco Saúde");
  check("Amil pronta para homologar", amilR.status === "ready_to_homologate");
  check("Teto da Amil = webservice (Nível 3)", amilR.connectionCeiling === "webservice");
  check("Bradesco pronta para homologar", bradR.status === "ready_to_homologate");
  check("Teto do Bradesco = signed_xml (Nível 2)", bradR.connectionCeiling === "signed_xml");
  check("Sugestão de piloto = Amil (maior volume entre as prontas)", r.summary.suggestedPilot?.name === "Amil");

  // ---- 3. Faltando um item bloqueante da operadora ----
  ClinicConnectionService.setOperatorReadiness(A.orgId, brad.id, { hasHomologAccess: false }, A.actorId);
  r = ClinicConnectionService.readiness(A.orgId);
  const bradR2 = r.operators.find((o: any) => o.name === "Bradesco Saúde");
  check("Sem homologação → gathering", bradR2.status === "gathering");
  check("Falta listada é a homologação", bradR2.missing.some((m: string) => m.includes("homologação")));

  // ---- 4. Certificado A3 bloqueia TODAS as operadoras (só manual) ----
  ClinicConnectionService.saveProfile(A.orgId, { certificateType: "a3" }, A.actorId);
  r = ClinicConnectionService.readiness(A.orgId);
  check("A3 bloqueia a Amil (blocked_certificate)", r.operators.find((o: any) => o.name === "Amil").status === "blocked_certificate");
  check("A3 → teto é apenas manual", r.operators.every((o: any) => o.connectionCeiling === "manual"));
  check("orgBlocking explica o A3", r.orgBlocking.some((b: string) => b.includes("A3")));
  // Volta para A1.
  ClinicConnectionService.saveProfile(A.orgId, { certificateType: "a1" }, A.actorId);

  // ---- 5. Bloqueantes de nível org faltando ----
  const C = seedOrg("C");
  ClinicConnectionService.saveProfile(C.orgId, { certificateType: "a1" }, C.actorId); // sem CNES nem registro
  const rc = ClinicConnectionService.readiness(C.orgId);
  check("Faltando CNES e registro → orgBlocking com 2 itens", rc.orgBlocking.length === 2);

  // ---- 6. Isolamento multi-tenant ----
  check("Org B tem perfil vazio/independente", ClinicConnectionService.getProfile(B.orgId).certificate_type === "unknown");
  check("Readiness de B não vê operadoras de A", ClinicConnectionService.readiness(B.orgId).operators.length === 0);
  check("Prontidão cross-tenant falha", (() => { try { ClinicConnectionService.setOperatorReadiness(B.orgId, amil.id, { credentialed: true }, B.actorId); return false; } catch (e: any) { return e.message.includes("não encontrada"); } })());

  // ---- 7. Auditoria ----
  const audited = db.prepare("SELECT event_type FROM auth_audit_logs WHERE organization_id = ?").all(A.orgId).map((r2: any) => r2.event_type);
  check("Auditoria CLINIC_CONNECTION_PROFILE_SAVED", audited.includes("CLINIC_CONNECTION_PROFILE_SAVED"));
  check("Auditoria CLINIC_OPERATOR_READINESS_SAVED", audited.includes("CLINIC_OPERATOR_READINESS_SAVED"));

  console.log("\n=== Módulo Clínica — Onboarding de Conexão TISS (ADR-081, Fase F0) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
