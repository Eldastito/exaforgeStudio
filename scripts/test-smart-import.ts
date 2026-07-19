/**
 * TEST — Importação inteligente PDF/imagem (ADR-101).
 * Testa a lógica determinística (schema, normalização, caminhos de erro).
 * A extração via IA (OpenAI) é glue fino e não roda no CI sem chave.
 * Uso: npm run test:smart-import
 */
import os from "os";
import path from "path";
import fs from "fs";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zf-smartimport-"));
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-smartimport-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { SmartImportService, SMART_IMPORT_SCHEMAS, normalizeRows } = await import("../src/server/SmartImportService.js");

  // 1. Schemas das 3 telas.
  check("1.1 schema products existe", !!SMART_IMPORT_SCHEMAS.products);
  check("1.2 schema prospect existe", !!SMART_IMPORT_SCHEMAS.prospect);
  check("1.3 schema reservas existe", !!SMART_IMPORT_SCHEMAS.reservas);
  check("1.4 getSchema inválido devolve null", SmartImportService.getSchema("xxx") === null);
  check("1.5 products tem os campos do CSV", SMART_IMPORT_SCHEMAS.products.fields.map(f => f.key).join(',') === 'nome,preco,quantidade,descricao,tipo');

  const prod = SMART_IMPORT_SCHEMAS.products;

  // 2. Normalização: coage ao schema, preenche faltantes com "".
  const n1 = normalizeRows(JSON.stringify({ rows: [{ nome: "Camisa", preco: 89.9 }] }), prod);
  check("2.1 uma linha extraída", n1.rows.length === 1);
  check("2.2 preço coagido a string", n1.rows[0].preco === "89.9");
  check("2.3 campos faltantes viram ''", n1.rows[0].descricao === "" && n1.rows[0].tipo === "");
  check("2.4 só chaves do schema entram", !("lixo" in normalizeRows(JSON.stringify({ rows: [{ nome: "X", lixo: "y" }] }), prod).rows[0]));

  // 3. Filtra linhas 100% vazias.
  const n2 = normalizeRows(JSON.stringify({ rows: [{ nome: "A" }, { nome: "", preco: "", quantidade: "", descricao: "", tipo: "" }] }), prod);
  check("3.1 linha totalmente vazia é descartada", n2.rows.length === 1);

  // 4. Warnings preservados.
  const n3 = normalizeRows(JSON.stringify({ rows: [{ nome: "A" }], warnings: ["preço da linha 2 ilegível"] }), prod);
  check("4.1 warnings vêm no retorno", n3.warnings.length === 1 && n3.warnings[0].includes("ilegível"));

  // 5. Aceita array puro (sem envelope {rows}).
  const n4 = normalizeRows(JSON.stringify([{ nome: "A" }, { nome: "B" }]), prod);
  check("5.1 array puro é aceito", n4.rows.length === 2);

  // 6. JSON inválido não quebra — devolve aviso.
  const n5 = normalizeRows("isso não é json", prod);
  check("6.1 JSON inválido devolve 0 linhas + aviso", n5.rows.length === 0 && n5.warnings.length === 1);

  // 7. Caminhos de erro do extract (determinísticos, sem IA).
  const e1 = await SmartImportService.extract(Buffer.from("x"), "application/pdf", "tipo_inexistente");
  check("7.1 tipo inválido -> erro", e1.ok === false && e1.error === "tipo_invalido");
  const e2 = await SmartImportService.extract(Buffer.from("x"), "text/plain", "products");
  check("7.2 formato não suportado -> erro", e2.ok === false && e2.error === "formato_nao_suportado");
  const e3 = await SmartImportService.extract(Buffer.from("não é um pdf de verdade"), "application/pdf", "products");
  check("7.3 PDF sem texto -> pede imagem", e3.ok === false && e3.error === "pdf_sem_texto");

  console.log("\n=== test:smart-import ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s).`); process.exit(1); }
  console.log("\n✅ Importação inteligente: schema + normalização + guardas OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
