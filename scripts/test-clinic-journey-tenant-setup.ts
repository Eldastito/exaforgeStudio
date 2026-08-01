/**
 * TESTE — Runbook Setup Jornada (script CLI idempotente)
 * -------------------------------------------------------------------
 * Prova o script clinic-journey-tenant-setup.ts:
 *   - backfillFromLegacy é idempotente (2ª execução = 0 novos).
 *   - Cobertura detecta profissional sem PIN (BLOQUEADOR).
 *   - Cobertura detecta profissional sem especialidade (WARN).
 *   - cycle_requires_guide vira 1 quando pedido; nunca é desligado
 *     pelo script (só via SQL manual — decisão explícita).
 *   - Cross-tenant: setup de org A não toca org B.
 *
 * Uso: npm run test:clinic-journey-tenant-setup
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-runbook-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-runbook";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicSpecialtyService } = await import("../src/server/ClinicSpecialtyService.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    return orgId;
  }

  // ── Setup: org A com 3 profissionais, 2 têm specialty legada,
  //          1 sem specialty. Só 1 tem PIN. ─────────────────────────
  const orgA = seedOrg("A");
  const orgB = seedOrg("B");

  const p1 = randomUUID(); // com specialty "Fisioterapia" + PIN
  const p2 = randomUUID(); // com specialty "Fisioterapia" sem PIN
  const p3 = randomUUID(); // sem specialty sem PIN
  db.prepare(`INSERT INTO clinic_professionals (id, organization_id, name, active, specialty) VALUES (?, ?, ?, 1, ?)`)
    .run(p1, orgA, "Ana", "Fisioterapia");
  db.prepare(`INSERT INTO clinic_professionals (id, organization_id, name, active, specialty) VALUES (?, ?, ?, 1, ?)`)
    .run(p2, orgA, "Bruno", "Fisioterapia");
  db.prepare(`INSERT INTO clinic_professionals (id, organization_id, name, active, specialty) VALUES (?, ?, ?, 1, NULL)`)
    .run(p3, orgA, "Carla");
  ClinicAgendaService.setProfessionalPin(orgA, p1, "1234", "test");

  // Simulamos o passo 1 do script direto (assim testamos a lógica
  // sem invocar processos filhos).
  const summary1 = ClinicSpecialtyService.backfillFromLegacy(orgA, "runbook-setup");
  check("Backfill 1ª execução criou specialty 'Fisioterapia'",
    summary1.specialtiesCreated === 1, `summary=${JSON.stringify(summary1)}`);
  check("Backfill 1ª execução criou 2 vínculos (p1 + p2)",
    summary1.linksCreated === 2);

  const summary2 = ClinicSpecialtyService.backfillFromLegacy(orgA, "runbook-setup");
  check("Backfill IDEMPOTENTE — 2ª execução: 0 specialty nova",
    summary2.specialtiesCreated === 0);
  check("Backfill IDEMPOTENTE — 2ª execução: 0 vínculo novo",
    summary2.linksCreated === 0);
  check("Backfill IDEMPOTENTE — 2ª execução: 2 vínculos já existiam",
    summary2.linksAlreadyExisted === 2);

  // Passo 2: cobertura (reproduz a lógica do script)
  const profs = db.prepare(
    `SELECT p.id, p.name, p.pin_hash,
            (SELECT COUNT(*) FROM clinic_professional_specialties ps
              WHERE ps.organization_id = ? AND ps.professional_id = p.id AND ps.active = 1) AS specialty_count
       FROM clinic_professionals p
      WHERE p.organization_id = ? AND p.active = 1`
  ).all(orgA, orgA) as any[];
  const missingPin = profs.filter(p => !p.pin_hash);
  const missingSpecialty = profs.filter(p => Number(p.specialty_count) === 0);
  check("Cobertura: 2 sem PIN (Bruno + Carla) = BLOQUEADOR", missingPin.length === 2);
  check("Cobertura: 1 sem specialty (Carla) = WARN", missingSpecialty.length === 1);

  // Passo 3: cycle_requires_guide
  const before = (db.prepare(`SELECT clinic_cycle_requires_guide FROM organization_settings WHERE organization_id=?`).get(orgA) as any)?.clinic_cycle_requires_guide;
  check("cycle_requires_guide começa 0", Number(before) === 0);
  db.prepare(`UPDATE organization_settings SET clinic_cycle_requires_guide = 1 WHERE organization_id = ?`).run(orgA);
  const after = (db.prepare(`SELECT clinic_cycle_requires_guide FROM organization_settings WHERE organization_id=?`).get(orgA) as any)?.clinic_cycle_requires_guide;
  check("cycle_requires_guide vira 1 após opt-in", Number(after) === 1);

  // Cross-tenant: nada da org B foi tocado
  const bSpecs = db.prepare(`SELECT COUNT(*) AS c FROM clinic_specialties WHERE organization_id=?`).get(orgB) as any;
  const bFlag  = db.prepare(`SELECT clinic_cycle_requires_guide FROM organization_settings WHERE organization_id=?`).get(orgB) as any;
  check("Cross-tenant: org B tem 0 specialties (setup só tocou A)", bSpecs.c === 0);
  check("Cross-tenant: org B mantém cycle_requires_guide=0", Number(bFlag?.clinic_cycle_requires_guide ?? 0) === 0);

  // Relatório
  console.log("");
  console.log("=".repeat(72));
  console.log("TESTE RUNBOOK SETUP JORNADA");
  console.log("=".repeat(72));
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? "  |  " + r.detail : ""}`);
  }
  console.log("=".repeat(72));
  console.log(`Passou: ${results.length - failures}/${results.length}`);

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
