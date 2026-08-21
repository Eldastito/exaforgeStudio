/**
 * TEST — Perdas operacionais na foto de custo (ADR-184 F3). DB-backed, determinístico.
 * Prova: operationalLossesDetail decompõe as perdas PURAS por driver com rótulo canônico
 * (DRIVER_LABEL, fonte única), ordenado desc, exclui desconto/devolucao, honesto sem perda;
 * surge no snapshot dre; NÃO muda o resultado do DRE (0-regressão); isolamento.
 *
 * Uso: npm run test:pnl-operational-losses
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pnlloss-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pnlloss-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const PERIOD = "2026-06";

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PnlCostReconciliationService: COST } = await import("../src/server/PnlCostReconciliationService.js");
  const { FinanceSnapshotAdapter } = await import("../src/server/FinanceSnapshotAdapter.js");
  const { ManagerialDreService } = await import("../src/server/ManagerialDreService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o);

  const mkLoss = (org: string, driver: string, amount: number) =>
    db.prepare(`INSERT INTO loss_events (id, organization_id, period, driver, amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, PERIOD, driver, amount);
  // Perdas puras: furto 100 (maior), merma 30, quebra 20; + dedução de receita: desconto 15, devolucao 10.
  mkLoss(A, "furto", 100); mkLoss(A, "merma", 30); mkLoss(A, "quebra", 20);
  mkLoss(A, "desconto", 15); mkLoss(A, "devolucao", 10);

  const d = COST.operationalLossesDetail(A, PERIOD);

  // ── decomposição por driver ──
  check("1.1 total das perdas puras = 150 (furto+merma+quebra)", d.total === 150);
  check("1.2 exclui desconto/devolucao dos items", !d.items.some((i) => i.driver === "desconto" || i.driver === "devolucao"));
  check("1.3 ordenado desc (furto primeiro)", d.items[0].driver === "furto" && d.items[0].amount === 100);
  check("1.4 rótulo canônico do furto (DRIVER_LABEL)", d.items[0].label === "furto/desvio");
  check("1.5 rótulo canônico da merma", d.items.find((i) => i.driver === "merma")?.label === "merma (perda no preparo)");
  check("1.6 note avisa que não entram no resultado", /NÃO entram no resultado/.test(d.note));

  // ── surge no snapshot dre ──
  const dre = FinanceSnapshotAdapter.build(A, PERIOD).dre;
  check("2.1 snapshot dre carrega operationalLossesDetail", dre.operationalLossesDetail?.total === 150 && Array.isArray(dre.operationalLossesDetail?.items));
  check("2.2 primeiro item do snapshot é furto com rótulo", dre.operationalLossesDetail.items[0].label === "furto/desvio");

  // ── 0-regressão: o resultado do DRE NÃO muda (perdas seguem fora) ──
  const raw = ManagerialDreService.monthly(A, PERIOD);
  check("3.1 resultadoOperacional do DRE inalterado (perdas não descontam)", dre.resultadoOperacional === raw.linhas.resultadoOperacional);

  // ── honesto: sem perda → items vazio, note honesto ──
  const empty = COST.operationalLossesDetail(A, "2019-01");
  check("4.1 período sem perda → total 0, items vazio", empty.total === 0 && empty.items.length === 0);
  check("4.2 note honesto sem perda", /Sem perdas operacionais/.test(empty.note));

  // ── isolamento ──
  const db2 = COST.operationalLossesDetail(B, PERIOD);
  check("5.1 B isolado (sem perdas)", db2.total === 0 && db2.items.length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} pnl-operational-losses: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
