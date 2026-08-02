/**
 * TESTE — Corrida de comissão (ADR-083 Fase G2, modelo CARIOCA) + escala.
 * ---------------------------------------------------------------------------
 * Prova o padrão da planilha do cliente:
 *   - semanas fecham no sábado; começo de mês quebrado (< 4 dias) cola na
 *     semana seguinte (01/08 sábado pertence à 1ª semana 01→08);
 *   - faixa mensal NÃO cumulativa sobre o atingimento da cota individual
 *     (bateu 1% / +10% 1,5% / +20% 2% / +30% 3%) — vale a MAIOR, não a soma;
 *   - sem cota batida, nenhum prêmio condicionado sai;
 *   - P.A (peças ÷ atendimentos ≥ 2,50) paga R$50 mensal SÓ com cota batida;
 *   - corrida semanal: 1º do ranking com cota ganha faixa da semana (+P.A
 *     R$30); 2º com cota ganha 0,5%; 1º SEM cota não ganha nada;
 *   - desvio de cota da REDE: 1º/2º maiores desvios com cota batida ganham
 *     R$250/R$100 (vendedor) — e o ranking considera TODAS as lojas mesmo
 *     filtrando a resposta por uma;
 *   - GERENTE: 1% da loja COM OU SEM cota; faixas maiores só com cota; desvio
 *     entre lojas R$300/R$150;
 *   - cota individual: cadastrada por semana OU derivada da escala (cota
 *     diária da loja ÷ escalados do dia — o "COTA ÷ 4" da folha);
 *   - escala semanal: grava/lê/copia semana; audit; isolamento multi-tenant;
 *   - run draft da corrida reusa a Fase G (aprovação humana).
 *
 * Uso:  npm run test:retail-commission-race
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comm-race-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comm-race-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailCommissionRaceService, DEFAULT_RACE_PLAN } = await import("../src/server/RetailCommissionRaceService.js");
  const { RetailSellerSalesService } = await import("../src/server/RetailSellerSalesService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);

  // ── Semanas (RN-G2-003) ────────────────────────────────────────────────────
  const weeks = RetailCommissionRaceService.weeksOfMonth("2026-08");
  check("agosto/26 tem 5 semanas de corrida", weeks.length === 5, JSON.stringify(weeks));
  check("1ª semana cola o sábado 01/08 (01→08)", weeks[0].start === "2026-08-01" && weeks[0].end === "2026-08-08");
  check("2ª semana dom 09 → sáb 15", weeks[1].start === "2026-08-09" && weeks[1].end === "2026-08-15");
  check("última semana termina em 31/08", weeks[4].end === "2026-08-31");
  const weeksJun = RetailCommissionRaceService.weeksOfMonth("2026-06");
  check("junho/26 (começa 2ª): segmento de 6 dias NÃO cola (semana própria)", weeksJun[0].start === "2026-06-01" && weeksJun[0].end === "2026-06-06", JSON.stringify(weeksJun[0]));

  // ── Cenário: 2 lojas, gerente na loja 1 ───────────────────────────────────
  const loja1 = RetailStoreService.create(A, { name: "Carioca", code: "1" });
  const loja2 = RetailStoreService.create(A, { name: "Nova Iguaçu", code: "2" });
  const gerenteId = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email, password_hash, role) VALUES (?, ?, 'Gabriel Gerente', 'g@x.com', 'x', 'member')`).run(gerenteId, A);
  db.prepare(`UPDATE retail_stores SET manager_user_id = ? WHERE id = ?`).run(gerenteId, loja1.id);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, 'G1', 'Gabriel Gerente', ?)`).run(randomUUID(), A, gerenteId);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'T1', 'Thamyres')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'A1', 'Andressa')`).run(randomUUID(), A);

  // Cotas semanais individuais (planilha: cota POR SEMANA por vendedor).
  // Thamyres: 1.000/semana ×5 = 5.000 no mês. Andressa: 2.000 ×5 = 10.000.
  // Gabriel (gerente vendedor): 1.000 ×5 = 5.000.
  for (const w of weeks) {
    RetailCommissionRaceService.setSellerQuotas(A, loja1.id, w.start, [
      { sellerKey: "mat:T1", sellerName: "Thamyres", amount: 1000 },
      { sellerKey: "mat:A1", sellerName: "Andressa", amount: 2000 },
      { sellerKey: "mat:G1", sellerName: "Gabriel Gerente", amount: 1000 },
    ], "tester");
  }

  // Vendas (lançamento manual da folha, com AT): Thamyres bate 32% acima
  // (5.000 → 6.600) com P.A alto; Andressa NÃO bate (10.000 → 9.000) com P.A
  // alto (não pode ganhar nada); Gabriel vende 5.750 (+15%).
  // Distribui por semana: Thamyres ganha as semanas 1-4; Andressa a 5ª.
  const lancar = (date: string, entries: any[]) =>
    RetailSellerSalesService.bulkCreate(A, { storeId: loja1.id, saleDate: date, entries }, "tester");
  lancar("2026-08-03", [
    { sellerName: "Thamyres", matricula: "T1", valor: 1650, pecas: 30, atendimentos: 10 },
    { sellerName: "Andressa", matricula: "A1", valor: 1200, pecas: 12, atendimentos: 4 },
    { sellerName: "Gabriel Gerente", matricula: "G1", valor: 1437.5, pecas: 20, atendimentos: 8 },
  ]);
  lancar("2026-08-10", [
    { sellerName: "Thamyres", matricula: "T1", valor: 1650, pecas: 30, atendimentos: 10 },
    { sellerName: "Andressa", matricula: "A1", valor: 1300, pecas: 13, atendimentos: 5 },
    { sellerName: "Gabriel Gerente", matricula: "G1", valor: 1437.5, pecas: 20, atendimentos: 8 },
  ]);
  lancar("2026-08-17", [
    { sellerName: "Thamyres", matricula: "T1", valor: 1650, pecas: 30, atendimentos: 10 },
    { sellerName: "Andressa", matricula: "A1", valor: 1500, pecas: 15, atendimentos: 6 },
    { sellerName: "Gabriel Gerente", matricula: "G1", valor: 1437.5, pecas: 20, atendimentos: 8 },
  ]);
  lancar("2026-08-24", [
    { sellerName: "Thamyres", matricula: "T1", valor: 1650, pecas: 30, atendimentos: 10 },
    { sellerName: "Andressa", matricula: "A1", valor: 1800, pecas: 18, atendimentos: 7 },
    { sellerName: "Gabriel Gerente", matricula: "G1", valor: 1437.5, pecas: 20, atendimentos: 8 },
  ]);
  lancar("2026-08-30", [
    { sellerName: "Andressa", matricula: "A1", valor: 3200, pecas: 32, atendimentos: 12 },
  ]);

  // Cota e fechamento da LOJA (pro gerente): cota mensal 15.000, vendido 16.575
  // (bateu, +10,5% → faixa 1,5%).
  const quota = db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, ?)`);
  quota.run(randomUUID(), A, loja1.id, "2026-08-03", 15000);
  const closing = db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, 'approved', ?)`);
  closing.run(randomUUID(), A, loja1.id, "2026-08-03", 16575);

  const race = RetailCommissionRaceService.raceMonth(A, "2026-08");
  const sr = race.stores.find((s: any) => s.storeId === loja1.id);
  const tham = sr.monthly.find((s: any) => s.sellerName === "Thamyres");
  const andressa = sr.monthly.find((s: any) => s.sellerName === "Andressa");
  const gabriel = sr.monthly.find((s: any) => s.sellerName === "Gabriel Gerente");

  // ── Faixas mensais não cumulativas ────────────────────────────────────────
  check("Thamyres: cota mensal 5.000 (soma das semanais)", tham?.quota === 5000, `quota=${tham?.quota}`);
  check("Thamyres: vendeu 6.600 (+32%) → faixa 3% (a MAIOR, não a soma)", tham?.tierPercent === 3, `pct=${tham?.tierPercent}`);
  check("Thamyres: prêmio mensal 3% × 6.600 = 198", tham?.tierAmount === 198, `amount=${tham?.tierAmount}`);
  check("Thamyres: P.A 3.0 ≥ 2,5 com cota → +R$50", tham?.paBonus === 50, `pa=${tham?.pa} bonus=${tham?.paBonus}`);
  check("Gabriel: +15% → faixa 1,5% (não 2%)", gabriel?.tierPercent === 1.5, `pct=${gabriel?.tierPercent} att=${gabriel?.attainment}`);
  check("Andressa: 9.000 < 10.000 → cota NÃO batida, zero faixa", andressa?.tierPercent === 0 && andressa?.tierAmount === 0, `pct=${andressa?.tierPercent}`);
  check("Andressa: P.A alto mas SEM cota → sem bônus P.A", andressa?.paBonus === 0, `bonus=${andressa?.paBonus}`);

  // ── Corrida semanal ───────────────────────────────────────────────────────
  const w1 = sr.weeks[0];
  const w1First = w1.sellers[0];
  check("Semana 1: Thamyres é a 1ª do ranking", w1First?.sellerName === "Thamyres", `1º=${w1First?.sellerName}`);
  check("Semana 1: 1ª com cota batida (1.650 ≥ 1.000, +65% → faixa 3%)", w1First?.prize.percent === 3, `pct=${w1First?.prize.percent}`);
  check("Semana 1: prêmio 3% × 1.650 = 49,50 + P.A R$30", w1First?.prize.amount === 49.5 && w1First?.prize.paBonus === 30, JSON.stringify(w1First?.prize));
  const w1Second = w1.sellers[1];
  check("Semana 1: 2º é Gabriel (1.437,50) com cota → 0,5%", w1Second?.sellerName === "Gabriel Gerente" && w1Second?.prize.percent === 0.5, `2º=${w1Second?.sellerName} pct=${w1Second?.prize.percent}`);
  const w5 = sr.weeks[4];
  const w5First = w5.sellers[0];
  check("Semana 5: Andressa 1ª (3.200 ≥ 2.000) → ganha a semana mesmo sem cota mensal", w5First?.sellerName === "Andressa" && w5First?.prize.amount > 0, JSON.stringify({ n: w5First?.sellerName, p: w5First?.prize }));

  // ── Desvio de cota da rede ────────────────────────────────────────────────
  check("Desvio da rede: Thamyres 1ª (+32%) → R$250", tham?.deviationPrize === 250, `prize=${tham?.deviationPrize}`);
  check("Desvio da rede: Gabriel 2º (+15%) → R$100", gabriel?.deviationPrize === 100, `prize=${gabriel?.deviationPrize}`);
  check("Desvio da rede: Andressa sem cota → sem prêmio de desvio", andressa?.deviationPrize === 0);

  // ── Gerente ───────────────────────────────────────────────────────────────
  const mgr = sr.manager;
  check("Gerente identificado pelo manager_user_id da loja", mgr?.name === "Gabriel Gerente");
  check("Gerente: loja +10,5% com cota → faixa 1,5% sobre 16.575 = 248,63", mgr?.storeTierPercent === 1.5 && mgr?.storeTierAmount === round2(16575 * 0.015), `pct=${mgr?.storeTierPercent} amt=${mgr?.storeTierAmount}`);
  check("Gerente: venda própria +15% → faixa 1,5% de 5.750 = 86,25", mgr?.ownTierPercent === 1.5 && mgr?.ownTierAmount === 86.25, `pct=${mgr?.ownTierPercent} amt=${mgr?.ownTierAmount}`);
  check("Gerente: desvio entre lojas → 1º (única com cota) R$300", mgr?.deviationPrize === 300, `prize=${mgr?.deviationPrize}`);
  check("Gerente: total fecha a soma das partes", mgr?.total === round2(mgr.storeTierAmount + mgr.ownTierAmount + mgr.paBonus + mgr.weeklyTotal + 300), `total=${mgr?.total}`);

  // Gerente SEM cota da loja ainda leva o 1% (min:0 — "com ou sem cota").
  db.prepare(`DELETE FROM retail_store_quotas WHERE organization_id = ? AND store_id = ?`).run(A, loja1.id);
  const raceNoQuota = RetailCommissionRaceService.raceMonth(A, "2026-08");
  const mgrNoQuota = raceNoQuota.stores.find((s: any) => s.storeId === loja1.id).manager;
  check("Gerente sem cota da loja: 1% sai mesmo assim (com ou sem cota)", mgrNoQuota?.storeTierPercent === 1 && mgrNoQuota?.storeTierAmount === round2(16575 * 0.01), `pct=${mgrNoQuota?.storeTierPercent}`);
  check("Gerente sem cota da loja: sem prêmio de desvio entre lojas", mgrNoQuota?.deviationPrize === 0);
  quota.run(randomUUID(), A, loja1.id, "2026-08-03", 15000);

  // ── Escala + cota derivada (o "COTA ÷ 4" da folha) ────────────────────────
  // Loja 2: SEM cota individual cadastrada. Cota diária 2.300 ÷ 2 escalados =
  // 1.150 pra cada no dia; semana com 1 dia escalado → cota semanal 1.150.
  quota.run(randomUUID(), A, loja2.id, "2026-08-10", 2300);
  RetailCommissionRaceService.saveSchedule(A, loja2.id, "2026-08-09", "2026-08-15", [
    { date: "2026-08-10", sellerKey: "nom:rafaela", sellerName: "Rafaela", status: "work" },
    { date: "2026-08-10", sellerKey: "nom:estefanio", sellerName: "Estefânio", status: "work" },
    { date: "2026-08-11", sellerKey: "nom:rafaela", sellerName: "Rafaela", status: "off" },
  ], "tester");
  RetailSellerSalesService.bulkCreate(A, { storeId: loja2.id, saleDate: "2026-08-10", entries: [
    { sellerName: "Rafaela", valor: 1199.4, pecas: 3, atendimentos: 2 },
    { sellerName: "Estefânio", valor: 449.8, pecas: 2, atendimentos: 1 },
  ] }, "tester");
  const race2 = RetailCommissionRaceService.raceMonth(A, "2026-08", { storeId: loja2.id });
  const sr2 = race2.stores[0];
  const rafaela = sr2.monthly.find((s: any) => s.sellerName === "Rafaela");
  const estefanio = sr2.monthly.find((s: any) => s.sellerName === "Estefânio");
  check("Cota derivada da escala: 2.300 ÷ 2 escalados = 1.150", rafaela?.quota === 1150, `quota=${rafaela?.quota} src=${rafaela?.quotaSource}`);
  check("Cota derivada marcada como 'schedule'", rafaela?.quotaSource === "schedule");
  check("Rafaela bateu a derivada (1.199,40 ≥ 1.150) → faixa 1%", rafaela?.tierPercent === 1, `pct=${rafaela?.tierPercent}`);
  check("Estefânio não bateu (449,80 < 1.150) → zero", estefanio?.tierPercent === 0);
  check("Escala expõe dias escalados e folgas", rafaela?.scheduledDays === 1 && rafaela?.offDays === 1, `work=${rafaela?.scheduledDays} off=${rafaela?.offDays}`);
  check("Filtro por loja NÃO esconde o ranking de desvio da rede", race2.networkDeviation.sellers.some((s: any) => s.sellerName === "Thamyres"));

  // Escala: leitura e cópia de semana.
  const sched = RetailCommissionRaceService.getSchedule(A, loja2.id, "2026-08-09", "2026-08-15");
  check("Escala gravada (3 entradas, work/off)", sched.length === 3 && sched.some((e: any) => e.status === "off"));
  RetailCommissionRaceService.copyScheduleWeek(A, loja2.id, "2026-08-09", "2026-08-16", 7, "tester");
  const schedNext = RetailCommissionRaceService.getSchedule(A, loja2.id, "2026-08-16", "2026-08-22");
  check("Copiar semana: mesmas 3 entradas deslocadas +7 dias (10→17, 11→18)", schedNext.length === 3 && schedNext.some((e: any) => e.work_date === "2026-08-18" && e.status === "off"), JSON.stringify(schedNext.map((e: any) => e.work_date)));

  // ── Plano por loja tem precedência sobre o default ────────────────────────
  const custom = JSON.parse(JSON.stringify(DEFAULT_RACE_PLAN));
  custom.seller.monthlyTiers = [{ min: 1.0, percent: 5 }];
  RetailCommissionRaceService.savePlan(A, loja2.id, custom, "tester");
  const planStore = RetailCommissionRaceService.getPlan(A, loja2.id);
  const planNet = RetailCommissionRaceService.getPlan(A, null);
  check("Plano da loja específica tem precedência", planStore.source === "store" && planStore.plan.seller.monthlyTiers[0].percent === 5);
  check("Sem plano da rede cadastrado → default CARIOCA", planNet.source === "default" && planNet.plan.seller.monthlyTiers[3].percent === 3);
  const race2b = RetailCommissionRaceService.raceMonth(A, "2026-08", { storeId: loja2.id });
  const rafaela2 = race2b.stores[0].monthly.find((s: any) => s.sellerName === "Rafaela");
  check("Corrida da loja 2 usa o plano próprio (5%)", rafaela2?.tierPercent === 5, `pct=${rafaela2?.tierPercent}`);

  // ── Run draft (Fase G, aprovação humana) ──────────────────────────────────
  const run = RetailCommissionRaceService.createRaceRun(A, "2026-08", "tester");
  check("Run draft criado com itens da corrida", run?.status === "draft" && Array.isArray(run.items) && run.items.length >= 4, `items=${run?.items?.length}`);
  const runTham = run.items.find((i: any) => i.seller_name === "Thamyres");
  const detail = JSON.parse(runTham?.calculation_details_json || "{}");
  check("Item do run carrega o detalhamento (faixa/P.A/semanal/desvio)", detail.type === "race" && detail.tierPercent === 3 && detail.deviationPrize === 250, JSON.stringify(detail));
  const mgrItem = run.items.find((i: any) => String(i.seller_name || "").includes("(gerente)"));
  check("Run tem o item do gerente", !!mgrItem && Number(mgrItem.commission_amount) > 0);
  const total = run.items.reduce((a: number, i: any) => a + Number(i.commission_amount || 0), 0);
  check("total_commission do run = soma dos itens", Math.abs(Number(run.total_commission) - total) < 0.01, `run=${run.total_commission} sum=${total}`);

  // ── Audit ─────────────────────────────────────────────────────────────────
  const audit = db.prepare(`SELECT event_type, COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? GROUP BY event_type`).all(A) as any[];
  const has = (t: string) => audit.some((a) => a.event_type === t);
  check("Audit: escala, cota, plano e run auditados",
    has("RETAIL_SCHEDULE_SAVED") && has("RETAIL_SELLER_QUOTA_SAVED") && has("RETAIL_COMMISSION_PLAN_SAVED") && has("RETAIL_COMMISSION_RACE_RUN_CREATED"),
    JSON.stringify(audit.map((a) => a.event_type)));

  // ── Isolamento multi-tenant ───────────────────────────────────────────────
  const raceB = RetailCommissionRaceService.raceMonth(B, "2026-08");
  check("Org B não vê lojas/corrida da org A", raceB.stores.length === 0 && raceB.totals.grand === 0);
  const schedB = RetailCommissionRaceService.getSchedule(B, loja2.id, "2026-08-09", "2026-08-15");
  check("Org B não lê a escala da org A", schedB.length === 0);
  const planB = RetailCommissionRaceService.getPlan(B, loja2.id);
  check("Org B não herda o plano da org A", planB.source === "default");

  // ── Saída ─────────────────────────────────────────────────────────────────
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} PASS`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

main().catch((e) => { console.error(e); process.exit(1); });
