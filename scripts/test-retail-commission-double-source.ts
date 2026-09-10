/**
 * TESTE — dupla contagem por FONTE ("o sistema mostra mais que a venda real").
 * ----------------------------------------------------------------------------
 * Reclamação real (loja Avenida Brasil, semana 1): o sistema mostra o vendedor
 * com venda MAIOR que a realidade. Causa: o vendedor tem venda no PDV (feed cru
 * da venda física) E no lançamento manual/foto (RE-lançamento da MESMA venda);
 * `salesBySellerStore` casa os dois pela matrícula e SOMA → a venda física entra
 * duas vezes. Isso só some quando a loja está marcada `seller_source='manual'`
 * (aí o PDV é excluído) — se não estiver, dobra silenciosamente.
 *
 * A correção (detectar + sinalizar, nunca dedup às cegas): expõe `salesBySource`
 * (composição por fonte) e marca `doubleSourced` quando PDV coexiste com
 * manual/ERP pro mesmo vendedor — o valor fica explicável e a dupla contagem
 * visível pro gestor reconciliar / marcar a fonte da loja.
 *
 * Reproduz os números do cliente: manual 7.569,70 + pdv 3.240,00 = 10.809,70.
 *
 * Uso:  npm run test:retail-commission-double-source
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-double-source-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-double-source-1";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");
  const { RetailCommissionRaceService } = await import("../src/server/RetailCommissionRaceService.js");

  const start = "2026-08-01", end = "2026-08-05";
  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'T', 'active')`).run(randomUUID(), id);
  // Loja com CODE (o PDV casa por code=filial) e SEM seller_source='manual' → PDV entra.
  const mkStore = (org: string, name: string, code: string, sellerSource: string | null = null) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active, seller_source) VALUES (?, ?, ?, ?, 1, ?)`).run(id, org, name, code, sellerSource); return id; };
  const mkManual = (org: string, storeId: string, name: string, mat: string, valor: number, pecas: number, day: string) =>
    db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor, pecas, atendimentos, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'manual')`).run(randomUUID(), org, storeId, `2026-08-${day}`, name, mat, valor, pecas);
  const mkPdv = (org: string, filial: string, mat: string, valor: number, pecas: number, day: string, boleta: string) =>
    db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor, pecas, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'N')`).run(randomUUID(), org, filial, boleta, `2026-08-${day}`, mat, valor, pecas);

  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const loja = mkStore(A, "Avenida Brasil", "AVB", null); // NÃO marcada 'manual' → PDV entra
  // Luiz: manual 7.569,70 + PDV 3.240,00 (mesma matrícula L1) → sistema soma 10.809,70
  mkManual(A, loja, "Luiz", "L1", 7569.70, 60, "03");
  mkPdv(A, "AVB", "L1", 3240.00, 20, "04", "B001");
  // Eduardo: só manual (fonte única) → correto, sem dupla
  mkManual(A, loja, "Eduardo", "E1", 5000.00, 40, "03");

  const rows = RetailCommissionService.salesBySellerStore(A, start, end);
  const luiz = rows.find((r) => r.matricula === "L1");
  const edu = rows.find((r) => r.matricula === "E1");

  // ── 1. reproduz o número inflado + o expõe por fonte ──
  check("1.1 Luiz existe", !!luiz, JSON.stringify(rows.map((r) => r.matricula)));
  check("1.2 sistema soma manual+pdv = 10.809,70", luiz?.sales === 10809.70, `sales=${luiz?.sales}`);
  check("1.3 salesBySource separa: manual 7.569,70", luiz?.salesBySource?.manual === 7569.70, JSON.stringify(luiz?.salesBySource));
  check("1.4 salesBySource separa: pdv 3.240,00", luiz?.salesBySource?.pdv === 3240.00);
  check("1.5 Luiz marcado doubleSourced (venda física contada 2x)", luiz?.doubleSourced === true);

  // ── 2. vendedor de fonte ÚNICA não é marcado (0-regressão / sem falso positivo) ──
  check("2.1 Eduardo NÃO doubleSourced", edu?.doubleSourced === false, JSON.stringify(edu?.salesBySource));
  check("2.2 Eduardo valor intacto", edu?.sales === 5000.00);

  // ── 3. a corrida do mês surfaceia a dupla contagem (pro gestor ver) ──
  const race = RetailCommissionRaceService.raceMonth(A, "2026-08");
  check("3.1 doubleSourcedCount >= 1", race.doubleSourcedCount >= 1, `count=${race.doubleSourcedCount}`);
  const g = (race.doubleSourced || []).find((s: any) => s.storeId === loja);
  check("3.2 loja aparece na dupla contagem", !!g);
  check("3.3 Luiz na lista com composição por fonte", !!g && g.sellers.some((s: any) => /luiz/i.test(s.sellerName) && s.salesBySource?.pdv === 3240.00));

  // ── 4. loja marcada seller_source='manual' → PDV excluído → sem dupla (o remédio) ──
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  const lojaB = mkStore(B, "Loja Manual", "MAN", "manual");
  mkManual(B, lojaB, "Luiz", "L1", 7569.70, 60, "03");
  mkPdv(B, "MAN", "L1", 3240.00, 20, "04", "B002");
  const rowsB = RetailCommissionService.salesBySellerStore(B, start, end);
  const luizB = rowsB.find((r) => r.matricula === "L1");
  check("4.1 loja 'manual' → PDV excluído, valor = só manual 7.569,70", luizB?.sales === 7569.70, `sales=${luizB?.sales}`);
  check("4.2 loja 'manual' → não doubleSourced", luizB?.doubleSourced === false);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-commission-double-source: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
