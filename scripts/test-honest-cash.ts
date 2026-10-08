/**
 * TESTE — "Caixa honesto" (01/10/2026, prints da TOULON).
 * Achados: com "Faturamento no Diretor" LIGADO, todo fechamento aprovado vira ENTRADA no livro-caixa ("Venda da loja (fechamento diário)") e
 * ninguém lança saída → o "Caixa atual" (R$ 1.435.378,92) era só a soma de toda a venda da história, não dinheiro em conta; o Tutor mandava
 * isso como "Caixa", os "dias de caixa" e a projeção de 13 semanas ("sem ruptura") partiam dele, e a tela Caixa mostrava sem milhar.
 * Também: a "Conferência da semana" mostrava R$ 0,00 para fechamento que existe mas ainda não tem valor informado.
 * Prova: `cashBasis` (caixa/vendas/entradas) + soma das entradas, Tutor (manhã/noite) e Central de Saúde com o rótulo honesto, sem "dias de
 * caixa" inventados, helpers das telas (rótulo/valor/nota; célula da semana), isolamento.
 * Uso:  npm run test:honest-cash
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-honest-cash-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-honest-cash-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const { FinancialLedgerService: L } = await import("../src/server/FinancialLedgerService.js");
  const { BusinessTutorService: T } = await import("../src/server/BusinessTutorService.js");
  const { BusinessHealthService: H } = await import("../src/server/BusinessHealthService.js");
  const { cashHeadline, cashBasisOf } = await import("../src/features/cashBasis.js");
  const { weekCellValue } = await import("../src/features/retailWeekCell.js");

  const org = (tag: string) => { const id = `org_${tag}_${randomUUID().slice(0, 6)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const ev = (o: string, direction: "in" | "out", amount: number, sourceType: string, eventDate?: string) => L.recordEvent(o, { direction, amount, sourceType, sourceId: randomUUID(), eventDate } as any);
  const morning = (o: string) => (T.morningBrief(o).text.split("\n").find((l) => l.startsWith("💰")) || "");

  // ── (1) cashBasis ──
  const A = org("A");                                           // nada lançado
  check("sem nenhum lançamento: basis 'caixa' (não há o que desconfiar)", L.tracking(A).cashBasis === "caixa");
  const B = org("B"); ev(B, "in", 919.4, "retail_closing"); ev(B, "in", 3876.22, "retail_closing"); ev(B, "in", 180, "retail_closing");
  const trB = L.tracking(B);
  check("só entradas de fechamento (a ponte ligada) e NENHUMA saída: basis 'vendas'", trB.cashBasis === "vendas" && trB.outflows === false, JSON.stringify(trB));
  check("entradasRegistradas = soma do que entrou (4.975,62), independente de saldo inicial", L.entradasRegistradas(B) === 4975.62, String(L.entradasRegistradas(B)));
  const C = org("C"); ev(C, "in", 500, "manual");
  check("só entradas, de origem manual: basis 'entradas'", L.tracking(C).cashBasis === "entradas");
  const D = org("D"); ev(D, "in", 1000, "retail_closing"); ev(D, "out", 300, "payable");
  check("há saída lançada: volta a ser 'caixa' (saldo confiável)", L.tracking(D).cashBasis === "caixa" && L.tracking(D).outflows === true);
  check("isolamento: as saídas da org D não 'curam' a org B", L.tracking(B).cashBasis === "vendas" && L.entradasRegistradas(B) === 4975.62);

  // ── (2) Tutor ──
  const mB = morning(B);
  const spToday = (await import("../src/server/FalaTuBriefingDigestService.js")).FalaTuBriefingDigestService.spParts(new Date()).dateSP;
  for (const o of [B, C]) db.prepare("UPDATE cash_events SET event_date = ? WHERE organization_id = ?").run(spToday, o);   // data do lançamento = hoje em Brasília (o default do ledger é UTC)
  const mB2 = morning(B);
  check("manhã (vendas, sem saída): mostra o ACUMULADO do mês e da semana (não o total desde sempre) — 'Vendas registradas no mês R$ 4.975,62 · na semana R$ 4.975,62 (sem saídas lançadas)', NÃO 'Caixa'", /Vendas registradas no mês R\$ 4\.975,62 · na semana R\$ 4\.975,62 \(sem saídas lançadas\)/.test(mB2) && !/Caixa R\$/.test(mB2), mB2);
  check("manhã (entradas manuais, sem saída): 'Entradas registradas no mês … · na semana …'", /Entradas registradas no mês R\$ 500,00 · na semana R\$ 500,00 \(sem saídas lançadas\)/.test(morning(C)), morning(C));
  // período: 14/10/2026 (quarta) → mês = 01/10..14/10, semana = seg 12/10..14/10; o que é de outro mês/antes da semana não entra
  const E = org("E");
  ev(E, "in", 7000, "retail_closing", "2026-09-30"); ev(E, "in", 100, "retail_closing", "2026-10-01"); ev(E, "in", 200, "retail_closing", "2026-10-12"); ev(E, "in", 50, "retail_closing", "2026-10-14");
  const NOW = new Date("2026-10-14T12:00:00Z");
  const mE = (T.morningBrief(E, NOW).text.split("\n").find((l) => l.startsWith("💰")) || "");
  check("manhã: mês acumulado = 01/10→hoje (R$ 350,00; o mês anterior NÃO entra) e semana = segunda→hoje (R$ 250,00; 01/10 fica fora)", /Vendas registradas no mês R\$ 350,00 · na semana R\$ 250,00 \(sem saídas lançadas\)/.test(mE), mE);
  check("o total desde sempre (R$ 7.350,00) não aparece mais na manhã", !/7\.350,00/.test(mE) && L.entradasRegistradas(E) === 7350);
  const per = T.entradasMesESemana(E, NOW);
  check("janelas do período declaradas: mês desde 01/10, semana desde segunda 12/10; isolamento (outra org não soma)", per.mesDesde === "2026-10-01" && per.semanaDesde === "2026-10-12" && per.mes === 350 && per.semana === 250 && T.entradasMesESemana(A, NOW).mes === 0);
  check("virada de mês: a semana que começa em segunda 28/09 cruza o mês (semana pode ser maior que o mês) e é calculada por data, não por contagem", (() => { const F = org("F"); ev(F, "in", 300, "retail_closing", "2026-09-29"); ev(F, "in", 40, "retail_closing", "2026-10-01"); const p = T.entradasMesESemana(F, new Date("2026-10-01T12:00:00Z")); return p.semanaDesde === "2026-09-28" && p.semana === 340 && p.mes === 40; })());
  const mD = morning(D);
  check("manhã (com saída lançada): segue 'Caixa R$ 700,00' (0-regressão)", /Caixa R\$ 700,00/.test(mD), mD);
  check("manhã sem lançamento nenhum: 'Caixa —' (já era assim)", /Caixa —/.test(morning(A)), morning(A));
  const kB: any = (H.overview(B) as any).kpis;
  check("Central de Saúde: kpis traz entradasRegistradas e o basis; 'dias de caixa' é NULL (não se inventa prazo sobre venda acumulada)", kB.entradasRegistradas === 4975.62 && kB.tracking.cashBasis === "vendas" && kB.survivalDays === null, JSON.stringify(kB));
  check("manhã sem saída: a linha não traz '~N dias de caixa'", !/dias de caixa/.test(mB), mB);
  const nB = T.eveningBrief(B).text;
  check("noite (vendas, sem saída): 'Entradas registradas hoje', não 'Entrou no caixa'", /Entradas registradas hoje/.test(nB) && !/Entrou no caixa/.test(nB), nB);
  check("noite (com saída lançada): segue 'Entrou no caixa' (0-regressão)", /Entrou no caixa/.test(T.eveningBrief(D).text));

  // ── (3) helpers das telas ──
  const hB = cashHeadline({ caixaAtual: 1435378.92, entradasRegistradas: 1435378.92, tracking: { cashBasis: "vendas" } });
  check("tela Caixa (vendas, sem saída): rótulo 'Vendas registradas', valor = entradas, nota 'não é o saldo em conta', não confiável", hB.label === "Vendas registradas" && hB.value === 1435378.92 && /não é o saldo em conta/.test(hB.note || "") && hB.reliable === false && hB.flowLabel === "entradas");
  const hE = cashHeadline({ caixaAtual: 10, entradasRegistradas: 500, tracking: { cashBasis: "entradas" } });
  check("tela Caixa (entradas): rótulo 'Entradas registradas'", hE.label === "Entradas registradas" && hE.value === 500);
  const hD = cashHeadline({ caixaAtual: 700, entradasRegistradas: 1000, tracking: { cashBasis: "caixa" } });
  check("tela Caixa (com saída): 'Caixa atual', saldo 700, confiável, sem nota", hD.label === "Caixa atual" && hD.value === 700 && hD.reliable && hD.note === null && hD.flowLabel === "líquido");
  check("resumo ausente/antigo (sem tracking): 'caixa' (0-regressão); valor ausente é null, não 0", cashBasisOf(undefined) === "caixa" && cashHeadline(undefined).value === null && cashBasisOf({}) === "caixa");

  const row = (inf: number, sys: number) => ({ informed_total: inf, system_total: sys, status: "pending" });
  check("grade da semana: fechamento SEM valor informado (0) = '—' (null), não R$ 0,00", weekCellValue(row(0, 0), "informed") === null && weekCellValue(row(0, 0), "system") === null && weekCellValue(row(0, 0), "variance") === null);
  check("grade da semana: sem fechamento nenhum = null; com valor = o valor", weekCellValue(null, "informed") === null && weekCellValue(row(1808.3, 1808.3), "informed") === 1808.3 && weekCellValue(row(1808.3, 1669.02), "system") === 1669.02);
  check("grade da semana: diferença só existe com os dois lados; 0 verdadeiro (iguais) continua 0", weekCellValue(row(100, 0), "variance") === null && weekCellValue(row(0, 100), "variance") === null && weekCellValue(row(500, 500), "variance") === 0 && weekCellValue(row(1499.1, 1669.02), "variance")! < 0);

  const pass = results.filter((x) => x.ok).length;
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${!x.ok && x.detail ? `\n      ↳ ${x.detail}` : ""}`);
  console.log(failures ? `\n${failures} FALHA(S) (${pass}/${results.length} ok)` : `\n${pass}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
