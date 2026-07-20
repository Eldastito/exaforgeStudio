/**
 * TEST — Gestão de perfis RBAC (ADR-095 Bloco 2).
 *
 * Cobre o ciclo de vida dos perfis via PermissionService: listar (semeia os
 * templates), criar custom, editar (Dono imutável), duplicar, excluir (Dono e
 * perfil com usuários bloqueados), atribuir a usuário e refletir no can().
 *
 * Uso: npm run test:rbac-profiles-api
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rbac-api-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-rbac-api-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const orgId = `org_rbacapi_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
    .run(randomUUID(), orgId, "RBAC API Test");

  // ===== 1. listProfiles semeia os templates on-demand =====
  const list = PermissionService.listProfiles(orgId);
  check("listProfiles semeia e retorna 6 templates", list.length === 6);
  const owner = list.find((p: any) => p.systemKey === "owner");
  check("template Dono existe e é full em vendas", !!owner && owner.permissions.vendas === "full");
  check("template Dono marcado isSystem", !!owner && owner.isSystem === true);

  // ===== 2. createProfile custom (Caixa) =====
  const caixaId = PermissionService.createProfile(orgId, "Caixa", { vendas: "write", pagamentos: "write", catalogo: "read", relatorios: "none" });
  const caixa = PermissionService.getProfile(orgId, caixaId);
  check("Caixa criado com vendas=write", caixa.permissions.vendas === "write");
  check("Caixa pagamentos=write", caixa.permissions.pagamentos === "write");
  check("Caixa módulo não citado = none", caixa.permissions.compras === "none");
  check("Caixa não é de sistema", caixa.isSystem === false);

  // Sanitização: nível inválido e módulo inexistente são ignorados.
  const dirtyId = PermissionService.createProfile(orgId, "Sujo", { vendas: "SUPER", inexistente: "full", catalogo: "read" });
  const dirty = PermissionService.getProfile(orgId, dirtyId);
  check("nível inválido vira none", dirty.permissions.vendas === "none");
  check("módulo inexistente é descartado", dirty.permissions.inexistente === undefined);
  check("nível válido no mesmo payload persiste", dirty.permissions.catalogo === "read");

  // ===== 3. updateProfile — edita custom; Dono imutável =====
  const upd = PermissionService.updateProfile(orgId, caixaId, { name: "Caixa PDV", permissions: { vendas: "full", pagamentos: "write" } });
  check("update do Caixa ok", upd.ok === true);
  const caixa2 = PermissionService.getProfile(orgId, caixaId);
  check("Caixa agora vendas=full", caixa2.permissions.vendas === "full");
  check("Caixa renomeado", caixa2.name === "Caixa PDV");
  const updOwner = PermissionService.updateProfile(orgId, owner.id, { permissions: { vendas: "none" } });
  check("Dono é imutável (update rejeitado)", updOwner.ok === false && updOwner.error === "owner_immutable");
  check("Dono segue full após tentativa", PermissionService.getProfile(orgId, owner.id).permissions.vendas === "full");

  // ===== 4. duplicateProfile =====
  const cloneId = PermissionService.duplicateProfile(orgId, caixaId, "Caixa Noturno");
  const clone = PermissionService.getProfile(orgId, cloneId!);
  check("clone herda permissões", clone.permissions.vendas === "full" && clone.permissions.pagamentos === "write");
  check("clone é um novo id", cloneId !== caixaId);

  // ===== 5. assignToUser + reflexo no can() =====
  const uid = `u_${randomUUID().slice(0, 5)}`;
  db.prepare(`INSERT INTO users (id, organization_id, email, role) VALUES (?, ?, ?, 'agent')`).run(uid, orgId, `${uid}@t.com`);
  const asg = PermissionService.assignToUser(orgId, uid, caixaId);
  check("atribuição de perfil ok", asg.ok === true);
  const userObj = { userId: uid, organizationId: orgId, role: "agent" }; // role legado ignorado quando há perfil
  check("usuário com Caixa: exclui venda (full)", PermissionService.can(orgId, userObj, "vendas", "delete"));
  check("usuário com Caixa: sem acesso a compras", !PermissionService.can(orgId, userObj, "compras", "read"));
  const pm = PermissionService.permissionMap(orgId, userObj);
  check("permissionMap reflete o perfil", pm.vendas === "full" && pm.compras === "none");
  // hasProfile (opt-in do gating de UI — ADR-095 Bloco 4)
  check("hasProfile true p/ usuário com perfil", PermissionService.hasProfile(orgId, userObj) === true);
  const legacyObj = { userId: "u_legacy_none", organizationId: orgId, role: "agent" };
  check("hasProfile false p/ usuário sem perfil", PermissionService.hasProfile(orgId, legacyObj) === false);

  // ===== 6. deleteProfile — Dono e perfil-com-usuários bloqueados; custom livre =====
  const delOwner = PermissionService.deleteProfile(orgId, owner.id);
  check("excluir Dono é bloqueado", delOwner.ok === false && delOwner.error === "owner_immutable");
  const delAssigned = PermissionService.deleteProfile(orgId, caixaId);
  check("excluir perfil com usuários é bloqueado", delAssigned.ok === false && delAssigned.error === "has_users");
  const delClone = PermissionService.deleteProfile(orgId, cloneId!);
  check("excluir perfil custom sem usuários é permitido", delClone.ok === true);
  check("perfil excluído some da lista", !PermissionService.getProfile(orgId, cloneId!));

  // ===== 7. backfillSystemProfiles é idempotente (não duplica) =====
  PermissionService.backfillSystemProfiles();
  const systemCount = (db.prepare(`SELECT COUNT(*) c FROM role_profiles WHERE organization_id = ? AND is_system = 1`).get(orgId) as any).c;
  check("backfill não duplica templates (6 de sistema)", systemCount === 6);

  // --- Relatório ---
  console.log("\n=== TEST: Gestão de perfis RBAC (ADR-095 Bloco 2) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Gestão de perfis RBAC OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
