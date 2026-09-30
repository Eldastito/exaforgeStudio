/**
 * TESTE — PRD Fase 1, F1.5: meses CONSECUTIVOS abaixo da meta por PESSOA
 * Prova: escala 🟡1 / 🟠2 / 🔴3+; bater a meta quebra a sequência (82/103/79 = 1º mês); mês sem meta ou com
 * férias/afastamento inteiros é NEUTRO (a sequência atravessa, nunca vira "meta não batida"); pessoa em 2
 * lojas soma vendas e cotas; fusão de identidade (F1.1b) vale; mês corrente não conta; matrícula
 * não identificada nunca gera alerta nominal; sinal no ledger só com % (sem R$), idempotente e auto-resolvido;
 * alerta proativo é opt-in; atingimento é Metric (meta ausente ≠ 0%); isolamento multi-tenant.
 * Uso:  npm run test:seller-goal-streak
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-goal-streak-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-goal-streak-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const throws = (fn: () => any, re: RegExp) => { try { fn(); return false; } catch (e: any) { return re.test(e.message); } };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SellerGoalStreakService: G } = await import("../src/server/SellerGoalStreakService.js");
  const { RetailSellerAbsenceService: Abs } = await import("../src/server/RetailSellerAbsenceService.js");
  const { RetailSellerIdentityService: Id } = await import("../src/server/RetailSellerIdentityService.js");
  const { RetailCommissionRaceService: R } = await import("../src/server/RetailCommissionRaceService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, code); return id; };
  const seller = (org: string, mat: string, name: string | null) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, ?, ?)`).run(id, org, mat, name); return id; };
  const carioca = store(A, "Carioca", "1002"), bangu = store(A, "Bangu", "1003");
  const pdv = (org: string, filial: string, cod: string, ym: string, valor: number) =>
    db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, valor, pecas, status, vendedor_codigo) VALUES (?, ?, ?, ?, ?, ?, 1, 'N', ?)`).run(randomUUID(), org, filial, randomUUID().slice(0, 8), `${ym}-05`, valor, cod);
  const quota = (org: string, storeId: string, ym: string, mat: string, name: string, amount: number) =>
    R.setSellerQuotas(org, storeId, R.weeksOfMonthFor(org, ym)[0].start, [{ sellerKey: `mat:${mat}`, sellerName: name, amount }], "u-owner");
  /** vendedor com cota 1000 e venda por mês (null = sem meta cadastrada naquele mês) */
  const scenario = (org: string, storeId: string, filial: string, mat: string, name: string, byMonth: Record<string, number | null>) => {
    for (const [ym, sales] of Object.entries(byMonth)) { if (sales === null) continue; quota(org, storeId, ym, mat, name, 1000); if (sales > 0) pdv(org, filial, mat, ym, sales); }
  };

  const kleyton = seller(A, "K1", "Kleyton Cunha"), vin = seller(A, "VN", "Vinícius Nascimento"), gab = seller(A, "GF", "Gabriel Farias"), ana = seller(A, "AN", "Ana");
  const bia = seller(A, "BI", "Bia Férias"), carlos = seller(A, "C1", "Carlos");
  scenario(A, carioca, "1002", "K1", "Kleyton Cunha", { "2026-07": 810, "2026-08": 760, "2026-09": 690 });   // 3º mês 🔴 (abr-jun sem meta: neutro)
  scenario(A, carioca, "1002", "VN", "Vinícius Nascimento", { "2026-07": 1050, "2026-08": 830, "2026-09": 790 }); // 2º mês 🟠 (jul bateu)
  scenario(A, carioca, "1002", "GF", "Gabriel Farias", { "2026-08": 1030, "2026-09": 740 });                     // 1º mês 🟡
  scenario(A, carioca, "1002", "AN", "Ana", { "2026-07": 820, "2026-08": 1030, "2026-09": 790 });                // ago quebra: 1º mês
  scenario(A, carioca, "1002", "BI", "Bia Férias", { "2026-07": 800, "2026-08": 300, "2026-09": 700 });          // sem férias: 3 meses abaixo
  // Carlos atua em 2 lojas: cota 500+500, vende 400 (Carioca) + 500 (Bangu) em set → 900/1000 abaixo (por loja: 400<500 e 500>=500)
  for (const [st, fil, v] of [[carioca, "1002", 400], [bangu, "1003", 500]] as const) { quota(A, st, "2026-09", "C1", "Carlos", 500); pdv(A, fil, "C1", "2026-09", v); }
  // matrícula NÃO identificada (sem nome) abaixo 3 meses
  for (const ym of ["2026-07", "2026-08", "2026-09"]) { quota(A, carioca, ym, "99999", "Matrícula 99999", 1000); pdv(A, "1002", "99999", ym, 500); }
  seller(A, "99999", null);
  // mês CORRENTE (out) muito abaixo: não pode contar
  pdv(A, "1002", "GF", "2026-10", 10); quota(A, carioca, "2026-10", "GF", "Gabriel Farias", 1000);

  const REF = "2026-10-15";
  const a = G.assess(A, REF);
  const P = (name: string) => a.people.find((p: any) => p.name === name)!;
  check("meses avaliados = 6 fechados (set..abr); o corrente NÃO entra", a.months.join() === "2026-09,2026-08,2026-07,2026-06,2026-05,2026-04");
  check("Kleyton: 3 meses consecutivos → 🔴 action (abr-jun sem meta são neutros)", P("Kleyton Cunha").streak === 3 && P("Kleyton Cunha").level === "action" && P("Kleyton Cunha").color === "red");
  check("Vinícius Nascimento: 2º mês → 🟠 critical + oferta de análise (Jul bateu e encerra)", P("Vinícius Nascimento").streak === 2 && P("Vinícius Nascimento").level === "critical" && P("Vinícius Nascimento").color === "orange" && P("Vinícius Nascimento").offerAnalysis === true);
  check("Gabriel: 1º mês → 🟡 attention, sem oferta (mês corrente abaixo NÃO conta)", P("Gabriel Farias").streak === 1 && P("Gabriel Farias").level === "attention" && P("Gabriel Farias").offerAnalysis === false);
  check("Ana 82/103/79: agosto bateu e QUEBRA → 1º mês (não 2)", P("Ana").streak === 1);
  check("mês sem meta é 'no_goal' e o atingimento é N/A (nunca 0%)", P("Kleyton Cunha").months.find((m: any) => m.month === "2026-06")!.status === "no_goal" && P("Kleyton Cunha").months.find((m: any) => m.month === "2026-06")!.attainment.state === "not_applicable");
  const setM = P("Kleyton Cunha").months.find((m: any) => m.month === "2026-09")!;
  check("atingimento de mês avaliado é Metric conhecida em % (690/1000 = 69%)", setM.status === "below" && setM.attainment.state === "value" && setM.attainment.value === 69 && setM.attainment.unit === "pct");
  check("nível ok quando bateu: pessoa cuja sequência é 0 não tem cor", (() => { const o = a.people.find((p: any) => p.streak === 0); return !o || (o.level === "none" && o.color === null); })());

  // ── pessoa em 2 lojas: soma ──
  check("Carlos (2 lojas): vendas e cotas SOMADAS por pessoa → 900/1000 abaixo (por loja isolada uma loja bateria)", P("Carlos").streak === 1 && P("Carlos").months[0].attainment.value === 90);

  // ── não identificada ──
  const un = a.people.find((p: any) => p.identified === false && p.streak === 3);
  check("matrícula sem nome: mede, mas NÃO é identificada e conta em skippedUnidentified", !!un && a.skippedUnidentified >= 1);
  const txt = G.briefText(a)!;
  check("briefText nomeia só IDENTIFICADOS, na linguagem do gestor, sem R$", /Kleyton Cunha/.test(txt) && !/99999/.test(txt) && !/R\$/.test(txt) && /🔴 3º mês consecutivo abaixo da meta/.test(txt) && /🟠 2º mês consecutivo/.test(txt) && /🟡 1º mês/.test(txt));
  check("briefText lista os meses da sequência (Julho 81%, Agosto 76%, Setembro 69%) e oferece análise do 2º mês em diante", /Julho — 81%/.test(txt) && /Agosto — 76%/.test(txt) && /Setembro — 69%/.test(txt) && (txt.match(/Posso analisar o desempenho/g) || []).length === 3);
  check("sem ninguém abaixo → briefText null (nada de ruído)", G.briefText({ people: [] }) === null);

  // ── ausências: férias tornam o mês NEUTRO ──
  check("Bia sem férias: jul/ago/set abaixo → 3º mês", P("Bia Férias").streak === 3);
  check("ausência exige vendedor existente, tipo e datas válidos", throws(() => Abs.add(A, { sellerId: randomUUID(), type: "ferias", startDate: "2026-08-01", endDate: "2026-08-31" }), /não encontrado/) && throws(() => Abs.add(A, { sellerId: bia, type: "licenca" as any, startDate: "2026-08-01", endDate: "2026-08-31" }), /type inválido/) && throws(() => Abs.add(A, { sellerId: bia, type: "ferias", startDate: "2026-08-31", endDate: "2026-08-01" }), /anterior/));
  const partial = Abs.add(A, { sellerId: bia, type: "ferias", startDate: "2026-08-01", endDate: "2026-08-10" }, "u-owner");
  check("férias PARCIAIS (10 dias) não tornam o mês inelegível — segue avaliado", G.assess(A, REF).people.find((p: any) => p.name === "Bia Férias")!.streak === 3 && Abs.daysAbsentInMonth(A, bia, "2026-08") === 10);
  Abs.add(A, { sellerId: bia, type: "ferias", startDate: "2026-07-25", endDate: "2026-09-02" }, "u-owner"); // cobre ago inteiro (e pontas de jul/set)
  const bia2 = G.assess(A, REF).people.find((p: any) => p.name === "Bia Férias")!;
  const biaAug = bia2.months.find((m: any) => m.month === "2026-08")!;
  check("férias do mês INTEIRO: agosto vira 'absent' (neutro) e a sequência ATRAVESSA (set + jul = 2, não 3)", biaAug.status === "absent" && bia2.streak === 2 && biaAug.absentDays === 31);
  check("sobreposição de ausências não conta o mesmo dia 2x", Abs.daysAbsentInMonth(A, bia, "2026-08") === 31 && Abs.daysAbsentInMonth(A, bia, "2026-09") === 2);
  check("cancelar ausência é soft (UPDATE) e devolve o mês a ser avaliado", Abs.cancel(A, Abs.list(A, bia).find((x: any) => x.start_date === "2026-07-25").id, "u-owner") === true && G.assess(A, REF).people.find((p: any) => p.name === "Bia Férias")!.streak === 3 && Abs.list(A, bia).length === 2 && Abs.cancel(A, partial.id) === true);

  // ── fusão de identidade (F1.1b) ──
  const lg = seller(A, "1002-LG", "Lohan Grande Rio"), lx = seller(A, "1002-LX", "LOHAN");
  quota(A, carioca, "2026-09", "1002-LG", "Lohan Grande Rio", 1000); pdv(A, "1002", "1002-LG", "2026-09", 400); pdv(A, "1002", "1002-LX", "2026-09", 500);
  Id.mergeSellers(A, lx, lg, "u-owner");
  const lohan = G.assess(A, REF).people.filter((p: any) => /lohan/i.test(p.name));
  check("fusão: UMA pessoa (Lohan Grande Rio) com 400 + 500 = 90% (não 2 pessoas)", lohan.length === 1 && lohan[0].months[0].attainment.value === 90 && lohan[0].streak === 1);

  // ── sinais no ledger ──
  check("alerta proativo é OPT-IN: pass() com flag desligada não publica", (() => { G.pass(new Date("2026-10-15T12:00:00Z")); return (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = 'seller_goal_streak'`).get(A) as any).n === 0; })());
  const pub = G.publish(A, REF);
  const sigs = db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND signal_type = 'seller_goal_streak'`).all(A) as any[];
  const sigOf = (name: string) => sigs.find((s: any) => JSON.parse(s.evidence_json).seller === name);
  check("publish: só IDENTIFICADOS com sequência ≥1 (Kleyton, Vinícius, Gabriel, Ana, Bia, Carlos, Lohan); a matrícula 99999 fica de fora", pub.published >= 6 && !sigs.some((s: any) => /99999/.test(s.evidence_json)) && pub.skippedUnidentified >= 1);
  check("severidade pela escala: 3º mês = risk, 2º = attention, 1º = info (acompanhamento não grita)", sigOf("Kleyton Cunha").severity === "risk" && sigOf("Vinícius Nascimento").severity === "attention" && sigOf("Gabriel Farias").severity === "info");
  const ev = JSON.parse(sigOf("Kleyton Cunha").evidence_json);
  check("sinal traz só FATOS em % (meses + atingimento) — sem R$/vendas/cota (dinheiro é role-gated)", ev.months.length === 3 && ev.months[0].attainmentPct === 69 && !/sales|quota|valor|R\$/i.test(sigOf("Kleyton Cunha").evidence_json) && sigOf("Kleyton Cunha").basis === "fact" && sigOf("Kleyton Cunha").impact_amount === null);
  const before = sigs.length;
  G.publish(A, REF);
  check("publicar de novo é idempotente (mesmas linhas)", (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = 'seller_goal_streak'`).get(A) as any).n === before);

  // ── flag + scheduler ──
  G.setEnabled(A, true);
  G.pass(new Date("2026-10-15T12:00:00Z"));
  check("com a flag ligada o pass() do Scheduler roda; 2x no mesmo dia não repete", G.enabled(A) === true && (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = 'seller_goal_streak'`).get(A) as any).n === before);

  // ── auto-resolve: no mês seguinte o Gabriel bate a meta (out) e a sequência quebra ──
  pdv(A, "1002", "GF", "2026-10", 1500);
  quota(A, carioca, "2026-10", "K1", "Kleyton Cunha", 1000); pdv(A, "1002", "K1", "2026-10", 500);
  const pub2 = G.publish(A, "2026-11-15");
  const gabSig = db.prepare(`SELECT status FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(A, `seller_goal_streak|${gab}`) as any;
  const kleySig = db.prepare(`SELECT status, evidence_json FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(A, `seller_goal_streak|${kleyton}`) as any;
  check("auto-resolve: Gabriel bateu a meta em out → sinal resolvido", gabSig.status === "resolved" && pub2.resolved >= 1);
  check("Kleyton segue e a sequência cresce (out abaixo → 4º mês) no mesmo sinal", kleySig.status === "open" && JSON.parse(kleySig.evidence_json).streak === 4);
  void ana;

  // ── isolamento ──
  const bCar = store(B, "Carioca B", "1002"); seller(B, "K1", "Kleyton Cunha");
  const aB = G.assess(B, REF);
  check("isolamento: org B não vê pessoas/ausências/sinais da A", aB.people.length === 0 && Abs.list(B).length === 0 && (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = 'seller_goal_streak'`).get(B) as any).n === 0 && bCar.length > 0);
  check("isolamento: não dá pra lançar ausência em vendedor de outra org", throws(() => Abs.add(B, { sellerId: kleyton, type: "ferias", startDate: "2026-08-01", endDate: "2026-08-31" }), /não encontrado/));

  console.log("\n=== PRD Fase 1 · F1.5: meses consecutivos abaixo da meta por pessoa ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
