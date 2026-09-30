/**
 * TESTE — PRD Fase 1, F1.0: estados semânticos de informação (src/lib/metric.ts)
 * Prova: zero real ≠ desconhecido ≠ não calculado ≠ N/A ≠ estimativa; null/NaN nunca
 * viram 0; total com parcela faltando não é total; fato e estimativa não se somam;
 * razão com denominador ausente/zero não vira 0%/NaN; o defeito real do `brl` legado
 * (null → "R$ 0,00") + redactMoney; guard: telas de varejo não têm mais o formatter legado.
 * Uso:  npm run test:semantic-metric
 */
import fs from "fs";
import path from "path";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const M = await import("../src/lib/metric.js");
  const { redactMoney } = await import("../src/server/moneyVisibility.js");

  // ── estados básicos ──
  check("zero real: known(0) → R$ 0,00 (o sistema SABE que foi zero)", M.formatMetric(M.known(0, { unit: "brl" })) === "R$ 0,00" && M.isKnown(M.known(0)));
  check("desconhecido → —", M.formatMetric(M.unknown("sem sync")) === "—" && !M.hasNumber(M.unknown()));
  check("não calculado → 'Não calculado'", M.formatMetric(M.notComputed("falta meta")) === "Não calculado");
  check("não aplicável → N/A", M.formatMetric(M.notApplicable()) === "N/A");
  check("estimativa → 'R$ X — estimativa' com confiança na nota", M.formatMetric(M.estimate(1500, { unit: "brl", confidence: 0.7 })) === "R$ 1.500,00 — estimativa" && M.metricNote(M.estimate(1, { confidence: 0.7, source: "ritmo histórico" })) === "confiança 70% · fonte: ritmo histórico");
  check("estados são distintos entre si", new Set(["value", "unknown", "not_computed", "not_applicable", "estimate"]).size === 5 && M.known(0).state !== M.unknown().state);
  check("motivo do não-valor aparece na nota", M.metricNote(M.notComputed("falta meta do dia")) === "falta meta do dia" && M.metricNote(M.known(5)) === null);

  // ── null/NaN nunca viram 0 ──
  check("known(NaN/Infinity/null) NÃO vira 0 → unknown", ["value"].every(() => [NaN, Infinity, null, undefined, "x"].every((v) => M.known(v as any).state === "unknown")));
  check("fromNullable: null/undefined/'' → unknown; 0 e '0' → zero real", M.fromNullable(null).state === "unknown" && M.fromNullable(undefined).state === "unknown" && M.fromNullable("").state === "unknown" && M.fromNullable(0).state === "value" && M.fromNullable("0").value === 0);
  check("fromNullable: string BR '12,5' → 12.5", M.fromNullable("12,5").value === 12.5);
  check("estimate com valor inválido → unknown; confiança clampada 0..1", M.estimate(NaN).state === "unknown" && M.estimate(1, { confidence: 5 }).confidence === 1 && M.estimate(1, { confidence: -2 }).confidence === 0);

  // ── formatBRL (drop-in das telas) ──
  check("formatBRL: null/undefined/'' → — (NUNCA R$ 0,00)", M.formatBRL(null) === "—" && M.formatBRL(undefined) === "—" && M.formatBRL("") === "—" && M.formatBRL(NaN) === "—");
  check("formatBRL: 0 → R$ 0,00 (zero real preservado)", M.formatBRL(0) === "R$ 0,00" && M.formatBRL("0") === "R$ 0,00");
  check("formatBRL: milhar e negativo", M.formatBRL(1420) === "R$ 1.420,00" && M.formatBRL(1234567.891) === "R$ 1.234.567,89" && M.formatBRL(-80.5) === "-R$ 80,50");

  // ── combine: total honesto ──
  const all = M.combineMetrics([M.known(100), M.known(50)], { unit: "brl" });
  check("combine: tudo conhecido → total = soma", all.fact.state === "value" && all.fact.value === 150 && all.unresolved === 0);
  const part = M.combineMetrics([M.known(100), M.unknown("loja sem dado"), M.known(50)], { unit: "brl" });
  check("combine: parcela desconhecida → NÃO é total (not_computed) e o parcial fica à parte", part.fact.state === "not_computed" && part.unresolved === 1 && part.partialFact === 150 && /faltam 1/.test(part.fact.reason || ""));
  const mix = M.combineMetrics([M.known(100), M.estimate(40, { confidence: 0.8 }), M.estimate(60, { confidence: 0.5 })]);
  check("combine: fato e estimativa NUNCA somados; estimativa agregada usa a MENOR confiança", mix.fact.value === 100 && mix.estimate.value === 100 && mix.estimate.confidence === 0.5 && mix.estimate.state === "estimate");
  check("combine: N/A é ignorado (não conta como faltante)", M.combineMetrics([M.known(10), M.notApplicable()]).fact.value === 10);
  check("combine: vazio/só desconhecido não vira 0", M.combineMetrics([]).fact.state === "unknown" && M.combineMetrics([null, undefined]).fact.state === "not_computed");
  check("combine: zero real somado é zero real (não desconhecido)", M.combineMetrics([M.known(0), M.known(0)]).fact.state === "value" && M.combineMetrics([M.known(0)]).fact.value === 0);

  // ── razão / atingimento ──
  const at = M.ratioMetric(M.known(1050), M.known(2500));
  check("razão: 1050/2500 = 42%", at.state === "value" && at.value === 42 && M.formatMetric(at) === "42%");
  check("razão: meta desconhecida → Não calculado (não 0%)", M.ratioMetric(M.known(1050), M.unknown()).state === "not_computed" && M.ratioMetric(M.unknown(), M.known(2500)).state === "not_computed");
  check("razão: meta zero → N/A (sem Infinity/NaN)", M.ratioMetric(M.known(10), M.known(0)).state === "not_applicable" && M.ratioMetric(M.known(0), M.known(0)).state === "not_applicable");
  check("razão: vendido zero real com meta válida → 0% (zero real, não desconhecido)", M.ratioMetric(M.known(0), M.known(2500)).state === "value" && M.ratioMetric(M.known(0), M.known(2500)).value === 0);
  const est = M.ratioMetric(M.estimate(500, { confidence: 0.6 }), M.known(1000));
  check("razão com estimativa herda estimativa e confiança", est.state === "estimate" && est.value === 50 && est.confidence === 0.6);

  // ── JSON puro (atravessa a API) ──
  const rt = JSON.parse(JSON.stringify(M.estimate(10, { unit: "brl", confidence: 0.5, source: "x" })));
  check("Metric é JSON puro (ida e volta idêntica)", M.formatMetric(rt) === "R$ 10,00 — estimativa" && rt.state === "estimate");

  // ── o defeito real que motivou a fatia ──
  const legacyBrl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace(".", ",")}`;
  const redacted = redactMoney(1234.5, { role: "agent" });
  check("DEFEITO LEGADO reproduzido: redactMoney→null e o brl antigo mostrava 'R$ 0,00'", redacted === null && legacyBrl(redacted) === "R$ 0,00");
  check("CORRIGIDO: mesmo dado redigido agora mostra —; owner vê o valor", M.formatBRL(redacted) === "—" && M.formatBRL(redactMoney(1234.5, { role: "owner" })) === "R$ 1.234,50");

  // ── guard: as telas de varejo não voltam ao formatter legado ──
  const root = path.resolve(process.cwd(), "src/features");
  for (const f of ["RetailOpsView.tsx", "RetailFloorView.tsx"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    check(`guard: ${f} usa o formatBRL compartilhado (sem 'Number(n || 0)' local)`, /formatBRL/.test(src) && !/const brl = \(n: any\) => `R\$ \$\{Number\(n \|\| 0\)/.test(src));
  }

  console.log("\n=== PRD Fase 1 · F1.0: estados semânticos ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
