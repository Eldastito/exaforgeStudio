/**
 * TESTE — Conferência do mês (folha × caixa) + total do mês = soma das folhas (TOULON, out/2026).
 * ----------------------------------------------------------------------------
 * Caso real: o total do mês da loja no app não batia com a soma das semanas do
 * gerente (Avenida Brasil +R$ 50,01, Grande Rio +R$ 83,91; Carioca batia). O
 * total do mês usava o CAIXA do PDV — sempre (política 'system') ou no dia sem
 * folha (política 'folha' antiga) — e a semana conferida mostrava a FOLHA.
 * Prova:
 *   - política 'folha': total do mês (corrida, previsão, conferência) = Σ folhas;
 *     dia sem folha NÃO vira caixa — aparece como "sem_folha", fora do total;
 *   - a diferença folha × caixa de cada dia fica listada (data, valores, situação);
 *   - Σ semanas = total do mês (mesma régua da corrida);
 *   - política 'system' segue como antes (legado): reproduz o +50,01 / +83,91;
 *   - loja onde folha = caixa todo dia (Carioca) bate nas duas políticas;
 *   - fechamento rejeitado fica fora; loja sem caixa no mês não gera alarme falso;
 *   - isolamento entre orgs + recorte do gerente.
 *
 * Uso:  npm run test:retail-month-check
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-month-check-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-month-check-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const r2 = (x: number) => Math.round(x * 100) / 100;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailMonthCheckService } = await import("../src/server/RetailMonthCheckService.js");
  const { RetailCommissionRaceService } = await import("../src/server/RetailCommissionRaceService.js");
  const { RetailForecastService } = await import("../src/server/RetailForecastService.js");
  const { officialSaleSql } = await import("../src/server/RetailSalesPolicy.js");
  const labels = await import("../src/features/retailops/monthCheckLabels.js");

  const mkOrg = (label: string, src: string) => {
    const id = `org_${label}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, retail_official_sale_source) VALUES (?, ?, ?, 'active', ?)`).run(randomUUID(), id, label, src);
    return id;
  };
  const closing = (org: string, storeId: string, date: string, folha: number, caixa: number, status = "approved") =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), org, storeId, date, status, folha, caixa);

  // Mesmo outubro nas duas orgs: T = 'folha' (TOULON), S = 'system' (legado).
  const seed = (org: string) => {
    const carioca = RetailStoreService.create(org, { name: "Carioca", code: "C1" });
    const grandeRio = RetailStoreService.create(org, { name: "Grande Rio", code: "G1" });
    const avBrasil = RetailStoreService.create(org, { name: "Avenida Brasil", code: "A1" });
    const semCaixa = RetailStoreService.create(org, { name: "Loja Sem Caixa", code: "X1" });
    // Carioca: folha = caixa todo dia.
    closing(org, carioca.id, "2026-10-02", 3000, 3000); closing(org, carioca.id, "2026-10-15", 4000, 4000); closing(org, carioca.id, "2026-10-31", 5000, 5000);
    // Grande Rio: 1 dia com caixa 83,91 acima da folha.
    closing(org, grandeRio.id, "2026-10-05", 2000, 2000); closing(org, grandeRio.id, "2026-10-20", 1000, 1083.91); closing(org, grandeRio.id, "2026-10-30", 1500, 1500);
    // Avenida Brasil: 1 dia SEM folha, caixa 50,01; + 1 fechamento rejeitado.
    closing(org, avBrasil.id, "2026-10-03", 2500, 2500); closing(org, avBrasil.id, "2026-10-12", 0, 50.01); closing(org, avBrasil.id, "2026-10-25", 1800, 1800);
    closing(org, avBrasil.id, "2026-10-26", 999, 0, "rejected");
    // Loja sem caixa do PDV no mês: só folha.
    closing(org, semCaixa.id, "2026-10-10", 700, 0);
    // Fora do mês (não pode entrar).
    closing(org, grandeRio.id, "2026-11-01", 9999, 9999); closing(org, grandeRio.id, "2026-09-30", 8888, 8888);
    return { carioca, grandeRio, avBrasil, semCaixa };
  };
  const T = mkOrg("TOULON", "folha"), t = seed(T);
  const S = mkOrg("LEGADO", "system"), s = seed(S);

  // ── 1. Política 'folha': total do mês = soma das folhas ──
  const mt = RetailMonthCheckService.month(T, "2026-10");
  const st = (m: any, id: string) => m.stores.find((x: any) => x.storeId === id);
  const gr = st(mt, t.grandeRio.id), ab = st(mt, t.avBrasil.id), ca = st(mt, t.carioca.id), sc = st(mt, t.semCaixa.id);
  check("1.1 Grande Rio: total = Σ folha 4.500,00 (caixa não entra)", gr.totals.counted === 4500 && gr.totals.folha === 4500 && gr.totals.countedMinusFolha === 0, JSON.stringify(gr.totals));
  check("1.2 Avenida Brasil: total = Σ folha 4.300,00 (dia sem folha não vira caixa de 50,01)", ab.totals.counted === 4300 && ab.totals.countedMinusFolha === 0, JSON.stringify(ab.totals));
  check("1.3 Carioca bate: total = folha = caixa 12.000,00", ca.totals.counted === 12000 && ca.totals.folha === 12000 && ca.totals.caixa === 12000 && ca.issues.length === 0);
  check("1.4 fonte informada = 'folha'", mt.source === "folha");

  // ── 2. Dias que explicam a diferença ──
  const grDay = gr.issues.find((d: any) => d.date === "2026-10-20");
  check("2.1 Grande Rio 20/10: folha ≠ caixa, folha − caixa = −83,91", grDay?.situation === "folha_diferente_do_caixa" && grDay?.folhaMinusCaixa === -83.91 && grDay?.counted === 1000, JSON.stringify(grDay));
  check("2.2 Grande Rio: só 1 dia a conferir (os iguais não poluem)", gr.issues.length === 1 && gr.counts.folhaDiferenteDoCaixa === 1);
  const abDay = ab.issues.find((d: any) => d.date === "2026-10-12");
  check("2.3 Avenida Brasil 12/10: folha não lançada, caixa 50,01, fora do total", abDay?.situation === "sem_folha" && abDay?.caixa === 50.01 && abDay?.counted === 0, JSON.stringify(abDay));
  const rej = ab.issues.find((d: any) => d.date === "2026-10-26");
  check("2.4 fechamento rejeitado listado e fora de todo total", rej?.situation === "rejeitado" && rej?.counted === 0 && ab.totals.folha === 4300);
  check("2.5 loja sem caixa no mês: caixaAvailable=false e sem alarme 'sem_caixa'", sc.caixaAvailable === false && sc.issues.length === 0 && sc.totals.counted === 700 && sc.totals.folhaMinusCaixa === null);
  check("2.6 Grande Rio folha − caixa do mês = −83,91", gr.totals.folhaMinusCaixa === -83.91);

  // ── 3. Semanas = mês (régua da corrida) ──
  check("3.1 Σ semanas = total do mês em todas as lojas", mt.stores.every((x: any) => x.weeksMatchMonth));
  const weeks = RetailCommissionRaceService.weeksOfMonthFor(T, "2026-10");
  check("3.2 semanas da conferência = semanas da corrida", JSON.stringify(gr.weeks.map((w: any) => [w.start, w.end])) === JSON.stringify(weeks.map((w) => [w.start, w.end])));
  check("3.3 fora do mês (30/09 e 01/11) não entra", gr.totals.folha === 4500 && !gr.issues.some((d: any) => d.date < "2026-10-01" || d.date > "2026-10-31"));

  // ── 4. O resto do app usa o MESMO número (corrida e previsão) ──
  const race = RetailCommissionRaceService.raceMonth(T, "2026-10");
  const raceSales = (id: string) => race.stores.find((x: any) => x.storeId === id)?.store?.sales;
  check("4.1 corrida: loja Grande Rio = 4.500,00 = conferência", raceSales(t.grandeRio.id) === gr.totals.counted, String(raceSales(t.grandeRio.id)));
  check("4.2 corrida: loja Avenida Brasil = 4.300,00 = conferência", raceSales(t.avBrasil.id) === ab.totals.counted, String(raceSales(t.avBrasil.id)));
  const raceWeeksSum = r2((race.stores.find((x: any) => x.storeId === t.grandeRio.id)?.weeks || []).reduce((a: number, w: any) => a + Number(w.storeSales || 0), 0));
  check("4.3 corrida: Σ semanas da loja = mês da loja", raceWeeksSum === raceSales(t.grandeRio.id), String(raceWeeksSum));
  const fc = RetailForecastService.dailyTotals(T, t.avBrasil.id, "2026-10-01", "2026-10-31");
  check("4.4 previsão: dia sem folha (12/10) não entra como venda", !fc.has("2026-10-12") && r2([...fc.values()].reduce((a, b) => a + b, 0)) === 4300);
  check("4.5 regra 'folha' não lê o caixa (sem substituição)", !officialSaleSql("folha").includes("system_total") && officialSaleSql("system").includes("system_total"));

  // ── 5. Política 'system' (legado) intacta: reproduz o sintoma de outubro ──
  const ms = RetailMonthCheckService.month(S, "2026-10");
  const sgr = st(ms, s.grandeRio.id), sab = st(ms, s.avBrasil.id), sca = st(ms, s.carioca.id);
  check("5.1 legado Grande Rio: app = folha + 83,91 (caixa manda)", sgr.totals.counted === 4583.91 && sgr.totals.countedMinusFolha === 83.91, JSON.stringify(sgr.totals));
  check("5.2 legado Avenida Brasil: app = folha + 50,01 (caixa do dia sem folha)", sab.totals.counted === 4350.01 && sab.totals.countedMinusFolha === 50.01, JSON.stringify(sab.totals));
  check("5.3 legado Carioca bate (folha = caixa)", sca.totals.countedMinusFolha === 0);
  const sRace = RetailCommissionRaceService.raceMonth(S, "2026-10").stores.find((x: any) => x.storeId === s.grandeRio.id)?.store?.sales;
  check("5.4 legado: corrida = conferência (mesma conta)", sRace === sgr.totals.counted, String(sRace));

  // ── 6. Isolamento + recorte do gerente ──
  check("6.1 org T não vê lojas da org S", !mt.stores.some((x: any) => [s.grandeRio.id, s.avBrasil.id, s.carioca.id, s.semCaixa.id].includes(x.storeId)));
  const scoped = RetailMonthCheckService.month(T, "2026-10", [t.grandeRio.id]);
  check("6.2 gerente: só a loja dele, total da rede recalculado", scoped.stores.length === 1 && scoped.scoped === true && scoped.network.counted === 4500);
  check("6.3 rede: total = Σ lojas", mt.network.counted === r2(12000 + 4500 + 4300 + 700) && mt.network.countedMinusFolha === 0);
  let threw = false; try { RetailMonthCheckService.month(T, "2026/10"); } catch { threw = true; }
  check("6.4 mês inválido recusado", threw);

  // ── 7. Rótulos da tela (puros) ──
  check("7.1 rótulo 'sem_folha' fala de folha não lançada", labels.situationLabel("sem_folha").includes("folha não lançada"));
  check("7.2 fonte: folha/caixa", labels.sourceLabel("folha") === "Folha do gerente" && labels.sourceLabel("system") === "Caixa do PDV");
  check("7.3 explicação: folha → 'soma das folhas'", labels.storeExplanation(gr, "folha") === "O total do mês é a soma das folhas.");
  check("7.4 explicação: legado com diferença cita o valor", labels.storeExplanation(sgr, "system").includes("83,91"));

  // ── 8. Fiação ──
  const routes = fs.readFileSync(path.join(process.cwd(), "src/server/routes/retailops.ts"), "utf8");
  const iCheck = routes.indexOf(`router.get("/closings/month-check"`), iId = routes.indexOf(`router.get("/closings/:id"`);
  check("8.1 rota /closings/month-check registrada ANTES de /closings/:id", iCheck > 0 && iId > iCheck);
  const view = fs.readFileSync(path.join(process.cwd(), "src/features/RetailOpsView.tsx"), "utf8");
  check("8.2 cartão montado na aba Fechamentos", view.includes("<MonthCheckCard isNetwork={isNetwork} />"));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-month-check: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
