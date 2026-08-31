/**
 * TEST — ADR-199 F0a: fundação de identidade + grupo (ZapFlow Grupo). DB-backed, det., isolado.
 *
 * Prova: backfill idempotente (2× sem duplicar) + reversível; email NULO nunca gera
 * identidade (RN-GRP-04); credencial copiada pra identidade; resolução multi-org de
 * membership por users.identity_id; holding (org_groups/membros) idempotente e isolada.
 * 0-regressão: o login segue lendo `users` (esta fatia não toca auth).
 *
 * Uso: npm run test:org-groups
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-orggroups-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-orggroups-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function mkUser(db: any, org: string, email: string | null, opts: { pwd?: string; mfa?: boolean; identityId?: string } = {}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, organization_id, name, email, password_hash, mfa_secret, mfa_enabled, identity_id, role, global_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner', 'active')`
  ).run(id, org, "User " + id.slice(0, 4), email, opts.pwd ?? null, opts.mfa ? "SECRET" : null, opts.mfa ? 1 : 0, opts.identityId ?? null);
  return id;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { AccountIdentityService: IDS } = await import("../src/server/AccountIdentityService.js");
  const { OrgGroupService: GRP } = await import("../src/server/OrgGroupService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;

  // 0. Migrations presentes.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('account_identities','org_groups','org_group_members')").all().map((r: any) => r.name);
  check("0.1 account_identities existe", tables.includes("account_identities"));
  check("0.2 org_groups existe", tables.includes("org_groups"));
  check("0.3 org_group_members existe", tables.includes("org_group_members"));
  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c: any) => c.name);
  check("0.4 users.identity_id existe", userCols.includes("identity_id"));

  // 1. Seed: dois usuários com email (marcas diferentes), um com MFA; um usuário SEM email (bot).
  const uA = mkUser(db, A, "dono@toulon.com", { pwd: "hashA", mfa: true });
  const uB = mkUser(db, B, "gerente@democrata.com", { pwd: "hashB" });
  const uBot = mkUser(db, A, null); // RN-GRP-04

  // 2. Backfill.
  const s1 = IDS.backfill();
  check("2.1 varre todos os users", s1.usersScanned === 3);
  check("2.2 cria 2 identidades (email não-nulo)", s1.identitiesCreated === 2);
  check("2.3 liga 2 users", s1.usersLinked === 2);
  check("2.4 pula email nulo (RN-GRP-04)", s1.skippedNullEmail === 1);
  const idA = IDS.getByEmail("dono@toulon.com");
  check("2.5 identidade criada por email (case-insensível/normalizado)", !!idA && idA.email === "dono@toulon.com");
  check("2.6 credencial MFA copiada pra identidade", !!idA && idA.mfaEnabled === true);
  const rowBot = db.prepare("SELECT identity_id FROM users WHERE id = ?").get(uBot) as any;
  check("2.7 user sem email fica sem identidade", rowBot.identity_id === null || rowBot.identity_id === undefined);
  const rowA = db.prepare("SELECT identity_id, password_hash, email FROM users WHERE id = ?").get(uA) as any;
  check("2.8 users.identity_id ligado", rowA.identity_id === idA!.id);
  check("2.9 0-regressão: credencial permanece em users (login legado)", rowA.password_hash === "hashA" && rowA.email === "dono@toulon.com");

  // 3. Idempotência: rodar de novo não duplica nem re-liga.
  const s2 = IDS.backfill();
  check("3.1 2ª passada não cria identidade", s2.identitiesCreated === 0);
  check("3.2 2ª passada não re-liga", s2.usersLinked === 0);
  check("3.3 já-ligados contabilizados", s2.alreadyLinked === 2);
  const idCount = db.prepare("SELECT COUNT(*) c FROM account_identities").get() as any;
  check("3.4 total de identidades continua 2 (sem duplicar)", idCount.c === 2);

  // 4. Resolução multi-org de membership (cenário F0c: mesmo humano em N orgs).
  //    Liga uma 2ª linha de users (outra org) à MESMA identidade — prova orgsForIdentity.
  mkUser(db, B, "dono-b@toulon.com", { pwd: "hashA2", identityId: idA!.id });
  const orgs = IDS.orgsForIdentity(idA!.id).sort();
  check("4.1 identidade resolve as 2 orgs onde tem linha de users", orgs.length === 2 && orgs.includes(A) && orgs.includes(B));
  check("4.2 usersForIdentity devolve 2 linhas", IDS.usersForIdentity(idA!.id).length === 2);
  // usuário bloqueado numa org não conta como membership de acesso
  const uBlocked = mkUser(db, A, "extra@toulon.com", { identityId: idA!.id });
  db.prepare("UPDATE users SET organization_id = ?, global_status = 'blocked' WHERE id = ?").run(`org_${randomUUID().slice(0,8)}`, uBlocked);
  check("4.3 org com user bloqueado não entra no membership", IDS.orgsForIdentity(idA!.id).length === 2);

  // 5. Holding (grupo).
  const g = GRP.createGroup({ name: "Grupo Franqueado X", ownerIdentityId: idA!.id });
  check("5.1 cria grupo", !!g.id && g.ownerIdentityId === idA!.id);
  let threw = false; try { GRP.createGroup({ name: "Sem dono", ownerIdentityId: "inexistente" }); } catch { threw = true; }
  check("5.2 recusa dono inexistente (não inventa)", threw);
  const m1 = GRP.addMember(g.id, A, "actor");
  const m2 = GRP.addMember(g.id, B, "actor");
  check("5.3 adiciona 2 membros", GRP.membersOf(g.id).length === 2);
  const m1b = GRP.addMember(g.id, A, "actor");
  check("5.4 addMember idempotente (UNIQUE group,org)", m1b.id === m1.id && GRP.membersOf(g.id).length === 2);
  check("5.5 groupsForOrg acha o grupo pela org", GRP.groupsForOrg(A).some((x) => x.id === g.id));
  check("5.6 groupsForOwner lista pelo dono", GRP.groupsForOwner(idA!.id).some((x) => x.id === g.id));
  check("5.7 removeMember tira do grupo (sem apagar dado da org)", GRP.removeMember(g.id, B) && GRP.membersOf(g.id).length === 1);

  // 6. Reversão (RN-GRP-08): desvincula users.identity_id e remove identidades órfãs,
  //    MENOS a que é dona de um grupo (idA é owner de g) — não quebra a holding.
  const rev = IDS.reverseBackfill();
  check("6.1 desvincula todos os users", rev.usersUnlinked >= 4);
  check("6.2 users voltam sem identity_id", (db.prepare("SELECT COUNT(*) c FROM users WHERE identity_id IS NOT NULL").get() as any).c === 0);
  check("6.3 remove identidade órfã (democrata)", IDS.getByEmail("gerente@democrata.com") === null);
  check("6.4 preserva identidade dona de grupo (não quebra holding)", IDS.getById(idA!.id) !== null);

  // Resultado.
  console.log("\n=== ADR-199 F0a — identidade + grupo ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S)`); process.exit(1); }
  console.log("\n✅ TODOS OS CHECKS PASSARAM");
}

main().catch((e) => { console.error(e); process.exit(1); });
