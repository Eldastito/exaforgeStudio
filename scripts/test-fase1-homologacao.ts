/**
 * TESTE — PRD Fase 1, F1.8: HOMOLOGAÇÃO / REGRESSÃO de ponta a ponta (TOULON).
 * Não cria lógica: compõe os serviços REAIS da Fase 1 com os casos que o Bruno citou e prova a REGRA DE OURO da
 * fase — "nada muda na TOULON sem ligar": org recém-criada = tudo desligado/inerte (0-regressão); e, ligado,
 * as peças conversam entre si sem se contradizer (a cota da manhã = a meta das 16h = a cota da noite), sem
 * inventar número (null ≠ 0), com dinheiro só pra owner/admin. Também audita a FIAÇÃO de produção (rotas,
 * passes do Scheduler, colunas opt-in, testes no package.json, runbook) — o que um PR isolado não enxerga.
 * Uso:  npm run test:fase1-homologacao
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fase1-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fase1-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const Day = (await import("../src/server/RetailDayBriefService.js")).RetailDayBriefService;
  const Aft = (await import("../src/server/RetailAfternoonBriefService.js")).RetailAfternoonBriefService;
  const Dup = (await import("../src/server/RetailSellerDuplicateService.js")).RetailSellerDuplicateService;
  const Ident = (await import("../src/server/RetailSellerIdentityService.js")).RetailSellerIdentityService;
  const Strat = (await import("../src/server/RetailReplenishmentStrategyService.js")).RetailReplenishmentStrategyService;
  const Neg = (await import("../src/server/NegativeStockDiagnosisService.js")).NegativeStockDiagnosisService;
  const Streak = (await import("../src/server/SellerGoalStreakService.js")).SellerGoalStreakService;
  const Sig = (await import("../src/server/BusinessSignalService.js")).BusinessSignalService;
  const Prio = (await import("../src/server/ImpactPrioritizationService.js")).ImpactPrioritizationService;
  const { officialSaleSourceOf } = await import("../src/server/RetailSalesPolicy.js");

  // ═══ 1. REGRA DE OURO: org nova = tudo desligado ═══
  const FRESH = `org_fresh_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Nova', 'active')`).run(randomUUID(), FRESH);
  const flags = db.prepare(`SELECT retail_afternoon_brief_enabled AS aft, retail_night_brief_enabled AS night, retail_seller_goal_streak_enabled AS streak, retail_replenishment_strategy AS strat, retail_official_sale_source AS src, tutor_wa_enabled AS tutor FROM organization_settings WHERE organization_id = ?`).get(FRESH) as any;
  check("org nova: parcial 16h, fechamento da noite, alerta de metas e resumo da manhã DESLIGADOS por padrão", !flags.aft && !flags.night && !flags.streak && !flags.tutor, JSON.stringify(flags));
  check("org nova: estratégia de reposição = contínua (comportamento de sempre) e fonte de venda = caixa (legado)", Strat.strategy(FRESH) === "continuous_replenishment" && officialSaleSourceOf(FRESH) === "system" && flags.strat == null);
  const sent: string[] = [];
  const send = async (_p: string, t: string) => { sent.push(t); };
  await Aft.runPass(FRESH, { now: new Date(), send, force: true }); await Day.runPass(FRESH, { now: new Date(), send, force: true });
  check("org nova: nenhuma mensagem proativa sai (nem com force — sem opt-in não envia)", sent.length === 0);
  check("org nova: sem cota → a manhã não muda; sem vendedores → nenhuma pergunta de duplicidade; sem negativo → diagnóstico vazio", Day.morningLines(FRESH, "2026-09-24").length === 0 && Dup.suggestions(FRESH).length === 0 && Neg.diagnose(FRESH).total === 0);
  check("org nova: alerta de metas por pessoa não publica nada desligado", Streak.enabled(FRESH) === false);

  // ═══ 2. CENÁRIO TOULON (casos do Bruno) ═══
  const T = `org_toulon_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, retail_official_sale_source) VALUES (?, ?, 'TOULON', 'active', 'folha')`).run(randomUUID(), T);
  const store = (name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, T, name, code); return id; };
  const ab = store("Avenida Brasil", "1001"), carioca = store("Carioca", "1002"), grande = store("Grande Rio", "1003");
  const D = "2026-09-24";
  const quota = (st: string, v: number, date = D) => db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), T, st, date, v);
  quota(carioca, 1000); quota(grande, 2500); quota(ab, 800);        // o exemplo do Bruno: "Carioca mil, Grande Rio 2.500"
  const closing = (st: string, v: number, cash?: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, details_json) VALUES (?, ?, ?, ?, 'received', ?, ?)`).run(randomUUID(), T, st, D, v, cash === undefined ? null : JSON.stringify({ dinheiro: cash }));
  closing(carioca, 1100, 300); closing(grande, 2650, 400);          // Avenida Brasil ainda não lançou
  let n = 0;
  const pdv = (filial: string, time: string, valor: number, cash: number) => db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, sale_time, valor, pecas, status, payments_json) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'N', ?)`).run(randomUUID(), T, filial, `b${++n}`, D, time, valor, JSON.stringify({ dinheiro: cash }));
  pdv("1003", "10:30", 500, 100); pdv("1003", "14:15", 550, 180); pdv("1003", "17:00", 300, 50);   // só 1.050 até as 16h

  const morning = Day.morningQuotas(T, D)!, night = Day.nightSnapshot(T, D), aft = Aft.snapshot(T, D, { now: new Date(`${D}T19:30:00Z`) });
  const metaOf = (s: any[], n: string, k: string) => s.find((x: any) => x.storeName === n)?.[k]?.value;
  check("EXEMPLO DO BRUNO (manhã): Carioca R$ 1.000 e Grande Rio R$ 2.500 por loja", metaOf(morning.stores, "Carioca", "meta") === 1000 && metaOf(morning.stores, "Grande Rio", "meta") === 2500);
  check("CONSISTÊNCIA: a cota da manhã = a meta das 16h = a cota da noite (uma fonte só, por loja)", ["Carioca", "Grande Rio", "Avenida Brasil"].every((s) => metaOf(morning.stores, s, "meta") === metaOf(aft.stores, s, "meta") && metaOf(aft.stores, s, "meta") === metaOf(night.stores, s, "cota")));
  check("16h (caixa, parcial): Grande Rio vendeu 1.050 até as 16h (vendas depois não entram) — 42%", metaOf(aft.stores, "Grande Rio", "vendido") === 1050 && metaOf(aft.stores, "Grande Rio", "atingimento") === 42);
  check("noite (folha oficial): Grande Rio 2.650 / cota 2.500 / dinheiro 400; Carioca 1.100 / 1.000", metaOf(night.stores, "Grande Rio", "venda") === 2650 && metaOf(night.stores, "Grande Rio", "dinheiro") === 400 && metaOf(night.stores, "Carioca", "venda") === 1100);
  check("HONESTIDADE: Avenida Brasil sem fechamento = 'aguardando' (nunca R$ 0) e a rede não vira total", night.stores.find((s: any) => s.storeName === "Avenida Brasil")!.venda.state === "unknown" && night.network.venda.state === "not_computed" && !/R\$ 0,00/.test(Day.nightText(night)));
  check("a parcial das 16h e o fechamento da noite rotulam a ORIGEM (caixa × folha) — não se passam um pelo outro", /caixa \(PDV\)/.test(Aft.text(aft)) && /folha/.test(Day.nightText(night)));

  // vendedores
  const seller = (mat: string, name: string, st?: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, ?, ?)`).run(id, T, mat, name); if (st) db.prepare(`INSERT INTO retail_seller_store_assignments (id, organization_id, seller_id, store_id, is_primary, active) VALUES (?, ?, ?, ?, 1, 1)`).run(randomUUID(), T, id, st); return id; };
  const eduL = seller("101", "Eduardo Lázaro", ab), edu = seller("102", "Eduardo", carioca);
  const lohanA = seller("201", "Lohan", grande), lohanB = seller("202", "Lohan Grande Rio", grande);
  const vinR = seller("301", "Vinícius Romão", ab), vinN = seller("302", "Vinícius Nascimento", store("Bangu", "1004"));
  const has = (a: string, b: string, kind: string) => Dup.suggestions(T).some((s) => [s.a.id, s.b.id].includes(a) && [s.a.id, s.b.id].includes(b) && s.kind === kind);
  check("casos do Bruno: Lohan e Eduardo = 'mesma pessoa?'; Vinícius = 'pessoas diferentes?'", has(lohanA, lohanB, "likely") && has(edu, eduL, "likely") && has(vinR, vinN, "check"));
  check("NADA funde sozinho: antes da resposta do dono nenhuma identidade foi unida", (db.prepare(`SELECT COUNT(*) AS c FROM retail_sellers WHERE organization_id = ? AND merged_into_seller_id IS NOT NULL`).get(T) as any).c === 0);
  Dup.markDistinct(T, vinR, vinN);
  Dup.confirmSame(T, lohanA, lohanB, {}, "dono");
  Dup.confirmSame(T, edu, eduL, { coverage: { startDate: "2026-10-01", endDate: "2026-10-20" } }, "dono");
  check("respondido: Vinícius nunca mais é perguntado; Lohan e Eduardo unidos (reversível)", !has(vinR, vinN, "check") && Dup.suggestions(T).length === 0, JSON.stringify(Dup.suggestions(T).map((x) => x.question)));
  check("Eduardo: cobre o Carioca só na janela de férias e volta à Avenida Brasil depois (lotação não virou permanente)", Ident.storeOn(T, eduL, "2026-10-10")?.storeName === "Carioca" && Ident.storeOn(T, eduL, "2026-11-05")?.storeName === "Avenida Brasil");
  Ident.unmerge(T, lohanA, "dono");
  check("reversível: desfazer a fusão do Lohan volta a perguntar", Dup.suggestions(T).some((s) => [s.a.id, s.b.id].includes(lohanA)));

  // estoque
  const prod = (name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', ?, 50, 1, 1)`).run(id, T, name); return id; };
  const pNeg = prod("Camisa Coleção Verão");
  db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, '', -3)`).run(randomUUID(), T, carioca, pNeg);
  const dg = Neg.diagnose(T);
  check("estoque negativo: diagnóstico agrupado em linguagem do gestor (causa não provada = 'sem causa provada', nunca chute)", dg.total === 1 && /1 ocorrência em 1 loja/.test(dg.headline || "") && dg.byCause[0].cause === "no_entry_registered");
  Strat.setStrategy(T, "collection_sellout", "dono");
  check("fim de coleção: produto de coleção sem meta não sugere recompra; voltar ao contínuo reativa", Strat.suggestsRepurchase(T, pNeg) === false && (Strat.setStrategy(T, "continuous_replenishment"), Strat.suggestsRepurchase(T, pNeg) === true));

  // linguagem empresarial (F1.7a) sobre um sinal real do varejo
  Sig.publish(T, { domain: "inventory", signalType: "retail_store_stockout", severity: "risk", basis: "fact", confidence: 1, impactAmount: 12, impactUnit: "units", sourceService: "test", evidence: { store: "Carioca", alerts: 12 }, dedupeKey: "hom:stockout" } as any);
  const pri = Prio.prioritize(T, { globalLimit: 5 }).global.find((p: any) => p.signalType === "retail_store_stockout");
  check("sinal de estoque chega ao dono em linguagem empresarial (sem 'stockout', sem 'Agir', ação específica)", !!pri && /divergência de estoque/i.test(pri.presentation.title) && !/stockout|retail_/.test(JSON.stringify(pri.presentation)) && pri.presentation.actionLabel !== "Agir");

  // ═══ 3. FIAÇÃO DE PRODUÇÃO ═══
  const routes = read("src/server/routes/retailops.ts");
  const need: Array<[string, RegExp]> = [
    ["parcial 16h", /router\.get\("\/afternoon-brief", (?:requireRole\("owner", "admin"\)|requireNetworkScope)/], ["liga 16h", /router\.put\("\/afternoon-brief\/enabled", (?:requireRole|requireNetworkScope)/],
    ["manhã/noite", /router\.get\("\/day-brief", (?:requireRole\("owner", "admin"\)|requireNetworkScope)/], ["liga noite", /router\.put\("\/night-brief\/enabled", (?:requireRole|requireNetworkScope)/],
    ["duplicidade", /"\/sellers\/identity\/suggestions", (?:requireRole|requireNetworkScope)/], ["confirma mesma pessoa", /"\/sellers\/identity\/confirm-same", (?:requireRole|requireNetworkScope)/], ["pessoas diferentes", /"\/sellers\/identity\/not-same", (?:requireRole|requireNetworkScope)/],
    ["diagnóstico negativo", /"\/stock\/negative\/diagnosis"/], ["estratégia (troca só owner/admin)", /router\.put\("\/stock\/replenishment-strategy", (?:requireRole\("owner", "admin"\)|requireNetworkScope)/],
    ["metas por pessoa", /"\/seller-goal-streaks", (?:requireRole\("owner", "admin"\)|requireNetworkScope)/], ["política de comissão", /"\/commission\/policies\/proposals\/:id\/confirm", (?:requireRole\("owner", "admin"\)|requireNetworkScope)/], ["importação por IA (só proposta)", /"\/commission\/policies\/import", (?:requireRole\("owner", "admin"\)|requireNetworkScope)/],
  ];
  for (const [label, re] of need) check(`rota montada (dinheiro/pessoas = owner/admin onde deve): ${label}`, re.test(routes));
  check("a trava de rede exige owner/admin E escopo de rede (gerente de loja = admin com loja atribuída não passa)", /const requireNetworkScope[\s\S]{0,400}\["owner", "admin"\]\.includes\(role\)[\s\S]{0,300}scope\.unrestricted/.test(routes));
  const sched = read("src/server/Scheduler.ts");
  check("Scheduler: parcial 16h e fechamento da noite têm passe no tick", /await this\.retailAfternoonBriefPass\(\)/.test(sched) && /await this\.retailNightBriefPass\(\)/.test(sched));
  check("Scheduler: alerta de metas por pessoa tem passe", /SellerGoalStreakService/.test(sched));
  const cols = (db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[]).map((c) => c.name);
  check("colunas opt-in existem (sem elas o ALTER aditivo não rodou)", ["retail_afternoon_brief_enabled", "retail_night_brief_enabled", "retail_seller_goal_streak_enabled", "retail_replenishment_strategy", "retail_official_sale_source"].every((c) => cols.includes(c)));
  const pkg = JSON.parse(read("package.json")).scripts as Record<string, string>;
  const tests = ["semantic-metric", "retail-code-resolver", "retail-floor-scan", "retail-seller-identity", "retail-seller-identity-aggregation", "seller-duplicates", "retail-commission-policy-status", "seller-goal-streak", "retail-afternoon-brief", "retail-day-brief", "retail-night-slots", "retail-replenishment-strategy", "retail-questions", "commission-import", "signal-language", "unknown-not-zero", "fase1-polish", "fase1-routes", "retail-store-write-scope", "retail-brief-switches", "fase1-homologacao"];
  check("todos os testes da Fase 1 estão no package.json e os arquivos existem", tests.every((t) => !!pkg[`test:${t}`] && fs.existsSync(path.join(process.cwd(), `scripts/test-${t}.ts`))), tests.filter((t) => !pkg[`test:${t}`]).join(","));
  check("runbook de homologação da Fase 1 existe e cobre as chaves, o roteiro e a reversão", /Reversão/.test(read("docs/runbook/fase1-homologacao.md")) && /night-brief\/enabled/.test(read("docs/runbook/fase1-homologacao.md")) && /afternoon-brief\/enabled/.test(read("docs/runbook/fase1-homologacao.md")));

  console.log("\n=== PRD Fase 1 · F1.8: homologação ponta a ponta ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
