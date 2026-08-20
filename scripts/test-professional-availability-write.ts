/**
 * TEST — Escrita da própria disponibilidade pelo profissional (ADR-180 F7.3). DB-backed,
 * det., isolado. Prova: o profissional define as janelas dele numa clínica dele (reusa a
 * validação do ScheduleConfig); só vínculo DELE e ACEITO; nunca edita vínculo de outro
 * profissional nem pendente.
 *
 * Uso: npm run test:professional-availability-write
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-availwrite-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-availwrite-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalScheduleConfigService: CFG } = await import("../src/server/ProfessionalScheduleConfigService.js");
  const { ProfessionalSelfService: SELF } = await import("../src/server/ProfessionalSelfService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'A', 'active', 'petshop', 1)`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'B', 'active', 'petshop', 1)`).run(randomUUID(), B);
  const pid = PRO.upsertIdentity({ name: "Dra. Vet", council: "CRMV-SP", registrationNumber: "12345" }, A).id;
  const other = PRO.upsertIdentity({ name: "Outro", council: "CRMV-SP", registrationNumber: "99999" }, A).id;
  const relA = REL.invite(A, { professionalId: pid }).id; REL.accept(A, relA);   // dele, aceito
  const relPend = REL.invite(B, { professionalId: pid }).id;                     // dele, PENDENTE
  const relOther = REL.invite(A, { professionalId: other }).id; REL.accept(A, relOther); // de outro

  // 1. O profissional define as próprias janelas na clínica A.
  const w = [{ dayOfWeek: 1, start: "09:00", end: "12:00", bufferMin: 0 }, { dayOfWeek: 3, start: "14:00", end: "18:00", bufferMin: 10 }];
  const saved = SELF.setWindows(pid, relA, w);
  check("1.1 janelas salvas (2)", Array.isArray(saved) && saved.length === 2);
  check("1.2 leitura reflete o que a clínica vê", CFG.listWindows(A, relA).length === 2);
  check("1.3 self.windows lê as próprias janelas", SELF.windows(pid, relA).length === 2);

  // 2. Reescrita (replace-all) atualiza.
  SELF.setWindows(pid, relA, [{ dayOfWeek: 5, start: "08:00", end: "10:00", bufferMin: 0 }]);
  check("2.1 replace-all deixa 1 janela", SELF.windows(pid, relA).length === 1);

  // 3. Validação herdada (dia inválido).
  let bad = false; try { SELF.setWindows(pid, relA, [{ dayOfWeek: 9, start: "08:00", end: "09:00" }]); } catch (e: any) { bad = e.message === "day_of_week_invalid"; }
  check("3.1 validação de dia herdada do ScheduleConfig", bad);

  // 4. Isolamento: não edita vínculo de OUTRO profissional.
  let e4 = false; try { SELF.setWindows(pid, relOther, w); } catch (e: any) { e4 = e.message === "relationship_not_found"; }
  check("4.1 não edita vínculo de outro profissional", e4);

  // 5. Vínculo PENDENTE do próprio profissional não aceita escrita.
  let e5 = false; try { SELF.setWindows(pid, relPend, w); } catch (e: any) { e5 = e.message === "relationship_not_accepted"; }
  check("5.1 vínculo pendente não aceita escrita", e5);

  // 6. O OUTRO profissional não mexe no vínculo do primeiro.
  let e6 = false; try { SELF.windows(other, relA); } catch (e: any) { e6 = e.message === "relationship_not_found"; }
  check("6.1 outro profissional não lê/edita o vínculo alheio", e6);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-availability-write: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
