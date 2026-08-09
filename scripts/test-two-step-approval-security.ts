/**
 * TEST — ADR-159 F1 (D2, SEGURANÇA): hardening do two-step approval.
 *
 * Prova, determinístico e sem IA:
 *   (a) o bypass do two-step está fechado — aprovação SEM identidade é rejeitada
 *       e nunca "conta"; um mesmo usuário aprovando 2× é idempotente (UNIQUE
 *       parcial); só 2 aprovadores DISTINTOS e NÃO-NULOS fecham o two_step;
 *   (b) a autorização de aprovação usa RBAC GRANULAR (PermissionService), não o
 *       claim legado `users.role`: perfil atribuído VENCE o claim; owner/gerente
 *       aprovam, operador não; `approval_role='owner'` exige o dono.
 *
 * Uso: npm run test:two-step-approval-security
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-two-step-sec-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-two-step-security-123456";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
function throws(fn: () => any): boolean { try { fn(); return false; } catch { return true; } }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { DecisionActionService: D } = await import("../src/server/DecisionActionService.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const twoStep = (orgId: string) => D.propose(orgId, { domain: "procurement", actionType: "choose_supplier", title: "Escolher fornecedor", expectedImpact: 30000 });
  const approvedRows = (orgId: string, actionId: string) => Number((db.prepare("SELECT COUNT(*) n FROM action_approvals WHERE action_id = ? AND organization_id = ? AND decision = 'approved'").get(actionId, orgId) as any).n);

  const orgA = mkOrg();

  // ===== 1. two_step SEM identidade é rejeitado e NÃO conta (bypass fechado) =====
  const s1 = twoStep(orgA);
  check("two_step: aprovar sem identidade LANÇA erro", throws(() => D.approve(orgA, s1.id, undefined)));
  check("two_step: sem identidade não avança (segue awaiting)", D.get(orgA, s1.id).status === "awaiting_approval");
  check("two_step: nenhuma linha 'approved' gravada sem identidade", approvedRows(orgA, s1.id) === 0);
  // Duas tentativas nulas seguidas continuam sem aprovar (o antigo COALESCE
  // colapsaria os nulos e poderia satisfazer com 1 ator — agora impossível).
  throws(() => D.approve(orgA, s1.id, undefined));
  check("two_step: 2 tentativas nulas NÃO aprovam", D.get(orgA, s1.id).status === "awaiting_approval");

  // ===== 2. Mesmo usuário 2× é idempotente; 2 distintos fecham =====
  const s2 = twoStep(orgA);
  D.approve(orgA, s2.id, "user-1");
  check("two_step: 1ª aprovação (user-1) ainda aguarda", D.get(orgA, s2.id).status === "awaiting_approval");
  D.approve(orgA, s2.id, "user-1");   // re-voto do mesmo: idempotente (UNIQUE parcial)
  check("two_step: mesmo usuário 2× não fecha", D.get(orgA, s2.id).status === "awaiting_approval");
  check("two_step: UNIQUE parcial impede 2ª linha do mesmo user (1 approved)", approvedRows(orgA, s2.id) === 1);
  const done = D.approve(orgA, s2.id, "user-2");
  check("two_step: 2º aprovador DISTINTO fecha → approved", done.status === "approved");
  check("two_step: exatamente 2 linhas 'approved' (user-1 + user-2)", approvedRows(orgA, s2.id) === 2);

  // ===== 3. single/reject também exigem identidade =====
  const single = D.propose(orgA, { domain: "sales", actionType: "collection", title: "Cobrar" });
  check("single: aprovar sem identidade LANÇA erro", throws(() => D.approve(orgA, single.id, undefined)));
  check("single: com identidade aprova", D.approve(orgA, single.id, "user-9").status === "approved");
  const toReject = twoStep(orgA);
  check("reject: sem identidade LANÇA erro", throws(() => D.reject(orgA, toReject.id, undefined)));
  check("reject: com identidade rejeita", D.reject(orgA, toReject.id, "user-9").status === "rejected");

  // ===== 4. RBAC GRANULAR na autorização (bug b) — legado (sem perfil) =====
  const owner = { userId: "u-owner", role: "owner" };
  const admin = { userId: "u-admin", role: "admin" };
  const agent = { userId: "u-agent", role: "agent" };
  check("legado: owner tem execucao write", P.can(orgA, owner, "execucao", "write") === true);
  check("legado: admin tem execucao write", P.can(orgA, admin, "execucao", "write") === true);
  check("legado: agent NÃO tem execucao write", P.can(orgA, agent, "execucao", "write") === false);
  // approval_role → nível gestor (full = 'delete'): owner/admin(gerente) passam.
  check("legado: owner tem execucao full (delete)", P.can(orgA, owner, "execucao", "delete") === true);
  check("legado: admin tem execucao full (delete)", P.can(orgA, admin, "execucao", "delete") === true);
  check("legado: agent NÃO tem execucao full", P.can(orgA, agent, "execucao", "delete") === false);
  // isOwner preserva o caso owner-only (change_price / approval_role='owner').
  check("isOwner: owner=true, admin=false, agent=false",
    P.isOwner(orgA, owner) === true && P.isOwner(orgA, admin) === false && P.isOwner(orgA, agent) === false);

  // Replica a decisão exata do gate da rota (approve handler).
  const gate = (u: any, approvalRole: string | null) =>
    P.can(orgA, u, "execucao", approvalRole ? "delete" : "write") && (approvalRole !== "owner" || P.isOwner(orgA, u));
  check("gate: sem approval_role → owner/admin sim, agent não",
    gate(owner, null) && gate(admin, null) && !gate(agent, null));
  check("gate: approval_role='admin' (send_campaign) → owner+admin sim, agent não",
    gate(owner, "admin") && gate(admin, "admin") && !gate(agent, "admin"));
  check("gate: approval_role='owner' (change_price) → SÓ owner (admin barrado)",
    gate(owner, "owner") && !gate(admin, "owner") && !gate(agent, "owner"));

  // ===== 5. Perfil GRANULAR vence o claim legado (não confia no role cru) =====
  P.seedSystemProfiles(orgA);
  const vendedorId = (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'vendedor'").get(orgA) as any).id;
  const ownerProfId = (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'owner'").get(orgA) as any).id;
  // Usuário com CLAIM role='owner' mas PERFIL vendedor (execucao=none): granular vence.
  const spoofed = { userId: "u-spoof", role: "owner", role_profile_id: vendedorId };
  check("granular: perfil vendedor VENCE claim 'owner' → execucao write negado", P.can(orgA, spoofed, "execucao", "write") === false);
  check("granular: isOwner ignora o claim cru (perfil vendedor ≠ owner)", P.isOwner(orgA, spoofed) === false);
  const realOwner = { userId: "u-real", role: "agent", role_profile_id: ownerProfId };
  check("granular: perfil owner concede full mesmo com claim 'agent'", P.can(orgA, realOwner, "execucao", "delete") === true);
  check("granular: isOwner reconhece o perfil owner", P.isOwner(orgA, realOwner) === true);

  // ===== 6. Isolamento multi-tenant =====
  const orgB = mkOrg();
  const sB = twoStep(orgB);
  D.approve(orgB, sB.id, "user-1");
  check("isolamento: aprovação de orgB não vaza pra orgA", approvedRows(orgA, sB.id) === 0);

  console.log("\n=== TEST: Two-step approval security (ADR-159 F1) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Two-step approval security (F1) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
