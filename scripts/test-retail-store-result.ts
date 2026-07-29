/**
 * TESTE — Custos fixos + RESULTADO/LUCRO por loja (RetailStoreCostService).
 * ---------------------------------------------------------------------------
 * O gestor perguntou onde lançar os custos fixos de cada loja (aluguel, luz,
 * condomínio...) e como isso vira o lucro por loja. Este teste prova:
 *
 *   - upsert dos custos DISCRIMINADOS por tipo (zera categoria com valor <= 0,
 *     ignora categoria desconhecida);
 *   - faturamento do mês vindo dos fechamentos (prefere system_total do PDV,
 *     ignora 'rejected');
 *   - guardrail: SEM margem bruta na loja, resultado e ponto de equilíbrio
 *     ficam NULL (nunca finge lucro subtraindo só o custo fixo do faturamento);
 *   - COM margem: resultado = faturamento×margem − custos fixos; e ponto de
 *     equilíbrio = custos ÷ (margem/100);
 *   - totais da rede somam só as lojas com margem no lucro;
 *   - isolamento multi-tenant.
 *
 * Tudo determinístico e offline (zero-token).
 *
 * Uso:  npm run test:retail-store-result
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-store-result-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-retail-store-result-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailStoreCostService } = await import("../src/server/RetailStoreCostService.js");

  const period = new Date().toISOString().slice(0, 7);

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const loja = RetailStoreService.create(A, { name: "Loja Centro", code: "1" });

  // ── Custos: estado inicial ──────────────────────────────────────────────────
  const c0 = RetailStoreCostService.list(A, loja.id);
  check("sem custos: total 0", c0.total === 0);
  check("sem custos: expõe as 7 categorias zeradas", Object.keys(c0.byCategory).length === 7 && c0.byCategory.aluguel === 0 && c0.byCategory.folha === 0, JSON.stringify(c0.byCategory));

  // ── Upsert discriminado por tipo ───────────────────────────────────────────
  RetailStoreCostService.setMany(A, loja.id, { aluguel: 5000, energia: 800, condominio: 1200, agua: 150, internet: 250, folha: 9000, outros: 600 } as any);
  const c1 = RetailStoreCostService.list(A, loja.id);
  check("custos somam 17000", near(c1.total, 17000), String(c1.total));
  check("aluguel gravado (5000)", c1.byCategory.aluguel === 5000);
  check("folha gravada (9000)", c1.byCategory.folha === 9000);

  // Upsert parcial: valor <= 0 ZERA a categoria; não mexe no que não veio.
  RetailStoreCostService.setMany(A, loja.id, { energia: 0 } as any);
  const c2 = RetailStoreCostService.list(A, loja.id);
  check("energia zerada por valor <= 0", c2.byCategory.energia === 0);
  check("aluguel intacto após upsert parcial", c2.byCategory.aluguel === 5000);
  check("total cai para 16200", near(c2.total, 16200), String(c2.total));

  // Categoria desconhecida é ignorada.
  RetailStoreCostService.setMany(A, loja.id, { imposto: 999 } as any);
  const c3 = RetailStoreCostService.list(A, loja.id);
  check("categoria desconhecida ignorada", (c3.byCategory as any).imposto === undefined && near(c3.total, 16200));

  // Restaura energia para os cálculos seguintes (total volta a 17000).
  RetailStoreCostService.setMany(A, loja.id, { energia: 800 } as any);

  // ── Faturamento dos fechamentos ────────────────────────────────────────────
  const ins = (status: string, informed: number, system: number, day: string) =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), A, loja.id, day, status, informed, system);
  ins("approved", 20000, 0, `${period}-05`);        // usa informed (system 0)
  ins("reconciled", 15000, 15500, `${period}-06`);  // prefere system_total (15500)
  ins("rejected", 99999, 99999, `${period}-07`);    // ignorado
  const fat = RetailStoreCostService.monthlyRevenue(A, loja.id, period);
  check("faturamento = 20000 + 15500 (ignora rejected, prefere system)", near(fat, 35500), String(fat));

  // ── Guardrail: sem margem, não há lucro nem ponto de equilíbrio ─────────────
  const semMargem = RetailStoreCostService.storeResult(A, loja.id, period)!;
  check("sem margem: faturamento presente", near(semMargem.faturamento, 35500));
  check("sem margem: custos presentes (17000)", near(semMargem.custosFixos.total, 17000));
  check("sem margem: hasMargin false", semMargem.hasMargin === false);
  check("sem margem: resultado NULL (não finge lucro)", semMargem.resultado === null);
  check("sem margem: ponto de equilíbrio NULL", semMargem.pontoEquilibrio === null);

  // ── Com margem: lucro e ponto de equilíbrio ─────────────────────────────────
  RetailStoreService.update(A, loja.id, { grossMarginPercent: 50 });
  const comMargem = RetailStoreCostService.storeResult(A, loja.id, period)!;
  // margem contribuição = 35500 × 50% = 17750; resultado = 17750 − 17000 = 750
  check("com margem: margem de contribuição = 17750", near(comMargem.margemContribuicao!, 17750), String(comMargem.margemContribuicao));
  check("com margem: resultado = 750 (lucro)", near(comMargem.resultado!, 750), String(comMargem.resultado));
  // ponto de equilíbrio = 17000 ÷ 0,50 = 34000
  check("com margem: ponto de equilíbrio = 34000", near(comMargem.pontoEquilibrio!, 34000), String(comMargem.pontoEquilibrio));
  check("com margem: progresso > 1 (faturou acima do equilíbrio)", (comMargem.progressoEquilibrio || 0) > 1);
  check("com margem: hasMargin true", comMargem.hasMargin === true);

  // Margem que dá prejuízo (custos > contribuição).
  RetailStoreService.update(A, loja.id, { grossMarginPercent: 20 });
  const prejuizo = RetailStoreCostService.storeResult(A, loja.id, period)!;
  // 35500 × 20% = 7100; 7100 − 17000 = -9900
  check("margem baixa: resultado negativo (prejuízo)", prejuizo.resultado! < 0 && near(prejuizo.resultado!, -9900), String(prejuizo.resultado));

  // Margem clampeada a 0..100 (RetailStoreService.marginOrNull).
  RetailStoreService.update(A, loja.id, { grossMarginPercent: 150 });
  check("margem > 100 é clampeada para 100", RetailStoreService.get(A, loja.id).gross_margin_percent === 100);
  RetailStoreService.update(A, loja.id, { grossMarginPercent: 50 });

  // ── Rede: totais só somam lojas com margem no lucro ──────────────────────────
  const loja2 = RetailStoreService.create(A, { name: "Loja Shopping", code: "2" }); // SEM margem
  RetailStoreCostService.setMany(A, loja2.id, { aluguel: 3000 } as any);
  ins2(db, A, loja2.id, `${period}-08`, 10000);
  const rede = RetailStoreCostService.allStoresResult(A, period);
  check("rede: 2 lojas no perStore", rede.perStore.length === 2);
  check("rede: faturamento total = 45500 (35500 + 10000)", near(rede.totals.faturamento, 45500), String(rede.totals.faturamento));
  check("rede: custos total = 20000 (17000 + 3000)", near(rede.totals.custosFixos, 20000), String(rede.totals.custosFixos));
  // lucro total soma só a loja 1 (loja 2 sem margem → resultado null, fora do total)
  check("rede: lucro total soma só quem tem margem (750)", near(rede.totals.resultado, 750), String(rede.totals.resultado));

  // ── Loja inexistente ────────────────────────────────────────────────────────
  let threw = false;
  try { RetailStoreCostService.setMany(A, "loja-fantasma", { aluguel: 1 } as any); } catch { threw = true; }
  check("setMany em loja inexistente lança erro", threw);
  check("storeResult de loja inexistente é null", RetailStoreCostService.storeResult(A, "loja-fantasma", period) === null);

  // ── Isolamento multi-tenant ─────────────────────────────────────────────────
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("isolamento: org B não vê custos da loja da org A", RetailStoreCostService.list(B, loja.id).total === 0);
  check("isolamento: org B não computa resultado da loja da org A", RetailStoreCostService.storeResult(B, loja.id, period) === null);
  check("isolamento: allStoresResult da org B é vazio", RetailStoreCostService.allStoresResult(B, period).perStore.length === 0);

  console.log("\n=== Custos fixos + resultado/lucro por loja ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

function ins2(db: any, org: string, storeId: string, day: string, informed: number) {
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, ?, 'approved', ?, 0)`)
    .run(randomUUID(), org, storeId, day, informed);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
