/**
 * TESTE — troca de código de filial no histórico (1006 → 1084): prévia, aplicar com confirmação, colisão nunca
 * sobrescrita, desfazer exato, isolamento. Uso: npm run test:retail-filial-remap
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-filial-remap-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-filial-remap-1234567890abc";
let failures = 0;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) failures++; };
const throws = (fn: () => any, re: RegExp) => { try { fn(); return false; } catch (e: any) { return re.test(e.message); } };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailFilialRemapService: S } = await import("../src/server/RetailFilialRemapService.js");
  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string, code: string, active = 1) => db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, name, code, active);
  const sale = (org: string, filial: string, boleta: string, date: string, valor: number, vend = "V1", status = "N") => db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, filial, boleta, date, vend, valor, status);
  const item = (org: string, filial: string, boleta: string, date: string, seq: number) => db.prepare(`INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, valor) VALUES (?, ?, ?, ?, ?, ?, 10)`).run(randomUUID(), org, filial, boleta, date, seq);
  const inst = (org: string, filial: string, boleta: string, date: string, numero: string, parcela: number, seq = 1) => db.prepare(`INSERT INTO retail_pdv_card_installments (id, organization_id, filial, boleta, sale_date, numero, parcela, seq, valor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 5)`).run(randomUUID(), org, filial, boleta, date, numero, parcela, seq);
  const erp = (org: string, filial: string, mat: string, date: string) => db.prepare(`INSERT INTO retail_erp_seller_sales (id, organization_id, filial, sale_date, matricula, valor) VALUES (?, ?, ?, ?, ?, 1)`).run(randomUUID(), org, filial, date, mat);
  const cnt = (org: string, t: string, filial: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE organization_id = ? AND filial = ?`).get(org, filial) as any).n;
  const snap = (org: string) => ["retail_pdv_sales", "retail_pdv_sale_items", "retail_pdv_card_installments", "retail_erp_seller_sales"].map((t) => ["1006", "1084"].map((f) => cnt(org, t, f)).join("/")).join(" | ");

  store(A, "Grande Rio", "1084"); store(A, "Av. Brasil", "1082"); store(A, "MT FRANQUIA", "1005", 0);
  const D = "2026-06-10";
  // 1006: 5 vendas. S4 colide idêntica; S5 colide com valor DIFERENTE.
  sale(A, "1006", "S1", "2026-05-01", 100); sale(A, "1006", "S2", "2026-05-02", 200); sale(A, "1006", "S3", "2026-05-03", 300, "V1", "C");
  sale(A, "1006", "S4", D, 400); sale(A, "1006", "S5", D, 500);
  sale(A, "1084", "S4", D, 400); sale(A, "1084", "S5", D, 999); sale(A, "1084", "N1", "2026-09-01", 50);
  item(A, "1006", "S1", "2026-05-01", 1); item(A, "1006", "S4", D, 1); item(A, "1006", "S5", D, 7);   // S5 item NÃO tem par, mas a venda S5 fica → o item fica
  item(A, "1084", "S4", D, 1);
  inst(A, "1006", "S1", "2026-05-01", "N1", 1); inst(A, "1006", "S4", D, "N4", 1); inst(A, "1084", "S4", D, "N4", 1);
  erp(A, "1006", "M1", "2026-05-01"); erp(A, "1006", "M2", "2026-05-01"); erp(A, "1084", "M2", "2026-05-01");
  sale(B, "1006", "S1", "2026-05-01", 777); store(B, "Outra", "1084");

  const before = snap(A), beforeB = snap(B);
  const p = S.plan(A, "1006", "1084");
  check("plano: vendas movem 3, ficam 2", p.tables.pdvSales.total === 5 && p.tables.pdvSales.move === 3 && p.tables.pdvSales.stay === 2);
  check("plano: item de venda que fica também fica", p.tables.saleItems.total === 3 && p.tables.saleItems.move === 1 && p.tables.saleItems.stay === 2);
  check("plano: parcela e ERP com colisão ficam", p.tables.cardInstallments.move === 1 && p.tables.erpSellerSales.move === 1 && p.tables.erpSellerSales.stay === 1);
  check("plano: colisões de venda idênticas × diferentes", p.salesCollisions.identical === 1 && p.salesCollisions.different === 1);
  check("plano: período e valor do que move (cancelada fora)", p.moving.firstDate === "2026-05-01" && p.moving.lastDate === "2026-05-03" && p.moving.pdvTotal === 300);
  check("plano é só leitura", snap(A) === before);

  check("recusa código antigo que é de loja ATIVA", throws(() => S.plan(A, "1082", "1084"), /ATIVA/));
  check("recusa destino sem loja ativa (inativo ou inexistente)", throws(() => S.plan(A, "1006", "1005"), /ativa/) && throws(() => S.plan(A, "1006", "9999"), /ativa/));
  check("recusa códigos iguais/vazios", throws(() => S.plan(A, "1006", "1006"), /iguais/) && throws(() => S.plan(A, "", "1084"), /Informe/));

  const exp = Object.fromEntries(Object.entries(p.tables).map(([k, v]) => [k, v.move]));
  check("apply exige digitar a confirmação", throws(() => S.apply(A, { from: "1006", into: "1084", confirm: "sim", expectedMove: exp }), /confirm_mismatch/) && snap(A) === before);
  check("apply recusa se os números da prévia mudaram", throws(() => S.apply(A, { from: "1006", into: "1084", confirm: "1006>1084", expectedMove: { ...exp, pdvSales: 99 } }), /plan_changed/) && snap(A) === before);

  const r = S.apply(A, { from: "1006", into: "1084", confirm: "1006>1084", expectedMove: exp }, "u1");
  check("moveu exatamente o previsto", r.moved.pdvSales === 3 && r.moved.saleItems === 1 && r.moved.cardInstallments === 1 && r.moved.erpSellerSales === 1);
  check("vendas sem colisão agora estão no 1084", cnt(A, "retail_pdv_sales", "1084") === 3 + 3 && cnt(A, "retail_pdv_sales", "1006") === 2);
  check("colisões ficaram no lugar com o valor original", (db.prepare(`SELECT valor FROM retail_pdv_sales WHERE organization_id = ? AND filial = '1084' AND boleta = 'S5'`).get(A) as any).valor === 999 && (db.prepare(`SELECT valor FROM retail_pdv_sales WHERE organization_id = ? AND filial = '1006' AND boleta = 'S5'`).get(A) as any).valor === 500);
  check("nada foi apagado (total de linhas igual)", ["retail_pdv_sales", "retail_pdv_sale_items", "retail_pdv_card_installments", "retail_erp_seller_sales"].every((t) => cnt(A, t, "1006") + cnt(A, t, "1084") === ({ retail_pdv_sales: 8, retail_pdv_sale_items: 4, retail_pdv_card_installments: 3, retail_erp_seller_sales: 3 } as any)[t]));
  check("outra organização intacta", snap(B) === beforeB);
  check("segunda aplicação: nada a mover", throws(() => S.apply(A, { from: "1006", into: "1084", confirm: "1006>1084", expectedMove: { pdvSales: 0, saleItems: 0, cardInstallments: 0, erpSellerSales: 0 } }), /nothing_to_move/));
  check("histórico registra a troca", S.history(A)[0].id === r.remapId && S.history(A)[0].undoneAt === null && S.history(B).length === 0);

  // um novo registro com a mesma chave aparece sob o código antigo → o desfazer não pode colidir
  sale(A, "1006", "S1", "2026-05-01", 1);
  const u = S.undo(A, r.remapId, "u1");
  check("desfazer devolve o que pôde e conta o que não pôde", u.returned.pdvSales === 2 && u.notReturned.pdvSales === 1 && u.returned.saleItems === 1 && u.returned.cardInstallments === 1 && u.returned.erpSellerSales === 1);
  check("o que já era do 1084 continua no 1084", cnt(A, "retail_pdv_sales", "1084") === 3 + 1 /* S1 ficou: tinha colisão nova */ && (db.prepare(`SELECT COUNT(*) n FROM retail_pdv_sales WHERE organization_id = ? AND filial = '1084' AND boleta IN ('S4','S5','N1')`).get(A) as any).n === 3);
  check("desfazer duas vezes é recusado", throws(() => S.undo(A, r.remapId), /already_undone/));
  check("desfazer troca de outra org é recusado", throws(() => S.undo(B, r.remapId), /não encontrada/));
  check("histórico marca como desfeita", S.history(A)[0].undoneAt !== null);

  const src = fs.readFileSync("src/server/RetailFilialRemapService.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  check("nunca apaga linhas do histórico", !/DELETE\s+FROM\s+retail_(pdv|erp)/i.test(src));
  check("aplicar roda em transação única", /db\.transaction\(\(\) => \{[\s\S]*retail_filial_remap_rows[\s\S]*UPDATE \$\{sp\.table\} SET filial = @into/.test(src));
  const routes = fs.readFileSync("src/server/routes/retailops.ts", "utf8");
  check("rotas atrás do escopo da rede", ['get("/stores/filial-remap/plan"', 'get("/stores/filial-remap/history"', 'post("/stores/filial-remap/apply"', 'post("/stores/filial-remap/undo/:remapId"'].every((x) => routes.includes(`router.${x}, requireNetworkScope`)));
  const card = fs.readFileSync("src/features/retailops/FilialCodeAuditCard.tsx", "utf8");
  check("tela: só aplica com a confirmação digitada e manda os números da prévia", /typed\.trim\(\) !== plan\.confirmWith/.test(card) && /expectedMove/.test(card) && /confirm: typed\.trim\(\)/.test(card));
  check("tela: prévia sem 'nada alterado' escondido, desfazer pede confirmação", /prévia, nada foi alterado ainda/.test(card) && /window\.confirm\('Desfazer/.test(card));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
