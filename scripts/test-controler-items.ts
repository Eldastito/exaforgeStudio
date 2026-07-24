/**
 * TESTE — CONTROLER Fatia 1c: classificação operacional do item (PRD-E-007).
 *
 * Cobre: default de migração (§30.2), classificação com finalidade + unidade de
 * compra × consumo + conversão de embalagem, vínculos-padrão (centro de custo /
 * localização) validados na org, regra de serviço sem estoque, conversões e
 * ISOLAMENTO multi-tenant. Aditivo — não muda nenhum fluxo existente.
 *
 * Uso:  npm run test:controler-items
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-controler-items-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-controler-items-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
function throws(fn: () => any): boolean { try { fn(); return false; } catch { return true; } }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OperationalItemService } = await import("../src/server/OperationalItemService.js");
  const { CostCenterService } = await import("../src/server/CostCenterService.js");
  const { InventoryLocationService } = await import("../src/server/InventoryLocationService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const [org, name] of [[A, "A"], [B, "B"]] as const) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  const mkProduct = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', ?, 10, 1)`).run(id, org, name); return id; };

  const cc = CostCenterService.create(A, { name: "Escritório" }, "u1");
  const loc = InventoryLocationService.create(A, { name: "Almox", type: "almoxarifado" }, "u1");
  const papel = mkProduct(A, "Papel A4");
  const camisa = mkProduct(A, "Camisa");

  // ===== Default de migração (§30.2) =====
  const def = OperationalItemService.get(A, papel);
  check("item nasce 'resale' com consumo desligado", def.operational_item_type === "resale" && def.consumption_control_enabled === 0 && Number(def.conversion_factor) === 1, JSON.stringify(def));

  // ===== Classificação: consumo com conversão de embalagem (1 caixa = 5000 folhas) =====
  const cls = OperationalItemService.classify(A, papel, {
    operationalItemType: "consumable", consumptionControlEnabled: true,
    defaultUom: "folha", purchaseUom: "caixa", conversionFactor: 5000,
    defaultCostCenterId: cc.id, defaultLocationId: loc.id, criticality: "alta", requiresRequest: true,
  }, "u1");
  check("classifica como consumível controlado", cls.operational_item_type === "consumable" && cls.consumption_control_enabled === 1, JSON.stringify(cls));
  check("guarda unidades e conversão", cls.default_uom === "folha" && cls.purchase_uom === "caixa" && Number(cls.conversion_factor) === 5000);
  check("amarra centro de custo e localização", cls.default_cost_center_id === cc.id && cls.default_location_id === loc.id);
  check("guarda criticidade e requires_request", cls.criticality === "alta" && cls.requires_request === 1);

  // Merge parcial: muda só a criticidade, resto permanece.
  const merged = OperationalItemService.classify(A, papel, { criticality: "critica" }, "u1");
  check("merge parcial preserva os demais campos", merged.criticality === "critica" && Number(merged.conversion_factor) === 5000 && merged.default_uom === "folha");

  // ===== Validações =====
  check("tipo operacional inválido rejeitado", throws(() => OperationalItemService.classify(A, papel, { operationalItemType: "xpto" })));
  check("criticidade inválida rejeitada", throws(() => OperationalItemService.classify(A, papel, { criticality: "urgentissima" })));
  check("fator de conversão <= 0 rejeitado", throws(() => OperationalItemService.classify(A, papel, { conversionFactor: 0 })));
  check("centro de custo precisa existir na org", throws(() => OperationalItemService.classify(A, papel, { defaultCostCenterId: randomUUID() })));
  check("localização precisa existir na org", throws(() => OperationalItemService.classify(A, papel, { defaultLocationId: randomUUID() })));

  // ===== Serviço/assinatura não têm saldo físico → consumo forçado off =====
  const limpeza = mkProduct(A, "Limpeza mensal");
  const svc = OperationalItemService.classify(A, limpeza, { operationalItemType: "service", consumptionControlEnabled: true }, "u1");
  check("serviço não controla consumo físico", svc.operational_item_type === "service" && svc.consumption_control_enabled === 0, JSON.stringify(svc));

  // ===== Conversões =====
  check("compra→consumo (2 caixas = 10000 folhas)", OperationalItemService.purchaseToConsumption(A, papel, 2) === 10000);
  check("consumo→compra (2500 folhas = 0,5 caixa)", OperationalItemService.consumptionToPurchase(A, papel, 2500) === 0.5);

  // ===== Listagens =====
  check("lista por tipo", OperationalItemService.list(A, { type: "consumable" }).length === 1);
  check("lista por consumo controlado", OperationalItemService.list(A, { consumptionControlled: true }).length === 1);
  check("camisa continua resale (não classificada)", OperationalItemService.get(A, camisa).operational_item_type === "resale");

  // ===== Isolamento =====
  const prodB = mkProduct(B, "Papel B");
  check("isolamento: classificar produto de outra org falha", throws(() => OperationalItemService.classify(A, prodB, { operationalItemType: "consumable" })));
  check("isolamento: usar centro de custo de A em produto de B falha", throws(() => OperationalItemService.classify(B, prodB, { defaultCostCenterId: cc.id })));
  check("isolamento: usar localização de A em produto de B falha", throws(() => OperationalItemService.classify(B, prodB, { defaultLocationId: loc.id })));
  check("isolamento: get cross-org devolve null", OperationalItemService.get(B, papel) === null);

  console.log("\n=== CONTROLER Fatia 1c — Classificação operacional do item ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
