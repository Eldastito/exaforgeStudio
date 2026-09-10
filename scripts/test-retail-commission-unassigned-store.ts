/**
 * TESTE — anomalia de comissão por loja: vendas SEM loja (store_id NULL) eram
 * DESCARTADAS silenciosamente da corrida (`raceMonth`), subvalorizando a loja e
 * fazendo o vendedor parecer "não bateu cota" — o valor exibido não conferia com
 * a realidade da loja.
 * ----------------------------------------------------------------------------
 * A correção NÃO inventa loja (o vendedor não tem loja fixa): SURFACEIA as
 * vendas sem loja num bloco `unassigned` acionável, para o total reconciliar e o
 * gestor atribuir a loja no lançamento.
 *
 * Prova:
 *  - venda COM loja entra na corrida da loja; venda SEM loja NÃO infla a loja;
 *  - a venda sem loja aparece em `unassigned` (não some) — sales/sellerCount certos;
 *  - filtrando por uma loja específica, `unassigned` é null (não é venda daquela loja);
 *  - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-commission-unassigned-store
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comm-unassigned-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-comm-unassigned-1";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailCommissionRaceService } = await import("../src/server/RetailCommissionRaceService.js");

  const MONTH = "2026-08";
  const D = (day: string) => `2026-08-${day}`;

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'T', 'active')`).run(randomUUID(), id);
  const mkStore = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, ?, 1)`).run(id, org, name); return id; };
  const mkManualSale = (org: string, storeId: string | null, name: string, matricula: string, valor: number, pecas: number, day: string) => {
    db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor, pecas, atendimentos, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`)
      .run(randomUUID(), org, storeId, D(day), name, matricula, valor, pecas, 0);
  };

  // ── Org A: João vendeu R$30.000 COM loja + R$20.000 SEM loja (lançamento sem loja escolhida) ──
  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const lojaA = mkStore(A, "Loja Centro");
  mkManualSale(A, lojaA, "João", "M1", 30000, 60, "10");
  mkManualSale(A, null, "João", "M1", 20000, 40, "12"); // SEM loja → antes: sumia da corrida

  const race = RetailCommissionRaceService.raceMonth(A, MONTH);

  // ── 1. a loja reflete SÓ o que foi atribuído a ela (não infla com a venda sem loja) ──
  const store = (race.stores || []).find((s: any) => s.storeId === lojaA);
  check("1.1 loja presente na corrida", !!store);
  const joaoInStore = store?.monthly?.find((s: any) => /jo[ãa]o/i.test(s.sellerName));
  check("1.2 João aparece na loja", !!joaoInStore, JSON.stringify(store?.monthly?.map((s:any)=>s.sellerName)));
  check("1.3 vendas da loja = só as R$30.000 atribuídas (não 50.000)", joaoInStore?.sales === 30000, `sales=${joaoInStore?.sales}`);

  // ── 2. a venda SEM loja NÃO some: aparece em `unassigned` (acionável) ──
  check("2.1 unassigned presente (não silenciado)", !!race.unassigned, JSON.stringify(race.unassigned));
  check("2.2 unassigned.sales = R$20.000", race.unassigned?.sales === 20000, `unassigned.sales=${race.unassigned?.sales}`);
  check("2.3 unassigned tem João", (race.unassigned?.sellers || []).some((s: any) => /jo[ãa]o/i.test(s.sellerName)));
  check("2.4 unassigned marca reason=sem_loja", race.unassigned?.reason === "sem_loja");
  check("2.5 unassigned.pecas = 40", race.unassigned?.pecas === 40, `pecas=${race.unassigned?.pecas}`);

  // ── 3. filtrando por UMA loja, unassigned é null (venda sem loja não é daquela loja) ──
  const raceStore = RetailCommissionRaceService.raceMonth(A, MONTH, { storeId: lojaA });
  check("3.1 filtro por loja → unassigned null", raceStore.unassigned === null);
  check("3.2 filtro por loja → loja ainda aparece", (raceStore.stores || []).some((s: any) => s.storeId === lojaA));

  // ── 4. sem vendas sem loja → unassigned null (0-regressão) ──
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  const lojaB = mkStore(B, "Loja B");
  mkManualSale(B, lojaB, "Maria", "M9", 10000, 20, "10"); // toda com loja
  const raceB = RetailCommissionRaceService.raceMonth(B, MONTH);
  check("4.1 sem venda sem-loja → unassigned null", raceB.unassigned === null);

  // ── 5. isolamento: A não vaza pra B ──
  check("5.1 B não vê a venda sem-loja de A", (raceB.unassigned == null));
  check("5.2 A não vê Maria de B", !(race.stores || []).some((s: any) => s.storeId === lojaB));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-commission-unassigned-store: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
