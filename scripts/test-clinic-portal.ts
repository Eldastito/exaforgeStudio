/**
 * TESTE — Módulo Clínica Fase D1: Portal do Profissional + export (ADR-080)
 * -------------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - geração de token (devolvido uma vez) resolve por hash, nunca por id;
 *   - o portal expõe SOMENTE a agenda do próprio profissional (não vaza a de
 *     outro profissional nem de outra organização);
 *   - projeção enxuta (sem ids internos/financeiro);
 *   - revogação e expiração invalidam o link; regenerar desativa o anterior;
 *   - CSV do dia sai com cabeçalho e linhas;
 *   - auditoria da emissão/revogação.
 *
 * Uso:  npm run test:clinic-portal
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-portal-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-portal-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicPortalService } = await import("../src/server/ClinicPortalService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, clinic_overrun_warning_minutes) VALUES (?, ?, ?, 'active', 15)`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkContact = (n: string) => { const id = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(id, orgId, channelId, n, `55${tag}${Math.floor(Math.random() * 1e8)}`); return id; };
    return { orgId, actorId: `user_${tag}`, c1: mkContact("Paciente 1"), c2: mkContact("Paciente 2") };
  }
  const A = seedOrg("A");
  const B = seedOrg("B");

  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Ana", color: "#22c55e" }, A.actorId);
  const dr = ClinicAgendaService.createProfessional(A.orgId, { name: "Dr. Bruno" }, A.actorId);
  ClinicAgendaService.createAppointment(A.orgId, { contactId: A.c1, title: "Consulta Ana", scheduledStart: "2026-08-01T09:00:00-03:00", professionalId: dra.id, durationMinutes: 30 }, A.actorId);
  ClinicAgendaService.createAppointment(A.orgId, { contactId: A.c2, title: "Consulta Bruno", scheduledStart: "2026-08-01T10:00:00-03:00", professionalId: dr.id, durationMinutes: 30 }, A.actorId);

  // ---- 1. Geração e resolução por token ----
  const { token, expiresAt } = ClinicPortalService.generateToken(A.orgId, dra.id, A.actorId);
  check("Token cru devolvido (uma vez)", typeof token === "string" && token.length >= 32);
  check("Token não é guardado em texto no banco", !db.prepare("SELECT 1 FROM professional_portal_tokens WHERE token_hash = ?").get(token));
  check("Expiração definida", !!expiresAt);
  const portal = ClinicPortalService.agendaByToken(token, "2026-08-01");
  check("Portal resolve o profissional certo", portal.professional.name === "Dra. Ana");

  // ---- 2. Só a agenda do PRÓPRIO profissional ----
  check("Portal mostra só a consulta da Dra. Ana", portal.appointments.length === 1 && portal.appointments[0].patient_name === "Paciente 1");
  check("Portal NÃO vaza a consulta do Dr. Bruno", !portal.appointments.some((a: any) => a.procedure === "Consulta Bruno"));
  // Projeção enxuta: sem contact_id/professional_id internos.
  check("Projeção enxuta (sem ids internos)", portal.appointments[0].contact_id === undefined && portal.appointments[0].professional_id === undefined);
  check("Projeção traz o essencial (horário, paciente, status)", !!portal.appointments[0].time && !!portal.appointments[0].patient_name && !!portal.appointments[0].status);

  // last_access registrado.
  const acc = db.prepare("SELECT last_access_at FROM professional_portal_tokens WHERE organization_id = ? AND professional_id = ?").get(A.orgId, dra.id) as any;
  check("Último acesso registrado", !!acc.last_access_at);

  // ---- 3. Token inválido / de outra coisa ----
  check("Token aleatório inválido é recusado", (() => { try { ClinicPortalService.agendaByToken("deadbeef".repeat(8)); return false; } catch (e: any) { return e.message.includes("inválido"); } })());

  // ---- 4. Regenerar desativa o anterior ----
  const again = ClinicPortalService.generateToken(A.orgId, dra.id, A.actorId);
  check("Token novo é diferente", again.token !== token);
  check("Token antigo deixa de valer após regenerar", (() => { try { ClinicPortalService.agendaByToken(token); return false; } catch { return true; } })());
  check("Token novo funciona", ClinicPortalService.agendaByToken(again.token, "2026-08-01").professional.name === "Dra. Ana");

  // ---- 5. Revogação ----
  check("Revogar retorna true", ClinicPortalService.revoke(A.orgId, dra.id, A.actorId) === true);
  check("Após revogar, o link não vale", (() => { try { ClinicPortalService.agendaByToken(again.token); return false; } catch { return true; } })());
  check("Status reflete inativo", ClinicPortalService.status(A.orgId, dra.id).active === false);

  // ---- 6. Expiração ----
  const exp = ClinicPortalService.generateToken(A.orgId, dr.id, A.actorId);
  db.prepare("UPDATE professional_portal_tokens SET expires_at = datetime('now','-1 day') WHERE organization_id = ? AND professional_id = ?").run(A.orgId, dr.id);
  check("Token expirado é recusado", (() => { try { ClinicPortalService.agendaByToken(exp.token); return false; } catch { return true; } })());

  // ---- 7. Isolamento multi-tenant ----
  check("Gerar token para profissional de A na org B falha", (() => { try { ClinicPortalService.generateToken(B.orgId, dra.id, B.actorId); return false; } catch (e: any) { return e.message.includes("não encontrado"); } })());

  // ---- 8. CSV ----
  const csv = ClinicPortalService.agendaCsv(A.orgId, "2026-08-01");
  check("CSV tem cabeçalho", csv.split("\n")[0].startsWith("Horario,Paciente,Profissional"));
  check("CSV lista os 2 agendamentos do dia", csv.trim().split("\n").length === 3);

  // ---- 9. Auditoria ----
  const audited = db.prepare("SELECT event_type FROM auth_audit_logs WHERE organization_id = ?").all(A.orgId).map((r: any) => r.event_type);
  check("Auditoria CLINIC_PORTAL_TOKEN_ISSUED", audited.includes("CLINIC_PORTAL_TOKEN_ISSUED"));
  check("Auditoria CLINIC_PORTAL_TOKEN_REVOKED", audited.includes("CLINIC_PORTAL_TOKEN_REVOKED"));

  console.log("\n=== Módulo Clínica — Portal do Profissional + export (ADR-080, Fase D1) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
