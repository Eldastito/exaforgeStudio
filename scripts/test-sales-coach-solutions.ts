/**
 * TEST — Sales Coach F4 (ADR-202): solutionsForSeller(). Recupera soluções de gerente
 * VALIDADAS (ADR-174) aplicáveis ao vendedor, rotulando ORIGEM HUMANA (RN-SC-5). Prova:
 * mapeamento gap→tipo (queda ↔ vendedor_queda_recorrente), targeted vs general (dedupe),
 * origem humana + caveat presentes, honestidade (sem solução → vazio), isolamento.
 *
 * Uso: npm run test:sales-coach-solutions
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-scsol-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-scsol-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SalesCoachService } = await import("../src/server/SalesCoachService.js");
  const { ManagerSolutionService } = await import("../src/server/ManagerSolutionService.js");
  const ORG = "org-A", ASOF = "2026-09-12", store = "store-A", author = "u-author", boss = "u-boss";

  db.prepare("INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Loja A', 'L1', 1)").run(store, ORG);
  const seller = db.prepare("INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, ?, ?, 1)");
  const sale = db.prepare("INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor, pecas, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')");
  let n = 0; const sk = () => `k${++n}`;

  // Vendedor em queda (4 meses, 3 quedas), com loja A.
  seller.run("gd", ORG, "M3", "Decl");
  sale.run(sk(), ORG, store, "2026-06-05", "Decl", "M3", 2000, 20); sale.run(sk(), ORG, store, "2026-07-05", "Decl", "M3", 1500, 15);
  sale.run(sk(), ORG, store, "2026-08-05", "Decl", "M3", 1000, 10); sale.run(sk(), ORG, store, "2026-09-05", "Decl", "M3", 600, 6);
  // Vendedor saudável (para o caso sem gap de queda).
  seller.run("gh", ORG, "M5", "Heal"); sale.run(sk(), ORG, store, "2026-08-05", "Heal", "M5", 4000, 40); sale.run(sk(), ORG, store, "2026-09-05", "Heal", "M5", 4200, 42);

  // Padrões-problema: um de queda de vendedor, um de outro tipo.
  db.prepare("INSERT INTO retail_store_patterns (id, organization_id, store_id, pattern_type, pattern_key, description, confidence, status, occurrences) VALUES ('p-decl', ?, ?, 'vendedor_queda_recorrente', 'kp1', 'Vendedor em queda', 0.8, 'validated', 3)").run(ORG, store);
  db.prepare("INSERT INTO retail_store_patterns (id, organization_id, store_id, pattern_type, pattern_key, description, confidence, status, occurrences) VALUES ('p-other', ?, ?, 'caixa_divergente_recorrente', 'kp2', 'Caixa diverge', 0.8, 'validated', 3)").run(ORG, store);

  // Promove uma solução de gerente para cada padrão.
  const promote = (refId: string, title: string) => {
    const p = ManagerSolutionService.create(ORG, { storeId: null, refType: "pattern", refId, title, proposal: `Ação: ${title}.` }, author);
    ManagerSolutionService.submit(ORG, p.id, author);
    ManagerSolutionService.approveForTest(ORG, p.id, boss, true);
    ManagerSolutionService.startTest(ORG, p.id, null, boss);
    ManagerSolutionService.recordOutcome(ORG, p.id, { final: 20, confidence: 0.9, period: "30d" }, boss);
    ManagerSolutionService.promote(ORG, p.id, boss, true);
    return p.id;
  };
  const solDecl = promote("p-decl", "Acompanhamento 1:1 semanal");
  const solOther = promote("p-other", "Dupla conferência de caixa");

  // ── vendedor em queda ──
  const rd = SalesCoachService.solutionsForSeller(ORG, "gd", { asOf: ASOF });
  check("1.1 gapTypes mapeia queda → vendedor_queda_recorrente", rd.gapTypes.includes("vendedor_queda_recorrente"));
  check("1.2 targeted traz a solução de queda", rd.targeted.some((s: any) => s.proposalId === solDecl));
  check("1.3 targeted rotula ORIGEM HUMANA + caveat (RN-SC-5)", rd.targeted.every((s: any) => s.origin === "humana" && typeof s.caveat === "string" && s.caveat.length > 0));
  check("1.4 targeted NÃO afirma eficácia geral (claim condicionada)", rd.targeted.every((s: any) => typeof s.claim === "string" && !/garantido|sempre funciona/i.test(s.claim)));
  check("1.5 general traz a de OUTRO tipo", rd.general.some((s: any) => s.proposalId === solOther));
  check("1.6 dedupe: a de queda não repete em general", !rd.general.some((s: any) => s.proposalId === solDecl));

  // ── vendedor saudável: sem gap de queda → sem targeted, mas general disponível ──
  const rh = SalesCoachService.solutionsForSeller(ORG, "gh", { asOf: ASOF });
  check("2.1 saudável → gapTypes vazio e targeted vazio", rh.gapTypes.length === 0 && rh.targeted.length === 0);
  check("2.2 general ainda lista o conhecimento validado do org", rh.general.length >= 2);

  // ── honestidade: org sem soluções ──
  const ORG2 = "org-empty";
  db.prepare("INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES ('e1', ?, 'E1', 'Ed', 1)").run(ORG2);
  db.prepare("INSERT INTO retail_seller_sales (id, organization_id, sale_date, seller_name, matricula, valor, pecas, source) VALUES ('es1', ?, '2026-09-05', 'Ed', 'E1', 100, 1, 'manual')").run(ORG2);
  const re = SalesCoachService.solutionsForSeller(ORG2, "e1", { asOf: ASOF });
  check("3.1 org sem soluções → targeted e general vazios (não inventa)", re.targeted.length === 0 && re.general.length === 0);

  // ── inexistente / isolamento ──
  check("4.1 vendedor inexistente → seller null", SalesCoachService.solutionsForSeller(ORG, "nao-existe", { asOf: ASOF }).seller === null);
  check("4.2 vendedor de outra org não vaza", SalesCoachService.solutionsForSeller("org-B", "gd", { asOf: ASOF }).seller === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} sales-coach-solutions: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
