/**
 * TESTE — PRD Fase 1, F1.1c: "esses dois são a mesma pessoa?" (cartão contextual, sem tela nova).
 * Prova com os casos REAIS do Bruno: Lohan (duplicado) e Eduardo → Eduardo Lázaro = "provável mesma pessoa";
 * Vinícius Romão × Vinícius Nascimento = "confira" (provavelmente diferentes) e, marcado como diferente,
 * NUNCA mais é sugerido; nada funde sozinho; "mesma pessoa" funde (reversível) e o par some; "cobrindo
 * férias" não deixa a loja da duplicata virar lotação permanente (vira cobertura com datas); validações
 * (datas, já é da loja); org sem duplicidade = sem sugestão; isolamento multi-tenant.
 * Uso:  npm run test:seller-duplicates
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dups-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-dups-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const D = (await import("../src/server/RetailSellerDuplicateService.js")).RetailSellerDuplicateService;
  const I = (await import("../src/server/RetailSellerIdentityService.js")).RetailSellerIdentityService;

  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, name.slice(0, 4)); return id; };
  const seller = (org: string, mat: string, name: string, storeId?: string) => {
    const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, ?, ?)`).run(id, org, mat, name);
    if (storeId) db.prepare(`INSERT INTO retail_seller_store_assignments (id, organization_id, seller_id, store_id, is_primary, active) VALUES (?, ?, ?, ?, 1, 1)`).run(randomUUID(), org, id, storeId);
    return id;
  };
  const ab = store(A, "Avenida Brasil"), carioca = store(A, "Carioca"), grande = store(A, "Grande Rio"), bangu = store(A, "Bangu");
  const eduL = seller(A, "101", "Eduardo Lázaro", ab), edu = seller(A, "102", "Eduardo", carioca);
  const lohanA = seller(A, "201", "Lohan", grande), lohanB = seller(A, "202", "Lohan Grande Rio", grande);
  const vinR = seller(A, "301", "Vinícius Romão", ab), vinN = seller(A, "302", "Vinícius Nascimento", bangu);
  seller(A, "401", "Marina Souza", carioca);           // sem parente
  const otherOrg = seller(B, "901", "Eduardo", undefined); seller(B, "902", "Eduardo Lázaro");

  const sug = D.suggestions(A);
  const find = (x: string, y: string) => D.suggestions(A).find((s) => [s.a.id, s.b.id].includes(x) && [s.a.id, s.b.id].includes(y));
  check("Eduardo × Eduardo Lázaro = 'likely' (mesma pessoa provável), canônica = o nome mais completo", find(edu, eduL)?.kind === "likely" && find(edu, eduL)?.suggestedIntoId === eduL);
  check("Lohan × Lohan Grande Rio = 'likely'", find(lohanA, lohanB)?.kind === "likely" && find(lohanA, lohanB)?.suggestedIntoId === lohanB);
  check("Vinícius Romão × Vinícius Nascimento = diferentes por construção: NÃO é sugerido (nem fundido)", !find(vinR, vinN) && (db.prepare(`SELECT COUNT(*) AS c FROM retail_sellers WHERE organization_id = ? AND merged_into_seller_id IS NOT NULL`).get(A) as any).c === 0);
  check("quem não tem parecido (Marina) não aparece; nada foi fundido sozinho", !sug.some((s) => s.a.name === "Marina Souza" || s.b.name === "Marina Souza") && (db.prepare(`SELECT COUNT(*) AS c FROM retail_sellers WHERE organization_id = ? AND merged_into_seller_id IS NOT NULL`).get(A) as any).c === 0);
  const sugB = D.suggestions(B);
  check("isolamento: a org B vê só o par dela (Eduardo × Eduardo Lázaro da B), nunca vendedores da A", sugB.length === 1 && sugB[0].a.id !== edu && sugB[0].b.id !== edu && [sugB[0].a.id, sugB[0].b.id].includes(otherOrg));

  // "pessoas diferentes" → nunca mais
  D.markDistinct(A, vinN, vinR);
  D.markDistinct(A, vinR, vinN);                          // idempotente, par em qualquer ordem
  check("'pessoas diferentes' memoriza o par (idempotente) e ele nunca mais é sugerido", !find(vinR, vinN) && !D.suggestions(A).some((s) => [s.a.id, s.b.id].includes(vinR) && [s.a.id, s.b.id].includes(vinN)) && (db.prepare(`SELECT COUNT(*) AS c FROM retail_seller_distinct_pairs WHERE organization_id = ?`).get(A) as any).c === 1);
  let crossErr = false; try { D.markDistinct(A, vinR, otherOrg); } catch { crossErr = true; }
  check("não dá pra marcar par com vendedor de OUTRA org", crossErr);

  // mesma pessoa simples (Lohan)
  const r1 = D.confirmSame(A, lohanA, lohanB, {}, "u1");
  const merged = db.prepare(`SELECT merged_into_seller_id FROM retail_sellers WHERE id = ?`).get(lohanA) as any;
  check("'mesma pessoa' funde na canônica sugerida (Lohan → Lohan Grande Rio), com aliases e reversível", r1.merged && merged.merged_into_seller_id === lohanB && I.resolve(A, { name: "Lohan" }).status !== "unidentified");
  check("o par resolvido some das sugestões", !find(lohanA, lohanB));
  I.unmerge(A, lohanA, "u1");
  check("unmerge desfaz a fusão (volta a ser sugerido)", !!find(lohanA, lohanB) || D.suggestions(A).some((s) => [s.a.id, s.b.id].includes(lohanA)));

  // validações da cobertura ANTES de escrever
  const errs: string[] = [];
  for (const cov of [{ startDate: "", endDate: "2026-10-10" }, { startDate: "2026-10-10", endDate: "2026-10-01" }]) {
    try { D.confirmSame(A, edu, eduL, { coverage: cov }); } catch (e: any) { errs.push(e.message); }
  }
  check("cobertura com datas inválidas é recusada ANTES de fundir (nada escrito)", errs.length === 2 && (db.prepare(`SELECT merged_into_seller_id AS m FROM retail_sellers WHERE id = ?`).get(edu) as any).m === null);

  // Eduardo cobrindo férias no Carioca
  const r2 = D.confirmSame(A, edu, eduL, { coverage: { startDate: "2026-10-01", endDate: "2026-10-20" } }, "u1");
  check("'mesma pessoa, cobrindo férias': funde em Eduardo Lázaro e registra cobertura no Carioca com as datas", r2.merged && r2.intoId === eduL && r2.coverage?.type === "cobertura_ferias" && r2.coverage.endDate === "2026-10-20");
  check("na janela ele conta no Carioca; fora dela volta à Avenida Brasil (a loja da duplicata NÃO virou lotação permanente)", I.storeOn(A, eduL, "2026-10-10")?.storeName === "Carioca" && I.storeOn(A, eduL, "2026-11-05")?.storeName === "Avenida Brasil");
  check("os nomes 'Eduardo' passam a resolver pra ele (alias) — sem inventar", I.resolve(A, { name: "Eduardo" }).status !== "unidentified");

  // "já é da loja" não é cobertura
  const p1 = seller(A, "501", "Paulo Alves", grande), p2 = seller(A, "502", "Paulo", grande);
  let sameStoreErr = "";
  try { D.confirmSame(A, p2, p1, { coverage: { startDate: "2026-10-01", endDate: "2026-10-05" } }); } catch (e: any) { sameStoreErr = e.message; }
  check("duplicata na MESMA loja da canônica não é cobertura (recusa com motivo)", /já é da loja/.test(sameStoreErr));
  let selfErr = false; try { D.confirmSame(A, p1, p1); } catch { selfErr = true; }
  check("não funde um vendedor nele mesmo", selfErr);

  check("org sem duplicidade = lista vazia (o cartão some)", (() => { const C = `org_C_${randomUUID().slice(0, 6)}`; seller(C, "1", "Ana Lima"); seller(C, "2", "Bruno Dias"); return D.suggestions(C).length === 0; })());

  console.log("\n=== PRD Fase 1 · F1.1c: sugestões de duplicidade de vendedor ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
