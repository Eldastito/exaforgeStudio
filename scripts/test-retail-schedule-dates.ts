/**
 * TESTE — datas da Escala & cotas + Fechamento do dia (fuso local, não UTC).
 * ------------------------------------------------------------------------------
 * Reproduz o bug do lojista: à NOITE no Brasil (UTC-3), formatar um dia com
 * `Date.toISOString()` devolvia o DIA SEGUINTE — a Escala mostrava 24/08 como
 * domingo (era segunda) e o Fechamento abria em "amanhã". Este teste FORÇA
 * TZ=America/Sao_Paulo (o CI roda em UTC, onde o bug não aparece) e prova que os
 * helpers locais acertam.
 *
 * Uso:  npm run test:retail-schedule-dates
 */
process.env.TZ = "America/Sao_Paulo";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { isoLocal, sundayOf, addDays, todayStr } = await import("../src/features/retailDateUtils.js");

  // Sábado, 29/08/2026, 22:17 LOCAL (Brasil). Em UTC isso é 30/08 01:17 — é aí
  // que o bug nascia. (mês 7 = agosto, 0-indexed.)
  const sábadoNoite = new Date(2026, 7, 29, 22, 17, 0);

  // ===== 1. isoLocal usa a data LOCAL, não a UTC =====
  check("1.1 isoLocal à noite = dia local (29/08)", isoLocal(sábadoNoite) === "2026-08-29", isoLocal(sábadoNoite));
  check("1.2 e é DIFERENTE do que toISOString (UTC) daria (30/08)", isoLocal(sábadoNoite) !== sábadoNoite.toISOString().slice(0, 10));
  check("1.3 (sanidade) o UTC realmente vira 30/08", sábadoNoite.toISOString().slice(0, 10) === "2026-08-30");

  // ===== 2. sundayOf: domingo REAL da semana (23/08), não 24/08 =====
  const ws = sundayOf(sábadoNoite);
  check("2.1 sundayOf(sáb 29/08 noite) = domingo 23/08", ws === "2026-08-23", ws);
  check("2.2 NÃO cai no bug antigo (24/08 = segunda)", ws !== "2026-08-24");

  // ===== 3. a grade da escala (domingo→sábado) bate com o calendário =====
  const DOW = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const esperado = ["2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29"];
  check("3.1 os 7 dias da semana batem com o calendário real", JSON.stringify(days) === JSON.stringify(esperado), days.join(","));
  check("3.2 coluna DOM = 23/08 (não 24/08)", DOW[0] === "DOM" && days[0] === "2026-08-23");
  check("3.3 coluna SÁB = 29/08 (o 'hoje' do lojista)", DOW[6] === "SÁB" && days[6] === "2026-08-29");

  // ===== 4. todayStr local = o dia do lojista, não "amanhã" =====
  // (compara com uma derivação local independente, sem depender do relógio real)
  const hojeLocal = isoLocal(new Date());
  check("4.1 todayStr() == data local de hoje", todayStr() === hojeLocal, `${todayStr()} vs ${hojeLocal}`);

  // ===== 5. de manhã, local e UTC coincidem (sem regressão) =====
  const sábadoManhã = new Date(2026, 7, 29, 8, 0, 0);
  check("5.1 de manhã isoLocal = 29/08 (igual ao UTC)", isoLocal(sábadoManhã) === "2026-08-29");

  console.log("\n=== TEST: datas da Escala & Fechamento (fuso local) — TZ=America/Sao_Paulo ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
