/**
 * TESTE — Clientes do PDV por loja (PRD Moda/TOULON, frente CRM, Fase 1)
 * ----------------------------------------------------------------------------
 * Prova, offline (RetailPdvCustomerService.list):
 *   - filtro por FILIAL (?store) estreita corretamente;
 *   - enriquecimento: store_id/store_name resolvidos por retail_stores.code;
 *   - filial SEM loja cadastrada → store_id/store_name = null (não inventa);
 *   - store_relation_type é sempre 'cadastro' (CRM-003, filial de origem);
 *   - source_synced_at reflete o updated_at do cliente;
 *   - lista `stores` só traz lojas ATIVAS da org com código;
 *   - isolamento multi-tenant (org B nunca aparece / seus stores não vazam);
 *   - busca por q + aniversariante combinam com o filtro de loja.
 *
 * Uso:  npm run test:retail-pdv-customers-by-store
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-pdvcust-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-pdv-customers-by-store-123456";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailPdvCustomerService } = await import("../src/server/RetailPdvCustomerService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  const B = `org_${randomUUID().slice(0, 8)}`;

  // Lojas da org A: Savassi (código L1) + Centro (código L2) + uma INATIVA (L3).
  const mkStore = (org: string, name: string, code: string, active = 1) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, ?)`)
      .run(id, org, name, code, active);
    return id;
  };
  const savassi = mkStore(A, "Savassi", "L1");
  mkStore(A, "Centro", "L2");
  mkStore(A, "Antiga", "L3", 0); // inativa: não deve entrar na lista `stores`
  mkStore(B, "Loja B", "LB");     // org B: nunca deve vazar

  const mkCustomer = (org: string, nome: string, filial: string | null, extra: Partial<{ nascimento: string; updated_at: string; cpf: string }> = {}) => {
    db.prepare(
      `INSERT INTO retail_pdv_customers (id, organization_id, codigo_n, nome, cpf, nascimento, filial, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), org, randomUUID().slice(0, 6), nome, extra.cpf || null, extra.nascimento || null, filial, extra.updated_at || null);
  };

  mkCustomer(A, "Ana Savassi", "L1", { nascimento: "1990-05-10", updated_at: "2026-08-16T12:00:00Z" });
  mkCustomer(A, "Bruno Savassi", "L1", { nascimento: "1988-07-22" });
  mkCustomer(A, "Carla Centro", "L2");
  mkCustomer(A, "Dora SemLoja", "L9"); // filial que NÃO tem loja cadastrada
  mkCustomer(B, "Cliente da B", "LB"); // isolamento

  // ===== 1. Sem filtro: só clientes da org A (isolamento) =====
  const all = RetailPdvCustomerService.list(A, {});
  check("sem filtro traz só clientes da org A", all.total === 4 && all.customers.length === 4, `total=${all.total}`);
  check("nenhum cliente da org B vaza", !all.customers.some((c: any) => c.nome === "Cliente da B"));

  // ===== 2. Filtro por filial =====
  const l1 = RetailPdvCustomerService.list(A, { store: "L1" });
  check("filtro store=L1 traz só os 2 da Savassi", l1.total === 2 && l1.customers.every((c: any) => c.filial === "L1"), `total=${l1.total}`);

  // ===== 3. Enriquecimento de loja =====
  const ana = l1.customers.find((c: any) => c.nome === "Ana Savassi") as any;
  check("store_id resolvido pela filial", ana?.store_id === savassi);
  check("store_name resolvido", ana?.store_name === "Savassi");
  check("store_relation_type é 'cadastro' (CRM-003)", ana?.store_relation_type === "cadastro");
  check("source_synced_at reflete updated_at", ana?.source_synced_at === "2026-08-16T12:00:00Z");

  // ===== 4. Filial sem loja cadastrada → null (não inventa) =====
  const l9 = RetailPdvCustomerService.list(A, { store: "L9" });
  const dora = l9.customers[0] as any;
  check("filial sem loja: store_id null", l9.total === 1 && dora?.store_id === null);
  check("filial sem loja: store_name null", dora?.store_name === null);

  // ===== 5. Lista `stores` só ativas da org, com código =====
  check("stores só as ativas da org A (2)", all.stores.length === 2 && all.stores.every((s: any) => s.code === "L1" || s.code === "L2"), `n=${all.stores.length}`);
  check("loja inativa não entra em stores", !all.stores.some((s: any) => s.code === "L3"));
  check("stores da org B não vazam", !all.stores.some((s: any) => s.code === "LB"));

  // ===== 6. q + aniversariante combinam com filial =====
  const byName = RetailPdvCustomerService.list(A, { store: "L1", q: "Ana" });
  check("q + store combinam", byName.total === 1 && byName.customers[0].nome === "Ana Savassi");
  const bday = RetailPdvCustomerService.list(A, { birthdayMonth: "07" });
  check("aniversariante de julho", bday.total === 1 && bday.customers[0].nome === "Bruno Savassi");

  // ===== 7. Org B isolada de ponta a ponta =====
  const bList = RetailPdvCustomerService.list(B, {});
  check("org B só vê o próprio cliente", bList.total === 1 && bList.customers[0].nome === "Cliente da B");

  console.log("\n=== TEST: Clientes do PDV por loja (CRM Fase 1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
