/**
 * TEST (integração/validação) — "experiência do gerente" ponta-a-ponta após os
 * PRs #1638 (catálogo RBAC add-on), #1639 (grupo/remanejamento + menu) e #1640
 * (normalização role manager→admin). Compõe os SERVIÇOS REAIS e prova, para um
 * gerente de loja num grupo, os 4 requisitos do cliente:
 *
 *   R1. Enxerga os módulos add-on/verticais (Operação da Rede, Atendimento de Loja…).
 *   R2. Menu "Grupo" OCULTO (não é dono de grupo).
 *   R3. Só a PRÓPRIA loja (isolamento; não troca pras outras).
 *   R4. Papel normalizado para "admin" (funciona nas rotas requireRole).
 *
 * Uso: npm run test:manager-experience
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mgrexp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mgrexp-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { AccountIdentityService: IDS } = await import("../src/server/AccountIdentityService.js");
  const { OrgGroupService: GRP } = await import("../src/server/OrgGroupService.js");
  const { PermissionService: PERM } = await import("../src/server/PermissionService.js");
  const { normalizeManagerRole } = await import("../src/server/migrations/normalizeManagerRole.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const [org, name] of [[A, "Toulon Nova Iguaçu"], [B, "Toulon Carioca"]] as [string, string][])
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);

  const mkUser = (org: string, email: string, role: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status, security_version) VALUES (?, ?, ?, ?, ?, 'active', 1)`)
      .run(id, org, `U ${id.slice(0, 4)}`, email, role);
    return id;
  };
  // Dono: linha em A e B (mesma identidade). Gerente: só na loja A, role LEGADO "manager".
  mkUser(A, "dono@toulon.com", "owner");
  mkUser(B, "dono2@toulon.com", "owner");
  const uMgr = mkUser(A, "gerente.ni@toulon.com", "manager");
  IDS.backfill();
  const ownerIdentity = IDS.getByEmail("dono@toulon.com")!.id;
  const mgrIdentity = IDS.getByEmail("gerente.ni@toulon.com")!.id;
  db.prepare("UPDATE users SET identity_id = ? WHERE role = 'owner'").run(ownerIdentity);

  // Grupo do DONO com A e B (o gerente não é dono de grupo).
  const g = GRP.createGroup({ name: "Grupo Toulon", ownerIdentityId: ownerIdentity });
  GRP.addMember(g.id, A); GRP.addMember(g.id, B);

  // Perfil "Gerente" atribuído ao gerente na loja A (o que o dono configura na UI).
  PERM.seedSystemProfiles(A);
  const gerenteProfile = (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'gerente'").get(A) as any).id;
  db.prepare("UPDATE users SET role_profile_id = ? WHERE id = ?").run(gerenteProfile, uMgr);

  // ── R4: normalização de papel (PR #1640) ──
  const r = normalizeManagerRole();
  check("R4.1 migração converte o gerente 'manager'→'admin'", r.converted === 1);
  const mgrRow = db.prepare("SELECT role, security_version, role_profile_id FROM users WHERE id = ?").get(uMgr) as any;
  check("R4.2 papel do gerente agora é 'admin' (passa em requireRole)", mgrRow.role === "admin");
  check("R4.3 security_version incrementado (relogin com papel certo)", mgrRow.security_version === 2);
  check("R4.4 perfil 'Gerente' preservado na normalização", mgrRow.role_profile_id === gerenteProfile);

  const mgrUser = { userId: uMgr, organizationId: A, role: mgrRow.role };

  // ── R1: enxerga os módulos add-on/verticais (PR #1638) ──
  for (const m of ["retail", "retail_floor", "clinica", "escola", "advocacia"])
    check(`R1 gerente enxerga '${m}' (perfil Gerente = full)`, PERM.can(A, mgrUser, m, "read") === true);
  check("R1.b gerente NÃO edita cobrança (perfil Gerente = read)", PERM.can(A, mgrUser, "cobranca", "read") === true && PERM.can(A, mgrUser, "cobranca", "write") === false);

  // ── R2: menu "Grupo" OCULTO (não é dono de grupo) ──
  check("R2.1 gerente não é dono de grupo (menu 'Grupo' some)", GRP.groupsForOwner(mgrIdentity).length === 0);
  check("R2.2 o DONO é dono do grupo (menu 'Grupo' aparece p/ ele)", GRP.groupsForOwner(ownerIdentity).some((x) => x.id === g.id));

  // ── R3: só a própria loja (isolamento) ──
  const mgrMemberships = IDS.memberships(mgrIdentity);
  check("R3.1 gerente tem membership só na própria loja (A)", mgrMemberships.length === 1 && mgrMemberships[0].organizationId === A);
  let switchThrew = false;
  try { IDS.resolveSwitch(uMgr, B); } catch { switchThrew = true; }
  check("R3.2 gerente NÃO consegue trocar pra outra loja (B) — 403", switchThrew);
  check("R3.3 o DONO alcança as duas lojas (switch permitido)", IDS.memberships(ownerIdentity).length === 2);

  console.log("\n=== validação: experiência do gerente (PRs #1638–#1640) ===");
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} manager-experience: ${results.length - failures}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
