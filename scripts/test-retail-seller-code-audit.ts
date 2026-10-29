/**
 * TESTE — auditoria somente-leitura dos códigos de vendedor (parado >45d, sucessor na mesma loja,
 * mesmo nome no ERP, caixa compartilhado, código de teste, isolamento). Uso: npm run test:retail-seller-code-audit
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seller-audit-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-seller-audit-1234567890abc";
let failures = 0;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) failures++; };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailSellerCodeAuditService: S } = await import("../src/server/RetailSellerCodeAuditService.js");
  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Av Brasil', '1001')`).run(randomUUID(), A);
  let b = 0;
  const sale = (org: string, code: string, date: string, filial = "1001", n = 1) => { for (let i = 0; i < n; i++) db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor) VALUES (?, ?, ?, ?, ?, ?, 10)`).run(randomUUID(), org, filial, `b${b++}`, date, code); };
  const erp = (org: string, code: string, name: string) => db.prepare(`INSERT INTO retail_erp_seller_sales (id, organization_id, filial, sale_date, matricula, seller_name, valor) VALUES (?, ?, '1001', '2026-05-01', ?, ?, 1)`).run(randomUUID(), org, code, name);
  const ASOF = "2026-10-25";

  sale(A, "OLD1", "2026-03-01"); sale(A, "OLD1", "2026-06-30");          // parou em 30/06
  sale(A, "NEW1", "2026-07-05", "1001", 3); sale(A, "NEW1", "2026-10-24"); // começou 5 dias depois, mesma loja
  sale(A, "ACT1", "2026-01-10"); sale(A, "ACT1", "2026-10-20");          // ativo, antigo
  sale(A, "BOX1", "2026-06-29", "1001", 60);                             // muito volume num dia só
  sale(A, "987654", "2026-04-27");                                        // padrão de teste
  sale(A, "LIM", "2026-09-10");                                           // 45 dias exatos → ativo
  sale(A, "LIM2", "2026-09-09");                                          // 46 dias → parado
  sale(A, "ALONE", "2026-03-01"); sale(A, "ALONE", "2026-04-01", "9999"); // parado sem sucessor (outra filial)
  sale(B, "OTHER", "2026-10-01");
  erp(A, "OLD1", "Maria Souza"); erp(A, "NEW1", "MARIA  souza"); erp(A, "ACT1", "João");

  const r = S.audit(A, { asOf: ASOF });
  const row = (m: string) => r.pending.find((x) => x.matricula === m)!;
  check("somente leitura: nenhuma venda alterada", (db.prepare(`SELECT COUNT(*) n FROM retail_pdv_sales WHERE organization_id = ?`).get(A) as any).n === b - 1);
  check("OLD1 parado há 117 dias", row("OLD1").status === "parado" && row("OLD1").daysSinceLast === 117);
  check("ACT1 ativo", row("ACT1").status === "ativo");
  check("limite: 45 dias é ativo, 46 é parado", row("LIM").status === "ativo" && row("LIM2").status === "parado");
  check("sucessor FORTE: mesmo nome no ERP + mesma loja", row("OLD1").successors[0]?.matricula === "NEW1" && row("OLD1").successors[0].evidence === "forte");
  check("nome aparece em 2 códigos", r.sameNameGroups.some((g) => g.matriculas.includes("OLD1") && g.matriculas.includes("NEW1")));
  check("sem nome em comum vira só 'possivel'", (() => { const x = S.audit(A, { asOf: ASOF }); db.prepare(`DELETE FROM retail_erp_seller_sales WHERE organization_id = ?`).run(A); const y = S.audit(A, { asOf: ASOF }); erp(A, "OLD1", "Maria Souza"); erp(A, "NEW1", "MARIA  souza"); erp(A, "ACT1", "João"); return x.pending.length === y.pending.length && y.pending.find((p) => p.matricula === "OLD1")!.successors[0]?.evidence === "possivel" && y.summary.erpNamesAvailable === false; })());
  check("parado sem código novo na mesma loja não inventa sucessor", row("ALONE").successors.length === 0);
  check("caixa compartilhado sinalizado", row("BOX1").flags.sharedBoxSuspect === true && row("ACT1").flags.sharedBoxSuspect === false);
  check("código de teste sinalizado", row("987654").flags.testPattern === true && row("OLD1").flags.testPattern === false);
  check("nome da loja resolvido", row("OLD1").stores[0].storeName === "Av Brasil");
  check("não mistura organizações", !r.pending.some((x) => x.matricula === "OTHER") && S.audit(B, { asOf: ASOF }).pending.length === 1);
  check("identificado sai da pendência mas segue como candidato a sucessor", (() => { db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'NEW1', 'Maria Souza')`).run(randomUUID(), A); const z = S.audit(A, { asOf: ASOF }); return !z.pending.some((x) => x.matricula === "NEW1") && z.pending.find((x) => x.matricula === "OLD1")!.successors[0]?.matricula === "NEW1"; })());
  check("resumo coerente", r.summary.pending === r.pending.length && r.summary.pendingActive + r.summary.pendingStopped === r.summary.pending);

  // ── pessoa provável pelo lançamento manual diário (BANGU: PDV 10830005 vs manual do Marcus) ──
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'BANGU', '1083')`).run(randomUUID(), A);
  const mk = (code: string, date: string, v: number) => db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor) VALUES (?, ?, '1083', ?, ?, ?, ?)`).run(randomUUID(), A, `p${b++}`, date, code, v);
  const man = (name: string, date: string, v: number, mat: string | null = null) => db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, sale_date, seller_name, matricula, valor) VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), A, date, name, mat, v);
  const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"];
  const marcusV = [900, 1200, 800, 1500, 700, 1000, 1100], outroV = [300, 2000, 100, 50, 3000, 20, 40];
  days.forEach((d, i) => { mk("10830005", d, marcusV[i] * 1.04); man("MARCUS VINICIUS", d, marcusV[i]); man("OUTRO VENDEDOR", d, outroV[i]); });
  mk("10830001", "2026-10-02", 100); mk("10830001", "2026-10-03", 50); // poucos dias: não aponta ninguém
  const sellerMarcus = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'MV1', 'Marcus Vinicius')`).run(sellerMarcus, A);
  const lp = S.audit(A, { asOf: ASOF }).pending;
  const p5 = lp.find((x) => x.matricula === "10830005")!;
  check("aponta MARCUS pelo padrão diário (±10%)", p5.likelyPerson?.name === "MARCUS VINICIUS" && p5.likelyPerson.matchDays === 7 && p5.likelyPerson.pdvDays === 7);
  check("liga ao cadastro quando há UMA pessoa com esse nome", p5.likelyPerson?.sellerId === sellerMarcus);
  check("poucos dias de venda: não aponta ninguém", lp.find((x) => x.matricula === "10830001")!.likelyPerson === null);
  check("código sem lançamento manual parecido: não aponta", lp.find((x) => x.matricula === "OLD1")!.likelyPerson === null);
  man("MARCUS DUPLICADO", "2026-10-01", 936); days.forEach((d, i) => man("MARCUS DUPLICADO", d, marcusV[i] * 1.02));
  check("empate entre duas pessoas: não aponta ninguém", S.audit(A, { asOf: ASOF }).pending.find((x) => x.matricula === "10830005")!.likelyPerson === null);
  // limiares: 10 dias de PDV com só 5 batendo (50%) e 5 dias de PDV com só 3 batendo (60%, mas < 5 dias)
  const d10 = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10"];
  d10.forEach((d, i) => { mk("CODE50", d, 1000); man("PESSOA CINQUENTA", d, i < 5 ? 1000 : 5000); });
  const d5 = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"];
  d5.forEach((d, i) => { mk("CODE3", d, 700); man("PESSOA TRES", d, i < 3 ? 700 : 4000); });
  const lq = S.audit(A, { asOf: ASOF }).pending;
  check("50% dos dias batendo não aponta", lq.find((x) => x.matricula === "CODE50")!.likelyPerson === null);
  check("menos de 5 dias batendo não aponta (mesmo com 60%)", lq.find((x) => x.matricula === "CODE3")!.likelyPerson === null);
  const src = fs.readFileSync("src/server/RetailSellerCodeAuditService.ts", "utf8");
  check("serviço não escreve no banco", !/\b(INSERT|UPDATE|DELETE)\b/i.test(src.replace(/\/\*[\s\S]*?\*\//g, "")));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
