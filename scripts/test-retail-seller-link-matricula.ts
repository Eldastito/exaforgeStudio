/**
 * TESTE — "É alguém já cadastrado?": vincular código novo a pessoa existente (alias de matrícula), sem criar vendedor.
 * Uso: npm run test:retail-seller-link-matricula
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seller-link-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-seller-link-1234567890abcd";
let failures = 0;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) failures++; };
const throws = (fn: () => any, re: RegExp) => { try { fn(); return false; } catch (e: any) { return re.test(e.message); } };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailSellerIdentityService: S } = await import("../src/server/RetailSellerIdentityService.js");
  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, code); return id; };
  const seller = (org: string, mat: string, name: string | null, active = 1) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, ?, ?, ?)`).run(id, org, mat, name, active); return id; };
  let n = 0;
  const sale = (org: string, code: string, date = "2026-10-01") => db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor) VALUES (?, ?, '1084', ?, ?, ?, 10)`).run(randomUUID(), org, `b${n++}`, date, code);
  const gr = store(A, "Grande Rio", "1084");
  const lohan = seller(A, "10840002", "Lohan Grande Rio");
  const semNome = seller(A, "10990001", null);
  const inativo = seller(A, "10990002", "Antigo", 0);
  db.prepare(`INSERT INTO retail_seller_store_assignments (id, organization_id, seller_id, store_id, is_primary, active) VALUES (?, ?, ?, ?, 1, 1)`).run(randomUUID(), A, lohan, gr);
  sale(A, "10060025"); sale(A, "10060025", "2026-06-30"); sale(A, "10840002"); sale(B, "10060025");

  check("pendência inclui o código antigo", S.unidentified(A).some((x) => x.matricula === "10060025"));
  const dir = S.directory(A);
  check("diretório: só nomeados e ativos, com lojas", dir.length === 1 && dir[0].name === "Lohan Grande Rio" && dir[0].stores[0] === "Grande Rio");
  check("diretório isolado por org", S.directory(B).length === 0);

  const before = (db.prepare(`SELECT COUNT(*) n FROM retail_sellers WHERE organization_id = ?`).get(A) as any).n;
  const r = S.linkMatricula(A, "10060025", lohan, "u1");
  check("vínculo devolve a pessoa", r.name === "Lohan Grande Rio" && r.matricula === "10060025");
  check("não criou vendedor novo", (db.prepare(`SELECT COUNT(*) n FROM retail_sellers WHERE organization_id = ?`).get(A) as any).n === before);
  check("código sai da pendência", !S.unidentified(A).some((x) => x.matricula === "10060025"));
  check("nome exibido é o da pessoa", S.displayName(A, "10060025") === "Lohan Grande Rio");
  check("idempotente", S.linkMatricula(A, "10060025", lohan).sellerId === lohan);
  check("é alias reversível", (() => { const al = S.listAliases(A, lohan).find((x: any) => x.alias === "10060025"); if (!al) return false; S.removeAlias(A, al.id); return S.unidentified(A).some((x) => x.matricula === "10060025"); })());

  check("código que não existe nas vendas é recusado", throws(() => S.linkMatricula(A, "99999999", lohan), /não aparece/));
  check("código vazio recusado", throws(() => S.linkMatricula(A, "  ", lohan), /Informe/));
  check("pessoa inexistente recusada", throws(() => S.linkMatricula(A, "10060025", "nao-existe"), /não encontrado/));
  check("outra org não vincula a pessoa desta", throws(() => S.linkMatricula(B, "10060025", lohan), /não encontrado/));
  const outro = seller(A, "10840099", "Outra Pessoa");
  S.linkMatricula(A, "10060025", lohan);
  check("código já vinculado a outra pessoa → conflito, não rouba", throws(() => S.linkMatricula(A, "10060025", outro), /conflict/));
  sale(A, "10840099");
  check("matrícula oficial de outra pessoa → conflito", throws(() => S.linkMatricula(A, "10840099", lohan), /alias_conflict/));
  check("vendedor sem nome fora do diretório, inativo também", !S.directory(A).some((x) => x.id === semNome || x.id === inativo));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
