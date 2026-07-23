/**
 * TEST — Índice de Sobrevivência Empresarial (ADR-127 Fatia 1).
 *
 * Placar 0-100 por composição ponderada dos sinais existentes: faixa certa,
 * componente sem dado entra neutro e baixa a confiança, pesos somam 100,
 * snapshot/tendência, isolamento. Sem chave de IA.
 *
 * Uso: npm run test:survival-index
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-survival-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-survival-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function fmt(dt: Date) { return dt.toISOString().slice(0, 10); }
function mondayOf(d: Date) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const dow = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dow); return x; }
function addDays(dt: Date, n: number) { const x = new Date(dt); x.setUTCDate(x.getUTCDate() + n); return x; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { SurvivalIndexService: S } = await import("../src/server/SurvivalIndexService.js");

  const week0 = mondayOf(new Date());
  const inWeek = (w: number) => fmt(addDays(week0, w * 7 + 2));
  const mkOrg = (n: string) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), id, n); return id; };

  // ===== 1. Estrutura: pesos somam 100, score 0-100 =====
  const orgId = mkOrg("Base");
  F.recordEvent(orgId, { direction: "in", amount: 5000 });
  const s = S.score(orgId);
  check("componentes somam peso 100", s.components.reduce((a: number, c: any) => a + c.weight, 0) === 100);
  check("score entre 0 e 100", s.score >= 0 && s.score <= 100);
  check("faixa e rótulo presentes", ["saudavel", "atencao", "risco", "critico"].includes(s.faixa) && typeof s.faixaLabel === "string");
  check("7 componentes", s.components.length === 7);

  // ===== 2. Sem dado entra NEUTRO e baixa a confiança =====
  const est = s.components.find((c: any) => c.key === "estoque");
  check("estoque (sem sinal) entra neutro 50 e hasData=false", est.score === 50 && est.hasData === false);
  check("confiança não é 'alta' com vários componentes sem dado", s.confidence !== "alta");

  // ===== 3. CRÍTICO: caixa em ruptura próxima derruba o índice =====
  const crit = mkOrg("Crit");
  F.recordEvent(crit, { direction: "in", amount: 500 });
  F.addPayable(crit, { description: "Conta", amount: 3000, dueDate: inWeek(1) }); // ruptura na semana 1
  const sc = S.score(crit);
  const caixaComp = sc.components.find((c: any) => c.key === "caixa");
  check("componente caixa pontua baixo na ruptura próxima", caixaComp.score <= 20);
  check("índice do negócio em ruptura fica em risco/crítico", ["risco", "critico"].includes(sc.faixa));

  // ===== 4. SAUDÁVEL: caixa forte, sem ruptura =====
  const ok = mkOrg("Ok");
  F.recordEvent(ok, { direction: "in", amount: 50000 });
  const so = S.score(ok);
  check("caixa forte pontua alto no componente caixa", so.components.find((c: any) => c.key === "caixa").score >= 80);
  check("índice do caixa forte ≥ índice do caixa em ruptura", so.score > sc.score);

  // ===== 4b. Recebíveis VENCIDOS derrubam o componente (ADR-132 Fatia 1) =====
  const orgOd = mkOrg("Vencido"); const orgCur = mkOrg("EmDia");
  for (const o of [orgOd, orgCur]) F.recordEvent(o, { direction: "in", amount: 2000 });
  F.addReceivable(orgOd, { description: "Atrasado", amount: 1000, dueDate: inWeek(-1), probability: 1 });
  F.addReceivable(orgCur, { description: "Futuro", amount: 1000, dueDate: inWeek(2), probability: 1 });
  const rOd = S.score(orgOd).components.find((c: any) => c.key === "recebiveis");
  const rCur = S.score(orgCur).components.find((c: any) => c.key === "recebiveis")?.score ?? 0;
  check("recebível vencido derruba o componente de recebíveis", (rOd?.score ?? 0) < rCur);
  check("componente de recebíveis anota o valor vencido", typeof rOd?.note === "string" && /vencido/i.test(rOd.note));

  // ===== 5. Snapshot + tendência =====
  // grava um snapshot do mês passado para medir a tendência.
  const lastPeriod = (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
  db.prepare(`INSERT INTO survival_index_snapshots (id, organization_id, period, score, faixa, confidence) VALUES (?, ?, ?, ?, 'risco', 'media')`).run(randomUUID(), ok, lastPeriod, so.score - 10);
  const so2 = S.score(ok);
  check("tendência SUBINDO vs snapshot anterior menor", so2.trend === "subindo");
  S.snapshot(orgId); S.snapshot(orgId);
  const snaps = (db.prepare("SELECT COUNT(*) c FROM survival_index_snapshots WHERE organization_id = ?").get(orgId) as any).c;
  check("snapshot do mês idempotente (1 linha)", snaps === 1);

  // ===== 5b. Estoque/capital parado vira componente com dado (Fatia 2) =====
  const orgEstoque = mkOrg("Estoque");
  F.recordEvent(orgEstoque, { direction: "in", amount: 5000 });
  // Faturamento do mês (para o ratio parado/receita).
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'pago', 2000)`).run(randomUUID(), orgEstoque);
  // Muito capital parado (8000) para pouca venda (2000) → componente pontua baixo.
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, 'p1', 100, 80)`).run(randomUUID(), orgEstoque);
  const sEstoque = S.score(orgEstoque);
  const compEstoque = sEstoque.components.find((c: any) => c.key === "estoque");
  check("estoque deixa de ser neutro: tem dado", compEstoque.hasData === true);
  check("muito capital parado vs venda → componente baixo", compEstoque.score < 50);

  // Estoque enxuto (pouco parado) pontua alto.
  const orgEstoqueOk = mkOrg("EstoqueOk");
  F.recordEvent(orgEstoqueOk, { direction: "in", amount: 5000 });
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'pago', 5000)`).run(randomUUID(), orgEstoqueOk);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, 'p1', 10, 50)`).run(randomUUID(), orgEstoqueOk);
  check("estoque enxuto pontua alto", (S.score(orgEstoqueOk).components.find((c: any) => c.key === "estoque")?.score ?? 0) >= 80);

  // Estoque com GIRO recente NÃO é penalizado — mede sem giro, não capital total (ADR-132 Fatia 4).
  const orgGiro = mkOrg("Giro");
  F.recordEvent(orgGiro, { direction: "in", amount: 5000 });
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'pago', 2000)`).run(randomUUID(), orgGiro);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, 'pGiro', 100, 80)`).run(randomUUID(), orgGiro); // 8000 em estoque
  db.prepare(`INSERT INTO stock_movements (id, organization_id, product_service_id, type, quantity) VALUES (?, ?, 'pGiro', 'saida', 5)`).run(randomUUID(), orgGiro); // vendeu hoje → gira
  const compGiro = S.score(orgGiro).components.find((c: any) => c.key === "estoque");
  check("muito capital mas girando → componente NÃO é penalizado", compGiro.score >= 80 && /girando/i.test(compGiro.note));

  // ===== 5c. Histórico do placar =====
  S.snapshot(orgEstoque, "2026-05"); S.snapshot(orgEstoque, "2026-06");
  const withHist = S.scoreWithHistory(orgEstoque);
  check("scoreWithHistory devolve placar + histórico", typeof withHist.score === "number" && Array.isArray(withHist.history) && withHist.history.length >= 2);
  check("histórico ordenado por período (asc)", withHist.history[0].period <= withHist.history[withHist.history.length - 1].period);

  // ===== 6. Isolamento =====
  const empty = mkOrg("Vazia");
  const se = S.score(empty);
  check("org vazia: índice calculável sem quebrar", typeof se.score === "number");
  check("org vazia: confiança baixa", se.confidence === "baixa");

  // --- Relatório ---
  console.log("\n=== TEST: Índice de Sobrevivência (ADR-127 Fatia 1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Índice de Sobrevivência OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
