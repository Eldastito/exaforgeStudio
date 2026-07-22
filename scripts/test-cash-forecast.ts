/**
 * TEST — Motor de Caixa, projeção de 13 semanas (ADR-125 Fatia 2).
 *
 * Onde o caixa vira prevenção: aponta a 1ª semana de ruptura, dias de
 * sobrevivência, cenários e SEMPRE premissas + confiança. Roda sem chave de IA.
 *
 * Uso: npm run test:cash-forecast
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cashfc-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-cashfc-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

function fmt(dt: Date) { return dt.toISOString().slice(0, 10); }
function mondayOf(d: Date) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const dow = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dow); return x; }
function addDays(dt: Date, n: number) { const x = new Date(dt); x.setUTCDate(x.getUTCDate() + n); return x; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { CashForecastService: C } = await import("../src/server/CashForecastService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);

  const week0 = mondayOf(new Date());
  const inWeek = (w: number) => fmt(addDays(week0, w * 7 + 2)); // 3º dia da semana w

  // Saldo inicial: 1000 no caixa.
  F.recordEvent(orgId, { direction: "in", amount: 1000 });
  // Conta a pagar de 3000 na semana 2 → deve furar o caixa.
  F.addPayable(orgId, { description: "Aluguel", amount: 3000, dueDate: inWeek(2) });
  // Recebível de 500 (prob 1) na semana 1.
  F.addReceivable(orgId, { description: "Cliente", amount: 500, dueDate: inWeek(1), probability: 1 });

  // ===== 1. Estrutura da projeção =====
  const fc = C.forecast(orgId, { minCash: 0 });
  check("projeção tem 13 semanas", fc.weeks.length === 13);
  check("semana 1 abre com o caixa atual (1000)", near(fc.weeks[0].opening, 1000));
  check("recebível cai na semana 1 (inflow 500)", near(fc.weeks[1].inflow, 500));
  check("conta a pagar cai na semana 2 (outflow 3000)", near(fc.weeks[2].outflow, 3000));

  // ===== 2. Encadeamento e ruptura =====
  // sem 0: 1000; sem 1: 1000+500=1500; sem 2: 1500-3000 = -1500 → negativa
  check("saldo encadeia entre semanas", near(fc.weeks[1].ending, 1500) && near(fc.weeks[2].ending, -1500));
  check("ruptura detectada na semana 2", !!fc.firstRisk && fc.firstRisk.weeksAhead === 2 && fc.firstRisk.risk === "negative");

  // ===== 3. Caixa mínimo antecipa a ruptura (tight) =====
  const fcMin = C.forecast(orgId, { minCash: 1200 });
  // sem 0 ending 1000 < 1200 → já é 'tight' na semana 0
  check("caixa mínimo antecipa o alerta (tight na semana 0)", !!fcMin.firstRisk && fcMin.firstRisk.weeksAhead === 0 && fcMin.firstRisk.risk === "tight");

  // ===== 4. Cenários diferem (pessimista recebe menos que otimista) =====
  const pess = fc.scenarios.pessimista.minEnding;
  const otim = fc.scenarios.otimista.minEnding;
  check("cenário pessimista ≤ otimista", pess <= otim);
  check("os 3 cenários vêm no payload", !!fc.scenarios.pessimista && !!fc.scenarios.provavel && !!fc.scenarios.otimista);

  // ===== 5. Premissas + confiança SEMPRE presentes =====
  check("projeção traz premissas explícitas", Array.isArray(fc.assumptions) && fc.assumptions.length >= 2);
  check("projeção traz nível de confiança", ["alta", "media", "baixa"].includes(fc.confidence));
  check("confiança alta quando há caixa+pagar+receber", fc.confidence === "alta" && fc.missing.length === 0);

  // Org sem dados → confiança baixa + checklist do que falta.
  const empty = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), empty);
  const fce = C.forecast(empty, {});
  check("org vazia → confiança baixa", fce.confidence === "baixa" && fce.missing.length >= 2);
  check("org vazia → sem ruptura falsa", fce.firstRisk === null);

  // ===== 6. Recorrência mensal gera vários vencimentos =====
  const org2 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Z', 'active')`).run(randomUUID(), org2);
  F.recordEvent(org2, { direction: "in", amount: 10000 });
  F.addPayable(org2, { description: "Mensalidade", amount: 400, dueDate: inWeek(0), recurrence: "monthly" });
  const fc2 = C.buildWeeks(org2, { scenario: "provavel" });
  const totalOut = fc2.reduce((s, w) => s + w.outflow, 0);
  check("conta mensal gera 3+ vencimentos no trimestre", totalOut >= 1200 - 0.01);

  // ===== 7. Dias de sobrevivência =====
  F.recordEvent(org2, { direction: "out", amount: 300, sourceType: "manual", note: "saída p/ média" });
  const sd = C.survivalDays(org2);
  check("dias de sobrevivência calculados (>0)", sd != null && sd > 0);

  // ===== 8. Snapshot idempotente =====
  C.snapshot(orgId, 0);
  C.snapshot(orgId, 0);
  const snaps = (db.prepare("SELECT COUNT(*) c FROM cash_forecast_weeks WHERE organization_id = ?").get(orgId) as any).c;
  check("snapshot idempotente (13 linhas, 1 por semana)", snaps === 13);

  // ===== 9. Isolamento =====
  check("isolamento: org2 não vê semanas da orgId", (db.prepare("SELECT COUNT(*) c FROM cash_forecast_weeks WHERE organization_id = ?").get(org2) as any).c === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Motor de Caixa — projeção 13 semanas (ADR-125 Fatia 2) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Projeção de caixa OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
