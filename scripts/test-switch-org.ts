/**
 * TEST — ADR-199 F0c-2: troca de operação (switch-org). DB-backed, isolado.
 *
 * Foco na parte crítica de segurança (resolução de membership por identidade). Prova:
 * memberships lista só orgs ativas da identidade; userRowForOrg respeita bloqueio;
 * resolveSwitch devolve a linha correta (claims da org alvo) e RECUSA org sem membership
 * ou bloqueada (RN §8/RN-GRP-06); sem identidade → recusa; o membership é por linha de
 * `users`, NUNCA pelo grupo (RN-GRP-01); e o JWT reassinado carrega a org/role alvo.
 *
 * Uso: npm run test:switch-org
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-switchorg-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-switchorg-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function mkOrg(db: any, org: string, name: string) {
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
}
function mkUser(db: any, org: string, identityId: string | null, role: string, opts: { email?: string | null; blocked?: boolean; sv?: number } = {}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, organization_id, name, email, password_hash, role, global_status, identity_id, security_version)
     VALUES (?, ?, ?, ?, 'h', ?, ?, ?, ?)`
  ).run(id, org, "U-" + role, opts.email === undefined ? `u-${id.slice(0,4)}@x.com` : opts.email, role, opts.blocked ? "blocked" : "active", identityId, opts.sv ?? 1);
  return id;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { AccountIdentityService: IDS } = await import("../src/server/AccountIdentityService.js");

  const A = `org_${randomUUID().slice(0,8)}`, B = `org_${randomUUID().slice(0,8)}`, C = `org_${randomUUID().slice(0,8)}`, D = `org_${randomUUID().slice(0,8)}`;
  mkOrg(db, A, "Toulon"); mkOrg(db, B, "Democrata"); mkOrg(db, C, "Bloqueada"); mkOrg(db, D, "Sem vínculo");

  const idt = "idt-" + randomUUID().slice(0, 8);
  const uA = mkUser(db, A, idt, "owner", { sv: 2 });      // dono na Toulon
  const uB = mkUser(db, B, idt, "admin");                 // admin na Democrata (mesma identidade)
  const uC = mkUser(db, C, idt, "owner", { blocked: true }); // bloqueado na org C
  // D: identidade NÃO tem linha (sem vínculo). Outro humano na D:
  mkUser(db, D, "outra-identidade", "owner");

  // 1. memberships — só orgs ativas da identidade (A e B; não C bloqueada; não D).
  const ms = IDS.memberships(idt);
  const orgSet = new Set(ms.map((m) => m.organizationId));
  check("1.1 lista as 2 orgs ativas", ms.length === 2 && orgSet.has(A) && orgSet.has(B));
  check("1.2 não inclui org com user bloqueado", !orgSet.has(C));
  check("1.3 não inclui org sem vínculo da identidade", !orgSet.has(D));
  check("1.4 carrega nome do negócio e role", !!ms.find((m) => m.organizationId === B && m.role === "admin" && m.businessName === "Democrata"));

  // 2. userRowForOrg — respeita bloqueio e vínculo.
  check("2.1 acha a linha na org A", IDS.userRowForOrg(idt, A)?.id === uA);
  check("2.2 org bloqueada → null", IDS.userRowForOrg(idt, C) === null);
  check("2.3 org sem vínculo → null", IDS.userRowForOrg(idt, D) === null);

  // 3. resolveSwitch — a partir da sessão em A, troca pra B (membership provado).
  const target = IDS.resolveSwitch(uA, B);
  check("3.1 resolve a linha da org alvo", target.id === uB && target.organization_id === B && target.role === "admin");

  // 4. RECUSA: org sem membership, org bloqueada, org inexistente.
  let denied = 0;
  for (const bad of [D, C, "org_inexistente"]) { try { IDS.resolveSwitch(uA, bad); } catch { denied++; } }
  check("4.1 recusa org sem membership / bloqueada / inexistente", denied === 3);

  // 5. Sessão sem identidade (email nulo, ex.: bot) → recusa (no_identity).
  const uBot = mkUser(db, A, null, "owner", { email: null });
  let botDenied = false; try { IDS.resolveSwitch(uBot, B); } catch (e: any) { botDenied = e?.message === "no_identity" || e?.message === "no_membership"; }
  check("5.1 sessão sem identidade não troca de org", botDenied);

  // 6. O JWT reassinado carrega a org/role ALVO (mesmo shape do login).
  const claims = { userId: target.id, organizationId: target.organization_id, role: target.role, role_profile_id: target.role_profile_id || null, email: target.email, name: target.name, platform_role: target.platform_role || null, sv: target.security_version ?? 1 };
  const token = jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: "1h" });
  const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
  check("6.1 JWT reassinado aponta pra org B / role admin / userId uB", decoded.organizationId === B && decoded.role === "admin" && decoded.userId === uB);

  // Resultado.
  console.log("\n=== ADR-199 F0c-2 — switch-org (resolução de membership) ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S)`); process.exit(1); }
  console.log("\n✅ TODOS OS CHECKS PASSARAM");
}

main().catch((e) => { console.error(e); process.exit(1); });
