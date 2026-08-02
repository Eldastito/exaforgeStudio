/**
 * TESTE — ADR-150 Fatia 6: conciliação declarado × PDV
 * ----------------------------------------------------
 * Prova, offline (matching por COBERTURA DE VALOR no nível loja/vendedor/dia,
 * porque retail_erp_seller_sales é agregado diário — não existe venda a venda):
 *   - cobertura total: ERP cobre a soma declarada → todos confirmed;
 *   - sem ERP no dia → todos unmatched (declarou, PDV não registrou);
 *   - cobertura parcial: confirma na ordem de started_at até caber no
 *     orçamento (ERP × 1.05); o resto unmatched — determinístico;
 *   - declarado SEM valor: confirmado quando o PDV tem venda no dia (não
 *     consome orçamento);
 *   - par loja↔ERP por store_id OU fallback filial = retail_stores.code;
 *   - idempotência e só-promove: re-rodar não rebaixa confirmed; ERP
 *     atrasado promove unmatched→confirmed;
 *   - override do gestor (único caminho que rebaixa): auditado; negado fora
 *     do escopo; só em atendimento convertido;
 *   - summary: contagens + declarado × ERP + gap;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-floor-reconciliation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-f6-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-floor-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { RetailFloorReconciliationService } = await import("../src/server/RetailFloorReconciliationService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "moda");
  ModuleService.enableModule(A, "retail_floor");

  const uManager = randomUUID(), uOther = randomUUID();
  const store1 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, manager_user_id) VALUES (?, ?, 'Loja 1005', '1005', ?)`).run(store1, A, uManager);
  const vAna = randomUUID(), vBia = randomUUID(), vCaio = randomUUID();
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'M-01', 'Ana')`).run(vAna, A);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'M-02', 'Bia')`).run(vBia, A);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'M-03', 'Caio')`).run(vCaio, A);

  const DAY = "2026-08-01";
  const shiftId = randomUUID();
  // Atendimentos convertidos direto no banco (o fluxo start/finish já é
  // coberto pelas Fatias 3/4 — aqui o alvo é o matching).
  const att = db.prepare(
    `INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id, started_at, ended_at, outcome, reconciliation_state, declared_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'converted', 'pending', ?)`
  );
  // Ana: 100 (10h), 150 (11h), 200 (12h) — ERP dela: 260 → 100+150 cabem (250 <= 273), 200 não.
  const a1 = randomUUID(), a2 = randomUUID(), a3 = randomUUID();
  att.run(a1, A, store1, shiftId, vAna, `${DAY} 10:00:00`, `${DAY} 10:20:00`, 100);
  att.run(a2, A, store1, shiftId, vAna, `${DAY} 11:00:00`, `${DAY} 11:20:00`, 150);
  att.run(a3, A, store1, shiftId, vAna, `${DAY} 12:00:00`, `${DAY} 12:20:00`, 200);
  // Bia: declarou 300 mas ERP não tem nada dela → unmatched.
  const b1 = randomUUID();
  att.run(b1, A, store1, shiftId, vBia, `${DAY} 10:30:00`, `${DAY} 10:50:00`, 300);
  // Caio: declarou SEM valor; ERP tem 80 dele (via fallback de filial) → confirmed.
  const c1 = randomUUID();
  db.prepare(
    `INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id, started_at, ended_at, outcome, reconciliation_state, declared_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'converted', 'pending', NULL)`
  ).run(c1, A, store1, shiftId, vCaio, `${DAY} 14:00:00`, `${DAY} 14:15:00`);

  // ERP: Ana com store_id resolvido; Caio SEM store_id (só filial = code 1005).
  const erp = db.prepare(
    `INSERT INTO retail_erp_seller_sales (id, organization_id, store_id, filial, sale_date, matricula, valor, pecas, external_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  erp.run(randomUUID(), A, store1, "1005", DAY, "M-01", 260, 3, `ref-ana-${DAY}`);
  erp.run(randomUUID(), A, null, "1005", DAY, "M-03", 80, 1, `ref-caio-${DAY}`);

  const manager = { userId: uManager, role: "agent" };

  // ---- 1. matching por cobertura ----
  const sum = RetailFloorReconciliationService.runDay(A, store1, DAY, uManager);
  const state = (id: string) => (db.prepare(`SELECT reconciliation_state AS s FROM retail_floor_attendances WHERE id = ?`).get(id) as any).s;
  check("cobertura: 100+150 cabem no ERP 260×1.05 → confirmed", state(a1) === "confirmed" && state(a2) === "confirmed");
  check("cobertura: o 3º (200) estoura o orçamento → unmatched", state(a3) === "unmatched");
  check("sem ERP no dia: Bia → unmatched", state(b1) === "unmatched");
  check("sem valor declarado + ERP>0 (fallback filial): Caio → confirmed", state(c1) === "confirmed");
  check("summary: contagens (3 confirmed, 2 unmatched, 0 pending)",
    sum.totals.confirmed === 3 && sum.totals.unmatched === 2 && sum.totals.pending === 0);
  check("summary: declarado 750 × ERP 340 → gap 410",
    sum.totals.declaredValue === 750 && sum.totals.erpValue === 340 && sum.totals.gap === 410);
  const auditRun = db.prepare(`SELECT COUNT(*) AS n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_FLOOR_RECONCILIATION_RUN'`).get(A) as any;
  check("run auditado", Number(auditRun.n) >= 1);

  // ---- 2. idempotência e só-promove ----
  RetailFloorReconciliationService.runDay(A, store1, DAY, uManager);
  check("re-rodar não muda nada (idempotente)", state(a1) === "confirmed" && state(a3) === "unmatched" && state(b1) === "unmatched");
  // ERP da Bia chega ATRASADO → promove unmatched→confirmed.
  erp.run(randomUUID(), A, store1, "1005", DAY, "M-02", 310, 2, `ref-bia-${DAY}`);
  RetailFloorReconciliationService.runDay(A, store1, DAY, uManager);
  check("ERP atrasado promove Bia unmatched→confirmed (310 cobre 300)", state(b1) === "confirmed");
  check("promoção não rebaixa os confirmed anteriores", state(a1) === "confirmed" && state(c1) === "confirmed");

  // ---- 3. override do gestor ----
  let badState = false;
  try { RetailFloorReconciliationService.override(A, a1, "pending", manager); } catch (e: any) { badState = /state inválido/.test(e.message); }
  check("override: state fora de confirmed|unmatched rejeitado", badState);
  let noScope = false;
  try { RetailFloorReconciliationService.override(A, a1, "unmatched", { userId: uOther, role: "agent" }); } catch (e: any) { noScope = e.message === "store_scope_denied"; }
  check("override: fora do escopo negado (RN-150-005)", noScope);
  RetailFloorReconciliationService.override(A, a1, "unmatched", manager);
  check("override: gestor rebaixa confirmed→unmatched (único caminho)", state(a1) === "unmatched");
  const auditOv = db.prepare(`SELECT metadata_json FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_FLOOR_RECONCILIATION_OVERRIDE' ORDER BY rowid DESC LIMIT 1`).get(A) as any;
  check("override auditado com from/to", JSON.parse(auditOv.metadata_json).from === "confirmed" && JSON.parse(auditOv.metadata_json).to === "unmatched");
  // Mas a máquina RE-PROMOVE unmatched se o ERP cobre — rebaixa de vez exige
  // que o dado sustente (documentado: máquina só promove; rebaixo é humano).
  let notConverted = false;
  const w1 = randomUUID();
  db.prepare(`INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id, started_at, ended_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, 'walkout')`).run(w1, A, store1, shiftId, vAna, `${DAY} 15:00:00`, `${DAY} 15:05:00`);
  try { RetailFloorReconciliationService.override(A, w1, "confirmed", manager); } catch (e: any) { notConverted = /convertido/.test(e.message); }
  check("override: walkout não tem conciliação", notConverted);

  // ---- 4. guards ----
  let badDate = false;
  try { RetailFloorReconciliationService.runDay(A, store1, "01/08/2026", uManager); } catch (e: any) { badDate = /YYYY-MM-DD/.test(e.message); }
  check("guard: data fora de YYYY-MM-DD rejeitada", badDate);
  let badStore = false;
  try { RetailFloorReconciliationService.runDay(A, randomUUID(), DAY, uManager); } catch (e: any) { badStore = /não encontrada/.test(e.message); }
  check("guard: loja inexistente rejeitada", badStore);

  // ---- 5. isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  let crossSum = false;
  try { RetailFloorReconciliationService.summary(B, store1, DAY); } catch { crossSum = true; }
  check("Isolamento: org B não lê conciliação da loja de A", crossSum);
  let crossOverride = false;
  try { RetailFloorReconciliationService.override(B, a1, "confirmed", { userId: randomUUID(), role: "owner" }); } catch { crossOverride = true; }
  check("Isolamento: org B não faz override em atendimento de A", crossOverride);

  console.log("\n=== ADR-150 Fatia 6: conciliação declarado × PDV ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
