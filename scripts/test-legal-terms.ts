/**
 * TEST — Terminologia da vertical Advocacia (ADR-191 F2). Função PURA.
 * Prova o vocabulário jurídico (cliente/advogado/área do direito/processo/encerramento/
 * prazo/audiência) e o gate `isLegal` (só `advocacia` ativa as features legais nas views,
 * como `clinicTerms.isPet` gateia as abas de pet). Muda rótulo, não comportamento.
 *
 * Uso: npm run test:legal-terms
 */
import { legalTerms } from "../src/lib/legalTerms.js";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function main() {
  const adv = legalTerms("advocacia");
  check("1.1 isLegal true na advocacia", adv.isLegal === true);
  check("1.2 cliente", adv.client === "Cliente" && adv.clientLower === "cliente" && adv.clientPlural === "Clientes");
  check("1.3 advogado", adv.professional === "Advogado" && adv.professionalPlural === "Advogados");
  check("1.4 área do direito (especialidade)", adv.practiceArea === "Área do Direito" && adv.practiceAreaPlural === "Áreas do Direito");
  check("1.5 processo (registro longitudinal)", adv.case === "Processo" && adv.casePlural === "Processos");
  check("1.6 encerramento (análogo de alta)", adv.closure === "Encerramento" && adv.closureVerb === "Encerrar");
  check("1.7 prazo + audiência (operacional F5/F6)", adv.deadline === "Prazo" && adv.hearing === "Audiência");

  // Fallback: qualquer outra vertical → isLegal false (features legais não aparecem).
  for (const v of ["saude", "petshop", "varejo", "", null, undefined]) {
    const t = legalTerms(v as any);
    check(`2.x isLegal false fora da advocacia (${String(v)})`, t.isLegal === false);
  }
  // Os rótulos existem mesmo fora da advocacia (função pura), mas o gate isLegal
  // é o que decide se a UI legal aparece — igual clinicTerms.isPet.
  check("3.1 rótulos presentes independem da vertical (gate é isLegal)", legalTerms("saude").case === "Processo");

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legal-terms: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
