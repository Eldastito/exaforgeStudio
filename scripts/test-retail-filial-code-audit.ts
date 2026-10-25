/**
 * TESTE — prévia SOMENTE LEITURA de vendas sob códigos de filial sem loja ativa (loja que mudou de código).
 * Uso: npm run test:retail-filial-code-audit
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-filial-audit-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-filial-audit-1234567890abc";
let failures = 0;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) failures++; };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailFilialCodeAuditService: S } = await import("../src/server/RetailFilialCodeAuditService.js");
  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string, code: string | null, active = 1) => db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, name, code, active);
  let n = 0;
  const sale = (org: string, filial: string, date: string, valor = 100, status = "N", boleta?: string) => db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor, status) VALUES (?, ?, ?, ?, ?, 'V1', ?, ?)`).run(randomUUID(), org, filial, boleta || `b${n++}`, date, valor, status);
  const item = (org: string, filial: string, boleta: string, date: string, seq: number) => db.prepare(`INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, valor) VALUES (?, ?, ?, ?, ?, ?, 10)`).run(randomUUID(), org, filial, boleta, date, seq);
  const inst = (org: string, filial: string, numero: string, parcela: number, seq: number) => db.prepare(`INSERT INTO retail_pdv_card_installments (id, organization_id, filial, boleta, sale_date, numero, parcela, seq, valor) VALUES (?, ?, ?, 'x', '2026-05-01', ?, ?, ?, 5)`).run(randomUUID(), org, filial, numero, parcela, seq);
  const erp = (org: string, filial: string, mat: string, date: string) => db.prepare(`INSERT INTO retail_erp_seller_sales (id, organization_id, filial, sale_date, matricula, valor) VALUES (?, ?, ?, ?, ?, 1)`).run(randomUUID(), org, filial, date, mat);

  store(A, "Grande Rio", "1084"); store(A, "Av. Brasil", "1082"); store(A, "MT FRANQUIA GRANDE RIO", "1005", 0);
  sale(A, "1005", "2026-01-10", 100); sale(A, "1005", "2026-03-01", 200); sale(A, "1005", "2026-03-02", 50, "C");
  sale(A, "1006", "2026-04-01", 300); sale(A, "1006", "2026-06-30", 400, "N", "DUP1");
  sale(A, "1084", "2026-07-01", 999, "N", "DUP1");                 // mesma boleta/dia do 1006 → colisão... (dia diferente: sem colisão)
  sale(A, "1084", "2026-06-30", 1, "N", "DUP1");                   // mesma boleta + mesmo dia que 1006/DUP1 → colide
  sale(A, "1082", "2026-02-01", 10);
  item(A, "1006", "DUP1", "2026-06-30", 1); item(A, "1084", "DUP1", "2026-06-30", 1); item(A, "1005", "z", "2026-01-10", 1);
  inst(A, "1005", "N1", 1, 1); inst(A, "1005", "N2", 1, 1); inst(A, "1084", "N2", 1, 1);
  erp(A, "1005", "M1", "2026-01-10"); erp(A, "1084", "M1", "2026-01-10"); erp(A, "1006", "M9", "2026-05-01");
  sale(B, "1005", "2026-01-10", 12345); store(B, "Outra org", "1084");

  const before = ["retail_pdv_sales", "retail_pdv_sale_items", "retail_pdv_card_installments", "retail_erp_seller_sales"].map((t) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n);

  const r = S.report(A);
  check("lista só códigos sem loja ativa (1005 e 1006)", r.orphans.map((o) => o.filial).join() === "1005,1006");
  check("loja ativa 1084/1082 não aparece", !r.orphans.some((o) => ["1084", "1082"].includes(o.filial)));
  const o5 = r.orphans.find((o) => o.filial === "1005")!, o6 = r.orphans.find((o) => o.filial === "1006")!;
  check("1005: reconhece a loja inativa", o5.storeRecord?.name === "MT FRANQUIA GRANDE RIO" && o5.storeRecord.active === false);
  check("1006: sem loja cadastrada", o6.storeRecord === null);
  check("1005: 3 vendas, período e valor sem cancelada", o5.pdvSales.rows === 3 && o5.pdvSales.firstDate === "2026-01-10" && o5.pdvSales.lastDate === "2026-03-02" && o5.pdvSales.total === 300);
  check("conta itens, parcelas e vendas por vendedor do ERP", o5.saleItems.rows === 1 && o5.cardInstallments.rows === 2 && o5.erpSellerSales.rows === 1 && o6.erpSellerSales.rows === 1);
  check("sem destino: não calcula colisão", o5.collisions === null && r.summary.orphanCodes === 2);
  check("resumo soma PDV", r.summary.pdvSales === 5 && r.summary.pdvTotal === 1000);

  const t = S.report(A, { into: "1084" });
  const t5 = t.orphans.find((o) => o.filial === "1005")!, t6 = t.orphans.find((o) => o.filial === "1006")!;
  check("destino reconhecido", t.target?.name === "Grande Rio" && !t.intoNotFound);
  check("1006: colide a boleta+dia, o item e nada mais", t6.collisions!.pdvSales === 1 && t6.collisions!.saleItems === 1 && t6.collisions!.total === 2 && t6.cleanToRemap === false);
  check("1005: colide a parcela de cartão e a venda do ERP", t5.collisions!.cardInstallments === 1 && t5.collisions!.erpSellerSales === 1 && t5.collisions!.pdvSales === 0);
  check("sobreposição de período indicada", t6.overlapsTarget === true && t5.overlapsTarget === false && t5.gapDaysToTarget! > 0);
  check("destino inexistente avisa e não calcula", (() => { const x = S.report(A, { into: "9999" }); return x.intoNotFound === true && x.target === null && x.orphans.every((o) => o.collisions === null); })());
  check("destino inativo não conta como destino", S.report(A, { into: "1005" }).intoNotFound === true);
  check("isolamento: outra org vê só a sua", S.report(B).orphans.length === 1 && S.report(B).summary.pdvTotal === 12345 && !S.report(B).orphans[0].storeRecord);
  check("não alterou nenhuma linha", ["retail_pdv_sales", "retail_pdv_sale_items", "retail_pdv_card_installments", "retail_erp_seller_sales"].map((x) => (db.prepare(`SELECT COUNT(*) n FROM ${x}`).get() as any).n).join() === before.join());
  const src = fs.readFileSync("src/server/RetailFilialCodeAuditService.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/`[^`]*`/g, "``");
  check("serviço não escreve no banco", !/\.run\(|INSERT|UPDATE|DELETE/.test(src));
  const routes = fs.readFileSync("src/server/routes/retailops.ts", "utf8");
  check("rota GET montada atrás do escopo da rede, sem POST/PUT", /router\.get\("\/stores\/filial-codes\/audit", requireNetworkScope/.test(routes) && !/router\.(post|put|patch|delete)\("\/stores\/filial-codes/.test(routes));
  check("tela montada só para a rede", /\{isNetwork && <FilialCodeAuditCard \/>\}/.test(fs.readFileSync("src/features/RetailOpsView.tsx", "utf8")));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
