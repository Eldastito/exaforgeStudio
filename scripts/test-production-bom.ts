/**
 * TEST — Produção: produto fabricado + BOM + necessidade de materiais
 * (fundação, ADR-141). Determinístico, sem chave de IA.
 *
 * Uso: npm run test:production-bom
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-prod-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-prod-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ProductionService: PR } = await import("../src/server/ProductionService.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const mkProduct = (org: string, name: string) => { const id = randomUUID(); db.prepare("INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'product', ?)").run(id, org, name); return id; };
  const setStock = (org: string, pid: string, qty: number) => db.prepare("INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available) VALUES (?, ?, ?, ?)").run(randomUUID(), org, pid, qty);

  const orgA = mkOrg();
  P.seedSystemProfiles(orgA);
  const uWith = (key: string) => ({ role: "agent", role_profile_id: (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?").get(orgA, key) as any)?.id });

  // ===== 1. RBAC `production` (só gestores) =====
  check("owner vê produção", P.can(orgA, uWith("owner"), "production", "read") === true);
  check("gerente vê produção", P.can(orgA, uWith("gerente"), "production", "read") === true);
  check("vendedor NÃO vê produção", P.can(orgA, uWith("vendedor"), "production", "read") === false);
  check("legado agent (sem perfil) NÃO vê produção", P.can(orgA, { role: "agent" }, "production", "read") === false);
  check("legado owner (sem perfil) vê produção", P.can(orgA, { role: "owner" }, "production", "read") === true);

  // ===== 2. Produto fabricado + materiais no catálogo =====
  const fg = mkProduct(orgA, "Bolo Pronto");
  const m1 = mkProduct(orgA, "Farinha"); setStock(orgA, m1, 100);
  const m2 = mkProduct(orgA, "Ovos");    setStock(orgA, m2, 10);

  const mp = PR.createProduct(orgA, { productServiceId: fg });
  check("cria produto fabricado", mp.ok === true && !!mp.id);
  check("produto fabricado idempotente por produto do catálogo", PR.createProduct(orgA, { productServiceId: fg }).id === mp.id);
  check("produto fabricado exige item do catálogo", PR.createProduct(orgA, { productServiceId: "nao-existe" }).ok === false);
  check("listProducts traz o nome do catálogo", PR.listProducts(orgA).some((p: any) => p.product_name === "Bolo Pronto"));

  // ===== 3. BOM + itens (upsert) =====
  const bom = PR.createBom(orgA, mp.id!, "Receita v1");
  check("cria BOM", bom.ok === true && !!bom.id);
  check("addBomItem exige material do catálogo", PR.addBomItem(orgA, bom.id!, { materialProductServiceId: "x", quantity: 1 }).ok === false);
  check("addBomItem exige quantidade > 0", PR.addBomItem(orgA, bom.id!, { materialProductServiceId: m1, quantity: 0 }).ok === false);
  PR.addBomItem(orgA, bom.id!, { materialProductServiceId: m1, quantity: 2, unit: "kg" });
  PR.addBomItem(orgA, bom.id!, { materialProductServiceId: m1, quantity: 2, unit: "kg" }); // upsert → não duplica
  PR.addBomItem(orgA, bom.id!, { materialProductServiceId: m2, quantity: 0.5, unit: "dz" });
  const got = PR.getBom(orgA, bom.id!);
  check("BOM tem 2 itens (upsert não duplica)", got.items.length === 2);
  check("item traz o nome do material", got.items.some((i: any) => i.material_name === "Farinha"));

  // ===== 4. Necessidade de materiais (determinística) =====
  const req60 = PR.materialRequirements(orgA, bom.id!, 60);
  const far = req60.items.find((i: any) => i.materialId === m1);
  const ovo = req60.items.find((i: any) => i.materialId === m2);
  check("Farinha: 2×60=120 necessária, 100 em estoque → falta 20", far.required === 120 && far.onHand === 100 && far.shortage === 20);
  check("Ovos: 0,5×60=30 necessário, 10 em estoque → falta 20", ovo.required === 30 && ovo.shortage === 20);
  check("hasShortage/shortageCount corretos p/ 60", req60.hasShortage === true && req60.shortageCount === 2);

  const req40 = PR.materialRequirements(orgA, bom.id!, 40);
  check("p/ 40: Farinha 80 (sem falta), Ovos 20 (falta 10) → shortageCount 1", req40.shortageCount === 1 && req40.items.find((i: any) => i.materialId === m1).shortage === 0);

  // ===== 5. Isolamento =====
  const orgB = mkOrg();
  check("isolamento: org B não vê produtos fabricados de A", PR.listProducts(orgB).length === 0 && PR.getBom(orgB, bom.id!) === null);
  check("isolamento: requirements de BOM de A é null em B", PR.materialRequirements(orgB, bom.id!, 10) === null);

  console.log("\n=== TEST: Produção — produto fabricado + BOM (ADR-141) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Produção (BOM) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
