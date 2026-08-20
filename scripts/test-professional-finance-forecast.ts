/**
 * TEST — Finanças F8.2 (ADR-180): direção do split ABERTA + imposto retido + previsão.
 * DB-backed, det., isolado. Prova que o % é de UM lado combinado (professional|clinic) e
 * o outro fica com o resto; o imposto retido é opt-in e HONESTO (sem config → null); e a
 * previsão a receber agrega o agendado-não-atendido por profissional. Nunca inventa.
 *
 * Uso: npm run test:professional-finance-forecast
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-proffc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-proffc-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalScheduleConfigService: CFG } = await import("../src/server/ProfessionalScheduleConfigService.js");
  const { ProfessionalBookingService: BOOK } = await import("../src/server/ProfessionalBookingService.js");
  const { ProfessionalFinanceService: FIN } = await import("../src/server/ProfessionalFinanceService.js");
  const { ClinicAgendaService: AG } = await import("../src/server/ClinicAgendaService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'Clin', 'active', 'petshop', 1)`).run(randomUUID(), org);
  const tutor = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Ana', 'ana')`).run(tutor, A);
  const svc = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, duration_minutes) VALUES (?, ?, 'service', 'Cirurgia', 200, 60)`).run(svc, A);

  const NOW = "2026-08-21T08:00:00.000Z";
  function setup(pct: number | null, beneficiary: any, tax: number | null, reg: string) {
    const prof = PRO.upsertIdentity({ name: `Dr ${reg}`, council: "CRMV-SP", registrationNumber: reg }, A).id;
    const rel = REL.invite(A, { professionalId: prof, permissions: { services: [svc], commissionPercent: pct, commissionBeneficiary: beneficiary, taxWithholdingPercent: tax } }).id;
    REL.accept(A, rel);
    CFG.setOffering(A, rel, { serviceId: svc, durationMin: 60 });
    return rel;
  }
  function book(rel: string, startISO: string) {
    CFG.setWindows(A, rel, [{ dayOfWeek: 1, start: "08:00", end: "18:00", bufferMin: 0 }]);
    const h = BOOK.holdSlot(A, rel, { serviceId: svc, startISO, nowISO: NOW });
    return BOOK.confirmBooking(A, { holdId: h.id, contactId: tutor, nowISO: NOW });
  }

  // 1. Beneficiário = profissional (default F8.1): 30% → prof 60, clínica 140.
  const relP = setup(30, "professional", null, "1001");
  const apptP = book(relP, "2026-08-24T09:00:00.000Z");
  const sP = FIN.settlement(A, apptP.id);
  check("1.1 % do profissional → prof 60 / clínica 140", sP.professionalAmount === 60 && sP.clinicAmount === 140);
  check("1.2 beneficiário exposto", sP.commissionBeneficiary === "professional");
  check("1.3 sem imposto → taxAmount null, líquido = bruto", sP.taxAmount === null && sP.netProfessional === 60);

  // 2. Beneficiário = clínica: 30% → clínica 60, prof 140 (direção invertida, o combinado).
  const relC = setup(30, "clinic", null, "1002");
  const apptC = book(relC, "2026-08-24T10:00:00.000Z");
  const sC = FIN.settlement(A, apptC.id);
  check("2.1 % da clínica → clínica 60 / prof 140", sC.clinicAmount === 60 && sC.professionalAmount === 140);
  check("2.2 sempre mostra os DOIS lados", sC.professionalAmount !== null && sC.clinicAmount !== null);

  // 3. Imposto retido (opt-in): prof bruto 140, retenção 10% → retido 14, líquido 126.
  const relT = setup(30, "clinic", 10, "1003");
  const apptT = book(relT, "2026-08-24T11:00:00.000Z");
  const sT = FIN.settlement(A, apptT.id);
  check("3.1 imposto retido = 14 (10% de 140)", sT.taxAmount === 14);
  check("3.2 líquido do profissional = 126 (140 − 14)", sT.netProfessional === 126);
  check("3.3 taxWithholdingPercent exposto", sT.taxWithholdingPercent === 10);

  // 4. Previsão a receber: relT tem 1 agendado (não atendido) → entra; relP atende → sai.
  AG.complete(A, apptP.id); // apptP vira realizado → NÃO conta na previsão
  const fc = FIN.forecast(A);
  const rowT = fc.byProfessional.find((r: any) => r.relationshipId === relT);
  const rowP = fc.byProfessional.find((r: any) => r.relationshipId === relP);
  check("4.1 profissional atendido sai da previsão", !rowP);
  check("4.2 agendado-não-atendido entra na previsão", !!rowT && rowT!.expected.count === 1);
  check("4.3 previsão traz líquido (com imposto) 126", rowT!.expected.netProfessional === 126);
  check("4.4 'quando': data do 1º atendimento previsto", rowT!.nextServiceDate === "2026-08-24T11:00:00.000Z");
  check("4.5 total líquido previsto somado", typeof fc.totalNetProfessional === "number" && fc.totalNetProfessional! >= 126);
  check("4.6 previsão ordenada por data mais próxima", fc.byProfessional.every((r: any, i: number, a: any[]) => i === 0 || String(a[i - 1].nextServiceDate) <= String(r.nextServiceDate)));

  // 5. setPermissions altera direção/imposto; undefined preserva.
  REL.setPermissions(A, relP, { taxWithholdingPercent: 20 });
  const relPnow = REL.get(A, relP)!;
  check("5.1 imposto atualizado", relPnow.taxWithholdingPercent === 20);
  check("5.2 beneficiário preservado (undefined não zera)", relPnow.commissionBeneficiary === "professional");
  REL.setPermissions(A, relP, { commissionBeneficiary: "clinic" });
  check("5.3 direção atualizada", REL.get(A, relP)!.commissionBeneficiary === "clinic");
  check("5.4 imposto preservado (undefined não zera)", REL.get(A, relP)!.taxWithholdingPercent === 20);

  // 6. Validação: percentual fora de faixa e beneficiário inválido lançam.
  let e1 = false; try { REL.setPermissions(A, relP, { commissionPercent: 150 }); } catch { e1 = true; }
  check("6.1 percentual > 100 rejeitado", e1);
  let e2 = false; try { REL.setPermissions(A, relP, { taxWithholdingPercent: -5 }); } catch { e2 = true; }
  check("6.2 percentual negativo rejeitado", e2);
  let e3 = false; try { REL.invite(A, { professionalId: PRO.upsertIdentity({ name: "X", council: "CRMV-SP", registrationNumber: "1009" }, A).id, permissions: { commissionBeneficiary: "banco" as any } }); } catch { e3 = true; }
  check("6.3 beneficiário inválido rejeitado", e3);

  // 7. Honestidade da previsão: sem comissão → split null mas gross conta; sem preço → missingPrice.
  const relN = setup(null, "professional", null, "1004"); // sem comissão
  book(relN, "2026-08-24T14:00:00.000Z");
  const fcN = FIN.forecast(A).byProfessional.find((r: any) => r.relationshipId === relN)!;
  check("7.1 sem comissão → prof null mas gross presente", fcN.expected.professionalAmount === null && fcN.expected.gross === 200);

  // 8. Isolamento (RN-PN-2): B não vê a previsão de A.
  check("8.1 previsão de B vazia (isolada)", FIN.forecast(B).byProfessional.length === 0);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-finance-forecast: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
