/**
 * TEST — Empresa × Proprietário (ADR-129 Fatia 1).
 *
 * Retirada tipada: os tipos que saem do caixa geram cash_event (idempotente) e
 * alimentam a linha de Retiradas da DRE; despesa_empresarial é aporte (não tira
 * do caixa). Alerta de excesso + pró-labore sustentável. Sem chave de IA.
 *
 * Uso: npm run test:owner-draws
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-owner-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-owner-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { ManagerialDreService: D } = await import("../src/server/ManagerialDreService.js");
  const { OwnerDrawService: O } = await import("../src/server/OwnerDrawService.js");

  const period = new Date().toISOString().slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);

  // Caixa inicial 2000.
  F.recordEvent(orgId, { direction: "in", amount: 2000 });

  // ===== 1. Retirada que sai do caixa gera saída =====
  const caixaAntes = F.cashOnHand(orgId);
  const d1 = O.record(orgId, { kind: "pro_labore", amount: 500, date: today }) as any;
  check("pró-labore registrado e marcado como saída de caixa", d1.ok && d1.cashOut === true);
  check("caixa caiu 500 (retirada saiu do caixa)", near(F.cashOnHand(orgId), caixaAntes - 500));

  // ===== 2. despesa_empresarial (aporte) NÃO tira do caixa =====
  const caixaPre = F.cashOnHand(orgId);
  const d2 = O.record(orgId, { kind: "despesa_empresarial", amount: 300, date: today }) as any;
  check("despesa_empresarial não sai do caixa (aporte)", d2.ok && d2.cashOut === false && near(F.cashOnHand(orgId), caixaPre));

  // ===== 3. Validações =====
  check("tipo inválido é recusado", O.record(orgId, { kind: "xpto", amount: 100 }).ok === false);
  check("valor inválido é recusado", O.record(orgId, { kind: "distribuicao", amount: 0 }).ok === false);

  // ===== 4. monthlyRetiradas soma só os tipos de saída =====
  O.record(orgId, { kind: "distribuicao", amount: 200, date: today });
  // retiradas do mês = 500 (pró-labore) + 200 (distribuição) = 700; despesa_empresarial fora.
  check("monthlyRetiradas soma só saídas (700)", near(O.monthlyRetiradas(orgId, period), 700));

  // ===== 5. Alimenta a linha de Retiradas da DRE =====
  // cria faturamento/CMV para ter resultado na DRE.
  const oid = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'pago', 3000)`).run(oid, orgId);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', 30, 100, 3000, 10)`).run(randomUUID(), oid, orgId);
  const dre = D.monthly(orgId, period);
  check("DRE: linha de Retiradas deixa de ser 0 (= 700)", near(dre.linhas.retiradas, 700));
  check("DRE: sobra = resultado - retiradas", near(dre.linhas.sobra, dre.linhas.resultadoOperacional - 700));

  // ===== 6. Idempotência do gancho de caixa por source =====
  const drawRow = db.prepare("SELECT id FROM owner_draws WHERE organization_id = ? AND kind='pro_labore' LIMIT 1").get(orgId) as any;
  const dup = F.recordEvent(orgId, { direction: "out", amount: 500, sourceType: "owner_draw", sourceId: drawRow.id });
  check("gancho de caixa é idempotente por source", (dup as any).deduped === true);

  // ===== 7. Summary: % do resultado, alerta e pró-labore sustentável =====
  const sum = O.summary(orgId, period);
  check("summary traz retiradas por tipo", sum.byKind.pro_labore === 500 && sum.byKind.distribuicao === 200 && sum.byKind.despesa_empresarial === 300);
  check("summary calcula % do resultado", typeof sum.pctDoResultado === "number" && sum.pctDoResultado! > 0);
  check("summary sugere pró-labore com premissas", sum.proLaboreSugerido >= 0 && sum.premissas.length >= 2);
  check("summary traz nível de alerta", ["ok", "atencao", "excesso"].includes(sum.alerta.nivel));

  // Excesso: retirar com resultado negativo dispara alerta 'excesso'.
  const org2 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), org2);
  F.recordEvent(org2, { direction: "in", amount: 1000 });
  O.record(org2, { kind: "pro_labore", amount: 400, date: today }); // sem faturamento → resultado 0/neg
  check("alerta de EXCESSO ao retirar sem resultado", O.summary(org2, period).alerta.nivel === "excesso");

  // ===== 8. Isolamento =====
  const empty = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Z', 'active')`).run(randomUUID(), empty);
  const se = O.summary(empty, period);
  check("isolamento: org vazia sem retiradas", se.retiradas === 0 && se.alerta.nivel === "ok");

  // --- Relatório ---
  console.log("\n=== TEST: Empresa × Proprietário (ADR-129 Fatia 1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Empresa × Proprietário OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
