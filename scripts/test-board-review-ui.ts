/**
 * TESTE — Revisão do mês (Board Review) na Central de Saúde: rótulos PUROS + fiação da tela.
 * Prova: formatação não inventa (null→"—", código desconhecido não vira texto cru, trimestre/mês legíveis) · a pauta separa FATOS de "sem dado" ·
 * o cartão está na Central de Saúde (sem menu novo), consome a rota REAL (montada no router), só aparece pra owner/admin, só carrega ao abrir,
 * trata 403/erro com texto honesto, mostra o aviso de piloto e não faz cálculo próprio · o servidor entrega a unidade da métrica.
 * Uso: npm run test:board-review-ui
 */
import os from "os"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-brui-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-brui-1234567890";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

async function main() {
  const L = await import("../src/features/boardreview/boardReviewLabels.js");
  check("periodLabel: mês e trimestre em português; formato desconhecido volta como veio", L.periodLabel("2026-09") === "setembro de 2026" && L.periodLabel("2026-Q3") === "3º trimestre de 2026" && L.periodLabel("2026-13") === "2026-13" && L.periodLabel(null) === "");
  check("brlOrDash/pctOrDash: ausência → '—' (nunca R$ 0,00); zero verdadeiro continua zero", L.brlOrDash(null) === "—" && L.brlOrDash(undefined) === "—" && /R\$\s?0,00/.test(L.brlOrDash(0)) && L.pctOrDash(null) === "—" && L.pctOrDash(0) === "0%" && L.pctOrDash(33.333, 1) === "33,3%");
  check("metricValue: % usa percentual, o resto BRL", L.metricValue("%", 20) === "20%" && /R\$\s?1\.000,00/.test(L.metricValue("BRL/m²", 1000)) && L.metricValue("%", null) === "—");
  check("paceLabel/bandLabel: traduzem os códigos; desconhecido → vazio (nunca o código cru)", L.paceLabel("behind") === "abaixo do ritmo" && L.paceLabel("missed") === "meta não atingida" && L.paceLabel("xyz") === "" && L.bandLabel("single_supplier") === "um único fornecedor" && L.bandLabel("high") === "concentração alta" && L.bandLabel("zzz") === "");
  const sp = L.splitAgenda([{ kind: "plan_behind", text: "a", source: "plano" }, { kind: "section_unavailable", text: "b", source: "lojas" }, { kind: "decision_review_due", text: "c", source: "decisoes" }]);
  check("splitAgenda: fatos primeiro, 'sem dado' à parte; entrada inválida → vazio", sp.facts.length === 2 && sp.gaps.length === 1 && sp.gaps[0].text === "b" && L.splitAgenda(null).facts.length === 0);
  const pl = L.planLines({ track: { revenue: { target: 100000, actual: 80000, progressPct: 80, paceStatus: "missed" } } });
  check("planLines: meta/realizado/% e ritmo; sem meta diz que não há; sem trilha → []", /80\.000,00/.test(pl[0]) && /80%/.test(pl[0]) && /meta não atingida/.test(pl[0]) && /não define meta/.test(L.planLines({ track: { revenue: { target: null } } })[0]) && L.planLines({}).length === 0);
  const dl = L.decisionLines({ decidedCount: 3, reviewsDue: [{ title: "Abrir loja X" }], calibration: { n: 2, within: 1 } });
  check("decisionLines: contagem, revisão vencida e calibração com aviso de amostra pequena", /3 decisão/.test(dl[0]) && /Abrir loja X/.test(dl[1]) && /1 de 2/.test(dl[2]) && /não é prova/.test(dl[2]) && L.decisionLines({ decidedCount: 0, reviewsDue: [], calibration: { n: 0 } }).length === 1);
  const sl = L.supplierLines({ totalSpend: 50000, topSharePct: 60, band: "high", coverage: { orderCoveragePct: 50 } });
  check("supplierLines: avisa leitura parcial com cobertura < 70%; sem cobertura não inventa", /concentração alta/.test(sl[1]) && /leitura parcial/.test(sl[2]) && L.supplierLines({ totalSpend: 1, topSharePct: null, coverage: {} }).length === 1);
  check("evidenceLabel: síntese do modelo NUNCA se passa por fonte viva", L.evidenceLabel("sintese_do_modelo").includes("hipótese") && L.evidenceLabel("fonte_viva") === "fonte viva" && L.evidenceLabel(null).includes("hipótese"));
  check("reviewConfidenceLabel: nunca 'alta'", L.reviewConfidenceLabel("baixa") === "confiança baixa" && L.reviewConfidenceLabel("media") === "confiança média" && L.reviewConfidenceLabel("alta") === "" && L.reviewConfidenceLabel(undefined) === "");

  // fiação
  const card = read("src/features/boardreview/BoardReviewCard.tsx");
  const hc = read("src/features/HealthCenterView.tsx");
  const router = read("src/server/routes/health.ts");
  check("o cartão está na Central de Saúde (sem menu novo)", /import\('@\/src\/features\/boardreview\/BoardReviewCard'\)/.test(hc) && /<BoardReviewCard \/>/.test(hc) && !/board_review|boardreview/.test(read("src/features/Sidebar.tsx")));
  check("consome a rota REAL, que existe no router", /\/api\/health-center\/board-review\?period=/.test(card) && /router\.get\("\/board-review"/.test(router));
  check("só aparece pra owner/admin (e a rota barra o resto)", /user\?\.role !== 'owner' && user\?\.role !== 'admin'\) return null/.test(card));
  check("não carrega ao montar: só ao abrir (toggle chama load)", !/useEffect/.test(card) && /if \(next && !data/.test(card));
  check("estados honestos: 403 (é do gestor), erro, carregando", /status === 403/.test(card) && /só do gestor/.test(card) && /Não consegui montar/.test(card) && /Montando a revisão/.test(card));
  check("mostra o aviso do piloto enquanto não validado e a confiança", /pilot\?\.validated/.test(card) && /pilot\?\.statement/.test(card) && /reviewConfidenceLabel/.test(card));
  check("sem cálculo próprio na tela (nada de reduce/somas/divisões sobre o dado)", !/\.reduce\(|Math\.|\/ ?100/.test(card));
  check("texto externo é dado não confiável: renderizado como texto, sem link/HTML", !/dangerouslySetInnerHTML|href=/.test(card));
  check("o servidor entrega a unidade da métrica (a tela não adivinha)", /unit: m\.unit/.test(read("src/server/BoardReviewService.ts")));
}
main().then(() => {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${!r.ok && r.d ? "  → " + r.d : ""}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(failures ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
