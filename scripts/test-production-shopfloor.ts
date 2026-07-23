/**
 * TEST — Produção: chão de fábrica (fatia 3, ADR-141).
 * Consumo real (baixa estoque), qualidade e paradas. Determinístico.
 *
 * Uso: npm run test:production-shopfloor
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sf-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-sf-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ProductionService: PR } = await import("../src/server/ProductionService.js");
  const { ProductionOrderService: PO } = await import("../src/server/ProductionOrderService.js");
  const { ProductionShopFloorService: SF } = await import("../src/server/ProductionShopFloorService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const mkProduct = (org: string, name: string) => { const id = randomUUID(); db.prepare("INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'product', ?)").run(id, org, name); return id; };
  const setStock = (org: string, pid: string, qty: number) => db.prepare("INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available) VALUES (?, ?, ?, ?)").run(randomUUID(), org, pid, qty);
  const stockOf = (org: string, pid: string) => { const r = db.prepare("SELECT quantity_available q FROM inventory_items WHERE organization_id = ? AND product_service_id = ?").get(org, pid) as any; return r ? Number(r.q) : 0; };

  const orgA = mkOrg();
  const fg = mkProduct(orgA, "Bolo");
  const m1 = mkProduct(orgA, "Farinha"); setStock(orgA, m1, 500);
  const m2 = mkProduct(orgA, "Ovos"); setStock(orgA, m2, 100);
  const mp = PR.createProduct(orgA, { productServiceId: fg }).id!;
  const bom = PR.createBom(orgA, mp).id!;
  PR.addBomItem(orgA, bom, { materialProductServiceId: m1, quantity: 2 });
  PR.addBomItem(orgA, bom, { materialProductServiceId: m2, quantity: 0.5 });
  const ord = PO.create(orgA, { manufacturedProductId: mp, bomId: bom, qtyPlanned: 100 }).id!;

  // ===== 1. Consumo só em produção =====
  check("não consome ordem em rascunho", SF.consumeMaterial(orgA, ord, { materialProductServiceId: m1, quantity: 10 }).ok === false);
  PO.release(orgA, ord);

  // ===== 2. Consumo real baixa o estoque =====
  const c1 = SF.consumeMaterial(orgA, ord, { materialProductServiceId: m1, quantity: 100, note: "lote 1" });
  check("consome material (ok)", c1.ok === true);
  check("estoque de Farinha baixou 500→400", stockOf(orgA, m1) === 400);
  check("consumo registrado", SF.listConsumptions(orgA, ord).length === 1 && SF.listConsumptions(orgA, ord)[0].material_name === "Farinha");
  check("consumo vira evento", (db.prepare("SELECT COUNT(*) n FROM production_events WHERE order_id = ? AND kind = 'consume'").get(ord) as any).n === 1);
  check("material inexistente rejeitado", SF.consumeMaterial(orgA, ord, { materialProductServiceId: "x", quantity: 1 }).ok === false);
  check("quantidade <= 0 rejeitada", SF.consumeMaterial(orgA, ord, { materialProductServiceId: m1, quantity: 0 }).ok === false);

  // ===== 3. Consumir a BOM inteira para uma quantidade =====
  const cb = SF.consumeForBom(orgA, ord, 50); // Farinha 2×50=100, Ovos 0,5×50=25
  check("consumeForBom consome os 2 materiais", cb.ok === true && cb.consumed === 2);
  check("Farinha 400→300 (mais 100)", stockOf(orgA, m1) === 300);
  check("Ovos 100→75 (25)", stockOf(orgA, m2) === 75);

  // ===== 4. Qualidade =====
  check("checklist aprovado", SF.addQualityCheck(orgA, ord, { name: "Peso correto", passed: true }).ok === true);
  check("checklist reprovado", SF.addQualityCheck(orgA, ord, { name: "Assamento", passed: false, notes: "cru no centro" }).ok === true);
  check("item de qualidade sem nome rejeitado", SF.addQualityCheck(orgA, ord, { name: " " }).ok === false);
  check("qualidade listada (2, 1 reprovado)", SF.listQualityChecks(orgA, ord).length === 2);

  // ===== 5. Parada =====
  check("registra parada", SF.addDowntime(orgA, ord, { reason: "Manutenção do forno", minutes: 45 }).ok === true);
  SF.addDowntime(orgA, ord, { reason: "Falta de material", minutes: 15 });
  check("motivo obrigatório", SF.addDowntime(orgA, ord, { reason: " ", minutes: 10 }).ok === false);

  // ===== 6. Resumo agregado + get() =====
  const s = SF.summary(orgA, ord);
  check("resumo: consumido total = 100+100+25 = 225", s.totalConsumed === 225);
  check("resumo: 2 checks, 1 reprovado", s.qualityChecks === 2 && s.qualityFailed === 1);
  check("resumo: 60 min de parada", s.downtimeMinutes === 60);
  const g = PO.get(orgA, ord);
  check("get() traz chão de fábrica", g.shopFloor.downtimeMinutes === 60 && g.consumptions.length === 3 && g.qualityChecks.length === 2 && g.downtime.length === 2);

  // ===== 7. Isolamento =====
  const orgB = mkOrg();
  check("isolamento: consumo cross-org falha", SF.consumeMaterial(orgB, ord, { materialProductServiceId: m1, quantity: 1 }).ok === false);
  check("isolamento: org B não vê consumos de A", SF.listConsumptions(orgB, ord).length === 0);

  console.log("\n=== TEST: Produção — chão de fábrica (ADR-141 fatia 3) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Produção (chão de fábrica) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
