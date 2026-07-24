/**
 * TESTE — Insights de varejo no briefing (WhatsApp) e no Diretor IA + sinal de
 * concentração de vendedor.
 *
 * Prova que os sinais da operação chegam onde o gestor lê:
 *   - retail_seller_concentration: um vendedor ≥ 70% das vendas → sinal;
 *   - topOpenSignals/describe geram a frase curta;
 *   - o briefing da manhã (BusinessTutorService) inclui a seção "Operação da loja";
 *   - o panorama do Diretor IA inclui o bloco de sinais da operação.
 *
 * Uso:  npm run test:retail-insights-briefing
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-insights-brief-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-insights-brief-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");
  const { RetailOpsSignalPublisher } = await import("../src/server/RetailOpsSignalPublisher.js");
  const { BusinessTutorService } = await import("../src/server/BusinessTutorService.js");
  const { ExecutiveAdvisorService } = await import("../src/server/ExecutiveAdvisorService.js");

  const today = new Date().toISOString().slice(0, 10);
  const G = `org_G_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'G', 'active')`).run(randomUUID(), G);
  const U1 = randomUUID(), U2 = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Ana', ?)`).run(U1, G, `a_${U1.slice(0, 6)}@x.com`);
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Bruno', ?)`).run(U2, G, `b_${U2.slice(0, 6)}@x.com`);
  const P = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Camisa', 100, 1, 0)`).run(P, G);

  OrdersService.createOrder(G, { items: [{ productId: P, name: "Camisa", unitPrice: 0, quantity: 9 }], sellerUserId: U1, autoClose: true }); // Ana 900
  OrdersService.createOrder(G, { items: [{ productId: P, name: "Camisa", unitPrice: 0, quantity: 1 }], sellerUserId: U2, autoClose: true }); // Bruno 100

  RetailOpsSignalPublisher.run(G, { asOf: today, windowDays: 3650 });
  check("concentração de vendedor: Ana 90% → sinal", !!db.prepare(`SELECT id FROM business_signals WHERE organization_id=? AND signal_type='retail_seller_concentration' AND status='open'`).get(G));

  const top = RetailOpsSignalPublisher.topOpenSignals(G, 3);
  check("topOpenSignals retorna o sinal", top.length >= 1 && top[0].signalType === "retail_seller_concentration", JSON.stringify(top));
  check("describe gera a frase (Ana 90%)", RetailOpsSignalPublisher.describe(top[0]).includes("Ana") && RetailOpsSignalPublisher.describe(top[0]).includes("90"));

  // Briefing da manhã inclui a seção da operação da loja.
  const brief = BusinessTutorService.morningBrief(G);
  check("briefing WhatsApp inclui 'Operação da loja'", brief.text.includes("Operação da loja"), brief.text.slice(0, 300));
  check("briefing menciona a concentração", /concentrad/i.test(brief.text));

  // Panorama do Diretor IA inclui o bloco de sinais da operação.
  const block = ExecutiveAdvisorService.retailSignalsBlock(G);
  check("Diretor: bloco de sinais da operação", block.includes("SINAIS DA OPERAÇÃO") && /concentrad/i.test(block), block.slice(0, 160));

  // Isolamento: org sem operação não polui o briefing.
  const H = `org_H_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'H', 'active')`).run(randomUUID(), H);
  check("isolamento: org H sem seção de loja no briefing", !BusinessTutorService.morningBrief(H).text.includes("Operação da loja"));
  check("isolamento: Diretor H sem bloco de sinais", ExecutiveAdvisorService.retailSignalsBlock(H) === "");

  console.log("\n=== Insights de varejo no briefing + Diretor IA ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
