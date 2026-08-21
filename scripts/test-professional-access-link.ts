/**
 * TEST — Magic-link emitido pela clínica (ADR-180 F7.2). DB-backed, det., isolado.
 * Prova: só um vínculo ACEITO da org emite; o link abre sessão; vínculo pendente/de outra
 * org não emite; revogar mata o acesso; a URL aponta pro webapp do profissional.
 *
 * Uso: npm run test:professional-access-link
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-acclink-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-acclink-123456";
process.env.APP_URL = "https://app.zapflow.test";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalAuthService: AUTH } = await import("../src/server/ProfessionalAuthService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'A', 'active', 'petshop', 1)`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'B', 'active', 'petshop', 1)`).run(randomUUID(), B);
  const pid = PRO.upsertIdentity({ name: "Dra. Vet", council: "CRMV-SP", registrationNumber: "12345" }, A).id;
  const relA = REL.invite(A, { professionalId: pid }).id; REL.accept(A, relA);   // aceito em A
  const relB = REL.invite(B, { professionalId: pid }).id;                        // pendente em B

  // 1. Clínica com vínculo aceito emite → URL + token que abre sessão.
  const issued = AUTH.issueForRelationship(A, relA, "userA");
  check("1.1 URL aponta pro webapp do profissional", /^https:\/\/app\.zapflow\.test\/profissional\//.test(issued.url));
  check("1.2 devolve o nome do profissional", issued.professionalName === "Dra. Vet");
  const sess = AUTH.startSession(issued.token);
  check("1.3 o token abre sessão do profissional certo", sess.professional.id === pid);

  // 2. Vínculo PENDENTE não emite.
  let e2 = false; try { AUTH.issueForRelationship(B, relB, "userB"); } catch (e: any) { e2 = e.message === "relationship_not_accepted"; }
  check("2.1 vínculo pendente não emite link", e2);

  // 3. Isolamento: a org B não emite sobre o vínculo de A.
  let e3 = false; try { AUTH.issueForRelationship(B, relA, "userB"); } catch (e: any) { e3 = e.message === "relationship_not_found"; }
  check("3.1 outra org não emite sobre vínculo alheio", e3);

  // 4. Status reflete link ativo.
  check("4.1 status ativo após emissão", AUTH.statusForRelationship(A, relA).active === true);

  // 5. Revogar → status inativo + token não abre mais sessão.
  const rev = AUTH.revokeForRelationship(A, relA, "userA");
  check("5.1 revogado", rev.revoked === true);
  check("5.2 status inativo após revogar", AUTH.statusForRelationship(A, relA).active === false);
  let e5 = false; try { AUTH.startSession(issued.token); } catch (e: any) { e5 = e.message === "token_invalid_or_expired"; }
  check("5.3 token revogado não abre sessão", e5);

  // 6. Reemitir gera um novo link válido (o antigo já morreu na revogação).
  const again = AUTH.issueForRelationship(A, relA, "userA");
  check("6.1 reemissão abre sessão de novo", AUTH.startSession(again.token).professional.id === pid);
  check("6.2 novo token ≠ antigo", again.token !== issued.token);

  // 7. F11.3 — issueAndSend ENTREGA o link ao e-mail do profissional (best-effort, honesto).
  const { deps } = await import("../src/server/ProfessionalAuthService.js");
  const sent: { to: string; subject: string; body: string }[] = [];
  deps.sendEmail = async (_org, to, subject, body) => { sent.push({ to, subject, body }); return { sent: true }; };

  // 7a. Profissional COM e-mail → envia; o corpo carrega a URL e o token muda (0-regressão do emit).
  db.prepare(`UPDATE professionals SET email = 'dra.vet@example.com' WHERE id = ?`).run(pid);
  const s1 = await AUTH.issueAndSend(A, relA, "userA");
  check("7.1 emitiu link válido junto do envio", AUTH.startSession(s1.token).professional.id === pid);
  check("7.2 delivery marca enviado ao e-mail do profissional", s1.delivery.sent === true && s1.delivery.to === "dra.vet@example.com" && s1.delivery.channel === "email");
  check("7.3 chamou o transporte 1x com a URL no corpo", sent.length === 1 && sent[0].to === "dra.vet@example.com" && sent[0].body.includes(s1.url));

  // 7b. Profissional SEM e-mail → honesto (`no_destination`), NÃO chama o transporte, mas emite o token.
  const pid2 = PRO.upsertIdentity({ name: "Dr. Sem Email", council: "CRMV-SP", registrationNumber: "77777" }, A).id;
  const relC = REL.invite(A, { professionalId: pid2 }).id; REL.accept(A, relC);
  const before = sent.length;
  const s2 = await AUTH.issueAndSend(A, relC, "userA");
  check("7.4 sem e-mail: honesto no_destination", s2.delivery.sent === false && s2.delivery.reason === "no_destination" && s2.delivery.to === null);
  check("7.5 sem e-mail: não tenta enviar, mas emite token válido", sent.length === before && AUTH.startSession(s2.token).professional.id === pid2);

  // 7c. Transporte falha (sem canal na org) → delivery honesto, token segue válido pra compartilhar manual.
  deps.sendEmail = async () => ({ sent: false, reason: "no_channel" });
  const s3 = await AUTH.issueAndSend(A, relA, "userA");
  check("7.6 sem canal: delivery honesto, mas link continua utilizável", s3.delivery.sent === false && s3.delivery.reason === "no_channel" && AUTH.startSession(s3.token).professional.id === pid);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-access-link: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
