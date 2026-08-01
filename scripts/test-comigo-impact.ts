/**
 * TEST — Comigo/Impact (Gap E do levantamento autônomos, ADR-088 D8).
 *
 * Prova, offline e em banco temporário:
 *   - captureBaselineIfNeeded é idempotente (grava só na 1ª vez)
 *   - summary sem vendas: provenBRL=0, orders=0, cta.show=false
 *   - summary com vendas paid/done: profit/revenue/orders corretos
 *   - fiado a receber é reportado sem entrar no provenBRL (sem dupla contagem)
 *   - CTA aparece quando profit >= threshold E billing_status "não pagante"
 *   - CTA some quando billing_status = 'active' (org já paga)
 *   - CTA some quando profit < threshold
 *   - Isolamento cross-tenant: baseline + números por org
 *
 * Uso:  npm run test:comigo-impact
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-impact-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-impact-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoImpactService, _internals } = await import("../src/server/ComigoImpactService.js");

  // ── Setup: 2 orgs (isolamento) — orgA trialing (não pagante), orgB active (paga) ─
  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'Loja A', 'active', 'autonomo', 'trialing')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'Loja B', 'active', 'autonomo', 'active')`).run(randomUUID(), orgB);

  const prodA = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Água', 5, 1)`).run(prodA, orgA);

  // ── 1. Baseline idempotente ─────────────────────────────────────────────
  // Captura em 2026-08-01 (o dia zero do módulo). "Agora" no teste = 2026-08-15;
  // vendas vão entre baseline e agora — a janela derived-only vai incluí-las.
  const baselineMs = Date.UTC(2026, 7, 1, 0, 0, 0);
  const now = Date.UTC(2026, 7, 15, 12, 0, 0);
  const baseline1 = ComigoImpactService.captureBaselineIfNeeded(orgA, baselineMs);
  check("baseline gravado", !!baseline1);
  const rowAfter = (db.prepare("SELECT comigo_impact_baseline_at FROM organization_settings WHERE organization_id = ?").get(orgA) as any).comigo_impact_baseline_at;
  check("baseline persistido no organization_settings", rowAfter === baseline1);

  const later = Date.UTC(2027, 0, 1, 0, 0, 0);
  const baseline2 = ComigoImpactService.captureBaselineIfNeeded(orgA, later);
  check("captureBaselineIfNeeded é idempotente (não sobrescreve)", baseline2 === baseline1);

  // orgB baseline em data diferente (pra isolamento no §8)
  ComigoImpactService.captureBaselineIfNeeded(orgB, Date.UTC(2026, 5, 1, 0, 0, 0));

  // ── 2. Summary sem vendas ───────────────────────────────────────────────
  const s0 = ComigoImpactService.summary(orgA, now);
  check("summary sem vendas: proven=0", near(s0.provenBRL, 0));
  check("summary sem vendas: revenue=0", near(s0.revenueBRL, 0));
  check("summary sem vendas: orders=0", s0.ordersCount === 0);
  check("summary sem vendas: fiado=0", near(s0.fiadoBalanceBRL, 0));
  check("summary sem vendas: cta escondido", s0.cta.show === false);
  check("summary sem vendas: cta.planId = autonomo", s0.cta.planId === "autonomo");
  check("summary sem vendas: cta.planName = Autônomo", s0.cta.planName === "Autônomo");

  // ── 3. Injeta vendas pagas + fiado, testa números ────────────────────────
  function paidOrder(orgId: string, paidVia: string, createdAt: string, items: Array<{ name: string; qty: number; price: number; cost: number }>) {
    const orderId = randomUUID();
    const total = items.reduce((s, it) => s + it.qty * it.price, 0);
    db.prepare(
      `INSERT INTO comigo_orders (id, organization_id, status, paid_via, source, total, created_at, paid_at) VALUES (?, ?, 'paid', ?, 'balcao', ?, ?, ?)`
    ).run(orderId, orgId, paidVia, total, createdAt, createdAt);
    for (const it of items) {
      db.prepare(
        `INSERT INTO comigo_order_items (id, order_id, product_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), orderId, prodA, it.name, it.qty, it.price, it.cost);
    }
  }

  // 2 pedidos pagos: 100/40 (lucro 60) + 200/80 (lucro 120) = revenue 300 / profit 180
  paidOrder(orgA, "cash", "2026-08-10 10:00:00", [
    { name: "Água", qty: 10, price: 10, cost: 4 },
  ]);
  paidOrder(orgA, "pix_manual", "2026-08-12 15:00:00", [
    { name: "Água", qty: 20, price: 10, cost: 4 },
  ]);

  // Fiado: dívida 250 + pagamento 50 → saldo 200
  db.prepare(
    `INSERT INTO comigo_fiado_ledger (id, organization_id, contact_id, kind, amount, created_at) VALUES (?, ?, ?, 'debt', 250, '2026-08-11 12:00:00')`
  ).run(randomUUID(), orgA, randomUUID());
  db.prepare(
    `INSERT INTO comigo_fiado_ledger (id, organization_id, contact_id, kind, amount, created_at) VALUES (?, ?, ?, 'payment', 50, '2026-08-13 09:00:00')`
  ).run(randomUUID(), orgA, randomUUID());

  const s1 = ComigoImpactService.summary(orgA, now);
  check("summary com vendas: revenue=300", near(s1.revenueBRL, 300));
  check("summary com vendas: proven=180 (lucro)", near(s1.provenBRL, 180));
  check("summary com vendas: orders=2", s1.ordersCount === 2);
  check("summary com vendas: fiado=200 (saldo, não entra no proven)", near(s1.fiadoBalanceBRL, 200));
  check("proven NÃO conta o fiado (sem dupla contagem)", !near(s1.provenBRL, 380));

  // ── 4. CTA condicional ao threshold ─────────────────────────────────────
  // 180 < 400 → CTA escondido (mesmo com trialing)
  check("proven 180 < threshold 400: cta escondido", s1.cta.show === false);

  // Sobe pra 500 de lucro (adiciona pedido de lucro 320)
  paidOrder(orgA, "cash", "2026-08-14 10:00:00", [
    { name: "Água", qty: 40, price: 10, cost: 2 },
  ]); // revenue 400 / custo 80 / lucro 320 → total lucro 180+320 = 500

  const s2 = ComigoImpactService.summary(orgA, now);
  check("agora proven=500", near(s2.provenBRL, 500));
  check("proven >= 400 E trialing: CTA aparece", s2.cta.show === true);
  check("cta.reason menciona trial", /trial/i.test(s2.cta.reason));

  // ── 5. Org "active" não vê CTA mesmo com valor provado alto ─────────────
  // Injeta as MESMAS vendas na orgB (que está 'active')
  const prodB = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Água', 10, 1)`).run(prodB, orgB);
  paidOrder(orgB, "cash", "2026-08-10 10:00:00", [
    { name: "Água", qty: 100, price: 10, cost: 2 },  // lucro 800
  ]);
  const sB = ComigoImpactService.summary(orgB, now);
  check("orgB (active): proven acima do threshold", sB.provenBRL >= 400);
  check("orgB (active): CTA continua escondido (já paga)", sB.cta.show === false);
  check("orgB (active): reason explica 'já é assinante'", /assinante/i.test(sB.cta.reason));

  // ── 6. Estados de billing sem plano ─────────────────────────────────────
  const orgC = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, billing_status) VALUES (?, ?, 'Loja C', 'active', 'blocked')`).run(randomUUID(), orgC);
  const prodC = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'X', 10, 1)`).run(prodC, orgC);
  ComigoImpactService.captureBaselineIfNeeded(orgC, Date.UTC(2026, 6, 15, 0, 0, 0));
  paidOrder(orgC, "cash", "2026-08-01 10:00:00", [
    { name: "X", qty: 100, price: 10, cost: 2 },  // lucro 800
  ]);
  const sC = ComigoImpactService.summary(orgC, now);
  check("orgC (blocked) com proven alto: CTA aparece", sC.cta.show === true);

  // ── 7. Threshold constant sanity check ──────────────────────────────────
  check("CTA_MIN_PROVEN_BRL exportado = 400", _internals.CTA_MIN_PROVEN_BRL === 400);
  check("'active' NÃO é considerado não-pagante", !_internals.NON_PAYING_STATUSES.has("active"));
  check("'trialing' É considerado não-pagante", _internals.NON_PAYING_STATUSES.has("trialing"));

  // ── 8. Isolamento cross-tenant ──────────────────────────────────────────
  // orgA e orgB tem baselines distintos + summaries distintos
  const sAAgain = ComigoImpactService.summary(orgA, now);
  const sBAgain = ComigoImpactService.summary(orgB, now);
  check("baselines de A e B distintos", sAAgain.baselineAt !== sBAgain.baselineAt);
  check("A não vê revenue de B", !near(sAAgain.revenueBRL, sBAgain.revenueBRL) || sAAgain.revenueBRL === 0);
  // fiado de A não aparece em B
  check("fiado isolado: B tem 0", near(sBAgain.fiadoBalanceBRL, 0));

  // ── 9. sinceDays ~ delta em dias ────────────────────────────────────────
  // baseline gravado em 2026-08-01 UTC; medindo em 2027-01-01 = 153 dias
  const laterMs = Date.UTC(2027, 0, 1, 12, 0, 0);
  const sFuture = ComigoImpactService.summary(orgA, laterMs);
  const expectedDays = Math.floor((laterMs - baselineMs) / 86400000);
  check(`sinceDays = ${expectedDays} (delta calendárico)`, sFuture.sinceDays === expectedDays);

  // ── Sumário ──────────────────────────────────────────────────────────
  console.log(`\n=== Comigo/Impact (Paywall) ===`);
  for (const r of results) console.log(`  ${r.ok ? "✔" : "✘"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} pass`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
