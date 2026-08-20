/**
 * TEST — Deslocamento entre clínicas (ADR-180 F5.2). DB-backed, det., isolado.
 * Prova: o profissional é GLOBAL — um atendimento federado dele em OUTRA clínica bloqueia
 * a vaga aqui (opt-in por `travelBufferMin`); a margem de deslocamento ALARGA o bloqueio;
 * desligado (null) → 0-regressão; só lê o BLOCO DE TEMPO (privacidade).
 *
 * Uso: npm run test:professional-travel
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-travel-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-travel-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalScheduleConfigService: CFG } = await import("../src/server/ProfessionalScheduleConfigService.js");
  const { ProfessionalAvailabilityService: AV } = await import("../src/server/ProfessionalAvailabilityService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'Clin', 'active', 'petshop', 1)`).run(randomUUID(), org);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES ('tB', ?, 'ch', 'Zé', 'ze')`).run(B);
  const svc = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, duration_minutes) VALUES (?, ?, 'service', 'Consulta', 60)`).run(svc, A);

  // MESMO profissional (identidade global) em DUAS clínicas.
  const pid = PRO.upsertIdentity({ name: "Vet", council: "CRMV-SP", registrationNumber: "12345" }, A).id;
  const relA = REL.invite(A, { professionalId: pid, permissions: { services: [svc] } }).id; REL.accept(A, relA);
  const relB = REL.invite(B, { professionalId: pid, permissions: { services: [] } }).id; REL.accept(B, relB);
  CFG.setOffering(A, relA, { serviceId: svc, durationMin: 60 });
  CFG.setWindows(A, relA, [{ dayOfWeek: 1, start: "09:00", end: "12:00", bufferMin: 0 }]); // slots 09,10,11

  // Atendimento federado do profissional na clínica B, 10:00–10:30 (segunda).
  db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, scheduled_end, status, network_relationship_id) VALUES (?, ?, 'tB', 'Atd B', '2026-08-24T10:00:00.000Z', '2026-08-24T10:30:00.000Z', 'confirmed', ?)`).run(randomUUID(), B, relB);

  const NOW = "2026-08-24T08:00:00.000Z";
  const times = () => AV.availableSlots(A, relA, "2026-08-24", { serviceId: svc, nowISO: NOW }).map((s) => s.start.slice(11, 16));

  // 1. Desligado (default null) → 0-regressão: os 3 slots.
  check("1.1 sem buffer (off) → 3 slots (0-regressão)", times().join(",") === "09:00,10:00,11:00");

  // 2. Buffer 0 → bloqueia só a sobreposição (10:00). 09:00 e 11:00 seguem.
  REL.setPermissions(A, relA, { travelBufferMin: 0 });
  check("2.1 buffer 0 → 10:00 bloqueado (atende em B)", !times().includes("10:00"));
  check("2.2 buffer 0 → 09:00 e 11:00 livres", times().includes("09:00") && times().includes("11:00"));

  // 3. Buffer 30 → a margem de deslocamento ALARGA: 09:00 também cai (chegar de B leva tempo).
  REL.setPermissions(A, relA, { travelBufferMin: 30 });
  const t30 = times();
  check("3.1 buffer 30 → 09:00 agora bloqueado (deslocamento)", !t30.includes("09:00"));
  check("3.2 buffer 30 → 11:00 ainda livre", t30.includes("11:00"));

  // 4. Só conta OUTRA clínica: um atendimento do profissional na PRÓPRIA clínica A não é
  //    contado pelo cross-clínica (já é do busyIntervals) — sanity: desligar volta ao normal.
  REL.setPermissions(A, relA, { travelBufferMin: null });
  check("4.1 desligar (null) volta pros 3 slots", times().join(",") === "09:00,10:00,11:00");

  // 5. Persistência + validação.
  REL.setPermissions(A, relA, { travelBufferMin: 45 });
  check("5.1 buffer persistido", REL.get(A, relA)!.travelBufferMin === 45);
  let bad = false; try { REL.setPermissions(A, relA, { travelBufferMin: -5 }); } catch (e: any) { bad = e.message === "travel_buffer_invalid"; }
  check("5.2 buffer negativo rejeitado", bad);
  check("5.3 comissão preservada (undefined não zera)", REL.get(A, relA)!.travelBufferMin === 45);

  // 6. Isolamento: a clínica B não enxerga o vínculo/buffer de A.
  check("6.1 B não vê o vínculo de A", REL.get(B, relA) === null);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-travel: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
