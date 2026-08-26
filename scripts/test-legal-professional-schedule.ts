/**
 * TEST — Ofertas + janelas do advogado federado (ADR-191 OAB-F2). DB-backed, det.
 * Prova a COMPOSIÇÃO sobre a ADR-180: exige o advogado FEDERADO (OAB-F1) antes de
 * configurar; ofertas de serviços jurídicos do catálogo (não inventa serviço); janelas
 * semanais (replace-all + buffer); e o isolamento por vínculo.
 *
 * Uso: npm run test:legal-professional-schedule
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-legalsched-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-legalsched-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegalProfessionalScheduleService: SCHED } = await import("../src/server/LegalProfessionalScheduleService.js");
  const { LegalProfessionalFederationService: FED } = await import("../src/server/LegalProfessionalFederationService.js");
  const { LegalPracticeService: P } = await import("../src/server/LegalPracticeService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'Silva Adv', 'active', 'advocacia', 1)`).run(randomUUID(), A);
  const oab = String(200000 + Math.floor(Math.random() * 700000));
  const lawyer = P.createLawyer(A, { name: "Dra. Ana", oabUf: "SP", oabNumber: oab }, "u1");
  const svc = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, duration_minutes, active) VALUES (?, ?, 'service', 'Consulta jurídica', 60, 1)`).run(svc, A);

  // ── 1. Sem federação → não configura (RN-PN-8/2) ──
  let e1 = false; try { SCHED.setOffering(A, lawyer.id, { serviceId: svc }, "u1"); } catch { e1 = true; }
  check("1.1 advogado não federado → configurar rejeitado", e1);
  let e2 = false; try { SCHED.setWindows(A, lawyer.id, [{ dayOfWeek: 1, start: "09:00", end: "12:00" }], "u1"); } catch { e2 = true; }
  check("1.2 janelas sem federação rejeitadas", e2);

  // federa
  FED.federate(A, lawyer.id, "u1");

  // ── 2. Oferta de serviço jurídico do catálogo (não inventa serviço) ──
  const off = SCHED.setOffering(A, lawyer.id, { serviceId: svc, durationMin: 45 }, "u1");
  check("2.1 oferta criada com override de duração", off.serviceId === svc && off.durationMin === 45 && off.durationSource === "override");
  check("2.2 listar ofertas do advogado", SCHED.listOfferings(A, lawyer.id).length === 1);
  let e3 = false; try { SCHED.setOffering(A, lawyer.id, { serviceId: randomUUID() }, "u1"); } catch { e3 = true; }
  check("2.3 serviço inexistente rejeitado (não inventa)", e3);

  // ── 3. Janelas semanais (replace-all + buffer) ──
  const w = SCHED.setWindows(A, lawyer.id, [
    { dayOfWeek: 1, start: "09:00", end: "12:00", bufferMin: 10 },
    { dayOfWeek: 3, start: "14:00", end: "18:00" },
  ], "u1");
  check("3.1 duas janelas gravadas com buffer", w.length === 2 && w[0].bufferMin === 10 && w[0].start === "09:00" && w[0].end === "12:00");
  const w2 = SCHED.setWindows(A, lawyer.id, [{ dayOfWeek: 5, start: "08:00", end: "10:00" }], "u1");
  check("3.2 replace-all substitui todas", w2.length === 1 && w2[0].dayOfWeek === 5 && SCHED.listWindows(A, lawyer.id).length === 1);
  let e4 = false; try { SCHED.setWindows(A, lawyer.id, [{ dayOfWeek: 9, start: "08:00", end: "10:00" }], "u1"); } catch { e4 = true; }
  check("3.3 dia da semana inválido rejeitado", e4);

  // ── 4. Remover oferta ──
  const rm = SCHED.removeOffering(A, lawyer.id, off.id, "u1");
  check("4.1 oferta removida", rm.removed === true && SCHED.listOfferings(A, lawyer.id).length === 0);

  // ── 5. Defederar tira a configuração de vista (vínculo revogado) ──
  FED.defederate(A, lawyer.id, "u1");
  let e5 = false; try { SCHED.listWindows(A, lawyer.id); } catch { e5 = true; }
  check("5.1 após defederar, configurar/listar exige nova federação", e5);

  // ── 6. Isolamento entre escritórios ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'Outro', 'active', 'advocacia', 1)`).run(randomUUID(), B);
  const lawyerB = P.createLawyer(B, { name: "Dra. Ana", oabUf: "SP", oabNumber: oab }, "u2");
  FED.federate(B, lawyerB.id, "u2");
  check("6.1 org B começa sem ofertas/janelas (isolado)", SCHED.listOfferings(B, lawyerB.id).length === 0 && SCHED.listWindows(B, lawyerB.id).length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legal-professional-schedule: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
