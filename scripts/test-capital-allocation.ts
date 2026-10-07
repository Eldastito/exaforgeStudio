/**
 * TESTE — ADR-205 F4.5: comparação de alternativas de investimento (CapitalAllocationService). COMPARA, não escolhe.
 * Prova: retorno esperado é entrada OBRIGATÓRIA do dono (faixa + origem + firmeza + risco + reversibilidade — nada preenchido por padrão) · aritmética por faixa (líquido, ROI, payback) ·
 * payback null quando o pior caso não rende · liderança POR CRITÉRIO (com empate), sem vencedor/ranking/recomendação · dominância só lógica · combinações que cabem no capital sem ordem de preferência ·
 * caixa vem do ScenarioEngine (13 semanas) · confiança nunca alta · read-only · rotas gestor-only · composição (sem cálculo de caixa próprio).
 * Uso: npm run test:capital-allocation
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-capital-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-capital-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { CapitalAllocationService: C, MAX_OPTIONS } = await import("../src/server/CapitalAllocationService.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const thrown = (f: () => any) => { try { f(); return null; } catch (e: any) { return e?.code || "error"; } };
  const A = mkOrg(), EMPTY = mkOrg();
  F.recordEvent(A, { direction: "in", amount: 90000 });
  const opt = (over: any = {}) => ({ label: "Opção X", amount: 10000, expectedMonthlyReturn: { low: 1000, high: 2000 }, startInMonths: 0, horizonMonths: 12, basis: "estimate", source: "média das últimas coleções", risk: "low", reversible: true, ...over });
  const reforma = opt({ label: "Reforma da loja", amount: 60000, expectedMonthlyReturn: { low: 2000, high: 6000 }, startInMonths: 2, basis: "estimate", risk: "medium", reversible: false });
  const colecao = opt({ label: "Coleção de verão", amount: 30000, expectedMonthlyReturn: { low: 1500, high: 5000 }, startInMonths: 0, basis: "fact", risk: "low", reversible: true });
  const vendedora = opt({ label: "Contratar vendedora", amount: 12000, expectedMonthlyReturn: { low: -500, high: 3000 }, startInMonths: 1, basis: "hypothesis", risk: "high", reversible: true });
  const before = () => ["decision_actions", "business_signals", "tasks", "purchase_orders", "payables"].map((t) => { try { return (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE organization_id = ?`).get(A) as any).c; } catch { return -1; } }).join(",");
  const b0 = before();
  const r = C.compare(A, { capitalAvailable: 45000, options: [reforma, colecao, vendedora] });
  const row = (l: string) => r.options.find((o: any) => o.label === l)!;

  check("é comparação, não previsão nem ação, e a decisão é humana", r.type === "capital_comparison" && r.isForecast === false && r.executes === false && r.decisionOwner === "human" && /Não é previsão nem recomendação/.test(r.statement));
  check("líquido por faixa = retorno × meses de retorno − investimento (Reforma: 10 meses → −40.000..0; Coleção: 12 → −12.000..30.000; Vendedora: 11 → −17.500..21.000)",
    row("Reforma da loja").netLow === -40000 && row("Reforma da loja").netHigh === 0 && row("Coleção de verão").netLow === -12000 && row("Coleção de verão").netHigh === 30000 && row("Contratar vendedora").netLow === -17500 && row("Contratar vendedora").netHigh === 21000 && row("Reforma da loja").returnMonths === 10);
  check("ROI em % por faixa (Coleção: −40%..+100%)", row("Coleção de verão").roiPct.low === -40 && row("Coleção de verão").roiPct.high === 100);
  check("payback em faixa (Coleção: 6..20 meses; Reforma: 12..32 meses contando os 2 de espera)", row("Coleção de verão").payback.bestMonths === 6 && row("Coleção de verão").payback.worstMonths === 20 && row("Reforma da loja").payback.bestMonths === 12 && row("Reforma da loja").payback.worstMonths === 32);
  check("pior caso sem retorno positivo → payback worst null e AVISA que pode não se pagar (não inventa número)", row("Contratar vendedora").payback.worstMonths === null && /pode não se pagar/.test(row("Contratar vendedora").payback.note) && row("Contratar vendedora").payback.paysBackInHorizon === "only_in_best_case");
  check("paga no horizonte? Reforma: não (pior caso 32 > 12); Coleção: não no pior caso (20 > 12) → false", row("Reforma da loja").payback.paysBackInHorizon === false && row("Coleção de verão").payback.paysBackInHorizon === false);
  check("resultado em FAIXA arredondada para exibir (nunca ponto)", typeof row("Coleção de verão").net.display === "string" && row("Coleção de verão").net.low === -12000 && row("Coleção de verão").net.high === 30000 && /–/.test(row("Coleção de verão").net.display));

  // sem vencedor
  const json = JSON.stringify(r);
  check("NÃO existe vencedor/ranking/recomendação/score na saída", !/"(winner|recommended|recommendation|ranking|rank|score|best|bestOption|choice)"/.test(json));
  check("liderança POR CRITÉRIO: menor desembolso=Vendedora · maior potencial=Coleção · melhor pior caso=Coleção · payback mais rápido=Vendedora · menor risco=Coleção · reversíveis=Coleção+Vendedora",
    r.byCriterion.smallestOutlay.join() === "Contratar vendedora" && r.byCriterion.highestUpside.join() === "Coleção de verão" && r.byCriterion.bestWorstCase.join() === "Coleção de verão" && r.byCriterion.fastestBestCasePayback.join() === "Contratar vendedora" && r.byCriterion.lowestRisk.join() === "Coleção de verão" && r.byCriterion.reversible.join() === "Coleção de verão,Contratar vendedora");
  check("critérios diferentes têm líderes diferentes (o ponto: trade-off, não um vencedor)", new Set([r.byCriterion.smallestOutlay[0], r.byCriterion.highestUpside[0]]).size === 2);
  check("empate no critério lista TODOS os empatados", (() => { const t = C.compare(EMPTY, { options: [opt({ label: "Alfa", amount: 5000 }), opt({ label: "Beta", amount: 5000 }), opt({ label: "Gama", amount: 9000 })] }); return t.byCriterion.smallestOutlay.join() === "Alfa,Beta"; })());

  // dominância
  check("dominância (só lógica): nenhuma entre Reforma/Coleção/Vendedora", r.dominations.length === 0);
  check("dominância detectada: X (barata, rende mais, risco menor, reversível) domina Y — e Y não domina X", (() => {
    const x = opt({ label: "Opção X", amount: 10000, expectedMonthlyReturn: { low: 1000, high: 2000 }, risk: "low", reversible: true });
    const y = opt({ label: "Opção Y", amount: 12000, expectedMonthlyReturn: { low: 900, high: 1800 }, startInMonths: 1, risk: "medium", reversible: false });
    const t = C.compare(EMPTY, { options: [x, y] });
    return t.dominations.length === 1 && t.dominations[0].dominant === "Opção X" && t.dominations[0].dominated === "Opção Y";
  })());
  check("sem dominância se os horizontes diferem (não compara maçã com laranja)", C.compare(EMPTY, { options: [opt({ label: "Opção X", horizonMonths: 12 }), opt({ label: "Opção Y", amount: 20000, expectedMonthlyReturn: { low: 500, high: 900 }, horizonMonths: 24 })] }).dominations.length === 0);

  // combinações
  check("capital 45.000: Reforma (60.000) não cabe; combinações que cabem = [Coleção], [Vendedora], [Coleção+Vendedora], em ordem de cadastro", row("Reforma da loja").fitsCapital === false && row("Coleção de verão").fitsCapital === true && r.bundles!.map((b: any) => b.options.join("+")).join("|") === "Coleção de verão|Contratar vendedora|Coleção de verão+Contratar vendedora");
  const bc = r.bundles!.find((b: any) => b.options.length === 2)!;
  check("combinação soma faixas (pior+pior, melhor+melhor), mostra sobra, risco máximo e reversibilidade", bc.totalAmount === 42000 && bc.leftover === 3000 && bc.net.low === -29500 && bc.net.high === 51000 && bc.maxRisk === "high" && bc.allReversible === true && bc.sameHorizon === true && /ordem de cadastro/.test(r.bundlesNote!));
  check("sem capital informado: sem combinações, fitsCapital null e avisa", (() => { const t = C.compare(A, { options: [reforma, colecao] }); return t.bundles === null && t.options.every((o: any) => o.fitsCapital === null) && t.caveats.some((c: string) => /Sem capital disponível/.test(c)); })());
  check("muitas combinações → corta em 40 e diz que truncou", (() => { const many = Array.from({ length: 8 }, (_, i) => opt({ label: `Opção ${i}`, amount: 1000 })); const t = C.compare(EMPTY, { capitalAvailable: 1e6, options: many }); return t.bundles!.length === 40 && t.bundlesTruncated === true; })());

  // caixa via ScenarioEngine
  check("caixa vem do ScenarioEngine (13 semanas): com saldo, mostra faixa do menor caixa; é o efeito do desembolso, e o aviso diz isso", row("Coleção de verão").cash.minCash !== null && typeof row("Coleção de verão").cash.minCash.display === "string" && /13 semanas/.test(row("Coleção de verão").cash.note) && r.caveats.some((c: string) => /13 semanas/.test(c)));
  check("desembolso maior → caixa mínimo menor (monotônico)", row("Reforma da loja").cash.minCash.low < row("Coleção de verão").cash.minCash.low && row("Coleção de verão").cash.minCash.low < row("Contratar vendedora").cash.minCash.low);
  check("empresa sem dado de caixa: não quebra e não inventa (minCash null ou faixa explicada)", (() => { const t = C.compare(EMPTY, { options: [colecao, vendedora] }); return t.options.every((o: any) => o.cash.minCash === null || typeof o.cash.minCash.display === "string") && t.options.every((o: any) => typeof o.cash.note === "string"); })());

  // confiança
  check("confiança nunca 'alta': fact → média; estimate/hypothesis → baixa, com o motivo", row("Coleção de verão").confidence.level === "media" && row("Reforma da loja").confidence.level === "baixa" && row("Contratar vendedora").confidence.level === "baixa" && r.options.every((o: any) => o.confidence.level !== "alta") && row("Contratar vendedora").confidence.reasons.some((x: string) => /hipótese/.test(x)));
  check("a origem e a firmeza que o dono declarou aparecem na saída (auditável)", row("Coleção de verão").declared.basis === "fact" && /coleções/.test(row("Coleção de verão").declared.source));
  check("avisos obrigatórios: não escolhe, retorno é do dono, sem interação entre opções, registrar em /strategic/decisions", r.caveats.some((c: string) => /não escolhe/.test(c)) && r.caveats.some((c: string) => /VOCÊ informou/.test(c)) && r.caveats.some((c: string) => /NÃO modelam interação/.test(c)) && r.caveats.some((c: string) => /strategic\/decisions/.test(c)));
  check("horizontes diferentes → avisa que o líquido não é comparável", C.compare(EMPTY, { options: [opt({ label: "Opção X" }), opt({ label: "Opção Y", horizonMonths: 24 })] }).caveats.some((c: string) => /horizontes diferentes/.test(c)));

  // entrada obrigatória
  const two = (x: any) => () => C.compare(EMPTY, { options: [opt({ label: "Opção A" }), x] });
  check("o retorno é OBRIGATÓRIO e nada é preenchido por padrão: sem faixa, sem origem, sem firmeza, sem risco, sem reversibilidade → recusa",
    thrown(two(opt({ label: "Opção B", expectedMonthlyReturn: undefined }))) === "missing_return" && thrown(two(opt({ label: "Opção B", expectedMonthlyReturn: { low: 100 } }))) === "missing_return"
    && thrown(two(opt({ label: "Opção B", source: "" }))) === "missing_source" && thrown(two(opt({ label: "Opção B", source: "ab" }))) === "missing_source"
    && thrown(two(opt({ label: "Opção B", basis: undefined }))) === "missing_basis" && thrown(two(opt({ label: "Opção B", basis: "certeza" }))) === "missing_basis"
    && thrown(two(opt({ label: "Opção B", risk: undefined }))) === "missing_risk" && thrown(two(opt({ label: "Opção B", risk: "enorme" }))) === "missing_risk"
    && thrown(two(opt({ label: "Opção B", reversible: undefined }))) === "missing_reversible" && thrown(two(opt({ label: "Opção B", reversible: "sim" }))) === "missing_reversible");
  check("valida números: valor ≤0, faixa invertida, início/horizonte fora de faixa, nome curto ou repetido, capital inválido",
    thrown(two(opt({ label: "Opção B", amount: 0 }))) === "invalid_amount" && thrown(two(opt({ label: "Opção B", amount: "abc" }))) === "invalid_amount" && thrown(two(opt({ label: "Opção B", expectedMonthlyReturn: { low: 500, high: 100 } }))) === "invalid_return"
    && thrown(two(opt({ label: "Opção B", startInMonths: 30 }))) === "invalid_start" && thrown(two(opt({ label: "Opção B", startInMonths: 1.5 }))) === "invalid_start" && thrown(two(opt({ label: "Opção B", horizonMonths: 0 }))) === "invalid_horizon" && thrown(two(opt({ label: "Opção B", horizonMonths: 99 }))) === "invalid_horizon"
    && thrown(two(opt({ label: "ab" }))) === "invalid_label" && thrown(two(opt({ label: "opção a" }))) === "duplicate_label" && thrown(() => C.compare(EMPTY, { capitalAvailable: -5, options: [opt({ label: "Opção A" }), opt({ label: "Opção B" })] })) === "invalid_capital");
  check("exige entre 2 e 8 alternativas", thrown(() => C.compare(EMPTY, { options: [opt()] })) === "too_few_options" && thrown(() => C.compare(EMPTY, {})) === "too_few_options" && thrown(() => C.compare(EMPTY, { options: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => opt({ label: `Opção ${i}` })) })) === "too_many_options");
  check("texto livre: controle removido e truncado (dado do dono, não instrução)", (() => { const t = C.compare(EMPTY, { options: [opt({ label: "  Linha\n\tdois\u0007 " + "x".repeat(200), source: "origem ".repeat(100) }), opt({ label: "Opção B" })] }); return !/[\n\t\u0007]/.test(t.options[0].label) && t.options[0].label.length <= 80 && t.options[0].declared.source.length <= 200; })());
  check("read-only e stateless: não grava nem cria ação/sinal/tarefa/pedido/conta", before() === b0);

  // rotas
  const { default: router } = await import("../src/server/routes/health.js");
  const express = (await import("express")).default;
  const mkU = (org: string, role: string, key: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, ?, 'active')`).run(id, org, `${id}@t.local`, role); const pid = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id; return { userId: id, id, role, role_profile_id: pid }; };
  const who: any = { dono: mkU(A, "owner", "owner"), vend: mkU(A, "agent", "vendedor") };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-anon"] ? undefined : A; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/health-center", router);
  const server = http.createServer(app); await new Promise<void>((x) => server.listen(0, x));
  const port = (server.address() as any).port;
  const call = async (u: string, user: string, body?: any, anon = false) => { const x = await fetch(`http://127.0.0.1:${port}/api/health-center${u}`, { method: "POST", headers: { "Content-Type": "application/json", "x-user": user, ...(anon ? { "x-anon": "1" } : {}) }, body: JSON.stringify(body || {}) }); return { status: x.status, body: await x.json().catch(() => ({})) as any }; };
  const ok = await call("/capital/compare", "dono", { capitalAvailable: 45000, options: [reforma, colecao, vendedora] });
  check("rota: gestor compara (200) e recebe a comparação completa", ok.status === 200 && ok.body.type === "capital_comparison" && ok.body.options.length === 3 && ok.body.bundles.length === 3);
  check("rota: vendedor não compara (403); sem empresa → 401", (await call("/capital/compare", "vend", { options: [reforma, colecao] })).status === 403 && (await call("/capital/compare", "dono", { options: [reforma, colecao] }, true)).status === 401);
  check("rota: entrada incompleta → 400 com código e mensagem (nada preenchido por padrão)", (await call("/capital/compare", "dono", { options: [reforma, { ...colecao, source: undefined }] })).body.code === "missing_source" && (await call("/capital/compare", "dono", { options: [reforma] })).status === 400);
  server.close();

  // fiação e composição
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/CapitalAllocationService.ts"), "utf8");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "");
  check("RN-F4-11: o caixa vem do ScenarioEngine; o serviço não toca banco nem calcula caixa/previsão por conta própria", /ScenarioEngine\.run/.test(code) && !/CashForecastService|PurchaseScenarioService|DecisionSimulatorService|FinancialLedgerService|from "\.\/db/.test(code));
  check("RN-F4-1/2: nunca cria ação/comando/mensagem/sinal e não grava (sem db, sem INSERT)", !/DecisionActionService|CommandExecutor|MessageProvider|ApprovalPolicy|BusinessSignalService|INSERT|UPDATE/.test(code));

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
