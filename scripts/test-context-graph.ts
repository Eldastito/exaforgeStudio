/**
 * TEST — PRD 3 F2 (§8/§10/§12/§66): Context Graph — travessia read-only das
 * relações que já existem como FK no schema. DB-backed, isolado por tmpDir.
 *
 * Prova, determinístico:
 *   - resolveEntity monta a ContextEntity (F1) com fonte/confiança/frescor;
 *   - as relações filho→pai saem certas (child_of/managed_by/in_store/reports_to/
 *     is_user/has_role/owned_by/custodied_by/supplied_by/belongs_to);
 *   - expansão reversa (loja→centros de custo, usuário→subordinados) descobre a
 *     MESMA aresta canônica (sem duplicar invertida);
 *   - ISOLAMENTO (RN-CG-1): FK que aponta pra outro tenant não resolve — nó/aresta
 *     descartados; travessia cross-tenant impossível;
 *   - NÃO INVENTA (RN-CG-2): FK pendurada não vira nó;
 *   - LIMITES (RN-CG-4): maxNodes/maxDepth/fanLimit respeitados + flag truncated;
 *   - âncora inexistente → found:false (grafo vazio, não erro).
 *
 * Uso: npm run test:context-graph
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ctx-graph-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ctx-graph-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const uid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ContextGraphService: G } = await import("../src/server/ContextGraphService.js");

  // ───────── Seed: duas orgs (A: rica; B: pra provar isolamento) ─────────
  const orgA = uid("orgA");
  const orgB = uid("orgB");
  const mkOrg = (org: string, name: string) =>
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  mkOrg(orgA, "Empresa A");
  mkOrg(orgB, "Empresa B");

  // usuários
  const boss = uid("user");   // gestor
  const clerk = uid("user");  // subordinado
  const mkUser = (org: string, id: string, name: string, role = "agent") =>
    db.prepare(`INSERT INTO users (id, organization_id, name, role, global_status) VALUES (?, ?, ?, ?, 'active')`).run(id, org, name, role);
  mkUser(orgA, boss, "Chefe", "admin");
  mkUser(orgA, clerk, "Auxiliar");

  // departamento (raiz) + filho, gerido pelo boss
  const deptRoot = uid("dept");
  const deptChild = uid("dept");
  const mkDept = (org: string, id: string, name: string, parent: string | null, mgr: string | null) =>
    db.prepare(`INSERT INTO business_departments (id, organization_id, name, code, manager_user_id, parent_department_id, active) VALUES (?, ?, ?, NULL, ?, ?, 1)`).run(id, org, name, mgr, parent);
  mkDept(orgA, deptRoot, "Operações", null, boss);
  mkDept(orgA, deptChild, "Logística", deptRoot, null);

  // loja gerida pelo boss
  const store = uid("store");
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, manager_user_id, active) VALUES (?, ?, 'Loja Centro', 'C1', ?, 1)`).run(store, orgA, boss);

  // centro de custo: no depto raiz + na loja + dono clerk
  const cc = uid("cc");
  db.prepare(`INSERT INTO cost_centers (id, organization_id, name, department_id, store_id, budget_owner_user_id, active) VALUES (?, ?, 'CC Loja', ?, ?, ?, 1)`).run(cc, orgA, deptRoot, store, clerk);

  // local de estoque na loja, custodiado pelo clerk
  const loc = uid("loc");
  db.prepare(`INSERT INTO inventory_locations (id, organization_id, name, type, store_id, responsible_user_id, active) VALUES (?, ?, 'Depósito', 'almoxarifado', ?, ?, 1)`).run(loc, orgA, store, clerk);

  // employee: vinculado ao clerk (is_user), reporta ao boss, com role
  const role = uid("role");
  db.prepare(`INSERT INTO employee_roles (id, organization_id, name, active) VALUES (?, ?, 'Vendedor', 1)`).run(role, orgA);
  const emp = uid("emp");
  db.prepare(`INSERT INTO employees (id, organization_id, user_id, name, role_id, manager_user_id, status) VALUES (?, ?, ?, 'João', ?, ?, 'active')`).run(emp, orgA, clerk, role, boss);

  // meta
  const goal = uid("goal");
  db.prepare(`INSERT INTO business_goals (id, organization_id, metric, target_amount) VALUES (?, ?, 'revenue', 100000)`).run(goal, orgA);

  // produto + fornecedor (contato) via pedido de compra
  const prod = uid("prod");
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, active) VALUES (?, ?, 'product', 'Café', 1)`).run(prod, orgA);
  const supplier = uid("supp");
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', 'Fornecedor X', 'sup-x')`).run(supplier, orgA);
  const req = uid("req"); const quote = uid("q"); const po = uid("po");
  db.prepare(`INSERT INTO purchase_orders (id, organization_id, requisition_id, quote_id, supplier_contact_id, supplier_name, status) VALUES (?, ?, ?, ?, ?, 'Fornecedor X', 'confirmed')`).run(po, orgA, req, quote, supplier);
  db.prepare(`INSERT INTO purchase_order_items (id, purchase_order_id, organization_id, product_service_id, ordered_qty) VALUES (?, ?, ?, ?, 5)`).run(uid("poi"), po, orgA, prod);

  const R = (t: string, id: string) => `${t}:${id}`;
  const relSet = (g: any) => new Set(g.relationships.map((x: any) => `${x.from}|${x.type}|${x.to}`));

  // ───────── 1. resolveEntity ─────────
  const eUser = G.resolveEntity(orgA, R("user", boss));
  check("1.1 resolveEntity user: id/tenant/type/name", !!eUser && eUser.id === boss && eUser.tenantId === orgA && eUser.type === "user" && eUser.name === "Chefe");
  check("1.2 fonte INTERNAL_DB + reference; confiança very_high band", !!eUser && eUser.source.type === "INTERNAL_DB" && eUser.source.reference === boss && eUser.confidence >= 0.9);
  check("1.3 atributos estruturais (role/global_status)", !!eUser && (eUser.attributes as any).role === "admin" && (eUser.attributes as any).global_status === "active");
  const eOrg = G.resolveEntity(orgA, R("organization", orgA));
  check("1.4 organization resolve pra si (business_name)", !!eOrg && eOrg.type === "organization" && eOrg.name === "Empresa A");
  const eGoal = G.resolveEntity(orgA, R("goal", goal));
  check("1.5 goal: name=metric, attr target_amount", !!eGoal && eGoal.name === "revenue" && (eGoal.attributes as any).target_amount === 100000);
  check("1.6 tipo desconhecido → null", G.resolveEntity(orgA, R("bogus", "x")) === null);
  check("1.7 ref sem id → null", G.resolveEntity(orgA, "user:") === null);

  // ───────── 2. Isolamento (RN-CG-1) ─────────
  check("2.1 entidade de outra org não resolve neste tenant", G.resolveEntity(orgB, R("user", boss)) === null);
  check("2.2 organization de outra org não resolve", G.resolveEntity(orgA, R("organization", orgB)) === null);

  // ───────── 3. Arestas filho→pai a partir de âncoras ─────────
  // employee → is_user/reports_to/has_role + belongs_to
  const gEmp = G.build(orgA, R("employee", emp), { maxDepth: 1 });
  const empRels = relSet(gEmp);
  check("3.1 employee is_user user", empRels.has(`${R("employee", emp)}|is_user|${R("user", clerk)}`));
  check("3.2 employee reports_to boss", empRels.has(`${R("employee", emp)}|reports_to|${R("user", boss)}`));
  check("3.3 employee has_role role", empRels.has(`${R("employee", emp)}|has_role|${R("role", role)}`));
  check("3.4 employee belongs_to organization", empRels.has(`${R("employee", emp)}|belongs_to|${R("organization", orgA)}`));

  // department raiz: managed_by boss + reverso (filho child_of, cc in_department)
  const gDept = G.build(orgA, R("department", deptRoot), { maxDepth: 1 });
  const dRels = relSet(gDept);
  check("3.5 department managed_by boss", dRels.has(`${R("department", deptRoot)}|managed_by|${R("user", boss)}`));
  check("3.6 reverso: deptChild child_of deptRoot (mesma direção canônica)", dRels.has(`${R("department", deptChild)}|child_of|${R("department", deptRoot)}`));
  check("3.7 reverso: cost_center in_department deptRoot", dRels.has(`${R("cost_center", cc)}|in_department|${R("department", deptRoot)}`));

  // store: managed_by + reverso cc in_store, loc in_store
  const gStore = G.build(orgA, R("store", store), { maxDepth: 1 });
  const sRels = relSet(gStore);
  check("3.8 store managed_by boss", sRels.has(`${R("store", store)}|managed_by|${R("user", boss)}`));
  check("3.9 cost_center in_store store", sRels.has(`${R("cost_center", cc)}|in_store|${R("store", store)}`));
  check("3.10 inventory_location in_store store", sRels.has(`${R("inventory_location", loc)}|in_store|${R("store", store)}`));

  // product supplied_by supplier (e reverso do supplier)
  const gProd = G.build(orgA, R("product", prod), { maxDepth: 1 });
  check("3.11 product supplied_by supplier", relSet(gProd).has(`${R("product", prod)}|supplied_by|${R("supplier", supplier)}`));
  const gSup = G.build(orgA, R("supplier", supplier), { maxDepth: 1 });
  check("3.12 supplier: mesma aresta canônica product supplied_by supplier", relSet(gSup).has(`${R("product", prod)}|supplied_by|${R("supplier", supplier)}`));

  // user reverso: subordinados/geridos
  const gUser = G.build(orgA, R("user", boss), { maxDepth: 1 });
  const uRels = relSet(gUser);
  check("3.13 reverso user: employee reports_to boss", uRels.has(`${R("employee", emp)}|reports_to|${R("user", boss)}`));
  check("3.14 reverso user: department managed_by boss", uRels.has(`${R("department", deptRoot)}|managed_by|${R("user", boss)}`));
  check("3.15 reverso user: store managed_by boss", uRels.has(`${R("store", store)}|managed_by|${R("user", boss)}`));

  // ───────── 4. Org âncora enumera estrutura; não-âncora vira folha ─────────
  const gOrg = G.build(orgA, R("organization", orgA), { maxDepth: 1 });
  const oRels = relSet(gOrg);
  check("4.1 org âncora: department belongs_to org", oRels.has(`${R("department", deptRoot)}|belongs_to|${R("organization", orgA)}`));
  check("4.2 org âncora: store belongs_to org", oRels.has(`${R("store", store)}|belongs_to|${R("organization", orgA)}`));
  check("4.3 org âncora: goal belongs_to org", oRels.has(`${R("goal", goal)}|belongs_to|${R("organization", orgA)}`));
  // Ancorando no employee com profundidade 2: a org é descoberta (via belongs_to)
  // mas NÃO re-enumera a estrutura da empresa (folha quando não é âncora). A meta
  // só é alcançável PELA enumeração da org — logo, se a org não enumera, a meta
  // não aparece. (A loja, sim, aparece: é gerida pelo chefe — caminho legítimo.)
  const gEmp2 = G.build(orgA, R("employee", emp), { maxDepth: 3, maxNodes: 100 });
  const hasGoalViaOrg = gEmp2.entities.some((e: any) => e.type === "goal");
  check("4.4 org não-âncora não re-enumera estrutura (meta não aparece)", !hasGoalViaOrg);

  // ───────── 5. Não inventa (RN-CG-2): FK pendurada ─────────
  const orphan = uid("dept");
  db.prepare(`INSERT INTO business_departments (id, organization_id, name, parent_department_id, active) VALUES (?, ?, 'Orfão', 'dept-inexistente', 1)`).run(orphan, orgA);
  const gOrphan = G.build(orgA, R("department", orphan), { maxDepth: 1 });
  check("5.1 FK pendurada não vira nó (só o próprio + org)", !gOrphan.entities.some((e: any) => e.id === "dept-inexistente"));
  check("5.2 FK pendurada não vira aresta child_of", ![...relSet(gOrphan)].some((k) => (k as string).includes("dept-inexistente")));

  // ───────── 6. Isolamento na travessia: FK cross-tenant não atravessa ─────────
  // depto na org B apontando (indevidamente) pra um gestor da org A: não resolve.
  const deptB = uid("dept");
  db.prepare(`INSERT INTO business_departments (id, organization_id, name, manager_user_id, active) VALUES (?, ?, 'DeptB', ?, 1)`).run(deptB, orgB, boss);
  const gB = G.build(orgB, R("department", deptB), { maxDepth: 1 });
  check("6.1 gestor de outra org não entra no grafo do tenant B", !gB.entities.some((e: any) => e.id === boss));
  check("6.2 sem aresta managed_by cross-tenant", ![...relSet(gB)].some((k) => (k as string).includes(boss)));

  // ───────── 7. Limites (RN-CG-4) ─────────
  const gCap = G.build(orgA, R("organization", orgA), { maxDepth: 3, maxNodes: 3 });
  check("7.1 maxNodes respeitado", gCap.entities.length <= 3);
  check("7.2 truncated=true quando cortou", gCap.truncated === true);
  const gDepth0 = G.build(orgA, R("user", boss), { maxDepth: 0 });
  check("7.3 maxDepth 0 → só a âncora, sem relações", gDepth0.entities.length === 1 && gDepth0.relationships.length === 0);

  // ───────── 8. Âncora inexistente → found:false ─────────
  const gMiss = G.build(orgA, R("user", "nao-existe"));
  check("8.1 âncora inexistente → found:false, grafo vazio", gMiss.found === false && gMiss.entities.length === 0 && gMiss.relationships.length === 0);

  // ───────── 9. Determinismo ─────────
  const g1 = JSON.stringify(G.build(orgA, R("store", store), { maxDepth: 2 }).relationships);
  const g2 = JSON.stringify(G.build(orgA, R("store", store), { maxDepth: 2 }).relationships);
  check("9.1 relações determinísticas entre execuções", g1 === g2);

  // ───────── 10. neighbors == build(maxDepth 1) ─────────
  const nb = G.neighbors(orgA, R("store", store));
  check("10.1 neighbors devolve 1 salto (âncora + vizinhos)", nb.stats.maxDepth === 1 && nb.entities.length > 1);

  console.log("\n=== TEST: Context Graph F2 (PRD 3) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Context Graph F2 OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
