/**
 * TEST — Executive Finance (ADR-190 F7, CEO Operating Layer). O pilar financeiro RICO
 * projetado na moldura executiva (liquidez/recebíveis/rentabilidade/retiradas), como
 * COMPOSIÇÃO PURA sobre o FinanceSnapshotAdapter + default_rate (F2).
 *
 * Cobre: estrutura + basis/scope preservados · default_rate honesto (unavailable sem
 * receivable; % real com receivable) · caveats de escopo · redação de dinheiro (§73 —
 * BRL redigido, %/contagem preservados) · isolamento.
 *
 * Uso: npm run test:executive-finance
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-efin-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-efin-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExecutiveFinanceService: F } = await import("../src/server/ExecutiveFinanceService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), A);

  // ── 1. Org vazia: estrutura completa + honestidade ──
  const f0 = F.read(A);
  check("1.1 available true (financeiro é o braço mais consolidado)", f0.available === true);
  check("1.2 blocos presentes", !!f0.liquidity && !!f0.receivables && !!f0.payables && !!f0.profitability);
  check("1.3 caixa é fact (basis preservado do adapter)", f0.liquidity?.cashBasis === "fact");
  check("1.4 default_rate unavailable sem receivable (honesto, não 0)", f0.receivables?.defaultRatePct === null && f0.receivables?.defaultRateAvailability === "unavailable");
  check("1.5 caveats de escopo presentes (core × all_channels)", f0.caveats.some((c) => c.includes("core")));
  check("1.6 rentabilidade traz escopo core", f0.profitability?.scope === "core");

  // ── 2. Recebíveis (um a vencer, um vencido) → default_rate disponível + real ──
  db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'A vencer', 1000, '2026-12-31', 'open')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'Vencido', 500, '2026-01-01', 'open')`).run(randomUUID(), A);
  const f1 = F.read(A);
  check("2.1 default_rate agora available", f1.receivables?.defaultRateAvailability === "available");
  check("2.2 inadimplência = vencido÷total = 500/1500 ≈ 33.3%", Math.abs((f1.receivables?.defaultRatePct ?? 0) - 33.3) < 0.5);
  check("2.3 a receber total = 1500 (fact)", f1.receivables?.total === 1500 && f1.receivables?.overdue === 500);

  // ── 3. Redação de dinheiro (§73): BRL redigido; %/contagem preservados ──
  const fR = F.read(A, { includeMoney: false });
  check("3.1 valores BRL redigidos (a receber/vencido null)", fR.receivables?.total === null && fR.receivables?.overdue === null);
  check("3.2 caixa BRL redigido", fR.liquidity?.cash === null);
  check("3.3 inadimplência (%) PRESERVADA (não é dinheiro)", Math.abs((fR.receivables?.defaultRatePct ?? 0) - 33.3) < 0.5);
  check("3.4 contagem de vencidos PRESERVADA (não é dinheiro)", fR.receivables?.overdueCount === 1);
  check("3.5 marcado redacted", fR.redacted === true);
  // default (true) mantém os valores.
  check("3.6 default expõe R$", f1.receivables?.total === 1500);

  // ── 4. Isolamento multi-tenant ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Outra', 'active')`).run(randomUUID(), B);
  const fB = F.read(B);
  check("4.1 org B não vê recebíveis de A", fB.receivables?.total === 0 && fB.receivables?.defaultRateAvailability === "unavailable");

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} executive-finance: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
