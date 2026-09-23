/**
 * TESTE — Plano da corrida POR COMPETÊNCIA (caso Toulon set/26).
 * ----------------------------------------------------------------------------
 * A regra de setembro (P.A mínimo 3,50 vendedor / 4,00 gerente) não pode
 * recalcular agosto (2,50). Prova a resolução por mês:
 *   loja+mês > rede+mês > plano legado da loja > rede legada > default —
 * em especial que o plano MENSAL da rede vence o plano LEGADO da loja no mês
 * configurado (senão "configurar setembro pra rede" silenciosamente não
 * valeria pra loja com plano antigo), e que meses sem competência continuam
 * no legado, sem retroagir nada.
 *
 * Uso:  npm run test:retail-commission-plan-months
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-plan-months-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-plan-months-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailCommissionRaceService, DEFAULT_RACE_PLAN } = await import("../src/server/RetailCommissionRaceService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const loja = randomUUID();
  const clone = () => JSON.parse(JSON.stringify(DEFAULT_RACE_PLAN));

  // ── 0. Sem nada salvo: default, com ou sem month ──
  check("0.1 sem plano salvo → default", RetailCommissionRaceService.getPlan(A, loja).source === "default");
  check("0.2 sem plano salvo com month → default", RetailCommissionRaceService.getPlan(A, loja, "2026-09").source === "default");

  // ── 1. Plano LEGADO da loja (sem competência) ──
  const legacy = clone();
  legacy.seller.monthlyTiers[0].percent = 5;
  RetailCommissionRaceService.savePlan(A, loja, legacy, "tester");
  check("1.1 legado da loja vale sem month", RetailCommissionRaceService.getPlan(A, loja).source === "store" && RetailCommissionRaceService.getPlan(A, loja).plan.seller.monthlyTiers[0].percent === 5);
  check("1.2 legado da loja vale em mês sem competência", RetailCommissionRaceService.getPlan(A, loja, "2026-08").plan.seller.monthlyTiers[0].percent === 5);

  // ── 2. Plano MENSAL da rede (set/26, P.A 3,50/4,00) vence o legado da loja ──
  const september = clone();
  september.seller.monthlyPa.min = 3.5;
  september.seller.weeklyFirstPa.min = 3.5;
  september.manager.monthlyPa.min = 4;
  september.manager.weeklyPa.min = 4;
  RetailCommissionRaceService.savePlan(A, null, september, "tester", "2026-09");
  const sep = RetailCommissionRaceService.getPlan(A, loja, "2026-09");
  check("2.1 rede+mês vence o legado da loja no mês configurado", sep.source === "network" && sep.effectiveMonth === "2026-09" && sep.plan.seller.monthlyPa.min === 3.5 && sep.plan.manager.weeklyPa.min === 4);
  check("2.2 agosto NÃO retroage: continua no legado da loja (P.A 2,50)", RetailCommissionRaceService.getPlan(A, loja, "2026-08").plan.seller.monthlyPa.min === 2.5 && RetailCommissionRaceService.getPlan(A, loja, "2026-08").source === "store");
  check("2.3 sem month, o legado segue intocado", RetailCommissionRaceService.getPlan(A, loja).source === "store");

  // ── 3. Plano MENSAL da loja vence o mensal da rede ──
  const storeSep = clone();
  storeSep.seller.monthlyPa.min = 3.8;
  RetailCommissionRaceService.savePlan(A, loja, storeSep, "tester", "2026-09");
  const sepStore = RetailCommissionRaceService.getPlan(A, loja, "2026-09");
  check("3.1 loja+mês > rede+mês", sepStore.source === "store" && sepStore.effectiveMonth === "2026-09" && sepStore.plan.seller.monthlyPa.min === 3.8);
  check("3.2 outra loja segue na rede+mês", RetailCommissionRaceService.getPlan(A, randomUUID(), "2026-09").plan.seller.monthlyPa.min === 3.5);
  // Regravar a mesma competência substitui (upsert), não duplica.
  storeSep.seller.monthlyPa.min = 3.9;
  RetailCommissionRaceService.savePlan(A, loja, storeSep, "tester", "2026-09");
  check("3.3 regravar a competência substitui", RetailCommissionRaceService.getPlan(A, loja, "2026-09").plan.seller.monthlyPa.min === 3.9);

  // ── 4. Validação e isolamento ──
  let threw = false;
  try { RetailCommissionRaceService.getPlan(A, loja, "set/2026" as any); } catch { threw = true; }
  check("4.1 month inválido é rejeitado", threw);
  threw = false;
  try { RetailCommissionRaceService.savePlan(A, null, clone(), "tester", "2026-9" as any); } catch { threw = true; }
  check("4.2 savePlan com month inválido é rejeitado", threw);
  check("4.3 org B não enxerga competência da A", RetailCommissionRaceService.getPlan(B, loja, "2026-09").source === "default");

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-commission-plan-months: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
