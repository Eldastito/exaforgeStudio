/**
 * TEST — People development / competências + trilhas (Epic 7 — fatia 2).
 * Skills, employee_skills, trilhas aplicáveis à função, lacuna de competência.
 * Determinístico, sem chave de IA.
 *
 * Uso: npm run test:people-development
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dev-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-dev-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { EmployeeService: E } = await import("../src/server/EmployeeService.js");
  const { PeopleDevelopmentService: D } = await import("../src/server/PeopleDevelopmentService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();
  const roleVend = E.createRole(orgA, "Vendedor").id!;
  const roleCaixa = E.createRole(orgA, "Caixa").id!;
  const emp = E.create(orgA, { name: "Maria", roleId: roleVend }).id!;

  // ===== 1. Competências (catálogo idempotente) =====
  const sVenda = D.createSkill(orgA, "Técnicas de venda", "comercial").id!;
  const sNego = D.createSkill(orgA, "Negociação").id!;
  const sCaixa = D.createSkill(orgA, "Operação de caixa").id!;
  check("skill idempotente por nome", D.createSkill(orgA, "Negociação").id === sNego);
  check("listSkills lista as 3", D.listSkills(orgA).length === 3);
  check("skill sem nome rejeitada", D.createSkill(orgA, " ").ok === false);

  // ===== 2. Competências do colaborador (upsert por nível) =====
  check("nível inválido rejeitado", D.setEmployeeSkill(orgA, emp, sVenda, "mestre").ok === false);
  D.setEmployeeSkill(orgA, emp, sVenda, "advanced");
  D.setEmployeeSkill(orgA, emp, sVenda, "intermediate"); // upsert
  const es = D.listEmployeeSkills(orgA, emp);
  check("employee_skill upsert (1 linha, nível atualizado)", es.length === 1 && es[0].level === "intermediate" && es[0].skill_name === "Técnicas de venda");
  check("setEmployeeSkill de skill inexistente falha", D.setEmployeeSkill(orgA, emp, "nao-existe", "basic").ok === false);

  // ===== 3. Trilhas: aplicável à função =====
  const pVend = D.createPath(orgA, { name: "Excelência em Vendas", roleId: roleVend, requiredSkillIds: [sVenda, sNego] }).id!;
  D.createPath(orgA, { name: "Rotina de Caixa", roleId: roleCaixa, requiredSkillIds: [sCaixa] });
  const pGeral = D.createPath(orgA, { name: "Atendimento ao Cliente", requiredSkillIds: [sNego] }).id!; // geral (role null)
  const applicable = D.applicablePaths(orgA, emp).map((p: any) => p.id);
  check("aplicáveis à função = trilha da função + gerais (não a de Caixa)", applicable.includes(pVend) && applicable.includes(pGeral) && applicable.length === 2);

  // ===== 4. Lacuna de competência =====
  // Maria tem 'Técnicas de venda' (intermediate) mas NÃO 'Negociação' → lacuna.
  const plan = D.developmentPlan(orgA, emp);
  check("lacuna aponta 'Negociação' (faltante)", plan.gaps.length === 1 && plan.gaps[0].skillId === sNego && plan.gaps[0].currentLevel === "none");
  check("'Técnicas de venda' NÃO é lacuna (já tem)", !plan.gaps.some((g: any) => g.skillId === sVenda));
  check("trilhas recomendadas cobrem a lacuna", plan.recommendedPaths.some((p: any) => p.id === pVend && p.covers.includes(sNego)) && plan.recommendedPaths.some((p: any) => p.id === pGeral));

  // Preenche a competência → lacuna some.
  D.setEmployeeSkill(orgA, emp, sNego, "basic");
  const plan2 = D.developmentPlan(orgA, emp);
  check("após aprender, lacuna zera", plan2.gaps.length === 0 && plan2.recommendedPaths.length === 0);

  // ===== 5. Atribuições (idempotente + status) =====
  const a1 = D.assign(orgA, emp, pVend);
  check("atribui trilha", a1.ok === true && !!a1.id);
  check("atribuir de novo = deduped (não duplica)", D.assign(orgA, emp, pVend).deduped === true);
  check("setAssignmentStatus completed grava completed_at", D.setAssignmentStatus(orgA, a1.id!, "completed").ok === true && !!D.listAssignments(orgA, emp)[0].completed_at);
  check("status inválido rejeitado", D.setAssignmentStatus(orgA, a1.id!, "abandonado").ok === false);
  check("assign trilha inexistente falha", D.assign(orgA, emp, "nao-existe").ok === false);

  // ===== 6. Isolamento =====
  const orgB = mkOrg();
  check("isolamento: skills não vazam", D.listSkills(orgB).length === 0);
  check("isolamento: development de colaborador de A é null em B", D.developmentPlan(orgB, emp) === null);
  check("isolamento: setEmployeeSkill cross-org falha", D.setEmployeeSkill(orgB, emp, sVenda, "basic").ok === false);

  console.log("\n=== TEST: People development / competências (Epic 7 — fatia 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ People development OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
