/**
 * TESTE — FLOOR: talão da venda no atendimento (PRD Moda/TOULON; ADR-175)
 * ----------------------------------------------------------------------
 * Prova, offline, o vínculo lista-da-vez → talão → boleta/PDV:
 *   - finish(converted) aceita o nº do talão e o persiste (normalizado);
 *   - talão só vale em venda realizada (converted) — rejeita nos demais;
 *   - formato inválido (sem dígitos) é rejeitado;
 *   - unicidade no turno: dois atendimentos não reivindicam o mesmo talão
 *     (mesmo com zeros à esquerda diferentes: "017752" ≡ "17752");
 *   - a conciliação DERIVA o casamento talão↔clique de boleta do dia
 *     (advisório: sem clique → matched=false; sem talão → null);
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-floor-talao
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-talao-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-floor-talao-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { RetailFloorAttendanceService } = await import("../src/server/RetailFloorAttendanceService.js");
  const { RetailFloorReconciliationService } = await import("../src/server/RetailFloorReconciliationService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, org);
    ModuleService.applyVertical(org, "moda");
    ModuleService.enableModule(org, "retail_floor");
  }

  const owner = { userId: randomUUID(), role: "owner" as const };
  const store1 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active, manager_user_id) VALUES (?, ?, 'Loja 1005', '1005', 1, ?)`).run(store1, A, owner.userId);
  const DAY = "2026-08-01";
  const shiftId = randomUUID();
  db.prepare(`INSERT INTO retail_floor_shifts (id, organization_id, store_id, status, opened_at) VALUES (?, ?, ?, 'open', ?)`).run(shiftId, A, store1, `${DAY} 09:00:00`);

  // Helper: cria um atendimento ATIVO (started) pronto pra finish. Cada um com
  // seu vendedor (o índice único impede 2 atendimentos ativos por vendedor).
  let sellerSeq = 0;
  const startAtt = () => {
    const s = randomUUID();
    db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, ?, ?)`).run(s, A, `M-${++sellerSeq}`, `V${sellerSeq}`);
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id, started_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, A, store1, shiftId, s, `${DAY} 10:00:00`);
    return id;
  };

  // ===== 1. converted + talão → persiste normalizado =====
  const a1 = startAtt();
  const r1 = RetailFloorAttendanceService.finish(A, a1, { outcome: "converted", declaredValue: 100, boletaNumber: "017752" }, owner);
  check("talão persistido na conversão", r1.boletaNumber === "017752", `boleta=${r1.boletaNumber}`);
  check("conversão fica pendente PDV", r1.reconciliationState === "pending");

  // ===== 2. talão só em converted =====
  const a2 = startAtt();
  let rejectedNonConverted = false;
  try { RetailFloorAttendanceService.finish(A, a2, { outcome: "walkout", boletaNumber: "017753" }, owner); }
  catch { rejectedNonConverted = true; }
  check("talão rejeitado fora de converted", rejectedNonConverted);

  // ===== 3. formato inválido =====
  const a3 = startAtt();
  let rejectedFormat = false;
  try { RetailFloorAttendanceService.finish(A, a3, { outcome: "converted", boletaNumber: "abc" }, owner); }
  catch { rejectedFormat = true; }
  check("talão sem dígitos é rejeitado", rejectedFormat);

  // ===== 4. unicidade no turno (mesmo nº com zeros diferentes) =====
  const a4 = startAtt();
  let rejectedDup = false;
  try { RetailFloorAttendanceService.finish(A, a4, { outcome: "converted", declaredValue: 90, boletaNumber: "17752" }, owner); }
  catch { rejectedDup = true; }
  check("talão duplicado no turno é rejeitado (017752 ≡ 17752)", rejectedDup);

  // outro talão no mesmo turno é aceito
  const a5 = startAtt();
  const r5 = RetailFloorAttendanceService.finish(A, a5, { outcome: "converted", declaredValue: 80, boletaNumber: "017753" }, owner);
  check("talão distinto no turno é aceito", r5.boletaNumber === "017753");

  // ===== 5. conciliação DERIVA casamento talão↔clique de boleta =====
  // Um clique de boleta do dia para 017752 (existe) — 017753 não tem clique.
  db.prepare(`INSERT INTO retail_boleta_days (id, organization_id, store_id, day, initial_number) VALUES (?, ?, ?, ?, '017752')`).run(randomUUID(), A, store1, DAY);
  db.prepare(`INSERT INTO retail_boleta_events (id, organization_id, store_id, day, boleta_number, seq, status) VALUES (?, ?, ?, ?, '017752', 1, 'active')`).run(randomUUID(), A, store1, DAY);

  const sum = RetailFloorReconciliationService.summary(A, store1, DAY);
  const byId: Record<string, any> = {};
  for (const a of sum.attendances) byId[a.id] = a;
  check("summary traz o talão do atendimento", byId[a1]?.boletaNumber === "017752");
  check("talão com clique → matched=true", byId[a1]?.boletaClickMatched === true);
  check("talão sem clique → matched=false", byId[a5]?.boletaClickMatched === false);
  check("totais de talão", sum.totals.withBoleta === 2 && sum.totals.boletaClickMatched === 1, `withBoleta=${sum.totals.withBoleta} matched=${sum.totals.boletaClickMatched}`);

  // atendimento convertido SEM talão → boletaNumber null, matched null
  const a6 = startAtt();
  RetailFloorAttendanceService.finish(A, a6, { outcome: "converted", declaredValue: 70 }, owner);
  const sum2 = RetailFloorReconciliationService.summary(A, store1, DAY);
  const a6row = sum2.attendances.find((x: any) => x.id === a6);
  check("sem talão → boletaNumber null + matched null", a6row?.boletaNumber === null && a6row?.boletaClickMatched === null);

  // ===== 6. isolamento =====
  // Org B tem seu próprio turno/loja e não enxerga talões da A.
  const storeB = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Loja B', 'B01', 1)`).run(storeB, B);
  const sumB = RetailFloorReconciliationService.summary(B, storeB, DAY);
  check("org B não vê atendimentos da A", sumB.attendances.length === 0);

  console.log("\n=== TEST: FLOOR — talão da venda no atendimento (ADR-175) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
