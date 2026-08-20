/**
 * TEST — Availability Engine + Hold atômico + confirm (ADR-180 F3). DB-backed, det.
 *
 * Coração do MVP da Agenda Federada. Prova: vagas geradas das janelas (F2) respeitando
 * duração + buffer, subtração de holds/appointments, corrida na MESMA vaga resolvida
 * atomicamente (só 1 vence — AC-012), TTL/expiração, confirm/release, isolamento
 * cross-org e recusa de vínculo não aceito. Datas fixas via nowISO (sem relógio).
 *
 * Uso: npm run test:professional-availability
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-profavail-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-profavail-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PROF } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalScheduleConfigService: CFG } = await import("../src/server/ProfessionalScheduleConfigService.js");
  const { ProfessionalAvailabilityService: AV } = await import("../src/server/ProfessionalAvailabilityService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Clínica A', 'active', 'petshop')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Clínica B', 'active', 'petshop')`).run(randomUUID(), B);
  const svc = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, duration_minutes, active) VALUES (?, ?, 'service', 'Cirurgia', 60, 1)`).run(svc, A);

  const prof = PROF.upsertIdentity({ council: "CRMV-SP", registrationNumber: "7001", name: "Dra. Cirurgiã" }, A);
  const rel = REL.invite(A, { professionalId: prof.id }, "userA");
  // 2026-08-24 é uma SEGUNDA-feira (dow=1). Config: janela seg 09:00–12:00, buffer 0.
  const DATE = "2026-08-24"; const NOW = "2026-08-20T00:00:00.000Z";
  CFG.setOffering(A, rel.id, { serviceId: svc }, "userA");
  CFG.setWindows(A, rel.id, [{ dayOfWeek: 1, start: "09:00", end: "12:00", bufferMin: 0 }], "userA");

  // 0. Vínculo pending não agenda.
  let t0 = false; try { AV.availableSlots(A, rel.id, DATE, { serviceId: svc, nowISO: NOW }); } catch { t0 = true; }
  check("0.1 vínculo pending recusa disponibilidade (não agenda)", t0);
  REL.accept(A, rel.id, "userA");

  // 1. Geração de vagas: 09-10, 10-11, 11-12 (3 slots de 60min).
  const slots = AV.availableSlots(A, rel.id, DATE, { serviceId: svc, nowISO: NOW });
  check("1.1 gera 3 vagas de 60min na janela de 3h", slots.length === 3);
  check("1.2 primeira vaga 09:00", slots[0].start === `${DATE}T09:00:00.000Z` && slots[0].durationMin === 60);
  check("1.3 vagas back-to-back sem buffer", slots[1].start === `${DATE}T10:00:00.000Z` && slots[2].start === `${DATE}T11:00:00.000Z`);

  // 1.4 buffer empurra a próxima vaga
  CFG.setWindows(A, rel.id, [{ dayOfWeek: 1, start: "09:00", end: "12:00", bufferMin: 30 }], "userA");
  const buffered = AV.availableSlots(A, rel.id, DATE, { serviceId: svc, nowISO: NOW });
  check("1.4 com buffer 30: 09-10 e 10:30-11:30 (2 vagas)", buffered.length === 2 && buffered[1].start === `${DATE}T10:30:00.000Z`);
  CFG.setWindows(A, rel.id, [{ dayOfWeek: 1, start: "09:00", end: "12:00", bufferMin: 0 }], "userA"); // volta

  // 1.5 dia sem janela → vazio; 1.6 data no passado → vazio
  check("1.5 dia sem janela (terça) → vazio", AV.availableSlots(A, rel.id, "2026-08-25", { serviceId: svc, nowISO: NOW }).length === 0);
  check("1.6 descarta vagas no passado", AV.availableSlots(A, rel.id, DATE, { serviceId: svc, nowISO: "2026-08-24T10:30:00.000Z" }).length === 1);

  // 1.7 serviço não ofertado / duração desconhecida → erro (não inventa)
  let t7 = false; try { AV.availableSlots(A, rel.id, DATE, { serviceId: "outro", nowISO: NOW }); } catch { t7 = true; }
  check("1.7 serviço não ofertado recusa (não inventa vaga)", t7);

  // 2. Hold atômico — a corrida na MESMA vaga. TTL longo p/ sobreviver ao sweep da seção 3.
  const h1 = AV.hold(A, rel.id, { serviceId: svc, startISO: `${DATE}T09:00:00.000Z`, ttlMinutes: 1440, nowISO: NOW }, "userA");
  check("2.1 hold cria reserva active com token e TTL", h1.status === "active" && !!h1.holdToken && !!h1.expiresAt);
  let raceLost = false; try { AV.hold(A, rel.id, { serviceId: svc, startISO: `${DATE}T09:00:00.000Z`, nowISO: NOW }, "userA"); } catch { raceLost = true; }
  check("2.2 2ª reserva na MESMA vaga perde (slot_taken) — atômico", raceLost);
  // sobreposição parcial também bloqueia
  let overlapLost = false; try { AV.hold(A, rel.id, { serviceId: svc, startISO: `${DATE}T09:30:00.000Z`, slotMinutes: 60, nowISO: NOW }, "userA"); } catch { overlapLost = true; }
  check("2.3 reserva sobreposta (09:30) também bloqueia", overlapLost);
  // vaga vizinha livre continua reservável
  const h2 = AV.hold(A, rel.id, { serviceId: svc, startISO: `${DATE}T10:00:00.000Z`, ttlMinutes: 1440, nowISO: NOW }, "userA");
  check("2.4 vaga vizinha (10:00) segue reservável", h2.status === "active");

  // 2.5 disponibilidade some as vagas seguradas
  const afterHold = AV.availableSlots(A, rel.id, DATE, { serviceId: svc, nowISO: NOW });
  check("2.5 disponibilidade subtrai as vagas em hold (resta 11:00)", afterHold.length === 1 && afterHold[0].start === `${DATE}T11:00:00.000Z`);

  // 2.6 fora da janela recusa
  let tWin = false; try { AV.hold(A, rel.id, { serviceId: svc, startISO: `${DATE}T13:00:00.000Z`, nowISO: NOW }, "userA"); } catch { tWin = true; }
  check("2.6 hold fora da janela recusa (não inventa vaga)", tWin);

  // 3. TTL / expiração — hold vencido não bloqueia nem confirma.
  const hTtl = AV.hold(A, rel.id, { serviceId: svc, startISO: `${DATE}T11:00:00.000Z`, ttlMinutes: 10, nowISO: NOW }, "userA");
  const afterTtlNow = "2026-08-20T00:20:00.000Z"; // 20min depois → hold de 10min expirou
  check("3.1 vaga com hold expirado reaparece na disponibilidade", AV.availableSlots(A, rel.id, DATE, { serviceId: svc, nowISO: afterTtlNow }).some((s) => s.start === `${DATE}T11:00:00.000Z`));
  let expConfirm = false; try { AV.confirm(A, hTtl.id, { nowISO: afterTtlNow }, "userA"); } catch { expConfirm = true; }
  check("3.2 confirmar hold expirado recusa", expConfirm);
  const swept = AV.sweepExpired(A, afterTtlNow);
  check("3.3 sweep marca o hold vencido como expired", swept.expired >= 1 && AV.getHold(A, hTtl.id)!.status === "expired");
  // após expirar, a vaga 11:00 pode ser re-segurada
  const hRehold = AV.hold(A, rel.id, { serviceId: svc, startISO: `${DATE}T11:00:00.000Z`, nowISO: afterTtlNow }, "userA");
  check("3.4 vaga re-segurável após expiração", hRehold.status === "active");

  // 4. Confirm trava a vaga durável (sem TTL) e não some ao passar o tempo.
  const conf = AV.confirm(A, h1.id, { nowISO: NOW }, "userA");
  check("4.1 confirm → confirmed sem expiração", conf.status === "confirmed" && conf.expiresAt === null);
  check("4.2 confirm idempotente", AV.confirm(A, h1.id, { nowISO: NOW }, "userA").status === "confirmed");
  let confRace = false; try { AV.hold(A, rel.id, { serviceId: svc, startISO: `${DATE}T09:00:00.000Z`, nowISO: NOW }, "userA"); } catch { confRace = true; }
  check("4.3 vaga confirmada bloqueia novo hold", confRace);

  // 5. Release libera a vaga.
  AV.release(A, h2.id, "userA");
  check("5.1 release → released", AV.getHold(A, h2.id)!.status === "released");
  const h2b = AV.hold(A, rel.id, { serviceId: svc, startISO: `${DATE}T10:00:00.000Z`, nowISO: NOW }, "userA");
  check("5.2 vaga liberada re-reservável", h2b.status === "active");

  // 6. Appointment do vínculo também subtrai da disponibilidade. Solta o hold de 11:00
  // antes, pra o bloqueio provar de fato a subtração do APPOINTMENT (não do hold).
  AV.release(A, hRehold.id, "userA");
  db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, scheduled_end, status, network_relationship_id) VALUES (?, ?, 'c', 'Consulta', ?, ?, 'confirmed', ?)`)
    .run(randomUUID(), A, `${DATE}T11:00:00.000Z`, `${DATE}T12:00:00.000Z`, rel.id);
  let apptRace = false; try { AV.hold(A, rel.id, { serviceId: svc, startISO: `${DATE}T11:00:00.000Z`, nowISO: NOW }, "userA"); } catch { apptRace = true; }
  check("6.1 appointment do vínculo bloqueia hold sobreposto", apptRace);

  // 7. Isolamento cross-org (RN-PN-2).
  let t8 = false; try { AV.availableSlots(B, rel.id, DATE, { serviceId: svc, nowISO: NOW }); } catch { t8 = true; }
  check("7.1 org B não lê disponibilidade do vínculo de A", t8);
  check("7.2 org B não enxerga hold de A", AV.getHold(B, h1.id) === null);
  let t9 = false; try { AV.confirm(B, hRehold.id, { nowISO: afterTtlNow }, "userB"); } catch { t9 = true; }
  check("7.3 org B não confirma hold de A", t9);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-availability: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
