/**
 * TEST — Aceite/recusa do VÍNCULO pelo profissional (ADR-180 F11.1). DB-backed, det., isolado.
 * Prova RN-PN-11 (mútuo consentimento): o profissional vê seus convites pendentes (cross-org)
 * e aceita (→ accepted + professional_accepted_at) ou recusa (→ revoked + sinal pra clínica);
 * só o vínculo DELE e PENDENTE; nunca toca convite de outro profissional.
 *
 * Uso: npm run test:professional-invite-response
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-invresp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-invresp-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalSelfService: SELF } = await import("../src/server/ProfessionalSelfService.js");
  const { BusinessSignalService: SIG } = await import("../src/server/BusinessSignalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Clínica A', 'active', 'petshop')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Clínica B', 'active', 'petshop')`).run(randomUUID(), B);
  const pid = PRO.upsertIdentity({ name: "Dra. Vet", council: "CRMV-SP", registrationNumber: "111" }, A).id;
  const other = PRO.upsertIdentity({ name: "Outro", council: "CRMV-SP", registrationNumber: "222" }, A).id;

  // Duas clínicas convidam o profissional (pending). Uma clínica convida o OUTRO.
  const relA = REL.invite(A, { professionalId: pid }).id;   // pending
  const relB = REL.invite(B, { professionalId: pid }).id;   // pending
  const relOther = REL.invite(A, { professionalId: other }).id; // de outro profissional

  // 1. Convites pendentes: o profissional vê os DELE (2), com nome da clínica.
  const inv = SELF.pendingInvites(pid);
  check("1.1 vê os 2 convites pendentes dele", inv.length === 2);
  check("1.2 convite traz o nome da clínica", inv.some((i) => i.clinicName === "Clínica A") && inv.some((i) => i.clinicName === "Clínica B"));
  check("1.3 NÃO vê o convite de outro profissional", !inv.some((i) => i.relationshipId === relOther));

  // 2. Aceita o convite de A → accepted + professional_accepted_at (mútuo consentimento).
  const acc = await SELF.respondToInvite(pid, relA, true);
  check("2.1 aceito → status accepted", acc.status === "accepted");
  const accAt = (db.prepare(`SELECT professional_accepted_at FROM clinic_professional_relationships WHERE id = ?`).get(relA) as any)?.professional_accepted_at;
  check("2.2 marca professional_accepted_at (consentimento do profissional)", !!accAt);
  check("2.3 sai da lista de pendentes", !SELF.pendingInvites(pid).some((i) => i.relationshipId === relA));

  // 3. Recusa o convite de B → revoked + sinal pra clínica B.
  const dec = await SELF.respondToInvite(pid, relB, false, "agenda cheia");
  check("3.1 recusado → status revoked", dec.status === "revoked");
  const sig = SIG.list(B, { status: "open" }).find((s: any) => s.signal_type === "professional_network/invite_declined");
  check("3.2 publica invite_declined pra clínica B", !!sig && sig.source_entity_id === relB);
  check("3.3 identidade global preservada (RN-PN-3)", PRO.getById(pid) !== null);

  // 4. Não pode responder de novo (não está mais pending).
  let e4 = false; try { await SELF.respondToInvite(pid, relA, true); } catch (e: any) { e4 = e.message === "invite_not_pending"; }
  check("4.1 já respondido → invite_not_pending", e4);

  // 5. Isolamento: o profissional não responde o convite de OUTRO profissional.
  let e5 = false; try { await SELF.respondToInvite(pid, relOther, true); } catch (e: any) { e5 = e.message === "relationship_not_found"; }
  check("5.1 não responde vínculo de outro profissional", e5);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-invite-response: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
