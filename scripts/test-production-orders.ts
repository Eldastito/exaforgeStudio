/**
 * TEST — Produção: ordens de produção (fatia 2, ADR-141).
 * Planejado/produzido/refugado/pendente, apontamento, atraso determinístico.
 * Determinístico, sem chave de IA.
 *
 * Uso: npm run test:production-orders
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-po-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-po2-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ProductionService: PR } = await import("../src/server/ProductionService.js");
  const { ProductionOrderService: PO } = await import("../src/server/ProductionOrderService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const mkProduct = (org: string, name: string) => { const id = randomUUID(); db.prepare("INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'product', ?)").run(id, org, name); return id; };
  const setStock = (org: string, pid: string, qty: number) => db.prepare("INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available) VALUES (?, ?, ?, ?)").run(randomUUID(), org, pid, qty);

  const orgA = mkOrg();
  const fg = mkProduct(orgA, "Bolo");
  const m1 = mkProduct(orgA, "Farinha"); setStock(orgA, m1, 500);
  const mp = PR.createProduct(orgA, { productServiceId: fg }).id!;
  const bom = PR.createBom(orgA, mp).id!;
  PR.addBomItem(orgA, bom, { materialProductServiceId: m1, quantity: 2, unit: "kg" });

  // ===== 1. Criar ordem =====
  check("ordem exige produto fabricado", PO.create(orgA, { manufacturedProductId: "x", qtyPlanned: 10 }).ok === false);
  check("ordem exige qty > 0", PO.create(orgA, { manufacturedProductId: mp, qtyPlanned: 0 }).ok === false);
  const ord = PO.create(orgA, { manufacturedProductId: mp, bomId: bom, qtyPlanned: 100, promisedDate: "2026-07-01" });
  check("cria ordem (draft)", ord.ok === true && PO.get(orgA, ord.id!).status === "draft");
  check("BOM inválida p/ outro produto é rejeitada", PO.create(orgA, { manufacturedProductId: mp, bomId: "nao-existe", qtyPlanned: 5 }).ok === false);

  // ===== 2. Não aponta antes de liberar =====
  check("não aponta ordem em rascunho", PO.report(orgA, ord.id!, { producedQty: 10 }).ok === false);
  check("libera a ordem", PO.release(orgA, ord.id!).ok === true && PO.get(orgA, ord.id!).status === "released");
  check("não libera de novo", PO.release(orgA, ord.id!).ok === false);

  // ===== 3. Atraso determinístico =====
  const g1 = PO.get(orgA, ord.id!, { asOfDate: "2026-07-23" });
  check("atrasada (prometida 07-01 < hoje 07-23, não concluída)", g1.late === true);
  check("não atrasada antes da data prometida", PO.get(orgA, ord.id!, { asOfDate: "2026-06-01" }).late === false);

  // ===== 4. Apontamento: produzido + refugo → pendente =====
  const r1 = PO.report(orgA, ord.id!, { producedQty: 40, scrappedQty: 5, note: "turno manhã" });
  check("apontar 40 bons + 5 refugo → in_progress", r1.ok === true && r1.status === "in_progress");
  const g2 = PO.get(orgA, ord.id!);
  check("produzido 40, refugo 5, pendente 60 (refugo não abate pendente)", g2.qty_produced === 40 && g2.qty_scrapped === 5 && g2.pending === 60);
  check("started_at preenchido no 1º apontamento", !!g2.started_at);
  check("apontamentos viram eventos (progress + scrap)", g2.events.filter((e: any) => e.kind === "progress").length === 1 && g2.events.filter((e: any) => e.kind === "scrap").length === 1);
  check("requirements usa o PENDENTE (60×2=120 de Farinha)", g2.requirements && g2.requirements.items[0].required === 120);

  // ===== 5. Conclui ao atingir o planejado =====
  const r2 = PO.report(orgA, ord.id!, { producedQty: 60 });
  check("atingir 100 produzidos → done", r2.status === "done");
  const g3 = PO.get(orgA, ord.id!, { asOfDate: "2026-07-23" });
  check("concluída: pendente 0, completed_at, NÃO atrasada", g3.pending === 0 && !!g3.completed_at && g3.late === false);
  check("não aponta ordem concluída", PO.report(orgA, ord.id!, { producedQty: 1 }).ok === false);

  // ===== 6. Etapas =====
  const ord2 = PO.create(orgA, { manufacturedProductId: mp, qtyPlanned: 20 }).id!;
  const st = PO.addStep(orgA, ord2, { name: "Montagem", assignedTo: "user-1" });
  check("adiciona etapa", st.ok === true);
  check("etapa sem nome rejeitada", PO.addStep(orgA, ord2, { name: " " }).ok === false);
  check("setStepStatus done", PO.setStepStatus(orgA, st.id!, "done").ok === true && PO.get(orgA, ord2).steps[0].status === "done");
  check("status de etapa inválido rejeitado", PO.setStepStatus(orgA, st.id!, "x").ok === false);

  // ===== 7. Cancelar =====
  check("cancela ordem em aberto", PO.cancel(orgA, ord2).ok === true && PO.get(orgA, ord2).status === "cancelled");
  check("não cancela ordem já concluída", PO.cancel(orgA, ord.id!).ok === false);

  // ===== 8. Lista =====
  check("lista por status", PO.list(orgA, { status: "done" }).length === 1 && PO.list(orgA, { status: "cancelled" }).length === 1);

  // ===== 9. Isolamento =====
  const orgB = mkOrg();
  check("isolamento: org B não vê ordens de A", PO.list(orgB).length === 0 && PO.get(orgB, ord.id!) === null);
  check("isolamento: report cross-org falha", PO.report(orgB, ord.id!, { producedQty: 1 }).ok === false);

  console.log("\n=== TEST: Produção — ordens (ADR-141 fatia 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Produção (ordens) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
