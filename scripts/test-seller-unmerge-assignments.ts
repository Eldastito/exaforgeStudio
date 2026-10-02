/**
 * TESTE — PRD Fase 1 §3 (S1b): `unmerge` DEVOLVE as lotações que a fusão moveu/encerrou (antes ficavam na
 * canônica — desfazer a fusão deixava a pessoa sem loja). Cobre: lotação movida volta; lotação da duplicata
 * que já existia na loja da canônica é reativada; principal única; equipe do dia reflete; fundir de novo funciona;
 * a lotação PRÓPRIA da canônica não é tocada; isolamento por org; lista de "a identificar".
 * Uso:  npm run test:seller-unmerge-assignments
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-unm-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-unmerge-1234567890";

let failures = 0;
function check(name: string, ok: boolean) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailSellerIdentityService: I } = await import("../src/server/RetailSellerIdentityService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, name.slice(0, 4)); return id; };
  const seller = (org: string, mat: string, name: string | null, stores: string[] = []) => {
    const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, ?, ?)`).run(id, org, mat, name);
    stores.forEach((st, i) => db.prepare(`INSERT INTO retail_seller_store_assignments (id, organization_id, seller_id, store_id, is_primary, active) VALUES (?, ?, ?, ?, ?, 1)`).run(randomUUID(), org, id, st, i === 0 ? 1 : 0));
    return id;
  };
  const live = (org: string, sid: string) => (db.prepare(`SELECT store_id, is_primary FROM retail_seller_store_assignments WHERE organization_id = ? AND seller_id = ? AND active = 1`).all(org, sid) as any[]);
  const ab = store(A, "Avenida Brasil"), carioca = store(A, "Carioca"), bangu = store(A, "Bangu");

  // into = Eduardo Lázaro (Av. Brasil) ; from = Eduardo (Carioca) → lotação MOVIDA
  const into = seller(A, "101", "Eduardo Lázaro", [ab]), from = seller(A, "102", "Eduardo", [carioca]);
  I.mergeSellers(A, from, into, "u1");
  check("após fundir: a canônica tem as duas lojas e `from` nenhuma", live(A, into).length === 2 && live(A, from).length === 0);
  check("equipe do Carioca já mostra a canônica", I.rosterOn(A, carioca).some((x) => x.id === into));
  I.unmerge(A, from, "u1");
  const lf = live(A, from), li = live(A, into);
  check("unmerge: `from` volta pro Carioca (lotação devolvida)", lf.length === 1 && lf[0].store_id === carioca);
  check("unmerge: `from` volta COM principal; a canônica fica só com a loja dela (Avenida Brasil)", lf[0].is_primary === 1 && li.length === 1 && li[0].store_id === ab && li[0].is_primary === 1);
  check("equipe do dia: Eduardo no Carioca, Lázaro na Av. Brasil", I.rosterOn(A, carioca).some((x) => x.id === from) && !I.rosterOn(A, carioca).some((x) => x.id === into) && I.rosterOn(A, ab).some((x) => x.id === into));
  check("nenhuma marca de fusão sobra nas lotações", (db.prepare(`SELECT COUNT(*) AS c FROM retail_seller_store_assignments WHERE organization_id = ? AND via_merge_of IS NOT NULL`).get(A) as any).c === 0);

  // duplicata já na MESMA loja da canônica → encerrada na fusão e REATIVADA no unmerge
  const into2 = seller(A, "201", "Lohan Grande Rio", [bangu]), from2 = seller(A, "202", "Lohan", [bangu]);
  I.mergeSellers(A, from2, into2, "u1");
  check("duplicata na mesma loja: após fundir só a canônica está na loja", live(A, from2).length === 0 && live(A, into2).length === 1);
  I.unmerge(A, from2, "u1");
  check("unmerge reativa a lotação da duplicata e preserva a da canônica", live(A, from2).length === 1 && live(A, from2)[0].store_id === bangu && live(A, into2).length === 1);

  // fundir de novo depois de desfazer funciona
  I.mergeSellers(A, from, into, "u1");
  check("dá pra fundir de novo depois de desfazer", live(A, into).length === 2 && live(A, from).length === 0);
  I.unmerge(A, from, "u1");
  check("e desfazer de novo devolve de novo (idempotente no ciclo)", live(A, from).length === 1 && live(A, into).length === 1);

  // isolamento
  const bs = store(B, "Loja B"); const sb = seller(B, "501", "Zé", [bs]);
  check("isolamento: nada da org A mexeu na org B", live(B, sb).length === 1 && I.unidentified(B).length === 0);

  // a identificar
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, vendedor_codigo) VALUES (?, ?, '1', 'B1', '2026-09-30', '7777', '7777')`).run(randomUUID(), A);
  const u = I.unidentified(A);
  check("matrícula vendendo sem nome aparece em 'a identificar' com o rótulo único", u.length === 1 && u[0].matricula === "7777" && u[0].displayName === "Vendedor não identificado — matrícula 7777");
  seller(A, "7777", "Marcos Souza");
  check("depois de nomeada, some da lista", I.unidentified(A).length === 0);

  console.log(failures ? `\n${failures} FALHA(S)` : "\nTodas as verificações OK");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
