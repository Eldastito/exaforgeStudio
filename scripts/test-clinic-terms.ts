/**
 * TEST — Terminologia da vertical clínica (vertical Petshop F2). Função PURA.
 * Prova o mapeamento pet/tutor × paciente/responsável (RN: muda vocabulário, não
 * comportamento) e a distinção SUJEITO-do-cuidado (patient) × PESSOA-que-age (client):
 *   - petshop → Pet / Tutor;
 *   - qualquer outra vertical (saude, varejo, null) → Paciente / Paciente(client);
 *   - client ≠ patient só no petshop (Pet × Tutor); iguais na clínica humana.
 *
 * Uso: npm run test:clinic-terms
 */
import { clinicTerms } from "../src/lib/clinicTerms.js";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function main() {
  const pet = clinicTerms("petshop");
  check("1.1 petshop: sujeito = Pet", pet.patient === "Pet" && pet.patientLower === "pet" && pet.patientPlural === "Pets");
  check("1.2 petshop: pessoa que age = Tutor", pet.client === "Tutor" && pet.clientLower === "tutor");
  check("1.3 petshop: guardian = Tutor", pet.guardian === "Tutor");
  check("1.4 petshop: isPet true", pet.isPet === true);
  check("1.5 petshop: sujeito ≠ pessoa (Pet × Tutor)", pet.patient !== pet.client);

  const saude = clinicTerms("saude");
  check("2.1 saúde: sujeito = Paciente", saude.patient === "Paciente" && saude.patientLower === "paciente");
  check("2.2 saúde: pessoa que age = Paciente (mesmo termo)", saude.client === "Paciente" && saude.patient === saude.client);
  check("2.3 saúde: guardian = Responsável", saude.guardian === "Responsável");
  check("2.4 saúde: isPet false", saude.isPet === false);

  for (const v of ["varejo", "", null, undefined]) {
    const t = clinicTerms(v as any);
    check(`3.x fallback (${String(v)}) = Paciente`, t.patient === "Paciente" && t.client === "Paciente" && t.isPet === false);
  }

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} clinic-terms: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
