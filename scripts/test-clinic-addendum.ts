/**
 * TESTE — Módulo Clínica Fatia 20: Addendum ao prontuário assinado
 * (ADR-080 extensão 2026-07 · CFM 1.821/2007).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - Encounter `draft` NÃO aceita addendum (fluxo é `update`); só `signed`.
 *   - Addendum é APPEND-ONLY (várias rows por encounter, autoria própria).
 *   - LGPD Art.11: sem consent ativo, addAddendum e listAddendums falham
 *     com LGPD_CONSENT_REQUIRED; revoke bloqueia leitura imediata.
 *   - PIN OPCIONAL (reusa Fase T): profissional SEM PIN cadastrado assina
 *     sem PIN (compat legado, signed_with_pin=false); profissional COM PIN
 *     exige — PIN_REQUIRED sem PIN, PIN_INVALID com PIN errado, ok com PIN
 *     certo (signed_with_pin=true).
 *   - Nota vazia rejeitada (ADDENDUM_EMPTY), nota longa rejeitada
 *     (ADDENDUM_TOO_LONG).
 *   - Listagem ordenada por created_at DESC.
 *   - Encounter inexistente na listagem devolve `[]` sem gatear consent
 *     (mesma semântica do history da Fase 19 — nada a esconder).
 *   - Isolamento multi-tenant (org B não vê nem adiciona addendum em
 *     encounter da org A).
 *   - Auditoria CLINIC_ENCOUNTER_ADDENDUM_ADDED com metadata correto.
 *
 * Uso:  npm run test:clinic-addendum
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-addendum-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-addendum-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicEncounterService } = await import("../src/server/ClinicEncounterService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkContact = (n: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, n, `55${tag}${Math.floor(Math.random() * 1e8)}`);
      return id;
    };
    return { orgId, actorId: `user_${tag}`, patient: mkContact("Paciente") };
  }

  function openSignedEncounter(seed: { orgId: string; actorId: string; patient: string }, profId: string, startISO: string) {
    LgpdService.grantConsent(seed.orgId, seed.patient, "dados_sensiveis", { channel: "in_person", actorId: seed.actorId });
    const apt = ClinicAgendaService.createAppointment(seed.orgId, {
      contactId: seed.patient,
      title: "Consulta",
      scheduledStart: startISO,
      professionalId: profId,
      durationMinutes: 30,
    }, seed.actorId);
    const enc = ClinicEncounterService.open(seed.orgId, apt.id, seed.actorId);
    ClinicEncounterService.update(seed.orgId, enc.id, seed.actorId, { subjective: "s", plan: "p" });
    return ClinicEncounterService.finalize(seed.orgId, enc.id, seed.actorId);
  }

  const A = seedOrg("A");
  const draA = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Ana" }, A.actorId);
  const enc = openSignedEncounter(A, draA.id, "2026-09-01T09:00:00-03:00");
  check("encounter começa signed", enc.status === "signed");

  // ── 1. Draft NÃO aceita addendum ─────────────────────────────────────────
  const draftApt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient,
    title: "Draft",
    scheduledStart: "2026-09-02T09:00:00-03:00",
    professionalId: draA.id,
    durationMinutes: 30,
  }, A.actorId);
  const draftEnc = ClinicEncounterService.open(A.orgId, draftApt.id, A.actorId);
  let threwDraft: any = null;
  try { ClinicEncounterService.addAddendum(A.orgId, draftEnc.id, A.actorId, { note: "x" }); } catch (e) { threwDraft = e; }
  check("addendum em encounter draft → ENCOUNTER_NOT_SIGNED", threwDraft?.code === "ENCOUNTER_NOT_SIGNED", String(threwDraft?.code));

  // ── 2. Signed aceita, APPEND-ONLY ────────────────────────────────────────
  const a1 = ClinicEncounterService.addAddendum(A.orgId, enc.id, A.actorId, { note: "Resultado exame chegou: normal.", actorName: "Dra. Ana" });
  check("addendum criado tem id", !!a1.id);
  check("addendum note preservada", a1.note.includes("Resultado exame"));
  check("author snapshot preenchido", a1.authorNameSnapshot === "Dra. Ana");
  check("signedWithPin=false (profissional sem PIN)", a1.signedWithPin === false);

  const a2 = ClinicEncounterService.addAddendum(A.orgId, enc.id, A.actorId, { note: "Paciente evoluiu bem no retorno." });
  check("segundo addendum criado (append-only)", a2.id !== a1.id);

  const list = ClinicEncounterService.listAddendums(A.orgId, enc.id);
  check("listAddendums retorna 2", list.length === 2, String(list.length));
  check("ordenado DESC (mais recente primeiro)", list[0].id === a2.id && list[1].id === a1.id);

  // ── 3. Validação de nota ─────────────────────────────────────────────────
  let threwEmpty: any = null;
  try { ClinicEncounterService.addAddendum(A.orgId, enc.id, A.actorId, { note: "   " }); } catch (e) { threwEmpty = e; }
  check("nota vazia → ADDENDUM_EMPTY", threwEmpty?.code === "ADDENDUM_EMPTY");

  let threwLong: any = null;
  try { ClinicEncounterService.addAddendum(A.orgId, enc.id, A.actorId, { note: "x".repeat(4001) }); } catch (e) { threwLong = e; }
  check("nota >4000 → ADDENDUM_TOO_LONG", threwLong?.code === "ADDENDUM_TOO_LONG");

  const shouldStillBe2 = ClinicEncounterService.listAddendums(A.orgId, enc.id);
  check("rejeições NÃO adicionaram row", shouldStillBe2.length === 2);

  // ── 4. LGPD gate ─────────────────────────────────────────────────────────
  LgpdService.revokeConsent(A.orgId, A.patient, "dados_sensiveis", A.actorId);
  let threwLgpdWrite: any = null;
  try { ClinicEncounterService.addAddendum(A.orgId, enc.id, A.actorId, { note: "novo" }); } catch (e) { threwLgpdWrite = e; }
  check("addAddendum após revoke → LGPD_CONSENT_REQUIRED", threwLgpdWrite?.code === "LGPD_CONSENT_REQUIRED");

  let threwLgpdRead: any = null;
  try { ClinicEncounterService.listAddendums(A.orgId, enc.id); } catch (e) { threwLgpdRead = e; }
  check("listAddendums após revoke → LGPD_CONSENT_REQUIRED", threwLgpdRead?.code === "LGPD_CONSENT_REQUIRED");

  // Re-grant restaura
  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { channel: "in_person", actorId: A.actorId });
  check("re-grant restaura leitura", ClinicEncounterService.listAddendums(A.orgId, enc.id).length === 2);

  // Encounter inexistente devolve [] SEM gatear consent
  const fakeId = randomUUID();
  check("encounter inexistente devolve [] (não gata)", ClinicEncounterService.listAddendums(A.orgId, fakeId).length === 0);

  // ── 5. PIN opcional ──────────────────────────────────────────────────────
  const drPin = ClinicAgendaService.createProfessional(A.orgId, { name: "Dr. PIN" }, A.actorId);
  ClinicAgendaService.setProfessionalPin(A.orgId, drPin.id, "4242", A.actorId);
  const encPin = openSignedEncounter({ ...A, patient: A.patient }, drPin.id, "2026-09-05T10:00:00-03:00");

  let threwPinReq: any = null;
  try { ClinicEncounterService.addAddendum(A.orgId, encPin.id, A.actorId, { note: "sem pin" }); } catch (e) { threwPinReq = e; }
  check("profissional com PIN sem PIN fornecido → PIN_REQUIRED", threwPinReq?.code === "PIN_REQUIRED", String(threwPinReq?.code));

  let threwPinBad: any = null;
  try { ClinicEncounterService.addAddendum(A.orgId, encPin.id, A.actorId, { note: "pin errado", pin: "0000" }); } catch (e) { threwPinBad = e; }
  check("PIN errado → PIN_INVALID", threwPinBad?.code === "PIN_INVALID");

  const aPin = ClinicEncounterService.addAddendum(A.orgId, encPin.id, A.actorId, { note: "com pin ok", pin: "4242" });
  check("PIN certo → addendum criado com signedWithPin=true", aPin.signedWithPin === true);

  // ── 6. Isolamento multi-tenant ───────────────────────────────────────────
  const B = seedOrg("B");
  check("org B não vê addendums de A", ClinicEncounterService.listAddendums(B.orgId, enc.id).length === 0);
  let threwCross: any = null;
  try { ClinicEncounterService.addAddendum(B.orgId, enc.id, B.actorId, { note: "invadindo" }); } catch (e) { threwCross = e; }
  check("org B tentando addendum em encounter de A → Prontuário não encontrado", threwCross?.message?.includes("não encontrado"));
  check("addendums de A intocados", ClinicEncounterService.listAddendums(A.orgId, enc.id).length === 2);

  // ── 7. Auditoria ─────────────────────────────────────────────────────────
  const audits = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_ENCOUNTER_ADDENDUM_ADDED'`
  ).get(A.orgId) as any;
  check("auditoria CLINIC_ENCOUNTER_ADDENDUM_ADDED = 3 (2 sem PIN + 1 com PIN)", Number(audits?.c) === 3, String(audits?.c));

  const auditMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_ENCOUNTER_ADDENDUM_ADDED'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get(A.orgId) as any;
  const meta = JSON.parse(auditMeta.metadata_json || "{}");
  check("audit metadata carrega encounterId", meta.encounterId === enc.id);
  check("audit metadata carrega addendumId", meta.addendumId === a1.id);
  check("audit metadata carrega signedWithPin=false pro primeiro", meta.signedWithPin === false);
  check("audit metadata carrega length correto", meta.length === a1.note.length);

  console.log("\n=== Addendum ao prontuário (ADR-080 Fase 20) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
