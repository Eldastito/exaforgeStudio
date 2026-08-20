/**
 * TEST — Ficha do pet + carteira de vacinação (Petshop F3). DB-backed, det., isolado.
 * Prova (RN-004, conv. nº 12, isolamento):
 *   - create valida o TUTOR (contato) na org; não inventa dono;
 *   - idade DERIVADA de birth_date (nowISO determinístico); null sem data;
 *   - listByTutor (1 tutor → N pets); update/patch + mudança de status;
 *   - carteira de vacinação: add + list; vaccinationStatus (ok/due/overdue/no_due);
 *   - dueVaccinations detecta vencidas/a vencer (só pets ativos);
 *   - publishVaccinationReminders publica no business_signals (dedupe), idempotente;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:clinic-pet
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-pet-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-clinic-pet-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ClinicPetService: PET } = await import("../src/server/ClinicPetService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Petshop A', 'active', 'petshop')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Petshop B', 'active', 'petshop')`).run(randomUUID(), B);
  // Tutores (contatos). channel_id/identifier obrigatórios na tabela contacts.
  const tutorA = randomUUID(), tutorB = randomUUID();
  const mkContact = (org: string, id: string, name: string) =>
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', ?, ?)`).run(id, org, name, id.slice(0, 8));
  mkContact(A, tutorA, "Maria Silva"); mkContact(B, tutorB, "João (org B)");

  const NOW = "2026-08-20T12:00:00Z";

  // ═══════════════ 1. create valida tutor + idade derivada ═══════════════
  let bad = false; try { PET.create(A, { tutorContactId: "nao-existe", name: "Rex" }); } catch { bad = true; }
  check("1.1 create rejeita tutor inexistente (não inventa dono)", bad);
  let bad2 = false; try { PET.create(A, { tutorContactId: tutorA }); } catch { bad2 = true; }
  check("1.2 name é obrigatório", bad2);
  const rex = PET.create(A, { tutorContactId: tutorA, name: "Rex", species: "cachorro", breed: "Labrador", sex: "male", size: "large", weightKg: 30, birthDate: "2022-08-20" }, "u1");
  check("1.3 cria pet", !!rex.id);
  const got = PET.get(A, rex.id, NOW);
  check("1.4 idade DERIVADA (4 anos em 2026-08-20 p/ nasc 2022-08-20)", got.age && got.age.years === 4);
  check("1.5 campos preservados (espécie/raça/porte)", got.species === "cachorro" && got.breed === "Labrador" && got.size === "large");
  const semData = PET.create(A, { tutorContactId: tutorA, name: "Bidu" }, "u1");
  check("1.6 sem birth_date → idade null (não inventa)", PET.get(A, semData.id, NOW).age === null);
  let bad3 = false; try { PET.create(A, { tutorContactId: tutorA, name: "X", species: "dinossauro" as any }); } catch { bad3 = true; }
  check("1.7 species inválida rejeitada", bad3);

  // ═══════════════ 2. listByTutor + update ═══════════════
  const list = PET.listByTutor(A, tutorA);
  check("2.1 tutor tem 2 pets ativos", list.length === 2);
  PET.update(A, rex.id, { weightKg: 32, neutered: true }, "u1");
  const upd = PET.get(A, rex.id, NOW);
  check("2.2 update aplica patch (peso+castrado)", upd.weightKg === 32 && upd.neutered === true && upd.name === "Rex");
  PET.update(A, semData.id, { status: "deceased" }, "u1");
  check("2.3 status muda; some da lista ativa", PET.listByTutor(A, tutorA).length === 1 && PET.get(A, semData.id).status === "deceased");

  // ═══════════════ 3. carteira de vacinação ═══════════════
  const vaxOverdue = PET.addVaccination(A, rex.id, { vaccine: "V10", dose: "anual", appliedAt: "2025-08-01", nextDueAt: "2026-08-01" }, "u1"); // vencida em NOW
  const vaxDue = PET.addVaccination(A, rex.id, { vaccine: "Antirrábica", dose: "anual", appliedAt: "2025-09-10", nextDueAt: "2026-09-10" }, "u1"); // a vencer (20 dias)
  const vaxOk = PET.addVaccination(A, rex.id, { vaccine: "Gripe", dose: "anual", appliedAt: "2026-06-01", nextDueAt: "2027-06-01" }, "u1"); // longe
  check("3.1 carteira lista as 3 doses", PET.listVaccinations(A, rex.id).length === 3);
  check("3.2 status overdue", PET.vaccinationStatus("2026-08-01", NOW) === "overdue");
  check("3.3 status due (dentro de 30 dias)", PET.vaccinationStatus("2026-09-10", NOW) === "due");
  check("3.4 status ok (fora da janela)", PET.vaccinationStatus("2027-06-01", NOW) === "ok");
  check("3.5 status no_due (sem data)", PET.vaccinationStatus(null, NOW) === "no_due");
  let vbad = false; try { PET.addVaccination(A, rex.id, {}); } catch { vbad = true; }
  check("3.6 vaccine obrigatório", vbad);

  // ═══════════════ 4. dueVaccinations + lembretes ═══════════════
  const due = PET.dueVaccinations(A, { nowISO: NOW });
  check("4.1 detecta 2 doses (overdue + due), não a 'ok'", due.length === 2 && due.some((d) => d.vaccinationId === vaxOverdue.id) && due.some((d) => d.vaccinationId === vaxDue.id) && !due.some((d) => d.vaccinationId === vaxOk.id));
  const pub = await PET.publishVaccinationReminders(A, { nowISO: NOW });
  check("4.2 publica 2 lembretes no business_signals", pub.published === 2);
  const sig = db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=? AND domain='clinic' AND signal_type='pet_vaccination_due'`).get(A) as any;
  check("4.3 sinais gravados no ledger", sig.c === 2);
  const pub2 = await PET.publishVaccinationReminders(A, { nowISO: NOW });
  const sig2 = db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=? AND signal_type='pet_vaccination_due'`).get(A) as any;
  check("4.4 idempotente (dedupe por dose — não duplica)", sig2.c === 2);

  // ═══════════════ 5. isolamento multi-tenant ═══════════════
  let cross = false; try { PET.create(A, { tutorContactId: tutorB, name: "Invasor" }); } catch { cross = true; }
  check("5.1 não cria pet com tutor de OUTRA org", cross);
  check("5.2 pet de A não aparece em B", PET.get(B, rex.id) === null);
  const sigB = db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=? AND signal_type='pet_vaccination_due'`).get(B) as any;
  check("5.3 lembretes de A não vazam p/ B", sigB.c === 0);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} clinic-pet: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
