/**
 * TESTE — Drill-down "vendas do dia" (RetailPdvSaleLinesService).
 * ------------------------------------------------------------------------------
 * Prova, offline, o detalhe por LINHA (cada uma com a DATA da venda), já que as
 * abas Mais vendidos/Por vendedor mostram só somas do período:
 *   - filtra por produto (código do ERP) e devolve cada linha com sua data;
 *   - resolve o nome da loja (filial→retail_stores.code) e do vendedor
 *     (matrícula→retail_sellers) quando existem;
 *   - filtra por vendedor e por loja;
 *   - ordena da mais recente pra mais antiga;
 *   - respeita o limite (cap) e devolve o total real;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-pdv-sale-lines
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pdv-sale-lines-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-pdv-sale-lines-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailPdvSaleLinesService: S } = await import("../src/server/RetailPdvSaleLinesService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);

  // Loja "01" (Centro) e vendedor 1024 (Maria) — pra provar a resolução de nomes.
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Centro', '01', 1)`).run(randomUUID(), A);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, '1024', 'Maria', 1)`).run(randomUUID(), A);

  const item = (org: string, filial: string, boleta: string, date: string, seq: number, produto: string, qtd: number, valor: number, vendedor: string | null) =>
    db.prepare(`INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor, vendedor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), org, filial, boleta, date, seq, produto, qtd, valor, vendedor);

  // Produto CAMISA (código ERP 011994036015): 3 vendas em datas diferentes.
  item(A, "01", "100", "2026-08-10", 1, "011994036015", 1, 99.9, "1024");
  item(A, "01", "101", "2026-08-12", 1, "011994036015", 2, 199.8, "1024");
  item(A, "02", "102", "2026-08-15", 1, "011994036015", 1, 99.9, "2048");
  // Outro produto (não deve entrar no filtro por produto).
  item(A, "01", "103", "2026-08-11", 1, "999999999999", 1, 50, "1024");
  // Fora do período.
  item(A, "01", "104", "2026-07-30", 1, "011994036015", 1, 99.9, "1024");

  // ===== 1. filtro por produto + data por linha =====
  const r = S.lines(A, { produto: "011994036015", start: "2026-08-01", end: "2026-08-31" });
  check("Só as 3 linhas do produto no período", r.total === 3 && r.lines.length === 3, `total=${r.total} shown=${r.lines.length}`);
  check("Cada linha traz a DATA da venda", r.lines.every((l: any) => !!l.date));
  check("Ordena da mais recente pra mais antiga", r.lines[0].date === "2026-08-15" && r.lines[2].date === "2026-08-10", `datas=${r.lines.map((l: any) => l.date).join(",")}`);
  check("Resolve nome da loja (01→Centro)", r.lines.some((l: any) => l.loja === "Centro"));
  check("Resolve nome do vendedor (1024→Maria)", r.lines.some((l: any) => l.vendedorNome === "Maria"));
  check("Vendedor sem cadastro cai no código cru (2048)", r.lines.some((l: any) => l.vendedorNome === "2048"));
  check("Peças e valor por linha", r.lines.find((l: any) => l.boleta === "101")?.pecas === 2 && r.lines.find((l: any) => l.boleta === "101")?.valor === 199.8);

  // ===== 2. filtro por vendedor e por loja =====
  const rv = S.lines(A, { produto: "011994036015", vendedor: "1024", start: "2026-08-01", end: "2026-08-31" });
  check("Filtro por vendedor 1024 → 2 linhas", rv.total === 2 && rv.lines.every((l: any) => l.vendedor === "1024"), `total=${rv.total}`);
  const rs = S.lines(A, { produto: "011994036015", store: "02", start: "2026-08-01", end: "2026-08-31" });
  check("Filtro por loja 02 → 1 linha", rs.total === 1 && rs.lines[0].filial === "02");

  // ===== 3. limite (cap) devolve total real =====
  const rc = S.lines(A, { produto: "011994036015", start: "2026-08-01", end: "2026-08-31", limit: 2 });
  check("cap=2 mostra 2 mas total continua 3", rc.lines.length === 2 && rc.total === 3 && rc.cap === 2);

  // ===== 4. sem datas → vazio =====
  const rEmpty = S.lines(A, { produto: "011994036015", start: "", end: "" });
  check("Sem período → vazio", rEmpty.lines.length === 0 && rEmpty.total === 0);

  // ===== 5. isolamento =====
  check("Isolamento: org B vem vazia", S.lines(B, { produto: "011994036015", start: "2026-08-01", end: "2026-08-31" }).total === 0);

  console.log("\n=== Drill-down vendas do dia (RetailPdvSaleLinesService) ===");
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok || !x.detail ? "" : ` — ${x.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
