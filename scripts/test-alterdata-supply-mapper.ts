/**
 * TEST — Mapper Supply Alterdata (ADR-105, Fase 1b): catálogo.
 *
 * Prova, offline, a tradução Supply → produto/variante do ZappFlow:
 *   - Referencia → produto (upsert idempotente por external_ref);
 *   - update de Referencia atualiza nome/preço sem duplicar;
 *   - CodigoDeBarras → variantes (cor/tamanho/EAN), has_variants=1;
 *   - EAN inválido não vira sku; EAN de capa adotado no produto;
 *   - barra órfã (produto ainda não importado) é pulada;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:alterdata-supply-mapper
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-supply-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-supply-mapper-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AlterdataSupplyMapper } = await import("../src/server/AlterdataSupplyMapper.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const prod = (ref: string) => db.prepare(`SELECT * FROM products_services WHERE organization_id=? AND external_ref=?`).get(A, ref) as any;
  const variants = (pid: string) => db.prepare(`SELECT * FROM product_variants WHERE organization_id=? AND product_service_id=? ORDER BY name`).all(A, pid) as any[];

  // ===== 1. Referencia → produto =====
  const n1 = AlterdataSupplyMapper.upsertReferencias(A, [
    { referenciaId: "1001", descricao: "Camisa Slim Preta", preco: 199.9, precoMin: 149.9, custo: 80, colecao: "VERAO26", grupo: "Camisas", controleVersao: 10 },
    { referenciaId: "1002", descricao: "Calça Alfaiataria", preco: 299, grupo: "Calças", controleVersao: 11 },
  ]);
  check("upsertReferencias importa 2 produtos", n1 === 2);
  const p1 = prod("1001");
  check("produto criado com nome/preço/categoria", p1 && p1.name === "Camisa Slim Preta" && Number(p1.price) === 199.9 && p1.category === "Camisas");
  check("min_price e external_ref gravados", Number(p1.min_price) === 149.9 && p1.external_ref === "1001");
  check("metadata guarda colecao/custo da Alterdata", /VERAO26/.test(p1.metadata_json) && /"custo":80/.test(p1.metadata_json));
  check("nasce como produto de vitrine com controle de estoque", p1.type === "product" && p1.storefront_visible === 1 && p1.stock_control_enabled === 1);

  // ===== 2. Upsert idempotente (update, não duplica) =====
  AlterdataSupplyMapper.upsertReferencias(A, [{ referenciaId: "1001", descricao: "Camisa Slim Preta (nova)", preco: 210, grupo: "Camisas", controleVersao: 20 }]);
  const cnt = (db.prepare(`SELECT COUNT(*) c FROM products_services WHERE organization_id=? AND external_ref='1001'`).get(A) as any).c;
  check("re-importar a mesma referência NÃO duplica", cnt === 1, String(cnt));
  check("update aplica novo nome/preço", prod("1001").name === "Camisa Slim Preta (nova)" && Number(prod("1001").price) === 210);

  // ===== 3. CodigoDeBarras → variantes =====
  const n2 = AlterdataSupplyMapper.upsertCodigosDeBarras(A, [
    { codigo: "1001", cor: "Preto", tamanho: "P", ean: "7891234567895", inativo: 0 },
    { codigo: "1001", cor: "Preto", tamanho: "M", ean: "7891234567901", inativo: 0 },
    { codigo: "1001", cor: "Preto", tamanho: "G", ean: "0000", inativo: 0 }, // EAN inválido
  ]);
  check("upsertCodigosDeBarras trata 3 barras", n2 === 3);
  const vs = variants(p1.id);
  check("3 variantes criadas no produto", vs.length === 3, String(vs.length));
  const vM = vs.find((v) => v.size === "M");
  check("variante M/Preto com cor/tamanho corretos", vM && vM.color === "Preto" && vM.size === "M");
  check("EAN válido vira sku da variante", vM && vM.sku === "7891234567901");
  const vG = vs.find((v) => v.size === "G");
  check("EAN inválido não vira sku", vG && !vG.sku);
  const p1b = prod("1001");
  check("produto marcado com has_variants", p1b.has_variants === 1);
  check("EAN de capa adotado do 1º válido", p1b.ean === "7891234567895");

  // Idempotência das variantes: reprocessar não duplica.
  AlterdataSupplyMapper.upsertCodigosDeBarras(A, [{ codigo: "1001", cor: "Preto", tamanho: "M", ean: "7891234567901", inativo: 0 }]);
  check("re-importar a mesma barra NÃO duplica variante", variants(p1.id).length === 3);

  // Inativa/descontinua → variante active=0.
  AlterdataSupplyMapper.upsertCodigosDeBarras(A, [{ codigo: "1001", cor: "Preto", tamanho: "M", ean: "7891234567901", descontinuado: 1 }]);
  check("descontinuado marca a variante inativa", variants(p1.id).find((v) => v.size === "M")?.active === 0);

  // ===== 4. Barra órfã (produto não importado) é pulada =====
  const nOrphan = AlterdataSupplyMapper.upsertCodigosDeBarras(A, [{ codigo: "9999", cor: "Azul", tamanho: "U", ean: "7899999999994" }]);
  check("barra de produto inexistente é pulada (retorna 0)", nOrphan === 0);

  // ===== 5. Isolamento =====
  const B = `org_${randomUUID().slice(0, 8)}`;
  const bCount = (db.prepare(`SELECT COUNT(*) c FROM products_services WHERE organization_id=? AND external_ref='1001'`).get(B) as any).c;
  check("Isolamento: org B não vê a referência de A", bCount === 0);

  console.log("\n=== TEST: Mapper Supply Alterdata (ADR-105, Fase 1b) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
