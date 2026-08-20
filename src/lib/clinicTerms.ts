/**
 * Terminologia da vertical clínica (ADR-179 / vertical Petshop F2).
 *
 * A operação clínica (ADR-145) é a MESMA para saúde humana e para petshop — muda só
 * o VOCABULÁRIO: "paciente" vira "pet" e "responsável" vira "tutor" quando a vertical
 * é petshop. Função PURA (sem React/store) para ser importável e testável em CI; o
 * componente usa o hook `useClinicTerms` (no arquivo da view) para ler a vertical.
 *
 * Não altera comportamento — só rótulos. LGPD/consentimento e demais fluxos seguem
 * inalterados nesta fatia.
 */
export interface ClinicTerms {
  isPet: boolean;
  // SUJEITO do cuidado (o nome no card, quem é atendido): Pet × Paciente.
  patient: string;             // "Pet" | "Paciente"
  patientLower: string;        // "pet" | "paciente"
  patientPlural: string;       // "Pets" | "Pacientes"
  patientPluralLower: string;  // "pets" | "pacientes"
  // PESSOA que agenda/confirma/recebe (o contato): no petshop é o TUTOR; na clínica
  // humana é o próprio PACIENTE. Por isso "confirmado pelo {client}" e não pelo pet.
  client: string;              // "Tutor" | "Paciente"
  clientLower: string;         // "tutor" | "paciente"
  // Responsável genérico (rótulo do contato/tutor): Tutor × Responsável.
  guardian: string;            // "Tutor" | "Responsável"
  guardianLower: string;       // "tutor" | "responsável"
}

export function clinicTerms(vertical?: string | null): ClinicTerms {
  const pet = vertical === "petshop";
  return pet
    ? { isPet: true, patient: "Pet", patientLower: "pet", patientPlural: "Pets", patientPluralLower: "pets", client: "Tutor", clientLower: "tutor", guardian: "Tutor", guardianLower: "tutor" }
    : { isPet: false, patient: "Paciente", patientLower: "paciente", patientPlural: "Pacientes", patientPluralLower: "pacientes", client: "Paciente", clientLower: "paciente", guardian: "Responsável", guardianLower: "responsável" };
}

export default clinicTerms;
