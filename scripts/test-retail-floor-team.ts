/**
 * TESTE — ADR-150 Fatia 11: equipe da loja (cadastro + foto) + escala do turno
 * ----------------------------------------------------------------------------
 * Prova, offline:
 *   - schema: aditivo retail_sellers.photo_url;
 *   - createSeller: nome obrigatório, matrícula opcional (placeholder LV-),
 *     duplicata rejeitada, auditoria;
 *   - updateSeller: nome/foto/matrícula/active, validações, auditoria;
 *   - contexto: sellers/sellerProfile expõem photoUrl (só pra gestor);
 *   - fila (ordered): entries carregam photoUrl pro card do Kanban;
 *   - escopo: assertAnyManager — owner/admin ok, gestor de alguma loja ok,
 *     usuário sem vínculo negado (RN-150-005);
 *   - isolamento multi-tenant (RN-150-001).
 *
 * Uso:  npm run test:retail-floor-team
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-f11-"));
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
  const { RetailFloorService } = await import("../src/server/RetailFloorService.js");
  const { RetailFloorShiftService, RetailFloorQueueService } = await import("../src/server/RetailFloorShiftService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);

  // ---- 1. Schema ----
  const cols = db.prepare(`PRAGMA table_info(retail_sellers)`).all() as any[];
  check("Schema: aditivo retail_sellers.photo_url", cols.some((c) => c.name === "photo_url"));

  // ---- 2. createSeller ----
  const uOwner = randomUUID(), uManager = randomUUID(), uNobody = randomUUID();
  const store1 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, manager_user_id) VALUES (?, ?, 'Loja 1005', '1005', ?)`).run(store1, A, uManager);

  let noName = false;
  try { RetailFloorService.createSeller(A, { name: "  " }, uOwner); } catch { noName = true; }
  check("Create: nome vazio é rejeitado", noName);

  const ana = RetailFloorService.createSeller(A, { name: "Ana Souza", photoUrl: "/media/ana.jpg" }, uOwner);
  check("Create: sem matrícula gera placeholder LV-", String(ana.matricula).startsWith("LV-"));
  check("Create: photoUrl persiste", ana.photoUrl === "/media/ana.jpg" && ana.active === true);

  const bia = RetailFloorService.createSeller(A, { name: "Bia Lima", matricula: "M-10" }, uOwner);
  check("Create: matrícula informada é respeitada", bia.matricula === "M-10" && bia.photoUrl === null);

  let dup = false;
  try { RetailFloorService.createSeller(A, { name: "Clone", matricula: "M-10" }, uOwner); } catch { dup = true; }
  check("Create: matrícula duplicada é rejeitada", dup);

  const auditC = db.prepare(`SELECT COUNT(*) AS n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_FLOOR_SELLER_CREATE'`).get(A) as any;
  check("Create: audita (logAuthEvent)", Number(auditC.n) >= 2);

  // ---- 3. updateSeller ----
  const ana2 = RetailFloorService.updateSeller(A, ana.id, { photoUrl: "/media/ana2.jpg" }, uOwner);
  check("Update: troca foto sem tocar no resto", ana2.photoUrl === "/media/ana2.jpg" && ana2.name === "Ana Souza" && ana2.matricula === ana.matricula);

  const ana3 = RetailFloorService.updateSeller(A, ana.id, { matricula: "M-77" }, uOwner);
  check("Update: placeholder LV- trocável por matrícula real (id preservado)", ana3.matricula === "M-77" && ana3.id === ana.id);

  let dupUpd = false;
  try { RetailFloorService.updateSeller(A, ana.id, { matricula: "M-10" }, uOwner); } catch { dupUpd = true; }
  check("Update: matrícula duplicada é rejeitada", dupUpd);

  const anaOff = RetailFloorService.updateSeller(A, ana.id, { active: false }, uOwner);
  check("Update: desativar (nunca DELETE — retenção)", anaOff.active === false);
  RetailFloorService.updateSeller(A, ana.id, { active: true }, uOwner);

  let notFound = false;
  try { RetailFloorService.updateSeller(A, randomUUID(), { name: "X" }, uOwner); } catch { notFound = true; }
  check("Update: vendedor inexistente é rejeitado", notFound);

  const auditU = db.prepare(`SELECT COUNT(*) AS n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_FLOOR_SELLER_UPDATE'`).get(A) as any;
  check("Update: audita (logAuthEvent)", Number(auditU.n) >= 4);

  // ---- 4. Contexto expõe photoUrl ----
  const ctxOwner = RetailFloorService.context(A, { userId: uOwner, role: "owner" });
  const anaCtx = ctxOwner.sellers.find((s: any) => s.id === ana.id);
  check("Contexto: sellers do gestor trazem photoUrl", anaCtx?.photoUrl === "/media/ana2.jpg");

  db.prepare(`UPDATE retail_sellers SET user_id = ? WHERE id = ?`).run(uNobody, bia.id);
  const ctxSeller = RetailFloorService.context(A, { userId: uNobody, role: "agent" });
  check("Contexto: sellerProfile traz photoUrl (null quando sem foto)",
    ctxSeller.sellerProfile?.sellerId === bia.id && ctxSeller.sellerProfile?.photoUrl === null);
  check("Contexto: não-gestor NÃO recebe o roster completo", ctxSeller.sellers.length === 0);

  // ---- 5. Fila carrega photoUrl ----
  const shift = RetailFloorShiftService.open(A, store1, { userId: uManager, role: "agent" });
  RetailFloorQueueService.join(A, { storeId: store1, sellerId: ana.id }, { userId: uManager, role: "agent" });
  const ordered = RetailFloorQueueService.ordered(A, shift.id);
  const anaQ = ordered.queue.find((q: any) => q.sellerId === ana.id);
  check("Fila: entry do Kanban carrega photoUrl", anaQ?.photoUrl === "/media/ana2.jpg");

  // ---- 6. Escopo assertAnyManager ----
  let okOwner = true; try { RetailFloorService.assertAnyManager(A, { userId: uOwner, role: "owner" }); } catch { okOwner = false; }
  check("Escopo: owner autoriza", okOwner);
  let okMgr = true; try { RetailFloorService.assertAnyManager(A, { userId: uManager, role: "agent" }); } catch { okMgr = false; }
  check("Escopo: gestor de alguma loja autoriza", okMgr);
  let deniedNobody = false; try { RetailFloorService.assertAnyManager(A, { userId: uNobody, role: "agent" }); } catch { deniedNobody = true; }
  check("Escopo: usuário sem loja gerenciada é negado", deniedNobody);

  // ---- 7. Isolamento multi-tenant ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const ctxB = RetailFloorService.context(B, { userId: uOwner, role: "owner" });
  check("Isolamento: B não vê vendedores de A", ctxB.sellers.length === 0);
  let crossUpd = false;
  try { RetailFloorService.updateSeller(B, ana.id, { name: "Hack" }, uOwner); } catch { crossUpd = true; }
  check("Isolamento: update cross-tenant negado", crossUpd);
  const sameMat = RetailFloorService.createSeller(B, { name: "Bia de B", matricula: "M-10" }, uOwner);
  check("Isolamento: matrícula M-10 livre em B (unique é por org)", sameMat.matricula === "M-10");
  let crossMgr = false;
  try { RetailFloorService.assertAnyManager(B, { userId: uManager, role: "agent" }); } catch { crossMgr = true; }
  check("Isolamento: gestor de A não gerencia em B", crossMgr);

  // ---- 8. Roster POR LOJA (lotação) — Atendimento de Loja filtra por loja ----
  const { RetailSellerDirectoryService } = await import("../src/server/RetailSellerDirectoryService.js");
  const store2 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, manager_user_id) VALUES (?, ?, 'Loja 2010', '2010', ?)`).run(store2, A, uManager);

  // Sem lotação → cai pro roster da org inteira, scoped:false (a UI avisa pra associar).
  const s0 = RetailFloorService.storeSellers(A, store1);
  check("StoreSellers: sem lotação cai pro roster da org (scoped:false)", s0.scoped === false && s0.sellers.length >= 2, `scoped=${s0.scoped} n=${s0.sellers.length}`);

  // Associa SÓ a Ana à loja 1.
  RetailSellerDirectoryService.setStoreSellers(A, store1, [ana.id], uOwner);
  const s1 = RetailFloorService.storeSellers(A, store1);
  check("StoreSellers: com lotação, scoped:true e só os da loja", s1.scoped === true && s1.sellers.length === 1 && s1.sellers[0].id === ana.id, `n=${s1.sellers.length}`);
  check("StoreSellers: entry traz photoUrl (card do Kanban)", s1.sellers[0]?.photoUrl === "/media/ana2.jpg");

  // Bia na loja 2 — não vaza pra loja 1.
  RetailSellerDirectoryService.setStoreSellers(A, store2, [bia.id], uOwner);
  check("StoreSellers: loja 2 só tem a Bia (não vaza entre lojas)", (() => { const s = RetailFloorService.storeSellers(A, store2); return s.sellers.length === 1 && s.sellers[0].id === bia.id; })());
  check("StoreSellers: loja 1 continua só com a Ana", (() => { const s = RetailFloorService.storeSellers(A, store1); return s.sellers.length === 1 && s.sellers[0].id === ana.id; })());

  // Reconcilia: +Bia na loja 1, depois -Ana (desativa, nunca DELETE), depois volta.
  RetailSellerDirectoryService.setStoreSellers(A, store1, [ana.id, bia.id], uOwner);
  check("StoreSellers: adicionar 2º vendedor à loja", RetailFloorService.storeSellers(A, store1).sellers.length === 2);
  RetailSellerDirectoryService.setStoreSellers(A, store1, [bia.id], uOwner);
  const s1c = RetailFloorService.storeSellers(A, store1);
  check("StoreSellers: remover da equipe tira da loja (sem apagar identidade)", s1c.sellers.length === 1 && s1c.sellers[0].id === bia.id);
  check("StoreSellers: Ana continua existindo como vendedora (soft)", !!db.prepare(`SELECT 1 FROM retail_sellers WHERE organization_id=? AND id=? AND active=1`).get(A, ana.id));
  // Reativa a Ana (reaproveita o vínculo inativo — não duplica a linha).
  RetailSellerDirectoryService.setStoreSellers(A, store1, [ana.id, bia.id], uOwner);
  const assignRows = db.prepare(`SELECT COUNT(*) AS n FROM retail_seller_store_assignments WHERE organization_id=? AND store_id=? AND seller_id=?`).get(A, store1, ana.id) as any;
  check("StoreSellers: reativar não duplica o vínculo (reaproveita a linha)", Number(assignRows.n) === 1, `linhas=${assignRows.n}`);

  let badStore = false; try { RetailSellerDirectoryService.setStoreSellers(A, randomUUID(), [ana.id], uOwner); } catch { badStore = true; }
  check("StoreSellers: loja inválida rejeitada", badStore);
  let badSeller = false; try { RetailSellerDirectoryService.setStoreSellers(A, store1, [randomUUID()], uOwner); } catch { badSeller = true; }
  check("StoreSellers: vendedor inválido rejeitado", badSeller);
  let crossTeam = false; try { RetailSellerDirectoryService.setStoreSellers(B, store1, [ana.id], uOwner); } catch { crossTeam = true; }
  check("StoreSellers: cross-tenant negado (loja de A não existe em B)", crossTeam);

  console.log("\n=== ADR-150 Fatia 11: equipe da loja (cadastro + foto) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
