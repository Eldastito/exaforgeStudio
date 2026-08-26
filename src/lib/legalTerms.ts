/**
 * Terminologia da vertical Advocacia (ADR-191 F2).
 *
 * A operação reusa entidades já existentes — profissional (→ advogado), especialidade
 * (→ área do direito), agenda (→ audiências) — e a vertical acrescenta o PROCESSO. Esta
 * camada é PURA (sem React/store): só RÓTULOS, para ser importável e testável em CI. O
 * componente lê a vertical via hook (`useLegalTerms`, nas views das fatias seguintes) e
 * decide o que mostrar por `isLegal` — igual `clinicTerms.isPet` gateia as abas de pet.
 *
 * Não altera NENHUM comportamento nesta fatia — só vocabulário.
 */
export interface LegalTerms {
  isLegal: boolean;
  // CLIENTE — a pessoa/empresa atendida (o contato).
  client: string;             // "Cliente"
  clientLower: string;        // "cliente"
  clientPlural: string;       // "Clientes"
  // ADVOGADO — o profissional responsável (reusa o modelo de profissional).
  professional: string;       // "Advogado"
  professionalLower: string;  // "advogado"
  professionalPlural: string; // "Advogados"
  // ÁREA DO DIREITO — a especialidade (reusa clinic_specialties).
  practiceArea: string;       // "Área do Direito"
  practiceAreaLower: string;  // "área do direito"
  practiceAreaPlural: string; // "Áreas do Direito"
  // PROCESSO — o registro longitudinal do caso (entidade nova, F4).
  case: string;               // "Processo"
  caseLower: string;          // "processo"
  casePlural: string;         // "Processos"
  // ENCERRAMENTO — fim do caso (análogo de alta/discharge da clínica).
  closure: string;            // "Encerramento"
  closureVerb: string;        // "Encerrar"
  // PRAZO / AUDIÊNCIA — rótulos operacionais das fatias F5/F6.
  deadline: string;           // "Prazo"
  deadlinePlural: string;     // "Prazos"
  hearing: string;            // "Audiência"
  hearingPlural: string;      // "Audiências"
}

export function legalTerms(vertical?: string | null): LegalTerms {
  return {
    isLegal: vertical === "advocacia",
    client: "Cliente", clientLower: "cliente", clientPlural: "Clientes",
    professional: "Advogado", professionalLower: "advogado", professionalPlural: "Advogados",
    practiceArea: "Área do Direito", practiceAreaLower: "área do direito", practiceAreaPlural: "Áreas do Direito",
    case: "Processo", caseLower: "processo", casePlural: "Processos",
    closure: "Encerramento", closureVerb: "Encerrar",
    deadline: "Prazo", deadlinePlural: "Prazos",
    hearing: "Audiência", hearingPlural: "Audiências",
  };
}

export default legalTerms;
