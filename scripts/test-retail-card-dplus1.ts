/**
 * TESTE — Recebíveis de cartão em modo D+1 (CARD-DPLUS1-001).
 *
 * Pedido da dona TOULON (20/09/2026): a loja recebe do adquirente D+1 o VALOR
 * INTEIRO da venda à vista, mesmo quando o CLIENTE parcelou. O modo padrão
 * (parcelas do cliente) repete o valor mês a mês e quebra a conferência.
 *
 * Prova, offline:
 *  - modo D+1 projeta 1 linha por TRANSAÇÃO, valor inteiro, em (venda + 1);
 *  - venda parcelada NÃO é repetida (aparece uma vez pelo total);
 *  - o total do mês da venda fica INTEIRO no D+1 (o modo parcelas só pega a
 *    parcela que vence no mês → subvalorizado);
 *  - filtro por filial; flag opt-in (default parcelas, 0-regressão); isolamento.
 *
 * Uso:  npm run test:retail-card-dplus1
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-carddp1-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-carddp1-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.02;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailCardReceivableService: R } = await import("../src/server/RetailCardReceivableService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);

  const ins = (filial: string, numero: string, parcela: string, seq: number, saleDate: string, venc: string, valor: number, liquido: number) =>
    db.prepare(`INSERT INTO retail_pdv_card_installments (id, organization_id, filial, boleta, sale_date, numero, parcela, seq, codigo_cartao, valor, liquido, taxa, vencimento) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'VISA', ?, ?, 0, ?)`)
      .run(randomUUID(), A, filial, "b" + numero, saleDate, numero, parcela, seq, valor, liquido, venc);

  // T1: venda parcelada 3x em 10/09, R$100 cada (total 300) — vencimentos em set/out/nov.
  ins("F1", "T1", "1/3", 1, "2026-09-10", "2026-09-15", 100, 97);
  ins("F1", "T1", "2/3", 2, "2026-09-10", "2026-10-15", 100, 97);
  ins("F1", "T1", "3/3", 3, "2026-09-10", "2026-11-15", 100, 97);
  // T2: à vista em 10/09, R$200. T3: à vista em 11/09 R$50. T4: outra filial.
  ins("F1", "T2", "1/1", 1, "2026-09-10", "2026-09-11", 200, 194);
  ins("F1", "T3", "1/1", 1, "2026-09-11", "2026-09-12", 50, 48);
  ins("F2", "T4", "1/1", 1, "2026-09-10", "2026-09-11", 999, 970);

  // ===== 1. flag default = installments (0-regressão) =====
  check("1.1 modo default = installments", R.getMode(A) === "installments");

  // ===== 2. D+1: recebimento = venda + 1, valor inteiro por transação =====
  const dp = R.dplus1Rows(A, "2026-09-01", "2026-09-30", { detailed: true });
  const byRec = new Map<string, any>(dp.byDayRows.map((r: any) => [r.vencimento, r]));
  // 11/09 (venda 10/09 +1) na visão REDE: T1 (300) + T2 (200) + T4/F2 (999) = 1499, 3 vendas.
  check("2.1 recebimento 11/09 (rede) = 3 vendas, bruto 1499", near(byRec.get("2026-09-11")?.bruto, 1499) && Number(byRec.get("2026-09-11")?.parcelas) === 3, JSON.stringify(byRec.get("2026-09-11")));
  check("2.2 recebimento 12/09 = 1 venda, bruto 50", near(byRec.get("2026-09-12")?.bruto, 50) && Number(byRec.get("2026-09-12")?.parcelas) === 1);
  check("2.3 F2 (outra filial) NÃO entra sem filtro? entra (rede) → total tem 999", dp.byDayRows.some((r: any) => near(r.bruto, 999) || r.bruto > 999));

  // ===== 3. venda parcelada aparece UMA vez pelo total (não repete) =====
  const t1Items = (dp.rowsD || []).filter((r: any) => r.numero === "T1");
  check("3.1 T1 aparece 1 linha só (não 3 parcelas)", t1Items.length === 1, String(t1Items.length));
  check("3.2 T1 valor inteiro = 300 (não 100)", near(t1Items[0]?.valor, 300), String(t1Items[0]?.valor));
  check("3.3 T1 recebimento = 11/09 e parcela 'à vista'", t1Items[0]?.vencimento === "2026-09-11" && t1Items[0]?.parcela === "à vista");

  // ===== 4. o mês fica INTEIRO no D+1 × parcelas (subvalorizado) =====
  const dpTotal = dp.byDayRows.reduce((a: number, r: any) => a + Number(r.bruto), 0); // F1: 300+200+50=550 (+F2 999)
  const dpF1 = R.dplus1Rows(A, "2026-09-01", "2026-09-30", { filial: "F1" }).byDayRows.reduce((a: number, r: any) => a + Number(r.bruto), 0);
  check("4.1 D+1 F1 pega a venda inteira no mês (550)", near(dpF1, 550), String(dpF1));
  // Modo parcelas na MESMA janela só captura a parcela que vence em setembro:
  // T1 parc1 (100) + T2 (200) + T3 (50) = 350 — prova o "quebra mês a mês".
  const instF1 = (db.prepare(`SELECT COALESCE(SUM(valor),0) AS s FROM retail_pdv_card_installments WHERE organization_id=? AND filial='F1' AND vencimento BETWEEN ? AND ?`).get(A, "2026-09-01", "2026-09-30") as any).s;
  check("4.2 modo parcelas subvaloriza o mês (350, só a parcela de set)", near(instF1, 350), String(instF1));
  check("4.3 D+1 (550) > parcelas (350) — captura a venda inteira", dpF1 > Number(instF1));

  // ===== 5. filtro por filial =====
  check("5.1 filtro F1 exclui a venda da F2 (999)", !R.dplus1Rows(A, "2026-09-01", "2026-09-30", { filial: "F1" }).byDayRows.some((r: any) => near(r.bruto, 999)));

  // ===== 6. toggle da flag =====
  R.setDplus1(A, true);
  check("6.1 setDplus1(true) → modo dplus1", R.getMode(A) === "dplus1" && R.isDplus1(A) === true);
  R.setDplus1(A, false);
  check("6.2 setDplus1(false) → volta pra installments", R.getMode(A) === "installments");

  // ===== 7. isolamento =====
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), B);
  check("7.1 org B não vê recebíveis de A", R.dplus1Rows(B, "2026-09-01", "2026-09-30", {}).byDayRows.length === 0);

  // ===== 8. janela: parcela de outubro (modo parcelas) não some no D+1 =====
  // A venda de 10/09 é recebida 11/09 — em outubro o D+1 não mostra nada dela.
  const octDp = R.dplus1Rows(A, "2026-10-01", "2026-10-31", { filial: "F1" }).byDayRows;
  check("8.1 outubro no D+1 não repete a venda de setembro", octDp.length === 0, JSON.stringify(octDp));

  console.log("\n=== TEST: Recebíveis de cartão D+1 ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
