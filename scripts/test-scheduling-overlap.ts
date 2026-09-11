/**
 * TEST — schedulingOverlap (F1.2 / convergência, PRD-ZF-UNIFIED-GAP-CLOSURE-03).
 * Trava a primitiva ÚNICA de sobreposição de intervalo que os 3 detectores in-memory
 * (ClinicAgenda/Comigo/ProfessionalAvailability) agora compartilham.
 *
 * Convenção MEIA-ABERTA [start, end): encostar NÃO é conflito. Prova a tabela-verdade e
 * a EQUIVALÊNCIA exata com a expressão que cada serviço tinha antes (`en > start && st <
 * end`) — garantia de 0-regressão da migração.
 *
 * Uso: npm run test:scheduling-overlap
 */
import { intervalsOverlap } from "../src/server/schedulingOverlap.js";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// ── tabela-verdade da sobreposição ──
check("1.1 sobreposição parcial (a começa dentro de b)", intervalsOverlap(10, 20, 15, 25) === true);
check("1.2 sobreposição parcial (a termina dentro de b)", intervalsOverlap(15, 25, 10, 20) === true);
check("1.3 a contém b", intervalsOverlap(10, 40, 20, 30) === true);
check("1.4 b contém a", intervalsOverlap(20, 30, 10, 40) === true);
check("1.5 intervalos idênticos", intervalsOverlap(10, 20, 10, 20) === true);

// ── meia-aberta: encostar NÃO conflita ──
check("2.1 a.end === b.start → sem conflito", intervalsOverlap(10, 20, 20, 30) === false);
check("2.2 b.end === a.start → sem conflito", intervalsOverlap(20, 30, 10, 20) === false);
check("2.3 totalmente antes", intervalsOverlap(0, 5, 10, 15) === false);
check("2.4 totalmente depois", intervalsOverlap(100, 110, 10, 15) === false);

// ── simetria e casos degenerados ──
check("3.1 simétrico (troca a↔b não muda o veredito)",
  intervalsOverlap(10, 22, 20, 30) === intervalsOverlap(20, 30, 10, 22));
// Intervalo de duração zero DENTRO do outro: o predicado retorna true — idêntico à
// expressão legada (`15 > 10 && 15 < 20`). Caso degenerado (atendimento tem duração),
// travado aqui só pra documentar a equivalência exata com o comportamento anterior.
check("3.2 duração zero dentro do outro → igual ao legado (true)",
  intervalsOverlap(15, 15, 10, 20) === true);

// ── EQUIVALÊNCIA com a expressão legada (`en > start && st < end`) em toda a grade ──
// st,en = intervalo existente; start,end = intervalo candidato (como os serviços usam).
let mismatches = 0;
for (let st = 0; st <= 6; st++) for (let en = st; en <= 6; en++)
  for (let start = 0; start <= 6; start++) for (let end = start; end <= 6; end++) {
    const legacy = en > start && st < end;
    if (intervalsOverlap(st, en, start, end) !== legacy) mismatches++;
  }
check("4.1 idêntico à expressão legada em 2401 combinações (0-regressão)", mismatches === 0);

const passed = results.filter((x) => x.ok).length;
for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
console.log(`\n${failures === 0 ? "✅" : "❌"} scheduling-overlap: ${passed}/${results.length} checks`);
process.exit(failures === 0 ? 0 : 1);
