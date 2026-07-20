/**
 * TEST — Performance fee em modo beta (ADR-091 §6, Bloco C).
 *
 * Ganho incremental = MARGEM recuperada atribuída por driver (carrinho
 * abandonado / PIX / cadência), reusando o motor de atribuição única do
 * RevenueIntelligence. Fee = 2% do ganho — MOSTRADO, não cobrado no beta.
 * Reposição entra só como estimativa SEPARADA (fora do fee). Sem custo, a
 * margem cai no default de 30%. Consentimento é revogável.
 *
 * Uso: npm run test:performance-fee
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-perffee-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-perffee-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PerformanceFeeService } = await import("../src/server/PerformanceFeeService.js");

  // Org criada AGORA (dentro da janela beta).
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'TOULON', 'active')`).run(randomUUID(), orgId);

  // Contato + ticket com nudge de abandono + pedido pago dentro da janela.
  const contactId = randomUUID(), ticketId = randomUUID(), orderId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente', '5521999990000')`).run(contactId, orgId);
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, stage, abandoned_nudged_at) VALUES (?, ?, ?, 'atendimento', datetime('now','-1 day'))`).run(ticketId, orgId, contactId);
  db.prepare(`INSERT INTO orders (id, organization_id, contact_id, ticket_id, status, total_amount, created_at, paid_at) VALUES (?, ?, ?, ?, 'pago', 100, datetime('now'), datetime('now'))`).run(orderId, orgId, contactId, ticketId);
  // Item com custo → margem 40% (receita 100, custo 60).
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'Produto', 100, 1, 100, 60)`).run(randomUUID(), orderId, orgId);

  // ===== 1. Ganho por driver = margem recuperada; fee = 2% =====
  const r = PerformanceFeeService.compute(orgId, "month");
  const abandoned = r.drivers.find(d => d.key === "abandoned_cart");
  check("driver carrinho abandonado atribuído (1 pedido, R$100)", !!abandoned && abandoned.orders === 1 && abandoned.recoveredRevenue === 100);
  check("margem provada = 40%", r.marginProven === true && r.marginPercent === 40);
  check("margem recuperada do driver = 40 (100 × 40%)", abandoned?.recoveredMargin === 40);
  check("ganho incremental = 40", r.incrementalGain === 40);
  check("fee = 2% do ganho = 0.80", r.fee === 0.8 && r.feePercent === 2);

  // ===== 2. Beta: mostra, não cobra (org nova) =====
  check("conta nova está em beta (não cobra)", r.beta === true && r.consented === false);

  // ===== 3. Reposição estimada é separada e NÃO entra no ganho =====
  check("estimativa de reposição existe separada", typeof r.estimated.reposicao === "number");
  check("reposição NÃO faz parte do ganho incremental", r.incrementalGain === (abandoned?.recoveredMargin || 0));

  // ===== 4. Sem custo → margem cai no default de 30% =====
  const org2 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Sem Custo', 'active')`).run(randomUUID(), org2);
  const c2 = randomUUID(), t2 = randomUUID(), o2 = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'C2', '5521888880000')`).run(c2, org2);
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, stage, abandoned_nudged_at) VALUES (?, ?, ?, 'atendimento', datetime('now','-1 day'))`).run(t2, org2, c2);
  db.prepare(`INSERT INTO orders (id, organization_id, contact_id, ticket_id, status, total_amount, created_at, paid_at) VALUES (?, ?, ?, ?, 'pago', 200, datetime('now'), datetime('now'))`).run(o2, org2, c2, t2);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', 200, 1, 200, 0)`).run(randomUUID(), o2, org2);
  const r2 = PerformanceFeeService.compute(org2, "month");
  check("sem custo → margem no default 30%", r2.marginProven === false && r2.marginPercent === 30);
  check("ganho = 200 × 30% = 60; fee = 1.20", r2.incrementalGain === 60 && r2.fee === 1.2);

  // ===== 5. Consentimento revogável + sai do beta após 6 meses =====
  db.prepare(`UPDATE organization_settings SET created_at = datetime('now','-7 months') WHERE organization_id = ?`).run(orgId);
  PerformanceFeeService.setConsent(orgId, true);
  const r3 = PerformanceFeeService.compute(orgId, "month");
  check("com consentimento + fora dos 6 meses → não é mais beta", r3.beta === false && r3.consented === true);
  PerformanceFeeService.setConsent(orgId, false);
  const r4 = PerformanceFeeService.compute(orgId, "month");
  check("revogar consentimento volta pro beta (não cobra)", r4.beta === true && r4.consented === false);

  // --- Relatório ---
  console.log("\n=== TEST: Performance fee beta (ADR-091 §6) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Performance fee (beta) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
