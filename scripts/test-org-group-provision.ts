/**
 * TEST — ADR-199 F1: provisionamento "Adicionar operação ao grupo". DB-backed, isolado.
 *
 * Prova o critério de aceite: onboarda 2 orgs (Toulon + Democrata) no grupo do mesmo
 * dono, cada uma com o MESMO conjunto de features do plano (paridade); dados NÃO cruzam
 * entre orgs; provisionar é idempotente; o dono acessa as duas e alterna (switch-org).
 *
 * Depende do schema relaxado (F0c-1) pra criar a 2ª linha de users com o mesmo email —
 * por isso roda o rebuild no setup (como a flag faria em produção).
 *
 * Uso: npm run test:org-group-provision
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-provision-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-provision-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const MIG = await import("../src/server/migrations/usersEmailConstraint.js");
  const { AccountIdentityService: IDS } = await import("../src/server/AccountIdentityService.js");
  const { OrgGroupProvisioningService: PROV } = await import("../src/server/OrgGroupProvisioningService.js");

  // Relaxa a constraint (F0c-1) — pré-requisito do mesmo email em 2 orgs.
  MIG.migrateUsersEmailConstraint(db);
  check("0.1 schema relaxado (UNIQUE org,email)", MIG.emailConstraintScope(db) === "org");

  // Org A (Toulon) com plano + módulos + a identidade do dono.
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, vertical, enabled_modules) VALUES (?, ?, 'Toulon', 'active', 'pro', 'varejo', ?)`)
    .run(randomUUID(), A, JSON.stringify(["catalogo", "vendas", "loja"]));
  const idn = db.prepare(`INSERT INTO account_identities (id, email, password_hash, status) VALUES (?, ?, 'H', 'active')`);
  const identityId = randomUUID();
  idn.run(identityId, "dono@grupo.com");
  const ownerA = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email, password_hash, role, global_status, identity_id) VALUES (?, ?, 'Dono', 'dono@grupo.com', 'H', 'owner', 'active', ?)`).run(ownerA, A, identityId);

  // Dado de negócio em A (pra provar que NÃO cruza).
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'wa', 'Cliente A', '5511999')`).run(randomUUID(), A);

  // 1. Provisiona Democrata copiando o plano de A (paridade default).
  const r = PROV.provision({ ownerIdentityId: identityId, businessName: "Democrata", copyPlanFromOrgId: A, actorUserId: ownerA });
  check("1.1 criou a nova operação", r.created === true && !!r.organizationId && r.organizationId !== A);
  check("1.2 vinculou ao grupo do dono", !!r.groupId);
  const B = r.organizationId;

  // 2. Paridade de plano: mesmo plan_id + mesmos módulos.
  const sB = db.prepare("SELECT plan_id, enabled_modules, business_name FROM organization_settings WHERE organization_id = ?").get(B) as any;
  check("2.1 mesmo plan_id (paridade)", sB.plan_id === "pro");
  check("2.2 mesmos módulos (paridade)", JSON.stringify(JSON.parse(sB.enabled_modules)) === JSON.stringify(["catalogo", "vendas", "loja"]));
  check("2.3 nome da operação correto", sB.business_name === "Democrata");

  // 3. O dono tem linha de users em B ligada à MESMA identidade e acessa as 2 orgs.
  const uB = IDS.userRowForOrg(identityId, B);
  check("3.1 dono tem linha em B ligada à identidade", !!uB && uB.identity_id === identityId && uB.email === "dono@grupo.com");
  const orgs = IDS.orgsForIdentity(identityId).sort();
  check("3.2 identidade acessa as 2 operações", orgs.length === 2 && orgs.includes(A) && orgs.includes(B));
  const target = IDS.resolveSwitch(ownerA, B); // dono em A troca pra B
  check("3.3 switch-org para a nova operação funciona", target.organization_id === B);

  // 4. ISOLAMENTO: o dado de A não aparece em B (cada org é tenant completo).
  const contactsB = db.prepare("SELECT COUNT(*) c FROM contacts WHERE organization_id = ?").get(B) as any;
  check("4.1 contatos de A NÃO cruzam pra B", contactsB.c === 0);
  const usersB = db.prepare("SELECT COUNT(*) c FROM users WHERE organization_id = ?").get(B) as any;
  check("4.2 B só tem o dono (dados de A não vazam)", usersB.c === 1);

  // 5. Idempotência: reprovisionar Democrata NÃO duplica.
  const r2 = PROV.provision({ ownerIdentityId: identityId, businessName: "Democrata", copyPlanFromOrgId: A });
  check("5.1 reexecução devolve a MESMA org (created=false)", r2.created === false && r2.organizationId === B);
  const orgCount = db.prepare("SELECT COUNT(*) c FROM organization_settings WHERE business_name = 'Democrata'").get() as any;
  check("5.2 não duplicou a operação", orgCount.c === 1);

  // 6. Não inventa: identidade inexistente é recusada.
  let threw = false; try { PROV.provision({ ownerIdentityId: "nao-existe", businessName: "X" }); } catch { threw = true; }
  check("6.1 recusa identidade inexistente", threw);

  // Resultado.
  console.log("\n=== ADR-199 F1 — provisionamento (Adicionar operação ao grupo) ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S)`); process.exit(1); }
  console.log("\n✅ TODOS OS CHECKS PASSARAM");
}

main().catch((e) => { console.error(e); process.exit(1); });
