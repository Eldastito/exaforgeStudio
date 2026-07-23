/**
 * TEST — People check-ins / reconhecimento documentado (Epic 7 — fatia 4).
 * Registro humano; sem pontuar qualidade humana. Determinístico.
 *
 * Uso: npm run test:people-checkins
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-chk-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-chk-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { EmployeeService: E } = await import("../src/server/EmployeeService.js");
  const { PeopleCheckinService: C } = await import("../src/server/PeopleCheckinService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();
  const emp = E.create(orgA, { name: "Maria" }).id!;

  // ===== 1. Criar exige resumo e colaborador válido =====
  check("sem resumo é rejeitado", C.create(orgA, { employeeId: emp, summary: "  " }).ok === false);
  check("colaborador inexistente é rejeitado", C.create(orgA, { employeeId: "nao-existe", summary: "ok" }).ok === false);

  // ===== 2. Tipos: checkin / recognition / feedback =====
  const c1 = C.create(orgA, { employeeId: emp, kind: "checkin", period: "2026-07", summary: "1:1 de julho", nextSteps: "Fechar trilha de vendas", authorUserId: "mgr" });
  check("cria check-in", c1.ok === true && !!c1.id);
  C.create(orgA, { employeeId: emp, kind: "recognition", summary: "Excelente atendimento na semana", authorUserId: "mgr" });
  C.create(orgA, { employeeId: emp, kind: "feedback", summary: "Melhorar pontualidade nos registros", authorUserId: "mgr" });
  check("tipo inválido cai para 'checkin'", (() => { const r = C.create(orgA, { employeeId: emp, kind: "nota", summary: "x" }); return C.get(orgA, r.id!).kind === "checkin"; })());

  // ===== 3. Lista + filtro por tipo =====
  check("lista todos (4)", C.list(orgA, emp).length === 4);
  check("filtra por tipo (recognition = 1)", C.list(orgA, emp, { kind: "recognition" }).length === 1);
  check("mais recente primeiro", C.list(orgA, emp)[0].created_at >= C.list(orgA, emp)[3].created_at);

  // ===== 4. Resumo por colaborador =====
  const s = C.summaryFor(orgA, emp);
  check("resumo conta por tipo", s.total === 4 && s.checkins === 2 && s.recognitions === 1 && s.feedbacks === 1);
  check("resumo traz o último check-in e reconhecimento", !!s.lastCheckin && !!s.lastRecognition && s.lastRecognition.kind === "recognition");

  // ===== 5. Get + conteúdo preservado =====
  const got = C.get(orgA, c1.id!);
  check("get preserva campos (period/next_steps/author)", got.period === "2026-07" && got.next_steps === "Fechar trilha de vendas" && got.author_user_id === "mgr");

  // ===== 6. Isolamento =====
  const orgB = mkOrg();
  check("isolamento: org B não vê check-ins de A", C.list(orgB, emp).length === 0 && C.get(orgB, c1.id!) === null);
  check("isolamento: criar em colaborador de A a partir de B falha", C.create(orgB, { employeeId: emp, summary: "x" }).ok === false);

  console.log("\n=== TEST: People check-ins (Epic 7 — fatia 4) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ People check-ins OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
