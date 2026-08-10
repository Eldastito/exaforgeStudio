/**
 * TEST — ADR-159 F4 (D3): RBAC default-deny FASEADO.
 *
 * Prova, determinístico:
 *   - flag OFF (default): fallback legado preservado (0 regressão) — admin sem
 *     perfil ainda tem acesso a módulo sensível;
 *   - flag ON: usuário SEM perfil é NEGADO em módulo sensível (fim do
 *     privilégio-por-omissão); o DONO nunca é negado; módulo NÃO-sensível segue
 *     no fallback legado; usuário COM perfil é resolvido pelo perfil (imune);
 *   - defaultDenyImpact lista quem perde acesso (dono e perfilados excluídos);
 *   - isolamento por org.
 *
 * Uso: npm run test:rbac-default-deny
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rbac-deny-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-rbac-deny-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();

  // Usuários legados SEM perfil (objeto do JWT, sem userId → sem lookup de perfil).
  const owner = { role: "owner" };
  const admin = { role: "admin" };
  const agent = { role: "agent" };

  // ===== 1. Flag OFF (default): fallback legado preservado =====
  check("OFF: admin sem perfil TEM execucao write (legado)", P.can(orgA, admin, "execucao", "write") === true);
  check("OFF: admin sem perfil TEM financeiro full (legado)", P.can(orgA, admin, "financeiro", "delete") === true);
  check("OFF: agent sem perfil NÃO tem execucao (legado atendente=none)", P.can(orgA, agent, "execucao", "write") === false);

  // ===== 2. Flag ON: sensível + sem perfil → NEGA =====
  P.setDefaultDeny(orgA, true);
  check("ON: admin sem perfil é NEGADO em execucao (sensível)", P.can(orgA, admin, "execucao", "write") === false);
  check("ON: admin sem perfil é NEGADO em financeiro (sensível)", P.can(orgA, admin, "financeiro", "read") === false);
  check("ON: admin sem perfil é NEGADO em pagamentos/compras/usuarios", !P.can(orgA, admin, "pagamentos", "read") && !P.can(orgA, admin, "compras", "read") && !P.can(orgA, admin, "usuarios", "read"));

  // ===== 3. DONO nunca é negado =====
  check("ON: owner sem perfil MANTÉM execucao/financeiro (nunca negado)", P.can(orgA, owner, "execucao", "delete") === true && P.can(orgA, owner, "financeiro", "delete") === true);

  // ===== 4. Módulo NÃO-sensível segue no fallback legado (mesmo com flag ON) =====
  check("ON: admin sem perfil MANTÉM atendimento (não-sensível, legado)", P.can(orgA, admin, "atendimento", "write") === true);

  // ===== 5. Usuário COM perfil é imune ao default-deny (resolve pelo perfil) =====
  P.seedSystemProfiles(orgA);
  const finProf = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'financeiro'`).get(orgA) as any).id;
  const vendProf = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'vendedor'`).get(orgA) as any).id;
  const finUser = { userId: "u-fin", role: "agent", role_profile_id: finProf };   // perfil financeiro = financeiro full
  const vendUser = { userId: "u-vend", role: "admin", role_profile_id: vendProf }; // perfil vendedor = financeiro none
  check("ON: perfil financeiro concede financeiro (imune ao default-deny)", P.can(orgA, finUser, "financeiro", "delete") === true);
  check("ON: perfil vendedor NÃO tem financeiro (decisão do perfil, não do deny)", P.can(orgA, vendUser, "financeiro", "read") === false);
  check("ON: perfil vendedor com claim 'admin' NÃO ganha execucao (perfil vence)", P.can(orgA, vendUser, "execucao", "write") === false);

  // ===== 6. Relatório de impacto =====
  const mkUser = (role: string, profileId: string | null) => db.prepare(`INSERT INTO users (id, organization_id, name, email, role, role_profile_id) VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), orgA, `U ${role}`, `${randomUUID().slice(0, 8)}@ex.com`, role, profileId);
  mkUser("owner", null);   // dono sem perfil — NÃO afetado
  mkUser("admin", null);   // afetado
  mkUser("agent", null);   // afetado
  mkUser("agent", finProf); // com perfil — NÃO afetado
  const impact = P.defaultDenyImpact(orgA);
  check("impacto: totalUsers=4, semPerfil=3, afetados=2 (admin+agent, dono e perfilado fora)", impact.totalUsers === 4 && impact.usersWithoutProfile === 3 && impact.affectedUsers === 2);
  check("impacto: lista os afetados (nenhum é owner)", impact.affected.length === 2 && impact.affected.every((u: any) => u.role !== "owner"));
  check("impacto: reporta módulos sensíveis + flag ligada", impact.sensitiveModules.includes("financeiro") && impact.sensitiveModules.includes("execucao") && impact.flagEnabled === true);

  // ===== 7. Isolamento por org =====
  const orgB = mkOrg(); // flag OFF
  check("isolamento: orgB (flag off) mantém fallback legado do admin", P.can(orgB, admin, "execucao", "write") === true);
  check("isolamento: defaultDenyEnabled é por org", P.defaultDenyEnabled(orgA) === true && P.defaultDenyEnabled(orgB) === false);

  console.log("\n=== TEST: RBAC default-deny faseado (ADR-159 F4/D3) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ RBAC default-deny faseado (F4) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
