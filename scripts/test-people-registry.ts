/**
 * TEST — People / RH cadastro funcional (Epic 7 — fatia 1).
 * Registro (função/gestor/unidade/jornada/status) + RBAC people. Determinístico.
 *
 * Uso: npm run test:people-registry
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-people-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-people-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { EmployeeService: E } = await import("../src/server/EmployeeService.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();
  P.seedSystemProfiles(orgA);
  const uWith = (key: string) => ({ userId: `u_${key}`, role: "agent", role_profile_id: (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?").get(orgA, key) as any)?.id });

  // ===== 1. RBAC do módulo `people` (só gestores por padrão) =====
  check("owner vê RH", P.can(orgA, uWith("owner"), "people", "read") === true);
  check("gerente vê RH", P.can(orgA, uWith("gerente"), "people", "read") === true);
  check("vendedor NÃO vê RH", P.can(orgA, uWith("vendedor"), "people", "read") === false);
  check("atendente NÃO vê RH", P.can(orgA, uWith("atendente"), "people", "read") === false);
  check("financeiro NÃO vê RH", P.can(orgA, uWith("financeiro"), "people", "read") === false);
  check("legado owner (sem perfil) vê RH", P.can(orgA, { role: "owner" }, "people", "read") === true);
  check("legado agent (sem perfil) NÃO vê RH", P.can(orgA, { role: "agent" }, "people", "read") === false);

  // ===== 2. Catálogo de funções (idempotente por nome) =====
  const r1 = E.createRole(orgA, "Vendedor de Loja", "Atende no balcão");
  check("cria função", r1.ok === true && !!r1.id);
  const r1b = E.createRole(orgA, "Vendedor de Loja");
  check("função idempotente por (org, nome)", r1b.ok === true && r1b.id === r1.id);
  E.createRole(orgA, "Caixa");
  check("listRoles lista as ativas", E.listRoles(orgA).length === 2);
  check("função sem nome é rejeitada", E.createRole(orgA, "  ").ok === false);

  // ===== 3. Colaboradores =====
  const mgr = randomUUID();
  const e1 = E.create(orgA, { name: "Maria Silva", roleId: r1.id!, managerUserId: mgr, unit: "Loja Centro", workSchedule: "seg-sex 9-18", hiredAt: "2025-01-10" });
  check("cria colaborador", e1.ok === true && !!e1.id);
  check("colaborador sem nome é rejeitado", E.create(orgA, { name: "" }).ok === false);
  const got = E.get(orgA, e1.id!);
  check("get traz o nome da função (join)", got.role_name === "Vendedor de Loja" && got.unit === "Loja Centro" && got.status === "active");

  E.create(orgA, { name: "João Souza", roleId: r1.id!, managerUserId: mgr, status: "leave" });
  E.create(orgA, { name: "Ana Costa", unit: "Loja Sul" });
  check("lista todos os colaboradores", E.list(orgA).length === 3);
  check("filtra por status", E.list(orgA, { status: "active" }).length === 2 && E.list(orgA, { status: "leave" }).length === 1);
  check("filtra por gestor", E.list(orgA, { managerUserId: mgr }).length === 2);

  // ===== 4. Update + status =====
  check("update altera unidade/jornada", E.update(orgA, e1.id!, { unit: "Loja Norte" }).ok === true && E.get(orgA, e1.id!).unit === "Loja Norte");
  check("status inválido é rejeitado", E.update(orgA, e1.id!, { status: "demitido" }).ok === false);
  check("setStatus inactive", E.setStatus(orgA, e1.id!, "inactive").ok === true && E.get(orgA, e1.id!).status === "inactive");
  check("update em id inexistente falha", E.update(orgA, "nao-existe", { unit: "X" }).ok === false);

  // ===== 5. Isolamento por organização =====
  const orgB = mkOrg();
  check("isolamento: org B não vê colaboradores de A", E.list(orgB).length === 0 && E.get(orgB, e1.id!) === null);
  check("isolamento: funções não vazam", E.listRoles(orgB).length === 0);

  console.log("\n=== TEST: People / RH cadastro funcional (Epic 7 — fatia 1) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ People registry OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
