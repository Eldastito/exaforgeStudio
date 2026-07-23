/**
 * TEST — Produção: sinais no núcleo transversal (fatia 4, ADR-141).
 * order.late / material.shortage / scrap.above_target; idempotente por dia.
 * Determinístico, sem chave de IA.
 *
 * Uso: npm run test:production-signals
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ps-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ps-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ProductionService: PR } = await import("../src/server/ProductionService.js");
  const { ProductionOrderService: PO } = await import("../src/server/ProductionOrderService.js");
  const { ProductionSignalPublisher: SIG } = await import("../src/server/ProductionSignalPublisher.js");
  const { ImpactPrioritizationService: IP } = await import("../src/server/ImpactPrioritizationService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const mkProduct = (org: string, name: string) => { const id = randomUUID(); db.prepare("INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'product', ?)").run(id, org, name); return id; };
  const setStock = (org: string, pid: string, qty: number) => db.prepare("INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available) VALUES (?, ?, ?, ?)").run(randomUUID(), org, pid, qty);
  // Cria produto fabricado + BOM (1 material perUnit=2, com estoque `matStock`).
  const mkOrder = (org: string, name: string, planned: number, promised: string | null, matStock: number) => {
    const fg = mkProduct(org, `${name}-fg`);
    const mat = mkProduct(org, `${name}-mat`); setStock(org, mat, matStock);
    const mp = PR.createProduct(org, { productServiceId: fg }).id!;
    const bom = PR.createBom(org, mp).id!;
    PR.addBomItem(org, bom, { materialProductServiceId: mat, quantity: 2 });
    const id = PO.create(org, { manufacturedProductId: mp, bomId: bom, qtyPlanned: planned, promisedDate: promised }).id!;
    PO.release(org, id);
    return id;
  };
  const sigOf = (org: string, type: string, orderId: string) => db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND signal_type = ? AND source_entity_id = ?").get(org, type, orderId) as any;
  const countType = (org: string, type: string) => (db.prepare("SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = ?").get(org, type) as any).n;

  const orgA = mkOrg();
  const ASOF = "2026-07-23";

  // late: prometida no passado, estoque farto (sem falta).
  const oLate = mkOrder(orgA, "late", 50, "2026-07-01", 10000);
  // shortage: prometida no futuro (não atrasada), estoque baixo (100×2=200 > 50).
  const oShort = mkOrder(orgA, "short", 100, "2030-01-01", 50);
  // scrap: futura, estoque farto, refugo alto (10 bons + 5 refugo = 33%).
  const oScrap = mkOrder(orgA, "scrap", 100, "2030-01-01", 10000);
  PO.report(orgA, oScrap, { producedQty: 10, scrappedQty: 5 });
  // ok: futura, estoque farto, sem refugo → nenhum sinal.
  const oOk = mkOrder(orgA, "ok", 30, "2030-01-01", 10000);

  // ===== 1. Publica os três tipos =====
  const r = SIG.run(orgA, { asOfDate: ASOF });
  check("run publica atraso/falta/refugo (1 cada)", r.late === 1 && r.shortage === 1 && r.scrap === 1 && r.published === 3);
  check("sinal de ATRASO na ordem certa", !!sigOf(orgA, "production_order_late", oLate));
  check("sinal de FALTA na ordem certa (com evidência)", (() => { const s = sigOf(orgA, "production_material_shortage", oShort); return !!s && /material/.test(s.evidence_json); })());
  check("sinal de REFUGO na ordem certa", !!sigOf(orgA, "production_scrap_above_target", oScrap));
  check("ordem saudável NÃO gera sinal", !sigOf(orgA, "production_order_late", oOk) && !sigOf(orgA, "production_material_shortage", oOk) && !sigOf(orgA, "production_scrap_above_target", oOk));
  check("domínio dos sinais é 'production'", (db.prepare("SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND domain = 'production'").get(orgA) as any).n === 3);

  // ===== 2. Idempotente por dia =====
  SIG.run(orgA, { asOfDate: ASOF });
  check("re-rodar no mesmo dia não duplica", countType(orgA, "production_order_late") === 1 && countType(orgA, "production_material_shortage") === 1 && countType(orgA, "production_scrap_above_target") === 1);

  // ===== 3. Ordem que deixou de estar atrasada não é reforçada indevidamente =====
  // (o oShort não está atrasado: sem sinal de atraso para ele)
  check("ordem no prazo não recebe sinal de atraso", !sigOf(orgA, "production_order_late", oShort));

  // ===== 4. Fluem para o Pareto (aparecem como prioridade) =====
  const prio = IP.prioritize(orgA);
  check("sinais de produção viram prioridades no Pareto", prio.global.some((p: any) => p.domain === "production"));

  // ===== 5. asOf antes da data prometida → sem atraso =====
  const orgB = mkOrg();
  const oFuture = mkOrder(orgB, "fut", 20, "2026-07-01", 10000);
  const rb = SIG.run(orgB, { asOfDate: "2026-06-01" });
  check("antes da data prometida: sem sinal de atraso", rb.late === 0 && !sigOf(orgB, "production_order_late", oFuture));

  // ===== 6. Isolamento =====
  check("isolamento: sinais de A não aparecem em B", (db.prepare("SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND source_entity_id = ?").get(orgB, oLate) as any).n === 0);

  console.log("\n=== TEST: Produção — sinais transversais (ADR-141 fatia 4) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Produção (sinais) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
