/**
 * TEST — Federação OAB / ponte de identidade (ADR-191 OAB-F1). DB-backed, determinístico.
 * Prova que o advogado da Advocacia liga à identidade GLOBAL da Agenda Federada (ADR-180)
 * pela OAB: gate opt-in (rede desativada não federa), OAB obrigatória, federar é idempotente
 * e reusa a identidade global, defederate revoga o vínculo mas PRESERVA a identidade global
 * (RN-PN-3), e o isolamento entre escritórios.
 *
 * Uso: npm run test:legal-federation
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-legalfed-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-legalfed-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegalProfessionalFederationService: FED } = await import("../src/server/LegalProfessionalFederationService.js");
  const { LegalPracticeService: P } = await import("../src/server/LegalPracticeService.js");
  const { ProfessionalService } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService } = await import("../src/server/ClinicProfessionalRelationshipService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Silva Adv', 'active', 'advocacia')`).run(randomUUID(), A);
  const oabNumber = String(100000 + Math.floor(Math.random() * 800000));
  const lawyer = P.createLawyer(A, { name: "Dra. Ana", oabUf: "SP", oabNumber }, "u1");
  const lawyerNoOab = P.createLawyer(A, { name: "Estagiário X" }, "u1"); // sem OAB

  // ── 1. Gate opt-in: rede desativada não federa ──
  let e1 = false; try { FED.federate(A, lawyer.id, "u1"); } catch { e1 = true; }
  check("1.1 rede desativada → federar rejeitado (RN-PN-8)", e1);
  check("1.2 status inicial: não federado, mas tem OAB", (() => { const s = FED.status(A, lawyer.id); return s.federated === false && s.hasOab === true && s.professionalId === null; })());

  // ativa a rede
  db.prepare(`UPDATE organization_settings SET professional_network_enabled = 1 WHERE organization_id = ?`).run(A);

  // ── 2. OAB obrigatória ──
  let e2 = false; try { FED.federate(A, lawyerNoOab.id, "u1"); } catch { e2 = true; }
  check("2.1 advogado sem OAB não federa", e2);
  check("2.2 status sem OAB → hasOab false", FED.status(A, lawyerNoOab.id).hasOab === false);

  // ── 3. Federar liga à identidade global + vínculo aceito ──
  const fed = FED.federate(A, lawyer.id, "u1");
  check("3.1 federado com identidade global + vínculo aceito", fed.federated === true && !!fed.professionalId && fed.relationshipStatus === "accepted");
  const globalProf = ProfessionalService.findByRegistration("OAB", `SP ${oabNumber}`);
  check("3.2 identidade global existe pela OAB (chave natural)", !!globalProf && globalProf.id === fed.professionalId && globalProf.name === "Dra. Ana");

  // ── 4. Idempotente (re-federar não duplica) ──
  const fed2 = FED.federate(A, lawyer.id, "u1");
  check("4.1 re-federar é idempotente (mesmo professional + vínculo)", fed2.professionalId === fed.professionalId && fed2.relationshipId === fed.relationshipId && fed2.federated === true);

  // ── 5. Defederate revoga o vínculo mas PRESERVA a identidade global (RN-PN-3) ──
  const def = FED.defederate(A, lawyer.id, "u1");
  check("5.1 defederado → não federado, vínculo revogado", def.federated === false && def.relationshipStatus === "revoked");
  check("5.2 identidade global PRESERVADA (nunca apaga — RN-PN-3)", !!ProfessionalService.findByRegistration("OAB", `SP ${oabNumber}`));
  // re-federar reativa o mesmo vínculo
  const re = FED.federate(A, lawyer.id, "u1");
  check("5.3 re-federar reativa o mesmo vínculo (accepted)", re.federated === true && re.professionalId === fed.professionalId);

  // ── 6. Isolamento entre escritórios: o MESMO advogado federa em outro org com vínculo próprio ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'Outro Adv', 'active', 'advocacia', 1)`).run(randomUUID(), B);
  const lawyerB = P.createLawyer(B, { name: "Dra. Ana", oabUf: "SP", oabNumber }, "u2"); // mesma OAB, outro escritório
  const fedB = FED.federate(B, lawyerB.id, "u2");
  check("6.1 mesma OAB → MESMA identidade global (ecossistema, §90)", fedB.professionalId === fed.professionalId);
  check("6.2 vínculos são SEPARADOS por org (RN-PN-2)", fedB.relationshipId !== fed.relationshipId);
  // revogar em A não afeta B
  FED.defederate(A, lawyer.id, "u1");
  check("6.3 revogar em A não afeta o vínculo de B", FED.status(B, lawyerB.id).federated === true && ClinicProfessionalRelationshipService.getByProfessional(B, fed.professionalId)?.status === "accepted");

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legal-federation: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
