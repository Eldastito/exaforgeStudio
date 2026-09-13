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

  // Categorias mapeiam CÓDIGO (o que está no produto) → NOME amigável.
  const casaco = S.createCategory(A, roupas.id, "Casacos", "001");
  const bermuda = S.createCategory(A, roupas.id, "Bermudas", "002");
  const cinto = S.createCategory(A, acess.id, "Cintos", "005");
  check("1.3 cria categorias (código→nome)", !!casaco.id && !!bermuda.id && !!cinto.id);
  // mesmo código não pode ser mapeado duas vezes
  let dupThrew = false;
  try { S.createCategory(A, roupas.id, "Casacão", "001"); } catch { dupThrew = true; }
  check("1.4 dedupe por código mapeado", dupThrew);
  // categoria em departamento inexistente
  let threw = false;
  try { S.createCategory(A, "nope", "X", "099"); } catch { threw = true; }
  check("1.5 categoria exige departamento válido", threw);

  // ===== 2. Árvore + sourceValues =====
  const tree = S.tree(A);
  check("2.1 árvore tem 2 departamentos", tree.length === 2, `n=${tree.length}`);
  const roupasNode = tree.find((d) => d.id === roupas.id)!;
  check("2.2 departamento traz suas categorias", roupasNode.categories.length === 2);
  // ordem por position (criação): Casacos(001) antes de Bermudas(002)
  check("2.3 categorias ordenadas por position", roupasNode.categories[0].name === "Casacos" && roupasNode.categories[1].name === "Bermudas");
  check("2.4 categoria expõe value (código) e name (rótulo)", roupasNode.categories[0].value === "001" && roupasNode.categories[1].value === "002");
  const vals = S.sourceValues(A, roupas.id).sort();
  check("2.5 sourceValues do departamento = códigos", vals.join("|") === "001|002", vals.join("|"));

  // ===== 3. Renomear categoria NÃO toca o produto (filtro é por código) =====
  const p1 = mkProduct(A, "Casaco TOULON", "001");
  const p2 = mkProduct(A, "Casaco jeans", "001");
  const pOther = mkProduct(A, "Cinto couro", "005");
  S.rename(A, casaco.id, "Casacos premium");
  const c1 = (db.prepare(`SELECT category FROM products_services WHERE id=?`).get(p1) as any)?.category;
  check("3.1 renomear categoria não muda o código do produto", c1 === "001");
  check("3.2 nome exibido atualizado", S.tree(A).find((d) => d.id === roupas.id)!.categories[0].name === "Casacos premium");

  // ===== 3b. availableValues traz códigos com contagem/exemplo e flag mapped =====
  const avail = S.availableValues(A);
  const a001 = avail.find((a) => a.value === "001");
  check("3b.1 availableValues conta produtos", !!a001 && a001!.count === 2, JSON.stringify(a001));
  check("3b.2 availableValues marca mapeado", !!a001 && a001!.mapped === true);
  const pUn = mkProduct(A, "Meia lisa", "007");
  check("3b.3 código não mapeado aparece como mapped=false", S.availableValues(A).some((a) => a.value === "007" && !a.mapped));

  // ===== 4. Renomear DEPARTAMENTO não toca produto =====
  S.rename(A, roupas.id, "Moda masculina");
  const still = (db.prepare(`SELECT category FROM products_services WHERE id=?`).get(p1) as any)?.category;
  check("4.1 renomear departamento não muda produto", still === "001");
  check("4.2 nome do departamento atualizado", S.tree(A).find((d) => d.id === roupas.id)?.name === "Moda masculina");

  // ===== 5. Remover =====
  S.remove(A, roupas.id); // departamento → apaga suas categorias do registro
  const treeAfter = S.tree(A);
  check("5.1 remove departamento (some do registro)", !treeAfter.some((d) => d.id === roupas.id));
  const childCount = Number((db.prepare(`SELECT COUNT(*) c FROM storefront_categories WHERE parent_id=?`).get(roupas.id) as any)?.c || 0);
  check("5.2 categorias do departamento somem do registro", childCount === 0);
  const productStillTagged = (db.prepare(`SELECT category FROM products_services WHERE id=?`).get(p1) as any)?.category;
  check("5.3 código do produto preservado após remover departamento", productStillTagged === "001");
  // remover categoria avulsa
  S.remove(A, cinto.id);
  const cintoLeft = Number((db.prepare(`SELECT COUNT(*) c FROM storefront_categories WHERE id=?`).get(cinto.id) as any)?.c || 0);
  check("5.4 remove categoria", cintoLeft === 0);

  // ===== 6. Isolamento multi-tenant =====
  const bDept = S.createDepartment(B, "Calçados");
  S.createCategory(B, bDept.id, "Tênis", "010");
  check("6.1 árvore de A não vê B", !S.tree(A).some((d) => d.name === "Calçados"));
  check("6.2 árvore de B só tem o seu", S.tree(B).length === 1 && S.tree(B)[0].name === "Calçados");
  // mesmo código "001" pode existir em orgs diferentes (isolado)
  const bCasaco = S.createCategory(B, bDept.id, "Botas", "001");
  check("6.3 mesmo código em outra org é permitido (isolado)", !!bCasaco.id);
  check("6.4 sourceValues de B não vê A", S.sourceValues(B, bDept.id).sort().join("|") === "001|010");

  console.log("\n=== TEST: Cadastro de categorias da vitrine ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
