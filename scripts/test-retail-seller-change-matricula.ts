/**
 * TESTE — correção de matrícula cadastrada errada (caso real TOULON Bangu, 13/11/2026):
 * Rhenã foi cadastrada na 10830007, que é da Maria Eduarda; a dela é a 10830006. O "é a mesma pessoa?"
 * só ligava a 006 como apelido (a 007 seguia presa) e a lista de pendências ignorava o apelido.
 * Uso:  npm run test:retail-seller-change-matricula
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seller-chmat-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-seller-change-matricula-123";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const throws = (fn: () => any, re: RegExp) => { try { fn(); return false; } catch (e: any) { return re.test(e.message); } };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailSellerIdentityService: S } = await import("../src/server/RetailSellerIdentityService.js");
  const { RetailSellerDirectoryService: D } = await import("../src/server/RetailSellerDirectoryService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const bangu = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'BANGU', '1083')`).run(bangu, A);
  const seller = (org: string, mat: string, name: string | null) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, ?, ?)`).run(id, org, mat, name); return id; };
  const pdv = db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, vendedor_codigo, valor) VALUES (?, ?, '1083', ?, ?, 'op', ?, 100)`);
  let b = 0;
  for (let i = 0; i < 5; i++) pdv.run(randomUUID(), A, String(++b), "2026-11-10", "10830006");
  for (let i = 0; i < 3; i++) pdv.run(randomUUID(), A, String(++b), "2026-11-10", "10830005");

  const rhena = seller(A, "10830007", "RHENÃ");
  const marcus = seller(A, "10830005", "MARCUS VINICIUS");
  // planejamento lançado pra Rhenã na matrícula errada
  db.prepare(`INSERT INTO retail_seller_quotas (id, organization_id, store_id, seller_key, seller_name, week_start, quota_amount) VALUES (?, ?, ?, 'mat:10830007', 'RHENÃ', '2026-11-09', 5000)`).run(randomUUID(), A, bangu);
  db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, '2026-11-14', 'mat:10830007', 'RHENÃ', 'work')`).run(randomUUID(), A, bangu);

  // ── 1. apelido aparece como identificado na lista da loja ──
  const before = D.discoverByStore(A, bangu);
  check("antes: 10830006 é pendência de nome", before.pendingName.some((p: any) => p.codigo === "10830006"));
  S.linkMatricula(A, "10830006", rhena, "u-gerente");
  const linked = D.discoverByStore(A, bangu);
  check("após ligar 006 à Rhenã (apelido), 006 sai da pendência", !linked.pendingName.some((p: any) => p.codigo === "10830006"));
  check("…e aparece como confirmado com o nome da Rhenã", linked.confirmed.some((p: any) => p.codigo === "10830006" && p.name === "RHENÃ" && p.sellerId === rhena));

  // ── 2. conflitos: nunca rouba ──
  check("trocar pra matrícula oficial de outra pessoa → conflito", throws(() => S.changeMatricula(A, rhena, "10830005"), /matricula_conflict/));
  check("matrícula vazia → erro", throws(() => S.changeMatricula(A, rhena, "  "), /Informe/));
  check("matrícula igual à atual → erro", throws(() => S.changeMatricula(A, rhena, "10830007"), /igual/));
  check("vendedor de outra org → não encontrado (isolamento)", throws(() => S.changeMatricula(B, rhena, "10830006"), /não encontrado/));
  const other = seller(A, "10830099", "OUTRA");
  S.addAlias(A, other, { alias: "10830088", kind: "matricula" });
  check("código ligado como apelido a OUTRA pessoa → conflito", throws(() => S.changeMatricula(A, rhena, "10830088"), /matricula_conflict/));

  // ── 3. troca 007 → 006 ──
  const r = S.changeMatricula(A, rhena, "10830006", "u-gerente");
  const row = db.prepare(`SELECT matricula, name FROM retail_sellers WHERE organization_id = ? AND id = ?`).get(A, rhena) as any;
  check("Rhenã agora tem a matrícula oficial 10830006", row.matricula === "10830006" && r.from === "10830007" && r.to === "10830006");
  check("o apelido 006 virou a oficial (apelido removido)", r.moved.aliasRemoved === 1 && S.listAliases(A, rhena).length === 0);
  check("a 007 NÃO virou apelido da Rhenã (fica livre)", S.resolve(A, { matricula: "10830007" }).status === "unidentified");
  check("cota da Rhenã acompanhou a troca (mat:007 → mat:006)",
    (db.prepare(`SELECT COUNT(*) AS n FROM retail_seller_quotas WHERE organization_id = ? AND seller_key = 'mat:10830006'`).get(A) as any).n === 1 &&
    (db.prepare(`SELECT COUNT(*) AS n FROM retail_seller_quotas WHERE organization_id = ? AND seller_key = 'mat:10830007'`).get(A) as any).n === 0);
  check("escala da Rhenã acompanhou a troca", r.moved.retail_schedule_entries === 1);
  const after = D.discoverByStore(A, bangu);
  check("006 confirmada como Rhenã pela matrícula oficial", after.confirmed.some((p: any) => p.codigo === "10830006" && p.name === "RHENÃ"));
  check("Marcus intocado", (db.prepare(`SELECT matricula FROM retail_sellers WHERE id = ?`).get(marcus) as any).matricula === "10830005");
  check("vendas do PDV não foram reescritas", (db.prepare(`SELECT COUNT(*) AS n FROM retail_pdv_sales WHERE organization_id = ? AND vendedor_codigo = '10830006'`).get(A) as any).n === 5);

  // ── 4. a Maria Eduarda agora cabe na 007 ──
  const maria = seller(A, "10830007", "MARIA EDUARDA");
  check("Maria Eduarda cadastrada na 10830007", S.resolve(A, { matricula: "10830007" }).seller?.id === maria);

  // ── 5. planejamento já existente na matrícula nova → recusa antes de escrever ──
  db.prepare(`INSERT INTO retail_seller_quotas (id, organization_id, store_id, seller_key, seller_name, week_start, quota_amount) VALUES (?, ?, ?, 'mat:10830077', 'X', '2026-11-09', 1)`).run(randomUUID(), A, bangu);
  check("planejamento na matrícula nova → conflito, nada escrito", throws(() => S.changeMatricula(A, marcus, "10830077"), /planejamento/) &&
    (db.prepare(`SELECT matricula FROM retail_sellers WHERE id = ?`).get(marcus) as any).matricula === "10830005");

  for (const r2 of results) console.log(`${r2.ok ? "PASS" : "FAIL"}  ${r2.name}${r2.detail ? ` — ${r2.detail}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
