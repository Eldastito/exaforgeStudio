/**
 * TEST — Ajuda zero-training do Fala Tu (PRD 6 / ADR-163 F7). DB-backed, det., isolado.
 * Prova (§30-§36, RN-UX-1/3/4):
 *   - classifica ensine/mostre/faça/onde (determinístico, §91-92);
 *   - ensine → explica módulo do MODULE_META (não inventa);
 *   - mostre → evidência da Smart Inbox (role-scoped);
 *   - faça → caminho GOVERNADO (política de aprovação) + deixa claro que NÃO executa (RN-UX-3);
 *   - onde → navega respeitando plano; recurso fora do plano é HONESTO (RN-UX-4), não finge;
 *   - flag refletida; multi-tenant.
 *
 * Uso: npm run test:zero-training-help
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-help-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-help-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ZeroTrainingHelpService: HELP } = await import("../src/server/ZeroTrainingHelpService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  const mkOrg = (org: string, inv: number) =>
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status, invisible_ux_enabled) VALUES (?, ?, 'X', 'active', 'varejo', 'autonomo', 'active', ?)`).run(randomUUID(), org, inv);
  mkOrg(A, 1); mkOrg(B, 0);
  PermissionService.seedSystemProfiles(A); PermissionService.seedSystemProfiles(B);
  const prof = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any).id;
  const owner = { userId: "u1", email: "dono@x.com", role: "owner", role_profile_id: prof(A, "owner"), organizationId: A };
  const ownerB = { userId: "u9", email: "dono@b.com", role: "owner", role_profile_id: prof(B, "owner"), organizationId: B };

  // 1 aprovação pendente → "mostra aprovações" deve contar ≥ 1.
  DA.propose(A, { domain: "sales", actionType: "prepare_campaign", title: "Campanha" });

  // ═══════════════ 1. ensine (explica módulo, não inventa) ═══════════════
  const teach = HELP.answer(A, owner, { text: "o que é campanhas?" });
  check("1.1 intent teach", teach.intent === "teach");
  check("1.2 explica pelo MODULE_META (Campanhas)", !!teach.module && teach.module!.key === "campanhas" && /disparos/i.test(teach.message));
  check("1.3 flag invisibleUx refletida", teach.invisibleUxEnabled === true);

  // ═══════════════ 2. mostre (evidência role-scoped) ═══════════════
  const show = HELP.answer(A, owner, { text: "mostra as aprovações" });
  check("2.1 intent show", show.intent === "show");
  check("2.2 evidência needsApproval ≥ 1", show.evidence?.category === "needsApproval" && show.evidence!.count >= 1);

  // ═══════════════ 3. faça (governado, NÃO executa) ═══════════════
  const doCamp = HELP.answer(A, owner, { text: "quero fazer uma campanha" });
  check("3.1 intent do", doCamp.intent === "do");
  check("3.2 governado por política (prepare_campaign)", doCamp.governedBy?.actionType === "prepare_campaign" && typeof doCamp.governedBy!.policy === "string");
  check("3.3 deixa claro que NÃO executa sozinho (RN-UX-3)", /não executo|confirma/i.test(doCamp.message));
  const doRef = HELP.answer(A, owner, { text: "quero fazer um reembolso" });
  check("3.4 reembolso → caminho governado", doRef.intent === "do" && doRef.governedBy?.actionType === "refund");

  // ═══════════════ 4. onde (navega + honesto sobre fora-do-plano) ═══════════════
  const navSurface = HELP.answer(A, owner, { text: "onde fica resultados?" });
  check("4.1 navega p/ superfície Resultados (disponível)", navSurface.intent === "navigate" && navSurface.navTarget?.key === "resultados" && navSurface.navTarget!.available === true);
  const navOut = HELP.answer(A, owner, { text: "onde fica campanhas?" });
  check("4.2 módulo fora-do-plano: HONESTO (available=false), não finge", navOut.intent === "navigate" && navOut.navTarget?.key === "campanhas" && navOut.navTarget!.available === false && /não está no seu plano/i.test(navOut.message));

  // ═══════════════ 5. unknown + multi-tenant ═══════════════
  const unk = HELP.answer(A, owner, { text: "asdf qwer zxcv" });
  check("5.1 pergunta obscura → unknown (oferece as opções)", unk.intent === "unknown" && /explicar|mostrar|fazer/i.test(unk.message));
  const showB = HELP.answer(B, ownerB, { text: "mostra as aprovações" });
  check("5.2 org B isolada (sem aprovações de A)", showB.evidence!.count === 0);
  check("5.3 flag OFF em B", showB.invisibleUxEnabled === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} zero-training-help: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
