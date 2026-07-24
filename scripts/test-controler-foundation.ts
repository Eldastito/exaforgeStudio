/**
 * TESTE — CONTROLER Fatia 1a: fundação de Departamentos e Centros de Custo
 * (PRD-E-007). Aditivo e opt-in; determinístico; isolado por organização.
 *
 * Cobre: CRUD, hierarquia (árvore, anti-ciclo), unicidade de código, validação
 * de vínculos (gestor/departamento/dono do orçamento na mesma org), ativar/
 * desativar e ISOLAMENTO multi-tenant.
 *
 * Uso:  npm run test:controler-foundation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-controler-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-controler-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
function throws(fn: () => any): boolean { try { fn(); return false; } catch { return true; } }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { DepartmentService } = await import("../src/server/DepartmentService.js");
  const { CostCenterService } = await import("../src/server/CostCenterService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const [org, name] of [[A, "A"], [B, "B"]] as const) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  const uA = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Ana', ?)`).run(uA, A, `a_${uA.slice(0, 6)}@x.com`);

  // ===== Departamentos: criar, validar, hierarquia =====
  const admin = DepartmentService.create(A, { name: "Administrativo", code: "ADM", managerUserId: uA }, "u1");
  check("cria departamento", !!admin.id && admin.name === "Administrativo" && admin.active === 1, JSON.stringify(admin));
  check("exige nome", throws(() => DepartmentService.create(A, { name: "  " })));
  check("código único por org", throws(() => DepartmentService.create(A, { name: "Outro", code: "ADM" })));
  check("gestor precisa existir na org", throws(() => DepartmentService.create(A, { name: "X", managerUserId: randomUUID() })));

  const ti = DepartmentService.create(A, { name: "TI", parentDepartmentId: admin.id }, "u1");
  const infra = DepartmentService.create(A, { name: "Infra", parentDepartmentId: ti.id }, "u1");
  check("cria subdepartamento", ti.parent_department_id === admin.id);
  check("pai precisa existir", throws(() => DepartmentService.create(A, { name: "Z", parentDepartmentId: randomUUID() })));

  // Árvore: 1 raiz (Administrativo) → TI → Infra.
  const tree = DepartmentService.tree(A);
  check("árvore tem 1 raiz", tree.length === 1 && tree[0].id === admin.id, JSON.stringify(tree.map((t: any) => t.name)));
  check("árvore aninha filhos", tree[0].children.length === 1 && tree[0].children[0].children.length === 1);

  // Anti-ciclo: Administrativo não pode virar filho do próprio neto (Infra).
  check("bloqueia ciclo na hierarquia", throws(() => DepartmentService.update(A, admin.id, { name: "Administrativo", parentDepartmentId: infra.id })));
  check("não pode ser pai de si mesmo", throws(() => DepartmentService.update(A, ti.id, { name: "TI", parentDepartmentId: ti.id })));

  // Atualizar + desativar.
  const upd = DepartmentService.update(A, ti.id, { name: "Tecnologia", code: "TEC" }, "u1");
  check("atualiza departamento", upd.name === "Tecnologia" && upd.code === "TEC");
  DepartmentService.setActive(A, infra.id, false, "u1");
  check("desativa some da lista padrão", !DepartmentService.list(A).some((d: any) => d.id === infra.id));
  check("desativa aparece com includeInactive", DepartmentService.list(A, { includeInactive: true }).some((d: any) => d.id === infra.id));

  // ===== Centros de custo =====
  const cc = CostCenterService.create(A, { name: "Escritório", code: "CC-ADM", departmentId: admin.id, budgetOwnerUserId: uA }, "u1");
  check("cria centro de custo vinculado ao depto", cc.department_id === admin.id && cc.budget_owner_user_id === uA, JSON.stringify(cc));
  check("cc: nome obrigatório", throws(() => CostCenterService.create(A, { name: "" })));
  check("cc: código único", throws(() => CostCenterService.create(A, { name: "Outro", code: "CC-ADM" })));
  check("cc: departamento precisa existir na org", throws(() => CostCenterService.create(A, { name: "X", departmentId: randomUUID() })));
  check("cc: dono do orçamento precisa existir", throws(() => CostCenterService.create(A, { name: "Y", budgetOwnerUserId: randomUUID() })));
  check("lista cc por departamento", CostCenterService.list(A, { departmentId: admin.id }).length === 1);

  // ===== Isolamento multi-tenant =====
  check("isolamento: org B não vê deptos de A", DepartmentService.list(B).length === 0);
  check("isolamento: org B não vê CCs de A", CostCenterService.list(B).length === 0);
  check("isolamento: get cross-org devolve null", DepartmentService.get(B, admin.id) === null && CostCenterService.get(B, cc.id) === null);
  // Org B pode reusar o MESMO código (unicidade é por org).
  check("código é único só dentro da org", !throws(() => DepartmentService.create(B, { name: "Adm B", code: "ADM" })));
  // Vínculo cross-org é rejeitado (depto de A não vale para CC de B).
  check("isolamento: CC de B não aceita depto de A", throws(() => CostCenterService.create(B, { name: "X", departmentId: admin.id })));

  console.log("\n=== CONTROLER Fatia 1a — Departamentos e Centros de Custo ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
