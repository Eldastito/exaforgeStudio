/**
 * TEST — Push do atendimento federado pra agenda Google do profissional (ADR-180 F6.3).
 * DB-backed, det., SEM rede (fetch injetado). Prova: confirmar → cria evento e guarda o
 * id (idempotente); cancelar → remove o evento e limpa o vínculo; sem conexão → no-op
 * (0-regressão); falha no Google nunca derruba o agendamento.
 *
 * Uso: npm run test:professional-google-sync
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-gsync-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-gsync-123456";
process.env.GOOGLE_CLIENT_ID = "cid.test"; process.env.GOOGLE_CLIENT_SECRET = "csecret.test"; process.env.APP_URL = "https://app.test";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const calls = { created: 0, deleted: 0 };
function makeFetch(): typeof fetch {
  return (async (url: any, init?: any): Promise<any> => {
    const u = String(url);
    const json = (o: any, ok = true, status = 200) => ({ ok, status, json: async () => o });
    if (u.includes("oauth2.googleapis.com/token")) {
      if (String(init?.body || "").includes("grant_type=refresh_token")) return json({ access_token: "acc-r", expires_in: 3600 });
      return json({ access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 });
    }
    if (u.includes("oauth2/v3/userinfo")) return json({ email: "vet@ex.com", name: "Vet" });
    if (u.includes("/events/")) { calls.deleted++; return json({}, true, 200); }   // DELETE por id
    if (u.includes("/events")) { calls.created++; return json({ id: `evt-${calls.created}`, htmlLink: "http://ev" }); } // POST create
    return json({}, false, 404);
  }) as any;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalScheduleConfigService: CFG } = await import("../src/server/ProfessionalScheduleConfigService.js");
  const { ProfessionalBookingService: BOOK } = await import("../src/server/ProfessionalBookingService.js");
  const { ProfessionalGoogleService: G } = await import("../src/server/ProfessionalGoogleService.js");
  G.deps.fetchFn = makeFetch();

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'Clin', 'active', 'petshop', 1)`).run(randomUUID(), A);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Ana', 'ana')`).run("tutorA", A);
  const svc = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, duration_minutes) VALUES (?, ?, 'service', 'Consulta', 100, 60)`).run(svc, A);
  const pid = PRO.upsertIdentity({ name: "Vet", council: "CRMV-SP", registrationNumber: "12345" }, A).id;
  const rel = REL.invite(A, { professionalId: pid, permissions: { services: [svc] } }).id;
  REL.accept(A, rel);
  CFG.setOffering(A, rel, { serviceId: svc, durationMin: 60 });
  CFG.setWindows(A, rel, [{ dayOfWeek: 1, start: "09:00", end: "12:00", bufferMin: 0 }]);
  const NOW = "2026-08-24T08:00:00.000Z";
  const evOf = (apptId: string) => (db.prepare(`SELECT network_google_event_id AS ev FROM appointments WHERE id = ?`).get(apptId) as any)?.ev ?? null;

  // 1. Profissional NÃO conectado → push é no-op (0-regressão).
  const h0 = BOOK.holdSlot(A, rel, { serviceId: svc, startISO: "2026-08-24T09:00:00.000Z", nowISO: NOW });
  const ap0 = BOOK.confirmBooking(A, { holdId: h0.id, contactId: "tutorA", nowISO: NOW });
  await BOOK.pushToGoogle(A, ap0.id);
  check("1.1 sem conexão → nenhum evento criado", calls.created === 0 && evOf(ap0.id) === null);

  // 2. Conecta o Google e confirma outro → push cria o evento e guarda o id.
  const state = new URL(G.authUrl(pid, A)).searchParams.get("state") || "";
  await G.handleCallback("code", state);
  const h1 = BOOK.holdSlot(A, rel, { serviceId: svc, startISO: "2026-08-24T10:00:00.000Z", nowISO: NOW });
  const ap1 = BOOK.confirmBooking(A, { holdId: h1.id, contactId: "tutorA", nowISO: NOW });
  await BOOK.pushToGoogle(A, ap1.id);
  check("2.1 conectado → evento criado", calls.created === 1);
  check("2.2 id do evento guardado no appointment", evOf(ap1.id) === "evt-1");

  // 3. Idempotente: 2º push não duplica.
  await BOOK.pushToGoogle(A, ap1.id);
  check("3.1 2º push não cria outro evento (idempotente)", calls.created === 1);

  // 4. Cancelar → remove o evento do Google, limpa o vínculo e marca cancelled.
  const before = calls.deleted;
  const cancelled = await BOOK.cancelBooking(A, ap1.id, "userA");
  check("4.1 evento removido do Google", calls.deleted === before + 1);
  check("4.2 vínculo do evento limpo", evOf(ap1.id) === null);
  check("4.3 status cancelado (preserva histórico)", cancelled.status === "cancelled");

  // 5. Cancelar de novo é idempotente (não remove duas vezes).
  const del2 = calls.deleted;
  await BOOK.cancelBooking(A, ap1.id, "userA");
  check("5.1 cancelar de novo não re-remove", calls.deleted === del2);

  // 6. Isolamento/robustez: appointment inexistente → erro claro (não inventa).
  let e6 = false; try { await BOOK.cancelBooking(A, "nao-existe", "userA"); } catch (e: any) { e6 = e.message === "appointment_not_found"; }
  check("6.1 cancelar inexistente → appointment_not_found", e6);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-google-sync: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
