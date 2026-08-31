/**
 * TEST — ADR-199 F2: visão consolidada do grupo (fan-out). DB-backed, isolado.
 *
 * Prova os critérios de aceite: consolidado = SOMA verificável das operações
 * (reconciliação numérica contra o dashboard por-org); filtro por operação; degradação
 * graciosa (uma org indisponível vira "parcial" sem derrubar o painel); nenhuma leitura
 * cruza orgs (cada número vem de uma chamada single-org — RN-GRP-01).
 *
 * Uso: npm run test:group-consolidation
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-consol-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-consol-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const MONTH = "2026-07";
function mkOrg(db: any, name: string) {
  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  return org;
}
function mkStore(db: any, org: string) {
  const id = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, 'Loja', 1)`).run(id, org);
  return id;
}
function mkClosing(db: any, org: string, store: string, total: number, day: string) {
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, 'approved', ?)`)
    .run(randomUUID(), org, store, `${MONTH}-${day}`, total);
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { OrgGroupService: GRP } = await import("../src/server/OrgGroupService.js");
  const { GroupConsolidationService: CONS } = await import("../src/server/GroupConsolidationService.js");
  const { RetailDashboardService: DASH } = await import("../src/server/RetailDashboardService.js");

  // Dono + grupo + 2 operações (Toulon, Democrata).
  const identityId = randomUUID();
  db.prepare(`INSERT INTO account_identities (id, email, status) VALUES (?, 'dono@grupo.com', 'active')`).run(identityId);
  const g = GRP.createGroup({ name: "Grupo X", ownerIdentityId: identityId });
  const A = mkOrg(db, "Toulon"), B = mkOrg(db, "Democrata");
  GRP.addMember(g.id, A); GRP.addMember(g.id, B);

  // Dados por operação: A = 1000 + 500 (2 fechamentos); B = 2000 (1 fechamento).
  const sA = mkStore(db, A), sB = mkStore(db, B);
  mkClosing(db, A, sA, 1000, "10"); mkClosing(db, A, sA, 500, "11");
  mkClosing(db, B, sB, 2000, "10");

  // 1. Consolidação = soma.
  const c = CONS.consolidateMonthly(g.id, MONTH);
  check("1.1 total de vendas = soma das operações (1500+2000)", c.totals.totalSales === 3500);
  check("1.2 total de fechamentos somado (2+1)", c.totals.closingsCount === 3);
  check("1.3 duas operações no detalhe", c.operations.length === 2 && c.operations.every((o) => !o.partial));
  const rowA = c.operations.find((o) => o.organizationId === A)!;
  const rowB = c.operations.find((o) => o.organizationId === B)!;
  check("1.4 detalhe por operação correto (A=1500, B=2000)", rowA.totalSales === 1500 && rowB.totalSales === 2000);
  check("1.5 carrega o nome da marca", rowA.businessName === "Toulon" && rowB.businessName === "Democrata");

  // 2. RECONCILIAÇÃO: consolidado == soma do dashboard por-org (chamado isoladamente).
  const recon = DASH.monthly(A, MONTH).totalSales + DASH.monthly(B, MONTH).totalSales;
  check("2.1 reconciliação numérica com o dashboard por-org", c.totals.totalSales === recon);

  // 3. Filtro por operação.
  const onlyA = CONS.consolidateMonthly(g.id, MONTH, { onlyOrg: A });
  check("3.1 filtro por marca traz só a operação pedida", onlyA.operations.length === 1 && onlyA.totals.totalSales === 1500);

  // 4. Degradação graciosa: B indisponível → parcial, total só de A, sem erro global.
  const degraded = CONS.consolidateMonthly(g.id, MONTH, {
    snapshotFn: (orgId, m) => { if (orgId === B) throw new Error("org indisponível"); return DASH.monthly(orgId, m); },
  });
  check("4.1 B aparece como parcial", degraded.partial.includes(B) && degraded.operations.find((o) => o.organizationId === B)!.partial === true);
  check("4.2 totais só das operações OK (só A=1500)", degraded.totals.totalSales === 1500);
  check("4.3 painel não quebra (A segue no detalhe)", degraded.operations.find((o) => o.organizationId === A)!.partial === false);

  // 5. Grupo vazio → zeros.
  const g2 = GRP.createGroup({ name: "Vazio", ownerIdentityId: identityId });
  const empty = CONS.consolidateMonthly(g2.id, MONTH);
  check("5.1 grupo sem operações → total zero e sem linhas", empty.totals.totalSales === 0 && empty.operations.length === 0);

  // Resultado.
  console.log("\n=== ADR-199 F2 — visão consolidada do grupo (fan-out) ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S)`); process.exit(1); }
  console.log("\n✅ TODOS OS CHECKS PASSARAM");
}

main().catch((e) => { console.error(e); process.exit(1); });
