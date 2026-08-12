/**
 * TEST — UX Presentation: Decision Card + humanState/humanError (PRD 6 / ADR-163 F4).
 * DB-backed, determinístico, isolado. Prova (§9,§39-44):
 *   - humanState: mapa técnico→humano; `failed` VISÍVEL (RN-UX-4, não some);
 *   - humanError: mensagem humana + hasDetails SEMPRE + técnico preservado (§44);
 *   - confidenceBand: alta/média/baixa (§64), null seguro;
 *   - card: o-que/por-que/impacto/recomendo/posso-fazer/regra; dinheiro role-gated
 *     (§73 — atendente vê que HÁ impacto, não o valor); canDo do RBAC real;
 *   - domínio invisível ao papel → card null (RN-UX-2); multi-tenant.
 *
 * Uso: npm run test:ux-presentation
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-uxp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-uxp-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { UxPresentationService: UXP } = await import("../src/server/UxPresentationService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");

  // ═══════════════ 1. humanState — mapa puro (sem DB) ═══════════════
  check("1.1 open → Identificado/identified", UXP.humanState("open").tone === "identified");
  check("1.2 awaiting_approval → Precisa de você/needs_you", UXP.humanState("awaiting_approval").tone === "needs_you");
  check("1.3 executing → Em andamento/in_progress", UXP.humanState("executing").tone === "in_progress");
  check("1.4 done → Concluído/done", UXP.humanState("done").tone === "done");
  check("1.5 failed VISÍVEL (tone failed, não escondido)", UXP.humanState("failed").tone === "failed" && /não deu certo/i.test(UXP.humanState("failed").label));
  check("1.6 status desconhecido → fallback seguro", UXP.humanState("zzz").key === "unknown" && UXP.humanState(null).key === "unknown");

  // ═══════════════ 2. humanError — nunca engole (§44) ═══════════════
  const eDup = UXP.humanError(new Error("SQLITE_CONSTRAINT_UNIQUE: contacts.id"));
  check("2.1 erro conhecido → humano + categoria", eDup.category === "duplicate" && /já existe/i.test(eDup.message));
  check("2.2 técnico preservado + hasDetails sempre", eDup.hasDetails === true && /SQLITE_CONSTRAINT_UNIQUE/.test(eDup.technical));
  const eUnk = UXP.humanError(new Error("kaboom xyz"));
  check("2.3 erro desconhecido → genérico MAS hasDetails+técnico", eUnk.category === "unknown" && eUnk.hasDetails === true && /kaboom/.test(eUnk.technical));
  const ePerm = UXP.humanError("forbidden: sem permissão");
  check("2.4 string de permissão mapeada", ePerm.category === "permission");

  // ═══════════════ 3. confidenceBand (§64) ═══════════════
  check("3.1 0.9 → alta", UXP.confidenceBand(0.9) === "alta");
  check("3.2 0.6 → média", UXP.confidenceBand(0.6) === "média");
  check("3.3 0.3 → baixa", UXP.confidenceBand(0.3) === "baixa");
  check("3.4 null → null", UXP.confidenceBand(null) === null);

  // ── setup DB p/ os cartões ──
  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  const mkOrg = (org: string) =>
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'X', 'active', 'varejo', 'autonomo', 'active')`).run(randomUUID(), org);
  mkOrg(A); mkOrg(B);
  PermissionService.seedSystemProfiles(A); PermissionService.seedSystemProfiles(B);
  const prof = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any).id;
  const owner = { userId: "u1", email: "dono@x.com", role: "owner", role_profile_id: prof(A, "owner"), organizationId: A };
  const atendente = { userId: "u3", email: "at@x.com", role: "agent", role_profile_id: prof(A, "atendente"), organizationId: A };
  const ownerB = { userId: "u9", email: "dono@b.com", role: "owner", role_profile_id: prof(B, "owner"), organizationId: B };

  // Ação visível a todos (domínio operacional sem malha) + impacto R$8.400 + exige aprovação.
  const visible = DA.propose(A, { domain: "operations", actionType: "prepare_campaign", title: "Recuperar carrinho", expectedImpact: 8400, impactUnit: "BRL", confidence: 0.82 });
  // Ação em domínio financeiro (invisível ao atendente).
  const fin = DA.propose(A, { domain: "finance", actionType: "prepare_campaign", title: "Renegociar fornecedor", expectedImpact: 3000 });

  // ═══════════════ 4. card do gestor (visão completa) ═══════════════
  const cOwner = UXP.card(A, DA.get(A, visible.id), owner);
  check("4.1 card monta (o-que)", !!cOwner && cOwner.what === "Recuperar carrinho");
  check("4.2 impacto R$ visível pro gestor", cOwner.impact.amount === 8400 && cOwner.impact.restricted === false);
  check("4.3 canDo do RBAC real inclui approve", Array.isArray(cOwner.canDo) && cOwner.canDo.includes("approve"));
  check("4.4 estado = Precisa de você", cOwner.state.tone === "needs_you");
  check("4.5 regra descreve a política", typeof cOwner.rule === "string" && cOwner.rule.length > 0);
  check("4.6 por-que traz base/confiança (banda)", cOwner.why.confidenceBand === "alta");

  // ═══════════════ 5. role-gating de dinheiro (§73) ═══════════════
  const cAt = UXP.card(A, DA.get(A, visible.id), atendente);
  check("5.1 atendente vê o cartão (domínio operacional)", !!cAt && cAt.what === "Recuperar carrinho");
  check("5.2 atendente NÃO vê o valor, mas SABE que há impacto", cAt.impact.amount === null && cAt.impact.restricted === true);

  // ═══════════════ 6. domínio invisível → card null (RN-UX-2) ═══════════════
  const cFinAt = UXP.card(A, DA.get(A, fin.id), atendente);
  const cFinOwner = UXP.card(A, DA.get(A, fin.id), owner);
  check("6.1 atendente não vê ação financeira (null)", cFinAt === null);
  check("6.2 gestor vê a ação financeira", !!cFinOwner && cFinOwner.impact.amount === 3000);

  // ═══════════════ 7. cards() lista + multi-tenant ═══════════════
  const listOwner = UXP.cards(A, owner);
  check("7.1 lista traz as 2 ações que pedem atenção", listOwner.length >= 2);
  const listAt = UXP.cards(A, atendente);
  check("7.2 lista do atendente esconde a financeira", listAt.every((c: any) => c.domain !== "finance"));
  const listB = UXP.cards(B, ownerB);
  check("7.3 org B isolada (sem ações de A)", listB.length === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} ux-presentation: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
