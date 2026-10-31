/**
 * TESTE — diagnóstico somente-leitura das LIGAÇÕES dos códigos de vendedor (com nome × sem nome) e das
 * matrículas fantasma (cadastrada, nunca vendeu no PDV/ERP). Uso: npm run test:retail-seller-linkage-audit
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seller-linkage-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-seller-linkage-1234567890abc";
let failures = 0;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) failures++; };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailSellerLinkageAuditService: S } = await import("../src/server/RetailSellerLinkageAuditService.js");
  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const storeA = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'BANGU', '1083')`).run(storeA, A);
  let b = 0;
  const ASOF = "2026-10-25";
  const pdv = (org: string, code: string, date: string, v = 100) => db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor) VALUES (?, ?, '1083', ?, ?, ?, ?)`).run(randomUUID(), org, `b${b++}`, date, code, v);
  const seller = (org: string, mat: string, name: string | null, active = 1) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, ?, ?, ?)`).run(id, org, mat, name, active); return id; };
  const manual = (org: string, name: string, date: string, v: number, mat: string | null = null) => db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, storeA, date, name, mat, v);
  const assign = (org: string, sellerId: string) => db.prepare(`INSERT INTO retail_seller_store_assignments (id, organization_id, seller_id, store_id, active) VALUES (?, ?, ?, ?, 1)`).run(randomUUID(), org, sellerId, storeA);
  const quota = (org: string, mat: string) => db.prepare(`INSERT INTO retail_seller_quotas (id, organization_id, store_id, seller_key, week_start, quota_amount) VALUES (?, ?, ?, ?, '2026-10-19', 1000)`).run(randomUUID(), org, storeA, `mat:${mat}`);

  // 3 códigos COM nome e ligações completas (PDV + manual + loja + meta) → baseline
  for (const [m, n] of [["N1", "Ana Lima"], ["N2", "Bia Costa"], ["N3", "Caio Dias"]] as const) {
    const id = seller(A, m, n); assign(A, id); quota(A, m); manual(A, n, "2026-10-10", 500, m);
    pdv(A, m, "2026-10-10", 500); pdv(A, m, "2026-10-12", 300);
  }
  // código SEM nome com vendas no PDV mas sem nada mais (BANGU 10830005)
  pdv(A, "10830005", "2026-10-11", 700); pdv(A, "10830005", "2026-10-12", 900);
  // código sem nome PARADO há mais de 90 dias: não conta como ativo
  pdv(A, "OLD9", "2026-03-01");
  // fantasmas: cadastrado, nunca vendeu no PDV/ERP, mas tem lançamento manual
  const gId = seller(A, "10830003", "Marcus Vinicius");
  const dias = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05", "2026-10-06", "2026-10-07"];
  const mv = [900, 1200, 800, 1500, 700, 1000];
  dias.forEach((d, i) => { manual(A, "Marcus Vinicius", d, mv[i]); pdv(A, "10830005", d, mv[i] * 1.03); });
  seller(A, "LV-123456", "Sem Venda Nenhuma");                 // fantasma sem nada
  seller(A, "10830004", "Inativa", 0);                          // inativa: não é fantasma
  seller(A, "10830009", null);                                  // sem nome: não é fantasma (nem está na lista de nomeados)
  // outro org: nada vaza
  pdv(B, "OUTRO", "2026-10-10"); seller(B, "GB", "Fantasma de B");

  const sums = JSON.stringify(db.prepare(`SELECT COUNT(*) n, SUM(valor) v FROM retail_pdv_sales WHERE organization_id = ?`).get(A));
  const r = S.report(A, { asOf: ASOF });
  const un = (m: string) => r.unnamed.find((x) => x.matricula === m)!;

  check("somente leitura: tabelas não mudaram", sums === JSON.stringify(db.prepare(`SELECT COUNT(*) n, SUM(valor) v FROM retail_pdv_sales WHERE organization_id = ?`).get(A)) && r.readOnly === true);
  check("grupos: 3 com nome e 1 sem nome ativos (OLD9 parado não conta)", r.groups.named.codes === 3 && r.groups.unnamed.codes === 1);
  check("com nome: 100% com PDV, manual, loja e meta", (["pdv", "manual", "loja", "meta"] as const).every((k) => r.groups.named.pct[k] === 100));
  check("sem nome: tem PDV mas não tem manual/loja/meta por matrícula", r.groups.unnamed.pct.pdv === 100 && r.groups.unnamed.pct.manual === 0 && r.groups.unnamed.pct.loja === 0 && r.groups.unnamed.pct.meta === 0);
  check("baseline = o que a maioria dos com nome tem (sem 'cadastro')", r.baseline.some((x) => x.key === "pdv") && !r.baseline.some((x) => (x.key as string) === "cadastro"));
  check("código sem nome lista o que FALTA vs. os com nome", un("10830005").lacks.includes("manual") && un("10830005").lacks.includes("loja") && un("10830005").lacks.includes("meta") && !un("10830005").lacks.includes("pdv"));
  check("código com nome nunca tem 'lacks'", r.groups.named.codes === 3 && !r.unnamed.some((x) => x.named));
  check("conta vendas do PDV do código sem nome", un("10830005").pdvSales === 2 + dias.length);
  check("resumo coerente", r.summary.unnamedActive === 1 && r.summary.unnamedTotal === 2 && r.summary.unnamedMissingLinks >= 1);

  const g = (m: string) => r.ghosts.find((x) => x.matricula === m);
  check("fantasma: cadastrada que nunca vendeu no PDV/ERP", !!g("10830003") && g("10830003")!.manualRows === dias.length);
  check("fantasma: soma o lançamento manual por NOME (matrícula vazia no manual)", Math.abs(g("10830003")!.manualTotal - mv.reduce((a, c) => a + c, 0)) < 0.01);
  check("fantasma com código provável pelo valor diário", g("10830003")!.probableCodes[0]?.matricula === "10830005");
  check("marca LV- como placeholder inventado", g("LV-123456")?.placeholder === true && g("10830003")!.placeholder === false);
  check("quem vendeu no PDV não é fantasma", !g("N1") && !g("N2"));
  check("inativa e sem nome não entram como fantasma", !g("10830004") && !g("10830009"));
  check("ordenados pelo valor manual (maior primeiro)", r.ghosts[0].matricula === "10830003");

  // apelido: pessoa com código real ligado por alias deixa de ser fantasma
  db.prepare(`INSERT INTO retail_seller_aliases (id, organization_id, seller_id, alias, alias_norm, kind) VALUES (?, ?, ?, '10830005', '10830005', 'matricula')`).run(randomUUID(), A, gId);
  const r2 = S.report(A, { asOf: ASOF });
  check("com alias de matrícula que vende, deixa de ser fantasma e o código sai de 'sem nome'", !r2.ghosts.some((x) => x.matricula === "10830003") && !r2.unnamed.some((x) => x.matricula === "10830005"));

  check("isolamento: B só vê o dele", S.report(B, { asOf: ASOF }).ghosts.every((x) => x.matricula === "GB") && !S.report(B, { asOf: ASOF }).unnamed.some((x) => x.matricula === "10830005") && !r.ghosts.some((x) => x.matricula === "GB"));
  check("org vazia não quebra", (() => { const e = S.report(`vazia_${randomUUID().slice(0, 4)}`, { asOf: ASOF }); return e.groups.named.codes === 0 && e.groups.named.pct.pdv === null && e.ghosts.length === 0 && e.baseline.length === 0; })());

  const src = fs.readFileSync("src/server/RetailSellerLinkageAuditService.ts", "utf8");
  check("serviço não escreve no banco", !/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM)?/i.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/`[^`]*`/g, "")));
  const route = fs.readFileSync("src/server/routes/retailops.ts", "utf8");
  check("rota montada e restrita à rede", route.includes('"/sellers/identity/linkage", requireNetworkScope'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FALHA(S)` : "\nTodos os checks passaram");
  process.exit(failures ? 1 : 0);
}
main();
