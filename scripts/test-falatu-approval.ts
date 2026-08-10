/**
 * TEST — PRD 1 Fase 4 (§24-25, §54, §66): Approval Center do Fala Tu. Aprovar/
 * rejeitar DENTRO do Fala Tu, mas com o MOTOR canônico (decision_actions/
 * ApprovalPolicy) — a camada só apresenta + delega, sem burlar RBAC (§30/CA13).
 *
 * Prova (determinístico; perfis RBAC reais):
 *   - pending: cards com motivo (§24) + flag canApprove por papel;
 *   - decide por actionId EXPLÍCITO + enum (§25); RBAC igual à rota core
 *     (vendedor não aprova; approval_role 'owner' só o dono);
 *   - two_step exige 2 aprovadores DISTINTOS; idempotência (§54: mesmo user 2× = no-op);
 *   - rejeição; decisão inválida barrada; isolamento multi-tenant.
 *
 * Uso: npm run test:falatu-approval
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-approval-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-approval-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
function throws(fn: () => any): boolean { try { fn(); return false; } catch { return true; } }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuApprovalService: FA } = await import("../src/server/FalaTuApprovalService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PermissionService.seedSystemProfiles(id); return id; };
  const org = mkOrg();
  const userFor = (key: string) => ({ userId: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id, role: key });
  const owner = userFor("owner"), gerente = userFor("gerente"), vendedor = userFor("vendedor");

  const act = (opts: { policy?: string; role?: string | null; impact?: number; org?: string } = {}) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, expected_impact, impact_unit, status, approval_policy, approval_role, created_by) VALUES (?, ?, 'sales', 'refund', 'Aprovar reembolso', ?, 'BRL', 'awaiting_approval', ?, ?, 'rule')`)
      .run(id, opts.org || org, opts.impact ?? 800, opts.policy || "single", opts.role ?? null);
    return id;
  };

  // ===== 1. pending: cards + canApprove por papel =====
  const a1 = act({ impact: 5000 });
  const pOwner = FA.pending(org, owner);
  check("1.1 pending lista a ação com card (actionId + why)", pOwner.items.some((c: any) => c.actionId === a1 && /pol[íi]tica/i.test(c.why)));
  check("1.2 owner canApprove=true", pOwner.items.find((c: any) => c.actionId === a1)?.canApprove === true);
  check("1.3 vendedor VÊ o card mas canApprove=false", FA.pending(org, vendedor).items.find((c: any) => c.actionId === a1)?.canApprove === false);

  // ===== 2. decide por actionId + enum; RBAC =====
  check("2.1 vendedor NÃO aprova (sem permissão execucao)", throws(() => FA.decide(org, vendedor, a1, "approve")));
  const r1 = FA.decide(org, owner, a1, "approve");
  check("2.2 owner aprova → status approved + mensagem", r1.action.status === "approved" && /Aprovado/.test(r1.message));
  check("2.3 decisão inválida barrada", throws(() => FA.decide(org, owner, act(), "talvez" as any)));

  // ===== 3. approval_role 'owner' → só o dono =====
  const aOwnerRole = act({ policy: "role", role: "owner" });
  check("3.1 gerente NÃO aprova ação de perfil owner", throws(() => FA.decide(org, gerente, aOwnerRole, "approve")));
  check("3.2 owner aprova a de perfil owner", FA.decide(org, owner, aOwnerRole, "approve").action.status === "approved");

  // ===== 4. two_step: 2 aprovadores distintos + idempotência (§54) =====
  const aTwo = act({ policy: "two_step" });
  const t1 = FA.decide(org, owner, aTwo, "approve");
  check("4.1 two_step: 1ª aprovação NÃO conclui (fica awaiting)", t1.action.status === "awaiting_approval" && /falta/i.test(t1.message));
  const t1b = FA.decide(org, owner, aTwo, "approve"); // MESMO user de novo
  check("4.2 idempotência: mesmo aprovador 2× não conta (segue awaiting)", t1b.action.status === "awaiting_approval");
  const t2 = FA.decide(org, gerente, aTwo, "approve"); // 2º distinto
  check("4.3 two_step: 2º aprovador DISTINTO conclui", t2.action.status === "approved");

  // ===== 5. Rejeição =====
  const aRej = act();
  const rej = FA.decide(org, owner, aRej, "reject");
  check("5.1 rejeição → status rejected", rej.action.status === "rejected" && /Rejeitado/.test(rej.message));
  check("5.2 vendedor NÃO rejeita (sem permissão)", throws(() => FA.decide(org, vendedor, act(), "reject")));

  // ===== 6. Isolamento multi-tenant =====
  const orgB = mkOrg();
  const aB = act({ org: orgB });
  check("6.1 org A não decide ação de B (não encontrada)", throws(() => FA.decide(org, owner, aB, "approve")));

  // ===== 7. Porta única: rota core e Fala Tu usam a MESMA checagem =====
  check("7.1 DA.canApprove owner=true, vendedor=false (mesma porta)", DA.canApprove(org, owner, { approval_role: null }) === true && DA.canApprove(org, vendedor, { approval_role: null }) === false);

  console.log("\n=== TEST: Approval Center do Fala Tu (PRD 1 Fase 4) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Approval Center do Fala Tu (Fase 4) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
