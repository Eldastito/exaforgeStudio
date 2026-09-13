/**
 * TESTE — Cadastro gerenciado de categorias da vitrine (departamento → categoria)
 * ----------------------------------------------------------------------------
 * Prova, offline (StorefrontCategoryService):
 *   - criar departamento (dedupe case-insensitive) e categoria (valida dept);
 *   - árvore ordenada por position; categoryNames de um departamento;
 *   - renomear CATEGORIA cascateia para products_services.category;
 *   - renomear DEPARTAMENTO não toca produto;
 *   - remover departamento apaga suas categorias do registro, mas NÃO o texto
 *     do produto (reversível); remover categoria;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:storefront-categories
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sf-categories-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-sf-categories-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { StorefrontCategoryService: S } = await import("../src/server/StorefrontCategoryService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  const B = `org_${randomUUID().slice(0, 8)}`;

  const mkProduct = (org: string, name: string, category: string | null) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, name, type, active, price, category) VALUES (?, ?, ?, 'product', 1, 10, ?)`)
      .run(id, org, name, category);
    return id;
  };

  // ===== 1. Criar departamentos + categorias =====
  const roupas = S.createDepartment(A, "Roupas masculinas");
  const acess = S.createDepartment(A, "Acessórios");
  check("1.1 cria departamentos", !!roupas.id && !!acess.id && roupas.id !== acess.id);
  // dedupe case-insensitive
  const dup = S.createDepartment(A, "roupas masculinas");
  check("1.2 dedupe departamento (case-insensitive)", dup.id === roupas.id);

  const casaco = S.createCategory(A, roupas.id, "Casaco");
  const bermuda = S.createCategory(A, roupas.id, "Bermuda de linho");
  const cinto = S.createCategory(A, acess.id, "Cinto");
  check("1.3 cria categorias", !!casaco.id && !!bermuda.id && !!cinto.id);
  const dupCat = S.createCategory(A, roupas.id, "casaco");
  check("1.4 dedupe categoria", dupCat.id === casaco.id);
  // categoria em departamento inexistente
  let threw = false;
  try { S.createCategory(A, "nope", "X"); } catch { threw = true; }
  check("1.5 categoria exige departamento válido", threw);

  // ===== 2. Árvore + categoryNames =====
  const tree = S.tree(A);
  check("2.1 árvore tem 2 departamentos", tree.length === 2, `n=${tree.length}`);
  const roupasNode = tree.find((d) => d.id === roupas.id)!;
  check("2.2 departamento traz suas categorias", roupasNode.categories.length === 2);
  // ordem por position (criação): Casaco antes de Bermuda
  check("2.3 categorias ordenadas por position", roupasNode.categories[0].name === "Casaco" && roupasNode.categories[1].name === "Bermuda de linho");
  const names = S.categoryNames(A, roupas.id).sort();
  check("2.4 categoryNames do departamento", names.join("|") === "Bermuda de linho|Casaco", names.join("|"));

  // ===== 3. Renomear CATEGORIA cascateia para produtos =====
  const p1 = mkProduct(A, "Casaco TOULON", "Casaco");
  const p2 = mkProduct(A, "Casaco jeans", "Casaco");
  const pOther = mkProduct(A, "Cinto couro", "Cinto");
  S.rename(A, casaco.id, "Casacos");
  const c1 = (db.prepare(`SELECT category FROM products_services WHERE id=?`).get(p1) as any)?.category;
  const c2 = (db.prepare(`SELECT category FROM products_services WHERE id=?`).get(p2) as any)?.category;
  const cO = (db.prepare(`SELECT category FROM products_services WHERE id=?`).get(pOther) as any)?.category;
  check("3.1 renomear categoria cascateia p/ produtos", c1 === "Casacos" && c2 === "Casacos", `${c1},${c2}`);
  check("3.2 não afeta outra categoria", cO === "Cinto");

  // ===== 4. Renomear DEPARTAMENTO não toca produto =====
  S.rename(A, roupas.id, "Moda masculina");
  const stillCasacos = (db.prepare(`SELECT category FROM products_services WHERE id=?`).get(p1) as any)?.category;
  check("4.1 renomear departamento não muda produto", stillCasacos === "Casacos");
  check("4.2 nome do departamento atualizado", S.tree(A).find((d) => d.id === roupas.id)?.name === "Moda masculina");

  // ===== 5. Remover =====
  S.remove(A, roupas.id); // departamento → apaga suas categorias do registro
  const treeAfter = S.tree(A);
  check("5.1 remove departamento (some do registro)", !treeAfter.some((d) => d.id === roupas.id));
  const childCount = Number((db.prepare(`SELECT COUNT(*) c FROM storefront_categories WHERE parent_id=?`).get(roupas.id) as any)?.c || 0);
  check("5.2 categorias do departamento somem do registro", childCount === 0);
  const productStillTagged = (db.prepare(`SELECT category FROM products_services WHERE id=?`).get(p1) as any)?.category;
  check("5.3 texto do produto preservado após remover departamento", productStillTagged === "Casacos");
  // remover categoria avulsa
  S.remove(A, cinto.id);
  const cintoLeft = Number((db.prepare(`SELECT COUNT(*) c FROM storefront_categories WHERE id=?`).get(cinto.id) as any)?.c || 0);
  check("5.4 remove categoria", cintoLeft === 0);

  // ===== 6. Isolamento multi-tenant =====
  const bDept = S.createDepartment(B, "Calçados");
  S.createCategory(B, bDept.id, "Tênis");
  check("6.1 árvore de A não vê B", !S.tree(A).some((d) => d.name === "Calçados"));
  check("6.2 árvore de B só tem o seu", S.tree(B).length === 1 && S.tree(B)[0].name === "Calçados");
  // rename em A não atinge produtos de B
  const bp = mkProduct(B, "Tênis run", "Tênis");
  S.rename(A, acess.id, "Acessórios masculinos"); // A
  check("6.3 rename em A não toca produto de B", (db.prepare(`SELECT category FROM products_services WHERE id=?`).get(bp) as any)?.category === "Tênis");

  console.log("\n=== TEST: Cadastro de categorias da vitrine ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
