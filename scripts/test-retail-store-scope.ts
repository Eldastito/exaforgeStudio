/**
 * TESTE — Trava de loja por usuário (PRD Moda/TOULON, CRM-002/AC-04/AC-18; ADR-173)
 * ----------------------------------------------------------------------------
 * Prova, offline (RetailStoreScopeService + enforcement nos serviços):
 *   - owner/admin → sem restrição (vê tudo);
 *   - usuário SEM atribuição → sem restrição (opt-in, retrocompatível);
 *   - usuário COM atribuição → restrito às lojas dele (ids + códigos);
 *   - setForUser valida loja da org e substitui o conjunto;
 *   - can/filter helpers;
 *   - enforcement: estoque negativo, clientes (por código) e reposição
 *     (loja necessitada) só trazem as lojas permitidas;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-store-scope
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-store-scope-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-store-scope-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreScopeService } = await import("../src/server/RetailStoreScopeService.js");
  const { RetailInventoryService } = await import("../src/server/RetailInventoryService.js");
  const { RetailPdvCustomerService } = await import("../src/server/RetailPdvCustomerService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  const B = `org_${randomUUID().slice(0, 8)}`;

  const mkStore = (org: string, name: string, code: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, 1)`).run(id, org, name, code);
    return id;
  };
  const l1 = mkStore(A, "Savassi", "L1");
  const l2 = mkStore(A, "Centro", "L2");
  const bStore = mkStore(B, "Loja B", "LB");
  const gerente = randomUUID(); // agent
  const owner = randomUUID();

  // ===== 1. Resolução do escopo =====
  check("owner sem restrição", RetailStoreScopeService.allowed(A, owner, "owner").unrestricted === true);
  check("admin sem restrição", RetailStoreScopeService.allowed(A, owner, "admin").unrestricted === true);
  check("agent SEM atribuição → sem restrição", RetailStoreScopeService.allowed(A, gerente, "agent").unrestricted === true);

  // Atribui o gerente à L1.
  const set = RetailStoreScopeService.setForUser(A, gerente, [l1], owner);
  check("setForUser grava 1 loja", set.length === 1 && set[0] === l1);
  const scope = RetailStoreScopeService.allowed(A, gerente, "agent");
  check("agent COM atribuição → restrito", scope.unrestricted === false && scope.storeIds.length === 1 && scope.storeIds[0] === l1);
  check("escopo traz o código da loja", scope.storeCodes.includes("L1") && !scope.storeCodes.includes("L2"));

  // setForUser ignora loja de fora da org
  const set2 = RetailStoreScopeService.setForUser(A, gerente, [l1, l2, bStore], owner);
  check("setForUser filtra loja de fora da org", set2.length === 2 && !set2.includes(bStore));
  // volta a só L1 pro resto do teste
  RetailStoreScopeService.setForUser(A, gerente, [l1], owner);

  // ===== 2. Helpers =====
  check("canAccessStore permitida", RetailStoreScopeService.canAccessStore(A, gerente, "agent", l1) === true);
  check("canAccessStore negada", RetailStoreScopeService.canAccessStore(A, gerente, "agent", l2) === false);
  check("owner acessa qualquer loja", RetailStoreScopeService.canAccessStore(A, owner, "owner", l2) === true);
  const allStores = [{ id: l1 }, { id: l2 }];
  check("filterStores restringe", RetailStoreScopeService.filterStores(A, gerente, "agent", allStores).length === 1);
  check("filterStores owner vê tudo", RetailStoreScopeService.filterStores(A, owner, "owner", allStores).length === 2);

  // ===== 3. Enforcement: estoque negativo =====
  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'product', 'Camisa')`).run(prod, A);
  RetailInventoryService.setQuantity(A, l1, prod, null, -2);
  RetailInventoryService.setQuantity(A, l2, prod, null, -3);
  const negRestricted = RetailInventoryService.listNegative(A, { restrictStoreIds: scope.storeIds });
  check("negativo restrito → só L1", negRestricted.total === 1 && negRestricted.items[0].store_id === l1, `n=${negRestricted.total}`);
  const negAll = RetailInventoryService.listNegative(A, {});
  check("sem restrição → as 2 lojas", negAll.total === 2);

  // ===== 4. Enforcement: clientes por código =====
  db.prepare(`INSERT INTO retail_pdv_customers (id, organization_id, codigo_n, nome, filial) VALUES (?, ?, 'c1', 'Ana', 'L1')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO retail_pdv_customers (id, organization_id, codigo_n, nome, filial) VALUES (?, ?, 'c2', 'Bia', 'L2')`).run(randomUUID(), A);
  const custRestricted = RetailPdvCustomerService.list(A, {}, { restrictCodes: scope.storeCodes });
  check("clientes restrito → só L1", custRestricted.total === 1 && custRestricted.customers[0].nome === "Ana");
  check("clientes restrito: seletor de lojas só L1", custRestricted.stores.length === 1 && custRestricted.stores[0].code === "L1");
  // restrição vazia (usuário sem loja com código) → nada vaza
  const custEmpty = RetailPdvCustomerService.list(A, {}, { restrictCodes: [] });
  check("restrição vazia não vaza cliente", custEmpty.total === 0);

  // ===== 5. Isolamento =====
  check("escopo da org B não vê usuário da A", RetailStoreScopeService.forUser(B, gerente).length === 0);

  console.log("\n=== TEST: Trava de loja por usuário (CRM-002) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
