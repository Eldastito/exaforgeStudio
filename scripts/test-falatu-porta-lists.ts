/**
 * TEST — ADR-160 F7 (Onda A): porta I/O, 3ª fatia — LISTA de COMPRAS vira
 * requisição de compra CANÔNICA.
 *
 * A fatia mais seletiva: só listas 'shopping' têm equivalente canônico (general/
 * meeting/trip ficam silo-only), e só os itens que CASAM com o catálogo viram
 * linhas da requisição (product_service_id é NOT NULL; nunca inventa produto).
 *
 * Prova, determinístico (semeia inbox + produtos direto; matcher é sync/sem IA):
 *   - flag OFF (default): confirm(LIST shopping) → só silo, sem requisição (0 regr.);
 *   - flag ON + shopping + itens que casam: cria requisição DRAFT + linhas dos
 *     itens casados + vínculo silo→canônico + retorna bridgedRequisitionId;
 *   - partial: itens sem match ficam só no silo (requisição só com os casados);
 *   - RN-151: nenhum item casa → sem requisição; tipo != shopping → silo-only;
 *   - requisição nasce 'draft' (humano aprova depois — nunca auto-compra);
 *   - isolamento multi-tenant; bridges independentes; toggles.
 *
 * Uso: npm run test:falatu-porta-lists
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-porta-lists-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-porta-lists-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService: FT } = await import("../src/server/FalaTuService.js");

  const mkOrg = (lists: boolean) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, falatu_bridge_lists_enabled) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, lists ? 1 : 0);
    return id;
  };
  const mkProduct = (orgId: string, name: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, active) VALUES (?, ?, 'product', ?, 1)`).run(id, orgId, name);
    return id;
  };
  const seedInbox = (orgId: string, userId: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO falatu_inbox_items (id, organization_id, user_id, source, content, summary, intent, entities_json, confidence, status) VALUES (?, ?, ?, 'webapp', 'compras', 'compras', 'LIST', '{}', 0.9, 'pending')`)
      .run(id, orgId, userId);
    return id;
  };
  const reqItems = (reqId: string) => db.prepare(`SELECT * FROM purchase_requisition_items WHERE requisition_id = ?`).all(reqId) as any[];
  const reqRow = (orgId: string, reqId: string) => db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ? AND organization_id = ?`).get(reqId, orgId) as any;
  const reqCount = (orgId: string) => (db.prepare(`SELECT COUNT(*) n FROM purchase_requisitions WHERE organization_id = ?`).get(orgId) as any).n;
  const siloList = (refId: string) => db.prepare(`SELECT * FROM falatu_lists WHERE id = ?`).get(refId) as any;
  const siloItems = (refId: string) => db.prepare(`SELECT * FROM falatu_list_items WHERE list_id = ?`).all(refId) as any[];

  // ===== 1. Flag OFF (default) → só silo =====
  const orgOff = mkOrg(false);
  mkProduct(orgOff, "Leite Integral");
  check("toggle: isListBridgeEnabled false por padrão", FT.isListBridgeEnabled(orgOff) === false);
  const inOff = seedInbox(orgOff, "u1");
  const rOff = FT.confirm(orgOff, "u1", inOff, { listType: "shopping", listItems: ["leite"] });
  check("OFF: confirmou como list (silo)", rOff.kind === "list" && !!rOff.refId);
  check("OFF: NÃO criou requisição", reqCount(orgOff) === 0);
  check("OFF: bridged_requisition_id NULL", siloList(rOff.refId!)?.bridged_requisition_id == null);
  check("OFF: retorno sem bridgedRequisitionId", rOff.bridgedRequisitionId == null);

  // ===== 2. Flag ON + shopping + itens que casam =====
  const orgOn = mkOrg(true);
  mkProduct(orgOn, "Leite Integral");
  mkProduct(orgOn, "Café em pó");
  check("toggle: isListBridgeEnabled true com flag", FT.isListBridgeEnabled(orgOn) === true);
  const inOn = seedInbox(orgOn, "u1");
  const rOn = FT.confirm(orgOn, "u1", inOn, { listType: "shopping", listItems: ["leite", "cafe"] });
  check("ON: criou exatamente 1 requisição", reqCount(orgOn) === 1);
  check("ON: retorno traz bridgedRequisitionId", !!rOn.bridgedRequisitionId);
  check("ON: requisição nasce 'draft' (humano aprova depois)", reqRow(orgOn, rOn.bridgedRequisitionId!)?.status === "draft");
  check("ON: 2 linhas na requisição (leite + café casaram)", reqItems(rOn.bridgedRequisitionId!).length === 2);
  check("ON: toda linha com product_service_id (nunca inventa produto)", reqItems(rOn.bridgedRequisitionId!).every((i) => !!i.product_service_id));
  check("ON: vínculo silo→canônico gravado", siloList(rOn.refId!)?.bridged_requisition_id === rOn.bridgedRequisitionId);
  check("ON: silo falatu_lists preservado (dual-write)", !!siloList(rOn.refId!) && siloItems(rOn.refId!).length === 2);

  // ===== 3. Partial: item sem match fica só no silo =====
  const orgP = mkOrg(true);
  mkProduct(orgP, "Leite Integral");
  const inP = seedInbox(orgP, "u1");
  const rP = FT.confirm(orgP, "u1", inP, { listType: "shopping", listItems: ["leite", "guardanapo descartável"] });
  check("partial: requisição só com o item casado (leite)", reqItems(rP.bridgedRequisitionId!).length === 1);
  check("partial: silo mantém TODOS os itens (2), inclusive o não-casado", siloItems(rP.refId!).length === 2);

  // ===== 4. RN-151 / seletividade =====
  const orgNone = mkOrg(true);
  mkProduct(orgNone, "Parafuso");
  const inNone = seedInbox(orgNone, "u1");
  const rNone = FT.confirm(orgNone, "u1", inNone, { listType: "shopping", listItems: ["banana", "abacaxi"] });
  check("nenhum match: sem requisição (silo-only)", rNone.bridgedRequisitionId == null && reqCount(orgNone) === 0);

  const orgGen = mkOrg(true);
  mkProduct(orgGen, "Leite Integral");
  const inGen = seedInbox(orgGen, "u1");
  const rGen = FT.confirm(orgGen, "u1", inGen, { listType: "general", listItems: ["leite"] });
  check("tipo != shopping: silo-only mesmo casando catálogo", rGen.bridgedRequisitionId == null && reqCount(orgGen) === 0);

  // ===== 5. Bridges independentes =====
  check("ON: list bridge não cria task", (db.prepare(`SELECT COUNT(*) n FROM tasks WHERE organization_id = ?`).get(orgOn) as any).n === 0);
  check("ON: list bridge não cria appointment", (db.prepare(`SELECT COUNT(*) n FROM appointments WHERE organization_id = ?`).get(orgOn) as any).n === 0);

  // ===== 6. Isolamento multi-tenant =====
  const orgA = mkOrg(true), orgB = mkOrg(true);
  mkProduct(orgA, "Leite Integral");
  mkProduct(orgB, "Leite Integral");
  const inA = seedInbox(orgA, "ua");
  FT.confirm(orgA, "ua", inA, { listType: "shopping", listItems: ["leite"] });
  check("isolamento: requisição de A não aparece em B", reqCount(orgB) === 0 && reqCount(orgA) === 1);

  // ===== 7. Toggles =====
  const orgTgl = mkOrg(false);
  check("setListBridge(true) liga", FT.setListBridge(orgTgl, true).lists === true && FT.isListBridgeEnabled(orgTgl) === true);
  check("bridgeState reporta tasks+events+lists", (() => { const s = FT.bridgeState(orgTgl); return typeof s.tasks === "boolean" && typeof s.events === "boolean" && s.lists === true; })());
  check("setListBridge(false) desliga", FT.setListBridge(orgTgl, false).lists === false);

  console.log("\n=== TEST: Fala Tu porta I/O — bridge de listas de compras (ADR-160 F7) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Fala Tu porta I/O — listas (F7) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
