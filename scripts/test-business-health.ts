/**
 * TEST — Central de Saúde e Decisão, síntese (ADR-126 Fatia 1).
 *
 * Status por regra determinística (gatilhos) + top-3 prioridades com impacto em
 * R$, marcação fato×estimativa e ação. Só leitura, isolado por org. Sem IA.
 *
 * Uso: npm run test:business-health
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-health-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-health-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function fmt(dt: Date) { return dt.toISOString().slice(0, 10); }
function mondayOf(d: Date) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const dow = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dow); return x; }
function addDays(dt: Date, n: number) { const x = new Date(dt); x.setUTCDate(x.getUTCDate() + n); return x; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { LossMarginService: L } = await import("../src/server/LossMarginService.js");
  const { BusinessHealthService: H } = await import("../src/server/BusinessHealthService.js");

  const week0 = mondayOf(new Date());
  const inWeek = (w: number) => fmt(addDays(week0, w * 7 + 2));
  const mkOrg = (name: string) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), id, name); return id; };

  // ===== 1. CRÍTICO: ruptura em ≤2 semanas + perda acima da meta =====
  const orgId = mkOrg("Crit");
  F.recordEvent(orgId, { direction: "in", amount: 1000 });         // caixa 1000
  F.addPayable(orgId, { description: "Fornecedor", amount: 3000, dueDate: inWeek(1) }); // fura na semana 1
  // faturamento + perda acima da meta
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'pago', 1000)`).run(randomUUID(), orgId);
  L.setConfig(orgId, 3, "faturamento");
  L.recordLoss(orgId, { driver: "merma", amount: 100 }); // 100/1000 = 10% > 3%

  const ov = H.overview(orgId, 0);
  check("status CRÍTICO com ruptura ≤2 semanas", ov.status === "critico");
  check("gatilho de ruptura aparece", ov.triggers.some((t: any) => t.code === "ruptura_2sem"));
  check("frase-síntese preenchida", typeof ov.synthesis === "string" && ov.synthesis.length > 10);
  check("no máximo 3 prioridades", ov.priorities.length <= 3 && ov.priorities.length >= 2);
  check("prioridades ordenadas por impacto (maior primeiro)", ov.priorities[0].impact >= ov.priorities[1].impact);
  check("prioridade de caixa presente com ação e fato", ov.priorities.some((p: any) => p.source === "caixa" && p.action?.view === "caixa" && p.basis === "fato"));
  check("prioridade de perdas presente (acima da meta)", ov.priorities.some((p: any) => p.source === "perdas" && p.basis === "fato"));
  check("toda prioridade tem impacto, ação e base (fato/estimativa)", ov.priorities.every((p: any) => typeof p.impact === "number" && p.action?.label && ["fato", "estimativa"].includes(p.basis)));

  // ===== 2. RISCO: ruptura no horizonte (>2 semanas), sem crítico =====
  const orgR = mkOrg("Risco");
  F.recordEvent(orgR, { direction: "in", amount: 1000 });
  F.addPayable(orgR, { description: "Conta", amount: 1500, dueDate: inWeek(5) }); // fura na semana 5
  const ovR = H.status(orgR, 0);
  check("status RISCO quando a ruptura é além de 2 semanas", ovR.status === "risco");
  check("não marca crítico sem gatilho crítico", ovR.triggers.every((t: any) => t.level !== "critico"));

  // ===== 3. Recebível vira prioridade de cobrança =====
  const orgC = mkOrg("Receber");
  F.recordEvent(orgC, { direction: "in", amount: 5000 });
  F.addReceivable(orgC, { description: "Cliente", amount: 400, dueDate: inWeek(1), probability: 1 });
  const ovC = H.overview(orgC, 0);
  check("recebível gera prioridade de cobrança", ovC.priorities.some((p: any) => p.source === "recebiveis" && p.impact >= 400));

  // ===== 4. SAUDÁVEL: sem gatilhos =====
  const orgOk = mkOrg("Ok");
  F.recordEvent(orgOk, { direction: "in", amount: 8000 });
  const ovOk = H.overview(orgOk, 0);
  check("status SAUDÁVEL sem gatilhos", ovOk.status === "saudavel");
  check("saudável sem prioridades de risco", ovOk.priorities.length === 0);

  // ===== 5. Org vazia: sem falso alarme + isolamento =====
  const empty = mkOrg("Vazia");
  const ovE = H.overview(empty, 0);
  check("org vazia → saudável, sem prioridades", ovE.status === "saudavel" && ovE.priorities.length === 0);
  check("isolamento: KPIs da org vazia zerados", ovE.kpis.caixaAtual === 0 && ovE.kpis.aReceber === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Central de Saúde e Decisão (ADR-126 Fatia 1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Central de Saúde OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
