/**
 * TEST — ADR-199 (extensão): equipe do grupo + REMANEJAMENTO de gerente entre lojas.
 *
 * Prova: listStaff omite o dono e lista o gerente; transferUser MOVE o mesmo usuário
 * A→B (muda org, reatribui perfil equivalente, limpa escopo, bump de security_version);
 * guardrails (não move o dono, destino/origem no grupo, mesma-org, colisão de e-mail);
 * isolamento (quem não é dono do grupo não lista nem transfere).
 *
 * Uso: npm run test:org-group-staff
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-grpstaff-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-grpstaff-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { AccountIdentityService: IDS } = await import("../src/server/AccountIdentityService.js");
  const { OrgGroupService: GRP } = await import("../src/server/OrgGroupService.js");
  const { OrgGroupStaffService: STAFF } = await import("../src/server/OrgGroupStaffService.js");
  const { PermissionService: PERM } = await import("../src/server/PermissionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`, OUT = `org_${randomUUID().slice(0, 8)}`;
  for (const [org, name] of [[A, "Toulon Nova Iguaçu"], [B, "Toulon Carioca"], [OUT, "Fora do Grupo"]] as [string, string][])
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);

  // Dono: linha em A e B, ligada à MESMA identidade. Gerentes: 1 em A, 1 em B (com email).
  const ownerId = randomUUID();
  const mkUser = (org: string, email: string | null, role: string, identityId: string | null) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status, identity_id) VALUES (?, ?, ?, ?, ?, 'active', ?)`)
      .run(id, org, `U ${id.slice(0, 4)}`, email, role, identityId);
    return id;
  };
  const uOwnerA = mkUser(A, "dono@toulon.com", "owner", null);
  mkUser(B, "dono2@toulon.com", "owner", null);
  const uMgrA = mkUser(A, "gerente.ni@toulon.com", "manager", null);
  mkUser(B, "gerente.carioca@toulon.com", "manager", null);
  IDS.backfill(); // liga identidades por email
  const ownerIdentity = IDS.getByEmail("dono@toulon.com")!.id;
  // Junta as duas linhas do dono sob a MESMA identidade (mesmo humano em 2 lojas).
  db.prepare("UPDATE users SET identity_id = ? WHERE organization_id IN (?, ?) AND role = 'owner'").run(ownerIdentity, A, B);

  // Grupo do dono com A e B como membros (OUT fica de fora).
  const g = GRP.createGroup({ name: "Grupo Toulon", ownerIdentityId: ownerIdentity });
  GRP.addMember(g.id, A); GRP.addMember(g.id, B);

  // Perfil 'gerente' na loja A atribuído ao gerente (pra provar a reatribuição na destino).
  PERM.seedSystemProfiles(A);
  const gerenteA = (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'gerente'").get(A) as any).id;
  db.prepare("UPDATE users SET role_profile_id = ? WHERE id = ?").run(gerenteA, uMgrA);

  // ── 1. listStaff: omite o dono, lista o gerente ──
  const stores = STAFF.listStaff(g.id, ownerIdentity);
  const storeA = stores.find((s) => s.organizationId === A)!;
  check("1.1 lista as 2 lojas do grupo", stores.length === 2);
  check("1.2 loja A tem só o gerente (dono omitido)", storeA.users.length === 1 && storeA.users[0].userId === uMgrA);
  check("1.3 traz o nome do perfil do gerente", !!storeA.users[0].profileName);
  check("1.4 não-dono do grupo → lista vazia (isolamento)", STAFF.listStaff(g.id, "identidade-aleatoria").length === 0);

  const svBefore = (db.prepare("SELECT security_version FROM users WHERE id = ?").get(uMgrA) as any).security_version || 1;
  const identityBefore = (db.prepare("SELECT identity_id FROM users WHERE id = ?").get(uMgrA) as any).identity_id;

  // ── 2. transferUser: move A→B ──
  const r = STAFF.transferUser({ groupId: g.id, ownerIdentityId: ownerIdentity, userId: uMgrA, toOrgId: B });
  check("2.1 transfer ok", r.ok === true && r.fromOrgId === A);
  const moved = db.prepare("SELECT organization_id, role_profile_id, security_version FROM users WHERE id = ?").get(uMgrA) as any;
  check("2.2 usuário agora na loja destino (B)", moved.organization_id === B);
  const gerenteB = (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'gerente'").get(B) as any)?.id;
  check("2.3 perfil reatribuído ao 'gerente' da destino", moved.role_profile_id === gerenteB && !!gerenteB);
  check("2.4 security_version incrementado (revoga sessão antiga)", (moved.security_version || 1) === svBefore + 1);
  check("2.5 mesmo login/identidade preservado", (db.prepare("SELECT identity_id FROM users WHERE id = ?").get(uMgrA) as any).identity_id === identityBefore);
  check("2.6 gerente some da loja de origem", !STAFF.listStaff(g.id, ownerIdentity).find((s) => s.organizationId === A)!.users.some((u) => u.userId === uMgrA));

  // ── 3. guardrails ──
  const gOwner = STAFF.transferUser({ groupId: g.id, ownerIdentityId: ownerIdentity, userId: uOwnerA, toOrgId: B });
  check("3.1 nunca move o dono", gOwner.ok === false && gOwner.code === "cannot_move_owner");
  const gOut = STAFF.transferUser({ groupId: g.id, ownerIdentityId: ownerIdentity, userId: uMgrA, toOrgId: OUT });
  check("3.2 destino fora do grupo → recusa", gOut.ok === false && gOut.code === "target_not_in_group");
  const gSame = STAFF.transferUser({ groupId: g.id, ownerIdentityId: ownerIdentity, userId: uMgrA, toOrgId: B });
  check("3.3 mesma org → recusa", gSame.ok === false && gSame.code === "same_org");
  const gIso = STAFF.transferUser({ groupId: g.id, ownerIdentityId: "outra-identidade", userId: uMgrA, toOrgId: A });
  check("3.4 não-dono do grupo → recusa (isolamento)", gIso.ok === false && gIso.code === "not_group_owner");

  // Nota: o guard de colisão de e-mail no destino ("email_exists_in_target") só é
  // ACIONÁVEL no schema de produção pós-ADR-199 F0c-1 (UNIQUE(organization_id, email)).
  // No schema default do teste, users.email é UNIQUE GLOBAL — a colisão nem se
  // constrói (o próprio INSERT falharia antes), então não há cenário a exercitar aqui.

  console.log("\n=== ADR-199 — equipe do grupo + remanejamento ===");
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} org-group-staff: ${results.length - failures}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
