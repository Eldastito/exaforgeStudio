/**
 * TESTE — CONTROLER Fatia 1b: Localizações de estoque (PRD-E-007).
 *
 * Cobre: CRUD do registro, validação de tipo/código/vínculos na org, saldos por
 * local, primitivas governadas receive()/transfer() (débito atômico + saldo
 * suficiente), e ISOLAMENTO multi-tenant. Aditivo — não toca o agregado legado.
 *
 * Uso:  npm run test:controler-locations
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-controler-loc-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-controler-loc-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
function throws(fn: () => any): boolean { try { fn(); return false; } catch { return true; } }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { InventoryLocationService } = await import("../src/server/InventoryLocationService.js");
  const { DepartmentService } = await import("../src/server/DepartmentService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const [org, name] of [[A, "A"], [B, "B"]] as const) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  const uA = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Carlos', ?)`).run(uA, A, `c_${uA.slice(0, 6)}@x.com`);
  const dept = DepartmentService.create(A, { name: "Operações" }, "u1");
  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Papel A4', 20, 1)`).run(prod, A);

  // ===== CRUD + validação =====
  const l1 = InventoryLocationService.create(A, { name: "Almoxarifado Central", type: "almoxarifado", code: "ALM", departmentId: dept.id, responsibleUserId: uA }, "u1");
  check("cria localização", !!l1.id && l1.type === "almoxarifado" && l1.active === 1, JSON.stringify(l1));
  check("nome obrigatório", throws(() => InventoryLocationService.create(A, { name: "" })));
  check("tipo inválido rejeitado", throws(() => InventoryLocationService.create(A, { name: "X", type: "foguete" })));
  check("código único por org", throws(() => InventoryLocationService.create(A, { name: "Outro", code: "ALM" })));
  check("departamento precisa existir na org", throws(() => InventoryLocationService.create(A, { name: "X", departmentId: randomUUID() })));
  check("responsável precisa existir na org", throws(() => InventoryLocationService.create(A, { name: "Y", responsibleUserId: randomUUID() })));

  const l2 = InventoryLocationService.create(A, { name: "Filial Centro", type: "filial" }, "u1");
  check("lista traz as 2 ativas", InventoryLocationService.list(A).length === 2);
  check("filtro por tipo", InventoryLocationService.list(A, { type: "filial" }).length === 1);

  // ===== Saldos + primitivas governadas =====
  const r = InventoryLocationService.receive(A, { locationId: l1.id, productId: prod, quantity: 10 }, "u1");
  check("receive incrementa o saldo do local", r.balance === 10, JSON.stringify(r));
  check("receive acumula", InventoryLocationService.receive(A, { locationId: l1.id, productId: prod, quantity: 5 }, "u1").balance === 15);
  check("receive quantidade não-positiva rejeitado", throws(() => InventoryLocationService.receive(A, { locationId: l1.id, productId: prod, quantity: 0 })));
  check("receive produto inexistente rejeitado", throws(() => InventoryLocationService.receive(A, { locationId: l1.id, productId: randomUUID(), quantity: 1 })));

  const t = InventoryLocationService.transfer(A, { fromLocationId: l1.id, toLocationId: l2.id, productId: prod, quantity: 6 }, "u1");
  check("transfer debita origem e credita destino", t.fromBalance === 9 && t.toBalance === 6, JSON.stringify(t));
  check("transfer saldo insuficiente rejeitado", throws(() => InventoryLocationService.transfer(A, { fromLocationId: l2.id, toLocationId: l1.id, productId: prod, quantity: 999 })));
  check("transfer mesmo local rejeitado", throws(() => InventoryLocationService.transfer(A, { fromLocationId: l1.id, toLocationId: l1.id, productId: prod, quantity: 1 })));
  check("balanceOf reflete o estado", InventoryLocationService.balanceOf(A, l1.id, prod) === 9 && InventoryLocationService.balanceOf(A, l2.id, prod) === 6);
  check("balances lista por produto", InventoryLocationService.balances(A, { productId: prod }).length === 2);

  // Local inativo não recebe.
  InventoryLocationService.setActive(A, l2.id, false, "u1");
  check("desativa some da lista padrão", InventoryLocationService.list(A).length === 1);
  check("receive em local inativo rejeitado", throws(() => InventoryLocationService.receive(A, { locationId: l2.id, productId: prod, quantity: 1 })));

  // ===== Isolamento =====
  check("isolamento: org B não vê locais de A", InventoryLocationService.list(B).length === 0);
  check("isolamento: org B não vê saldos de A", InventoryLocationService.balances(B).length === 0);
  check("isolamento: receive cross-org rejeitado", throws(() => InventoryLocationService.receive(B, { locationId: l1.id, productId: prod, quantity: 1 })));
  check("isolamento: transfer cross-org rejeitado", throws(() => InventoryLocationService.transfer(B, { fromLocationId: l1.id, toLocationId: l2.id, productId: prod, quantity: 1 })));
  check("código único é por org (B pode reusar 'ALM')", !throws(() => InventoryLocationService.create(B, { name: "Alm B", code: "ALM" })));

  console.log("\n=== CONTROLER Fatia 1b — Localizações de estoque ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
