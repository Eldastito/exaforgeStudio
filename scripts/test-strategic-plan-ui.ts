/**
 * TESTE — Plano do mês (ADR-205 F4.12): cartão na Central de Saúde + rótulos PUROS + o corpo que a tela envia contra o serviço REAL.
 * Prova: parse da meta digitada não chuta (inválido→null) · trocar a meta PRESERVA orçamento e eventos (revisão v2 sem perder linhas) · a tela cria+ativa
 * com 1 campo e mostra realizado/ritmo/orçamento/eventos sem inventar · fiação (sem menu novo, só owner/admin, só carrega ao abrir, estados honestos,
 * sem cálculo próprio) · isolamento entre empresas.
 * Uso: npm run test:strategic-plan-ui
 */
import os from "os"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-spui-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-spui-1234567890";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

async function main() {
  const L = await import("../src/features/strategicplan/planLabels.js");
  const { default: db } = await import("../src/server/db.js");
  const { StrategicPlanService } = await import("../src/server/StrategicPlanService.js");

  // ── rótulos puros ──
  check("currentMonthKeySP: mês em São Paulo, não no fuso do navegador (virada de mês às 02:00Z ainda é o mês anterior em SP)", L.currentMonthKeySP(new Date("2026-10-15T12:00:00Z")) === "2026-10" && L.currentMonthKeySP(new Date("2026-11-01T02:00:00Z")) === "2026-10" && L.currentMonthKeySP(new Date("2026-11-01T04:00:00Z")) === "2026-11");
  check("parseMoneyInput: formatos BR aceitos", L.parseMoneyInput("150000") === 150000 && L.parseMoneyInput("150.000") === 150000 && L.parseMoneyInput("150.000,50") === 150000.5 && L.parseMoneyInput("R$ 150.000") === 150000 && L.parseMoneyInput("1500,5") === 1500.5 && L.parseMoneyInput("99.5") === 99.5);
  check("parseMoneyInput: inválido/zero/negativo/texto → null (nunca chuta)", L.parseMoneyInput("") === null && L.parseMoneyInput("0") === null && L.parseMoneyInput("-5") === null && L.parseMoneyInput("abc") === null && L.parseMoneyInput("12a") === null && L.parseMoneyInput(null) === null);

  // ── o corpo que a tela envia, contra o serviço REAL ──
  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'x', 'active')`).run(randomUUID(), o);
  const owner = { userId: "u1", role: "owner" };
  const key = L.currentMonthKeySP();
  const created: any = StrategicPlanService.create(A, owner, { periodType: "month", periodKey: key, title: "Plano de teste", lines: [{ kind: "revenue_target", label: "Faturamento", amount: 100000 }] });
  check("criar com 1 campo (meta) funciona e nasce rascunho", created.status === "draft" && L.revenueTargetOf(created) === 100000);
  const active: any = StrategicPlanService.activate(A, created.id, owner);
  check("ativar em seguida (o que o botão faz)", active.status === "active");
  // dono já tinha orçamento e evento cadastrados (por outra via): a troca de meta não pode apagá-los
  const day = `${key}-28`;
  StrategicPlanService.revise(A, created.id, owner, { lines: [{ kind: "revenue_target", amount: 100000 }, { kind: "budget", category: "marketing", amount: 5000 }, { kind: "event", label: "Liquidação", eventDate: day, cashImpact: -2000 }] });
  const before: any = StrategicPlanService.get(A, created.id);
  const revised: any = StrategicPlanService.revise(A, created.id, owner, { lines: L.withRevenueTarget(before.lines, 150000), changeNote: "teste" });
  check("alterar a meta: v3, meta nova, 1 única meta", revised.version === 3 && L.revenueTargetOf(revised) === 150000 && revised.lines.filter((l: any) => l.kind === "revenue_target").length === 1);
  check("alterar a meta PRESERVA orçamento e evento do dono", revised.lines.some((l: any) => l.kind === "budget" && l.category === "marketing" && l.amount === 5000) && revised.lines.some((l: any) => l.kind === "event" && l.label === "Liquidação" && l.eventDate === day && l.cashImpact === -2000));
  check("versão anterior continua no histórico (append-only)", revised.versions.length === 3);

  // ── leitura do acompanhamento ──
  const tr: any = StrategicPlanService.track(A, created.id);
  const rl = L.revenueLine(tr);
  check("sem fechamento de loja: diz que não dá pra saber o realizado (não 'zero')", !!rl && /Ainda sem fechamento/.test(rl) && !/R\$\s?0,00/.test(rl), String(rl));
  const fake = { revenue: { target: 150000, actual: 60000, progressPct: 40, elapsedPct: 50, paceStatus: "behind", previousPeriod: { actual: 120000 }, targetVsPreviousPct: 25 } };
  check("com realizado: valor, % da meta, % do período e ritmo traduzido", /60\.000,00/.test(L.revenueLine(fake)!) && /40%/.test(L.revenueLine(fake)!) && /50%/.test(L.revenueLine(fake)!) && /abaixo do ritmo/.test(L.revenueLine(fake)!));
  check("período anterior: compara só quando existe; meta acima/abaixo", /acima/.test(L.previousLine(fake)!) && L.previousLine({ revenue: { previousPeriod: { actual: null } } }) === null);
  const bl = L.budgetLines({ budgets: [{ label: "Marketing", planned: 5000, committed: 6000, overBudget: true }, { label: "Aluguel", planned: 9000, committed: null }] });
  check("orçamento: acima do orçamento dito; sem contas lançadas diz que não dá pra acompanhar (não inventa 0)", /acima do orçamento/.test(bl[0]) && /não dá para acompanhar/.test(bl[1]) && !/R\$\s?0,00/.test(bl[1]));
  check("eventos: dias até, data BR, caixa declarado", /em 3 dias/.test(L.eventLines({ calendar: { events: [{ label: "X", eventDate: "2026-10-20", daysUntil: 3, passed: false, cashImpact: -2000 }] } })[0]) && /20\/10\/2026/.test(L.eventLines({ calendar: { events: [{ label: "X", eventDate: "2026-10-20", daysUntil: 3, passed: false, cashImpact: null }] } })[0]));
  check("entradas vazias não quebram", L.revenueLine(null) === null && L.budgetLines(undefined).length === 0 && L.eventLines({}).length === 0 && L.revenueTargetOf(null) === null);

  // ── isolamento ──
  check("isolamento: a outra empresa não vê o plano", StrategicPlanService.list(B).length === 0 && StrategicPlanService.get(B, created.id) === null);

  // ── fiação ──
  const card = read("src/features/strategicplan/StrategicPlanCard.tsx"), hc = read("src/features/HealthCenterView.tsx"), router = read("src/server/routes/health.ts");
  check("o cartão está na Central de Saúde (sem menu novo)", /import\('@\/src\/features\/strategicplan\/StrategicPlanCard'\)/.test(hc) && /<StrategicPlanCard \/>/.test(hc) && !/strategicplan/i.test(read("src/features/Sidebar.tsx")));
  check("usa as rotas REAIS de plano (existem no router)", /\/api\/health-center\/plans\?periodType=month/.test(card) && /router\.get\("\/plans"/.test(router) && /router\.post\("\/plans"/.test(router) && /router\.put\("\/plans\/:id"/.test(router) && /\/activate/.test(card) && /router\.post\("\/plans\/:id\/activate"/.test(router));
  check("só owner/admin vê o cartão", /user\?\.role !== 'owner' && user\?\.role !== 'admin'\) return null/.test(card));
  check("não carrega ao montar: só ao abrir", !/useEffect/.test(card) && /if \(next && !loaded/.test(card));
  check("estados honestos: 403, erro, carregando, erro de salvamento mostra a mensagem do servidor", /status === 403/.test(card) && /só do gestor/.test(card) && /Não consegui carregar/.test(card) && /Carregando/.test(card) && /d\?\.error/.test(card));
  check("a tela não prevê nem sugere meta (placeholder é só exemplo de formato; sem cálculo próprio)", !/\.reduce\(|Math\./.test(card) && /não uma previsão/.test(card));
  check("o plano nasce da decisão do dono: ativação é ação explícita do botão, e só ele escreve a meta", /Definir meta do mês/.test(card) && /parseMoneyInput\(value\)/.test(card));
}
main().then(() => {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${!r.ok && r.d ? "  → " + r.d : ""}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(failures ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
