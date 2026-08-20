/**
 * TEST — Professional Network & Agenda Federada (ADR-180 F1). DB-backed, det., isolado.
 *
 * Prova a decisão de fronteira: identidade GLOBAL do profissional (professionals, sem
 * organization_id) + bridge POR-ORG (clinic_professional_relationships). Cobre:
 * identidade idempotente pela chave do conselho, NÃO sobrescreve com vazio (RN-PN-3),
 * ciclo convite→aceite→revogação, isolamento cross-org (RN-PN-2), e que revogar não
 * apaga a identidade global.
 *
 * Uso: npm run test:professional-network
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-profnet-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-profnet-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PROF } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Clínica A', 'active', 'petshop')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Clínica B', 'active', 'petshop')`).run(randomUUID(), B);

  // 1. Identidade global — idempotência pela chave do conselho.
  const p1 = PROF.upsertIdentity({ council: "CRMV-SP", registrationNumber: "12345", name: "Dra. Marina Aves", specialties: ["cardiologia de aves"] }, A);
  check("1.1 cria identidade global", !!p1.id && p1.name === "Dra. Marina Aves");
  const p1b = PROF.upsertIdentity({ council: "crmv-sp", registrationNumber: "12345", name: "Marina" }, B); // outra org, mesma chave (case-insensível)
  check("1.2 mesma chave (conselho+registro) → mesma identidade (idempotente)", p1b.id === p1.id);
  check("1.3 NÃO sobrescreve nome existente com outro (RN-PN-3)", PROF.getById(p1.id)!.name === "Dra. Marina Aves");
  // completa campo faltante (email) sem apagar
  PROF.upsertIdentity({ council: "CRMV-SP", registrationNumber: "12345", name: "x", email: "marina@vet.com" }, A);
  check("1.4 completa campo vazio (email) sem apagar o resto", PROF.getById(p1.id)!.email === "marina@vet.com" && PROF.getById(p1.id)!.specialties.length === 1);

  // 1.5 validação — não inventa (exige council/registration/name)
  let threw = false; try { PROF.upsertIdentity({ council: "CRMV-SP", name: "Sem registro" } as any, A); } catch { threw = true; }
  check("1.5 exige registro (não inventa identidade)", threw);

  // 2. Busca.
  check("2.1 busca por nome encontra", PROF.search("Marina").some((p) => p.id === p1.id));
  check("2.2 busca por registro encontra", PROF.search("12345").some((p) => p.id === p1.id));

  // 3. Convite / ciclo do vínculo (bridge por-org).
  const relA = REL.invite(A, { professionalId: p1.id, permissions: { services: ["svc-cirurgia"], commissionPercent: 30 }, notes: "cirurgia de aves" }, "userA");
  check("3.1 convite nasce pending (RN-PN-5)", relA.status === "pending");
  check("3.2 vínculo carrega a identidade global", relA.professional?.id === p1.id);
  check("3.3 permissões e comissão gravadas", relA.permissions.services[0] === "svc-cirurgia" && relA.commissionPercent === 30);

  // convite idempotente por (org, professional)
  const relA2 = REL.invite(A, { professionalId: p1.id }, "userA");
  check("3.4 reconvite devolve a MESMA relação (UNIQUE org,professional)", relA2.id === relA.id);

  const accepted = REL.accept(A, relA.id, "userA");
  check("3.5 aceite → accepted", accepted.status === "accepted" && !!accepted.respondedAt);

  // 4. Isolamento cross-org (RN-PN-2).
  check("4.1 B não enxerga a relação de A (get)", REL.get(B, relA.id) === null);
  check("4.2 B não lista a relação de A", REL.list(B).length === 0);
  check("4.3 A lista a própria relação", REL.list(A).some((r) => r.id === relA.id));

  // B cria a PRÓPRIA relação com o MESMO profissional (identidade compartilhada, vínculos separados).
  const relB = REL.invite(B, { professionalId: p1.id }, "userB");
  check("4.4 B tem vínculo próprio com o mesmo profissional", relB.id !== relA.id && relB.professionalId === p1.id);
  check("4.5 vínculo de B nasce pending, independe do accepted de A", relB.status === "pending" && REL.get(A, relA.id)!.status === "accepted");

  // 5. Revogação não apaga a identidade global (RN-PN-3).
  const revoked = REL.revoke(A, relA.id, "userA");
  check("5.1 revoga o vínculo de A", revoked.status === "revoked" && !!revoked.revokedAt);
  check("5.2 identidade global permanece", PROF.getById(p1.id) !== null);
  check("5.3 vínculo de B intacto após A revogar (isolamento)", REL.get(B, relB.id)!.status === "pending");
  // reconvite reativa o vínculo revogado
  const reinvited = REL.invite(A, { professionalId: p1.id }, "userA");
  check("5.4 reconvite reativa o vínculo revogado → pending", reinvited.id === relA.id && reinvited.status === "pending");

  // 6. setPermissions preserva isolamento.
  REL.setPermissions(A, relA.id, { services: ["svc-cirurgia", "svc-internacao"] }, "userA");
  check("6.1 atualiza permissões", REL.get(A, relA.id)!.permissions.services.length === 2);
  let threwPerm = false; try { REL.setPermissions(B, relA.id, { services: [] }, "userB"); } catch { threwPerm = true; }
  check("6.2 org B não altera permissões de vínculo de A", threwPerm);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-network: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
