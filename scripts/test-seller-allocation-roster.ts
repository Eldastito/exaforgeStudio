/**
 * TESTE — PRD Fase 1 §3 (S1): a alocação por período É CONSUMIDA pelos cálculos/telas, e matrícula sem pessoa
 * confirmada aparece como "Vendedor não identificado — matrícula X" (nunca "Matrícula X", nunca nome chutado).
 * Prova: equipe do dia (`rosterOn`) inclui cobertura vigente e tira quem cobre outra loja; fora da janela volta;
 * fundido nunca aparece; `storeSellers` (fila da loja) usa a mesma vigência; rótulo único; isolamento por org.
 * Uso:  npm run test:seller-allocation-roster
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alloc-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-alloc-1234567890";

let failures = 0;
function check(name: string, ok: boolean) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailSellerIdentityService: I, unidentifiedLabel } = await import("../src/server/RetailSellerIdentityService.js");
  const { RetailFloorService: F } = await import("../src/server/RetailFloorService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, name.slice(0, 4)); return id; };
  const seller = (org: string, mat: string, name: string | null, storeId?: string) => {
    const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, ?, ?)`).run(id, org, mat, name);
    if (storeId) db.prepare(`INSERT INTO retail_seller_store_assignments (id, organization_id, seller_id, store_id, is_primary, active) VALUES (?, ?, ?, ?, 1, 1)`).run(randomUUID(), org, id, storeId);
    return id;
  };
  const ab = store(A, "Avenida Brasil"), carioca = store(A, "Carioca");
  const ana = seller(A, "11", "Ana", ab), bia = seller(A, "12", "Bia", ab), cris = seller(A, "13", "Cris", carioca);
  const idsOf = (list: any[]) => list.map((x) => x.id).sort().join();
  const D = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

  check("sem cobertura: equipe do dia = lotação principal", idsOf(I.rosterOn(A, ab)) === [ana, bia].sort().join() && idsOf(I.rosterOn(A, carioca)) === cris);

  I.addAssignment(A, { sellerId: ana, storeId: carioca, type: "cobertura_ferias", startDate: D(-1), endDate: D(3) }, "u1");
  check("cobertura vigente: Ana ENTRA na equipe do Carioca", idsOf(I.rosterOn(A, carioca)) === [ana, cris].sort().join());
  check("cobertura vigente: Ana SAI da equipe da Avenida Brasil (está cobrindo outra loja)", idsOf(I.rosterOn(A, ab)) === bia);
  check("a MESMA vigência de assignmentsOn/storeOn (uma definição só)", I.storeOn(A, ana, D(0))?.storeId === carioca);
  check("fila da loja (storeSellers) usa a equipe vigente", F.storeSellers(A, carioca).sellers.some((s: any) => s.id === ana) && !F.storeSellers(A, ab).sellers.some((s: any) => s.id === ana));
  check("fora da janela (depois do fim): volta pra Avenida Brasil e sai do Carioca", idsOf(I.rosterOn(A, ab, D(10))) === [ana, bia].sort().join() && idsOf(I.rosterOn(A, carioca, D(10))) === cris);
  check("antes da janela: ainda é da loja de origem", idsOf(I.rosterOn(A, ab, D(-5))) === [ana, bia].sort().join());

  // fundido nunca aparece
  const bia2 = seller(A, "99", "Bia Duplicada", ab);
  I.mergeSellers(A, bia2, bia, "u1");
  check("vendedor fundido não aparece na equipe (só a canônica)", !I.rosterOn(A, ab).some((s) => s.id === bia2));
  // inativo não aparece
  db.prepare(`UPDATE retail_sellers SET active = 0 WHERE id = ?`).run(cris);
  check("vendedor inativo não aparece", !I.rosterOn(A, carioca).some((s) => s.id === cris));

  // rótulo único
  seller(A, "7777", null);
  check("matrícula sem pessoa → 'Vendedor não identificado — matrícula X'", I.displayName(A, "7777") === unidentifiedLabel("7777") && /^Vendedor não identificado — matrícula 7777$/.test(I.displayName(A, "7777")));
  check("matrícula inexistente também não vira nome inventado", I.displayName(A, "5555") === "Vendedor não identificado — matrícula 5555");
  check("pessoa identificada mostra o nome", I.displayName(A, "11") === "Ana");

  // isolamento
  const bs = store(B, "Loja B");
  check("isolamento: equipe da org B não enxerga vendedores da A", I.rosterOn(B, bs).length === 0 && I.rosterOn(B, ab).length === 0);

  console.log(failures ? `\n${failures} FALHA(S)` : "\nTodas as verificações OK");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
