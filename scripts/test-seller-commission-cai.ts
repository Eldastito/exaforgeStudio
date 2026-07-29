/**
 * TESTE — Comissão por vendedor via CAI_USUARIO (homologação Toulon, ADR-105)
 * --------------------------------------------------------------------------
 * A Alterdata confirmou que a `matricula` do VendaMalote é o OPERADOR de caixa;
 * o VENDEDOR (base da comissão individual) é o CAI_USUARIO (relação com
 * VENDEDORES por VEN_CODIGO = CAI_CODIGO). No nosso modelo isso vira a coluna
 * `retail_pdv_sales.vendedor_codigo`.
 *
 * Prova, offline:
 *   - pdvSalesBySeller atribui a venda ao VENDEDOR (vendedor_codigo), não ao
 *     operador de caixa (vendedor);
 *   - dois operadores diferentes vendendo pelo mesmo vendedor somam no vendedor;
 *   - fallback: sem vendedor_codigo (base antiga), cai no operador;
 *   - nome do vendedor vem do mapeamento retail_sellers (matrícula = CAI_USUARIO);
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:seller-commission-cai
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seller-cai-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-seller-cai-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");

  const orgId = `org_${randomUUID().slice(0, 6)}`;
  const orgB = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Toulon', 'active')`).run(randomUUID(), orgId);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Outra', 'active')`).run(randomUUID(), orgB);

  const sale = (org: string, boleta: string, date: string, operador: string, vendedorCodigo: string | null, valor: number) => {
    db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, usuario, vendedor_codigo, valor, pecas, status)
      VALUES (?, ?, '1', ?, ?, ?, ?, ?, ?, 1, 'N')`)
      .run(randomUUID(), org, boleta, date, operador, vendedorCodigo, vendedorCodigo, valor);
  };

  const D = "2026-07-10";
  // Operador OP1 no caixa, mas dois vendedores diferentes (V1, V2)
  sale(orgId, "b1", D, "OP1", "V1", 100);
  sale(orgId, "b2", D, "OP1", "V2", 50);
  // Mesmo vendedor V1 vendendo por OUTRO operador (OP2) — deve somar em V1
  sale(orgId, "b3", D, "OP2", "V1", 30);
  // Venda antiga sem vendedor_codigo → fallback para o operador OP3
  sale(orgId, "b4", D, "OP3", null, 20);

  // Mapeamento de nome do vendedor por CAI_USUARIO (matrícula = código do vendedor)
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'V1', 'Ana Vendedora')`).run(randomUUID(), orgId);

  const rows = RetailCommissionService.pdvSalesBySeller(orgId, "2026-07-01", "2026-07-31");
  const byKey = Object.fromEntries(rows.map((r: any) => [r.matricula, r]));

  check("Atribui pelo VENDEDOR (V1), não pelo operador (OP1)", !!byKey["V1"] && !byKey["OP1"]);
  check("Mesmo vendedor por operadores diferentes soma (V1 = 100+30)", Number(byKey["V1"]?.sales) === 130 && Number(byKey["V1"]?.orders) === 2);
  check("Segundo vendedor separado (V2 = 50)", Number(byKey["V2"]?.sales) === 50);
  check("Nome do vendedor vem do retail_sellers (V1 = Ana Vendedora)", byKey["V1"]?.sellerName === "Ana Vendedora");
  check("Fallback para operador quando não há CAI_USUARIO (OP3 = 20)", Number(byKey["OP3"]?.sales) === 20);
  check("Total de chaves de vendedor é 3 (V1, V2, OP3)", rows.length === 3);

  // Isolamento
  sale(orgB, "b1", D, "OPX", "VX", 999);
  const rowsB = RetailCommissionService.pdvSalesBySeller(orgB, "2026-07-01", "2026-07-31");
  check("Org B só vê o próprio vendedor", rowsB.length === 1 && rowsB[0].matricula === "VX");
  check("Org A não foi contaminada", RetailCommissionService.pdvSalesBySeller(orgId, "2026-07-01", "2026-07-31").every((r: any) => r.matricula !== "VX"));

  console.log("\n=== Comissão por vendedor via CAI_USUARIO (ADR-105, homologação Toulon) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
