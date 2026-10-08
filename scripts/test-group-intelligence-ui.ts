/**
 * TESTE — ADR-205 F4.8 (UI): aba "Inteligência" do Grupo (OrgGroupView + intelligenceLabels).
 * Prova: rótulos/formatação PUROS não inventam (null→"—", motivo→palavra do dono, posição normalizada) · a aba está ligada e consome a rota REAL
 * (montada no router, atrás da flag) · estados honestos (403/400/erro/carregando) · mostra o motivo quando não há ranking, a cobertura e as perguntas ·
 * não faz cálculo próprio de comparação (só exibe o que o servidor devolveu).
 * Uso: npm run test:group-intelligence-ui
 */
import os from "os"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-gint-ui-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-gint-ui-1234567890";
const __dirname = path.dirname(fileURLToPath(import.meta.url)); const repoRoot = path.resolve(__dirname, "..");
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

async function main() {
  const L = await import("../src/features/orggroup/intelligenceLabels.js");
  // formatação
  check("formatMetricValue: BRL formatado; % com 1 casa; null/NaN/undefined → '—' (nunca R$ 0,00)", /R\$\s?1\.000,00/.test(L.formatMetricValue("BRL/m²", 1000)) && L.formatMetricValue("%", 20) === "20%" && L.formatMetricValue("%", 33.33) === "33,3%" && L.formatMetricValue("BRL/m²", null) === "—" && L.formatMetricValue("%", undefined) === "—" && L.formatMetricValue("BRL/pessoa", NaN) === "—");
  check("formatMetricValue: zero verdadeiro continua zero (só ausência vira '—')", /R\$\s?0,00/.test(L.formatMetricValue("BRL/m²", 0)) && L.formatMetricValue("%", 0) === "0%");
  check("previousMonth: mês anterior e virada de ano", L.previousMonth("2026-10-08") === "2026-09" && L.previousMonth("2026-01-15") === "2025-12");
  // motivos
  const rs = ["amostra_minima", "nichos_diferentes", "nicho_desconhecido", "mes_incompleto"].map((r) => L.reasonLabel(r));
  check("reasonLabel: os 4 motivos viram frase em português do dono (nunca o código cru) e dizem que os valores seguem lado a lado/ou o mês", rs.every((t) => t.length > 30 && !/_/.test(t)) && /3 operações/.test(rs[0]) && /nichos diferentes/.test(rs[1]) && /nicho/.test(rs[2]) && /mês já fechado/.test(rs[3]) && L.reasonLabel(null) === "" && L.reasonLabel("algo_novo") !== "");
  // posição
  check("positionLabel: posição NORMALIZADA pelo servidor — above=melhor (inclusive custo fixo), below=pior; sem posição → null", L.positionLabel("above_median")?.text === "melhor que a mediana" && L.positionLabel("above_median")?.tone === "good" && L.positionLabel("below_median")?.text === "pior que a mediana" && L.positionLabel("below_median")?.tone === "warn" && L.positionLabel("near_median")?.tone === "neutral" && L.positionLabel(null) === null && L.positionLabel("x") === null);
  check("confidenceLabel: nunca 'alta'; sem ranking dito", L.confidenceLabel("insuficiente") === "sem ranking" && L.confidenceLabel("baixa") === "confiança baixa" && L.confidenceLabel("media") === "confiança média" && L.confidenceLabel("alta") === "" && L.confidenceLabel(undefined) === "");
  check("coverageLabel: só aparece quando a cobertura é incompleta; ausência não inventa", L.coverageLabel({ used: 1, of: 2 }) === "1 de 2 loja(s) com dado" && L.coverageLabel({ used: 2, of: 2 }) === null && L.coverageLabel({ used: 0, of: 0 }) === null && L.coverageLabel(null) === null);

  // fiação da tela
  const view = read("src/features/orggroup/OrgGroupView.tsx");
  check("a aba existe: tipo Tab, botão 'Inteligência' e render do IntelligenceTab", /type Tab = [^;]*'intelligence'/.test(view) && /setTab\('intelligence'\)/.test(view) && /<IntelligenceTab groupId=\{groupId\}/.test(view) && />Inteligência</.test(view));
  check("consome a rota real com o período escolhido (/api/groups/:id/intelligence?period=)", /\/api\/groups\/\$\{groupId\}\/intelligence\?period=\$\{month\}/.test(view));
  const router = (await import("../src/server/routes/orgGroups.js")).default as any;
  const paths: string[] = (router?.stack || []).filter((l: any) => l?.route?.path).map((l: any) => String(l.route.path));
  check("a rota consumida está MONTADA no router do grupo (sem 404 por fiação)", paths.includes("/:groupId/intelligence"));
  const tab = view.slice(view.indexOf("function IntelligenceTab"), view.indexOf("// ---------- Equipe"));
  check("estados honestos: 403 (só dono/admin), 400 (período), erro HTTP e falha de rede têm mensagem; carregando visível", /r\.status === 403/.test(tab) && /r\.status === 400/.test(tab) && /HTTP \$\{r\.status\}/.test(tab) && /Falha de rede/.test(tab) && /Carregando/.test(tab));
  check("sem grupo → estado vazio explicativo (não chama a API)", /if \(!groupId\) return <Empty/.test(tab) && /if \(!groupId\) return;/.test(tab));
  check("mostra motivo da ausência de ranking, cobertura incompleta, posição e as perguntas do servidor", /reasonLabel\(m\.reason\)/.test(tab) && /coverageLabel\(o\.coverage\)/.test(tab) && /positionLabel\(o\.position\)/.test(tab) && /\(m\.questions \|\| \[\]\)\.length > 0/.test(tab) && /m\.questions\.map/.test(tab));
  check("mostra operação indisponível (parcial) e os caveats do servidor", /o\.partial/.test(tab) && /data\.caveats/.test(tab));
  check("não calcula comparação na tela: sem mediana/ranking/soma própria (só exibe o que o servidor devolveu)", !/\.sort\(|reduce\(|Math\.(min|max)|median\(/.test(tab) && /m\.median/.test(tab));
  check("só dinheiro/valor via formatMetricValue (null→'—'); nada de toFixed/'R$ 0' hardcoded", /formatMetricValue\(m\.unit, o\.value\)/.test(tab) && !/toFixed|R\$ 0/.test(tab));
  const hasTextRec = /\b(recomend|deveria|feche|vender a|trocar de)/i.test(tab);
  check("a tela não recomenda ação (sem 'recomendamos/deveria/feche/vender/trocar')", !hasTextRec);

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
