/**
 * TEST — Serviços ofertados + janelas de disponibilidade (ADR-180 F2). DB-backed, det.
 *
 * Prova a config do vínculo que o Availability Engine (F3) vai consumir: serviços
 * ofertados (com override de duração e fallback pro catálogo), janelas semanais
 * validadas, isolamento cross-org (RN-PN-2), recusa de vínculo revogado e de serviço
 * fora do catálogo (não inventa).
 *
 * Uso: npm run test:professional-schedule-config
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-profcfg-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-profcfg-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PROF } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalScheduleConfigService: CFG } = await import("../src/server/ProfessionalScheduleConfigService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Clínica A', 'active', 'petshop')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Clínica B', 'active', 'petshop')`).run(randomUUID(), B);

  // Catálogo: serviço com duração no catálogo, serviço sem duração, e serviço da org B.
  const svcCatDur = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, duration_minutes, active) VALUES (?, ?, 'service', 'Cirurgia de aves', 90, 1)`).run(svcCatDur, A);
  const svcNoDur = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, active) VALUES (?, ?, 'service', 'Avaliação', 1)`).run(svcNoDur, A);
  const svcB = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, duration_minutes, active) VALUES (?, ?, 'service', 'Consulta B', 30, 1)`).run(svcB, B);

  const prof = PROF.upsertIdentity({ council: "CRMV-SP", registrationNumber: "9001", name: "Dr. Aves" }, A);
  const relA = REL.invite(A, { professionalId: prof.id }, "userA");
  REL.accept(A, relA.id, "userA");

  // 1. Ofertas — duração override × catálogo × desconhecida.
  const o1 = CFG.setOffering(A, relA.id, { serviceId: svcCatDur }, "userA");
  check("1.1 oferta usa duração do catálogo quando sem override", o1.durationMin === 90 && o1.durationSource === "catalog");
  const o1b = CFG.setOffering(A, relA.id, { serviceId: svcCatDur, durationMin: 120 }, "userA");
  check("1.2 override de duração prevalece", o1b.durationMin === 120 && o1b.durationSource === "override");
  check("1.3 upsert idempotente por (org,rel,service)", o1b.id === o1.id);
  const o2 = CFG.setOffering(A, relA.id, { serviceId: svcNoDur }, "userA");
  check("1.4 sem override e sem catálogo → duração null (não inventa)", o2.durationMin === null && o2.durationSource === "unknown");
  check("1.5 lista traz as ofertas ativas", CFG.listOfferings(A, relA.id).length === 2);

  // 2. Validações — serviço fora do catálogo, duração inválida.
  let t1 = false; try { CFG.setOffering(A, relA.id, { serviceId: "nao-existe" }, "userA"); } catch { t1 = true; }
  check("2.1 recusa serviço fora do catálogo (não inventa)", t1);
  let t2 = false; try { CFG.setOffering(A, relA.id, { serviceId: svcCatDur, durationMin: 0 }, "userA"); } catch { t2 = true; }
  check("2.2 recusa duração <= 0", t2);
  let t3 = false; try { CFG.setOffering(A, relA.id, { serviceId: svcB }, "userA"); } catch { t3 = true; }
  check("2.3 recusa serviço de OUTRA org (isolamento do catálogo)", t3);

  // 3. Janelas — validação + replace-all + ordenação.
  const w = CFG.setWindows(A, relA.id, [
    { dayOfWeek: 3, start: "14:00", end: "18:00", bufferMin: 10 },
    { dayOfWeek: 1, start: "08:00", end: "12:00" },
  ], "userA");
  check("3.1 grava 2 janelas", w.length === 2);
  check("3.2 ordena por dia depois hora", w[0].dayOfWeek === 1 && w[1].dayOfWeek === 3);
  check("3.3 converte HH:MM → minutos", w[0].startMinute === 480 && w[0].endMinute === 720);
  check("3.4 buffer default 0 quando ausente", w[0].bufferMin === 0 && w[1].bufferMin === 10);
  // replace-all
  const w2 = CFG.setWindows(A, relA.id, [{ dayOfWeek: 5, start: "09:00", end: "13:00" }], "userA");
  check("3.5 replace-all substitui as janelas", w2.length === 1 && w2[0].dayOfWeek === 5);

  // 3.6-3.9 validações de janela
  const bad = [
    { dayOfWeek: 7, start: "08:00", end: "10:00" },       // dia inválido
    { dayOfWeek: 2, start: "10:00", end: "09:00" },       // start >= end
    { dayOfWeek: 2, start: "abc", end: "10:00" },         // hora inválida
    { dayOfWeek: 2, start: "08:00", end: "10:00", bufferMin: -5 }, // buffer negativo
  ];
  let badCount = 0;
  for (const b of bad) { try { CFG.setWindows(A, relA.id, [b as any], "userA"); } catch { badCount++; } }
  check("3.6 recusa janelas inválidas (dia/ordem/hora/buffer)", badCount === 4);
  check("3.7 janelas válidas intactas após falhas (replace-all atômico não parcial)", CFG.listWindows(A, relA.id).length === 1);

  // 4. Isolamento cross-org (RN-PN-2).
  let t4 = false; try { CFG.listOfferings(B, relA.id); } catch { t4 = true; }
  check("4.1 org B não lê config de vínculo de A", t4);
  let t5 = false; try { CFG.setWindows(B, relA.id, [{ dayOfWeek: 1, start: "08:00", end: "09:00" }], "userB"); } catch { t5 = true; }
  check("4.2 org B não escreve janelas no vínculo de A", t5);
  check("4.3 org B não apaga oferta de A", CFG.removeOffering(B, o1.id).removed === false);
  check("4.4 oferta de A intacta após tentativa de B", CFG.getOffering(A, o1.id) !== null);

  // 5. Vínculo revogado não aceita config.
  REL.revoke(A, relA.id, "userA");
  let t6 = false; try { CFG.setOffering(A, relA.id, { serviceId: svcCatDur }, "userA"); } catch { t6 = true; }
  check("5.1 vínculo revogado recusa nova config", t6);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-schedule-config: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
