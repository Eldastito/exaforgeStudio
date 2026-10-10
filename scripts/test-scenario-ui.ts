/**
 * TESTE — Cenário "e se?" (ADR-205 F4.14): cartão na Central de Saúde + rótulos PUROS + o corpo que a tela envia contra o ScenarioEngine REAL.
 * Prova: premissa inválida não chuta (erro, nunca número inventado) · opcional em branco é omitido · zero é aceito onde faz sentido (caixa mínimo) ·
 * a resposta real do motor vira frases honestas (faixa, origem da premissa, "—" no lugar de 0) · fiação (sem menu novo, só owner/admin, só carrega
 * ao abrir, rota existente, não executa, sem cálculo próprio) · isolamento entre empresas.
 * Uso: npm run test:scenario-ui
 */
import os from "os"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-scui-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-scui-1234567890";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

async function main() {
  const L = await import("../src/features/scenario/scenarioLabels.js");
  const { default: db } = await import("../src/server/db.js");
  const { ScenarioEngine } = await import("../src/server/ScenarioEngine.js");
  const kinds: any[] = ScenarioEngine.kinds();
  const spec = (k: string) => kinds.find((x) => x.kind === k);

  // ── parse do que o dono digita ──
  check("parseSignedNumber: sinal, vírgula e % aceitos", L.parseSignedNumber("-20") === -20 && L.parseSignedNumber("+15") === 15 && L.parseSignedNumber("12,5") === 12.5 && L.parseSignedNumber("-20%") === -20);
  check("parseSignedNumber: lixo → null (nunca chuta)", L.parseSignedNumber("") === null && L.parseSignedNumber("abc") === null && L.parseSignedNumber("1,2,3") === null && L.parseSignedNumber(null) === null);
  const okP = L.buildScenarioInputs(spec("purchase"), { amount: "50.000", minCash: "0", payInWeeks: "" });
  check("compra: valor ok, caixa mínimo ZERO é aceito, semana em branco é omitida", okP.ok && (okP as any).inputs.amount === 50000 && (okP as any).inputs.minCash === 0 && !("payInWeeks" in (okP as any).inputs));
  check("obrigatório faltando → erro que diz qual campo", (() => { const r: any = L.buildScenarioInputs(spec("purchase"), { amount: "" }); return !r.ok && /Valor da compra/.test(r.error); })());
  check("obrigatório com lixo → erro, nunca vira número", (() => { const r: any = L.buildScenarioInputs(spec("hire"), { monthlyCost: "muito" }); return !r.ok && /Não entendi/.test(r.error); })());
  check("valor da compra zero → erro (obrigatório precisa ser > 0)", !(L.buildScenarioInputs(spec("purchase"), { amount: "0" }) as any).ok);
  check("vendas: variação negativa passa", (L.buildScenarioInputs(spec("sales_change"), { changePct: "-20" }) as any).inputs.changePct === -20);
  check("tipo não escolhido → erro", !(L.buildScenarioInputs(undefined, {}) as any).ok);

  // ── rótulos da resposta ──
  check("sourceLabel: origem em português claro", L.sourceLabel("user") === "informado por você" && L.sourceLabel("data") === "medido na sua empresa" && L.sourceLabel("default") === "padrão do sistema" && L.sourceLabel("x") === "");
  check("confidenceLabel: sem 'alta' inventada pra nível desconhecido", L.confidenceLabel("media") === "confiança média" && L.confidenceLabel("baixa") === "confiança baixa" && L.confidenceLabel(undefined) === "");
  check("assumptionValue: R$, %, semana; null/vazio → '—' (null ≠ 0)", L.assumptionValue({ value: 50000, unit: "BRL" }) === "R$ 50.000" && L.assumptionValue({ value: -20, unit: "pct" }) === "-20%" && L.assumptionValue({ value: 15, unit: "pct" }) === "+15%" && L.assumptionValue({ value: 3, unit: "semanas" }) === "semana 3" && L.assumptionValue({ value: null, unit: "pct" }) === "—" && L.assumptionValue({ value: 0, unit: "BRL" }) === "R$ 0");
  check("metricDisplay: sem faixa → '—', nunca 0", L.metricDisplay({ range: { display: null } }) === "—" && L.metricDisplay(null) === "—" && L.metricDisplay({ range: { display: "R$ 12.000 – R$ 15.000" } }) === "R$ 12.000 – R$ 15.000");
  check("sensitivityLine: swing null → diz que não dá pra medir", /sem como medir/.test(L.sensitivityLine({ rank: 2, label: "Margem", lowCase: "a", highCase: "b", output: "x", swing: null })) && /R\$ 1\.500/.test(L.sensitivityLine({ rank: 1, label: "Valor", lowCase: "-20%", highCase: "+20%", output: "x", swing: 1500 })));

  // ── o corpo que a tela envia, contra o motor REAL ──
  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`, Z = `org_Z_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B, Z]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'x', 'active')`).run(randomUUID(), o);
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  F.recordEvent(A, { direction: "in", amount: 10000 });
  for (let i = 0; i < 30; i++) { const oid = randomUUID(); db.prepare("INSERT INTO comigo_orders (id, organization_id, status, total) VALUES (?, ?, 'paid', 40)").run(oid, A); db.prepare("INSERT INTO comigo_order_items (id, order_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, 'Item', 1, 40, 20)").run(randomUUID(), oid); }
  const refused: any = ScenarioEngine.run(Z, "hire", (L.buildScenarioInputs(spec("hire"), { monthlyCost: "3.000" }) as any).inputs);
  check("empresa sem custos cadastrados: o motor RECUSA (não inventa margem) e a mensagem chega inteira pra tela", refused.ok === false && refused.reason === "sem_margem" && /margem/.test(refused.message));
  const hire: any = ScenarioEngine.run(A, "hire", (L.buildScenarioInputs(spec("hire"), { monthlyCost: "3.000" }) as any).inputs);
  check("contratação: motor aceita o corpo da tela; é cenário, não previsão, não executa", hire.ok && hire.type === "scenario" && hire.isForecast === false && hire.executes === false);
  check("contratação: premissa digitada volta como 'informado por você' com o valor certo", (() => { const a = hire.assumptions.find((x: any) => x.key === "monthlyCost"); return a.source === "user" && L.assumptionValue(a) === "R$ 3.000" && L.sourceLabel(a.source) === "informado por você"; })());
  check("contratação: toda métrica sem faixa aparece como '—' e as com faixa mostram a faixa do motor", hire.metrics.every((m: any) => L.metricDisplay(m) === (m.range.display ?? "—")) && hire.metrics.some((m: any) => m.range.display));
  const sales: any = ScenarioEngine.run(Z, "sales_change", (L.buildScenarioInputs(spec("sales_change"), { changePct: "-20" }) as any).inputs);
  check("vendas sem histórico: o motor RECUSA em vez de inventar, e a mensagem chega à tela", sales.ok === false && typeof sales.message === "string" && sales.message.length > 10);
  const salesBase: any = ScenarioEngine.run(A, "sales_change", (L.buildScenarioInputs(spec("sales_change"), { changePct: "-20", baseRevenue30: "100.000" }) as any).inputs);
  check("vendas com base informada: simula; base marcada 'informado por você'", salesBase.ok && salesBase.assumptions.find((x: any) => x.key === "baseRevenue30").source === "user");
  check("confiança nunca 'alta' enquanto o piloto não validou", [hire, salesBase].every((o: any) => o.confidence.level !== "alta"));
  const purchase: any = ScenarioEngine.run(A, "purchase", (L.buildScenarioInputs(spec("purchase"), { amount: "20.000", payInWeeks: "2" }) as any).inputs);
  check("compra: sempre devolve sensibilidade ordenada e a tela monta uma linha por driver", purchase.ok && purchase.sensitivity.length >= 1 && purchase.sensitivity.every((r: any, i: number) => r.rank === i + 1 && L.sensitivityLine(r).startsWith(`${i + 1}º`)));
  check("isolamento: rodar na empresa A não escreve nada na B (motor é read-only)", (() => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as any[];
    return tables.every((t) => { try { const c = db.prepare(`SELECT COUNT(*) c FROM "${t.name}" WHERE organization_id = ?`).get(B) as any; return t.name === "organization_settings" ? c.c === 1 : c.c === 0; } catch { return true; } });
  })());

  // ── fiação ──
  const card = read("src/features/scenario/ScenarioCard.tsx");
  const hc = read("src/features/HealthCenterView.tsx");
  const side = read("src/features/Sidebar.tsx");
  check("sem menu novo: nada de cenário na Sidebar", !/ScenarioCard|e se\.\.\.\?/i.test(side));
  check("cartão dentro da Central de Saúde, carregado sob demanda (lazy)", /const ScenarioCard = lazy\(/.test(hc) && /<ScenarioCard \/>/.test(hc));
  check("só dono/admin vê o cartão", /role !== 'owner' && user\?\.role !== 'admin'\) return null/.test(card));
  check("só carrega ao abrir (toggle → loadKinds)", /const toggle = \(\) =>[\s\S]*loadKinds\(\)/.test(card) && !/useEffect/.test(card));
  check("usa as rotas existentes da F4.1 (kinds + simulate/scenario), sem inventar rota", /simulate\/scenario\/kinds/.test(card) && /simulate\/scenario'/.test(card) && /method: 'POST'/.test(card));
  check("403 tem frase honesta; erro do motor aparece pro dono", /forbidden/.test(card) && /j\?\.message/.test(card));
  check("diz na tela que é simulação, não previsão, e que nada foi executado", /simulação, não previsão — nada foi executado/.test(card));
  check("tela não calcula: sem Math.* nem reduce na renderização", !/Math\.|\.reduce\(/.test(card));
  check("a rota segue protegida pro gestor (hasFullBusinessVisibility) e o motor não executa", /simulate\/scenario[\s\S]{0,400}hasFullBusinessVisibility/.test(read("src/server/routes/health.ts")) && /executes: false/.test(read("src/server/ScenarioEngine.ts")));

  for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.d ? " — " + r.d : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
