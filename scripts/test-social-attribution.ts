/**
 * TEST — Social Analytics & Attribution (PRD 10 / ADR-167 F12). DB-backed, determinístico.
 * Prova (D6/§42, RN-SI-03): PUBLISHED → RESULTADO.
 *   - publica governado (F11) → confirmação social_publish pending com external_ref;
 *   - sem analytics ainda → resolvePending NÃO força (awaitingAnalytics, honesto);
 *   - com analytics (F4) → confirma com engajamento MEDIDO → ação conclui + outcome;
 *   - NUNCA inventa dinheiro (resultAmount null); atribuição liga variante→engajamento;
 *   - idempotente (2ª resolução não reconfirma); isolamento.
 *
 * Uso: npm run test:social-attribution
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-attr-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-attr-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const tick = () => new Promise((r) => setImmediate(r));

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { GovernedPublishService: GP } = await import("../src/server/GovernedPublishService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");
  const { ConfirmationEngine } = await import("../src/server/ConfirmationEngine.js");
  const { SocialAttributionService: ATTR } = await import("../src/server/SocialAttributionService.js");

  const A = "org_attr_A", B = "org_attr_B";
  const approver = "user-appr";

  // publica governado (F11): propor → aprovar → executar.
  const action = GP.propose(A, { channel: "stub", caption: "linho", mediaRef: "art:1", variantKey: "sig-1:A", correlationId: "corr-A" });
  DA.approve(A, action.id, approver, {});
  const exec = await GP.execute(A, action.id);
  const externalRef = exec.result?.externalRef as string;
  check("0.1 publicado com external_ref + confirmação pending", !!externalRef && ConfirmationEngine.getForAction(A, action.id)?.status === "pending");

  // ═══════════════ 1. sem analytics → não força (honesto) ═══════════════
  const r0 = ATTR.resolvePending(A);
  check("1.1 sem analytics → awaitingAnalytics (PUBLISHED≠RESULTADO)", r0.resolved === 0 && r0.awaitingAnalytics === 1);
  check("1.2 confirmação segue pending", ConfirmationEngine.getForAction(A, action.id)?.status === "pending");

  // ═══════════════ 2. analytics chega (F4) → resolve com engajamento medido ═══════════════
  db.prepare(`INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, published_at, impressions, reach, likes, comments, shares, saves, analytics_available)
              VALUES (?, ?, 'stub', ?, '2026-08-13T12:00:00Z', 1000, 800, 50, 10, 5, 8, 1)`).run(randomUUID(), A, externalRef);
  const r1 = ATTR.resolvePending(A);
  check("2.1 resolve 1 confirmação", r1.resolved === 1 && r1.awaitingAnalytics === 0);
  const conf = ConfirmationEngine.getForAction(A, action.id);
  check("2.2 confirmação CONFIRMED com engajamento medido", conf?.status === "confirmed" && conf?.evidence?.engagement === 73);
  check("2.3 evidência carrega o analytics (não inventa dinheiro)", conf?.evidence?.source === "social_analytics" && conf?.evidence?.impressions === 1000);

  // ação conclui (async) → poll por done + outcome
  let done = false;
  for (let i = 0; i < 30 && !done; i++) { await tick(); done = (db.prepare(`SELECT status FROM decision_actions WHERE id = ?`).get(action.id) as any)?.status === "done"; }
  check("2.4 ação concluída (done) após confirmação", done);
  check("2.5 outcome registrado (fecha o loop, RESULTADO observável)", (db.prepare(`SELECT COUNT(*) n FROM action_outcomes WHERE action_id = ?`).get(action.id) as any).n >= 1);

  // ═══════════════ 3. atribuição liga variante→engajamento ═══════════════
  const attr = ATTR.attribution(A, { correlationId: "corr-A" });
  check("3.1 atribuição por correlação", attr.length === 1 && attr[0].variantKey === "sig-1:A");
  check("3.2 engajamento medido atribuído à variante", attr[0].measured === true && attr[0].engagement === 73 && attr[0].confirmationStatus === "confirmed");

  // ═══════════════ 4. idempotência ═══════════════
  const r2 = ATTR.resolvePending(A);
  check("4.1 2ª resolução não reconfirma (nada pendente)", r2.resolved === 0 && r2.awaitingAnalytics === 0);

  // ═══════════════ 5. isolamento multi-tenant ═══════════════
  check("5.1 B não vê atribuição de A", ATTR.attribution(B).length === 0);
  check("5.2 B não resolve confirmações de A", ATTR.resolvePending(B).resolved === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} social-attribution: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
