/**
 * TEST — Social Proactivity (PRD 10 / ADR-167 F14). DB-backed, determinístico.
 * Prova (§42): a fatia social entra nas superfícies proativas EXISTENTES (sem nova).
 *   - digest COMPÕE oportunidades (F7) + aprovações pendentes (F11) + resultados
 *     medidos (F12) + o que funciona (F13), humano e só do que existe;
 *   - a oportunidade de conteúdo aparece no `attention()`/Smart Inbox com summary HUMANO
 *     (via note), não "content opportunity" cru;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:social-proactivity
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sproac-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-sproac-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const tick = () => new Promise((r) => setImmediate(r));

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SocialProactivityService: SP } = await import("../src/server/SocialProactivityService.js");
  const { OpportunityMatchingService: OM } = await import("../src/server/OpportunityMatchingService.js");
  const { GovernedPublishService: GP } = await import("../src/server/GovernedPublishService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");
  const { SocialAttributionService: ATTR } = await import("../src/server/SocialAttributionService.js");
  const { CreativeLearningService: CL } = await import("../src/server/CreativeLearningService.js");
  const { VerticalIntelligenceService: VI } = await import("../src/server/VerticalIntelligenceService.js");
  const { SocialAnalyticsService: AN } = await import("../src/server/SocialAnalyticsService.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");

  const A = "org_sp_A", B = "org_sp_B";
  const master = { userId: "master", organizationId: null };
  const approver = "user-appr";
  const setup = (org: string) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET vertical='moda', external_intelligence_enabled=1, pattern_memory=1 WHERE organization_id = ?`).run(org);
  };
  setup(A); setup(B);
  await VI.runResearch(master, { vertical: "moda", topic: "concorrência", ttlDays: 7 }, { providerName: "stub" });
  await VI.runResearch(master, { vertical: "moda", topic: "tendências", ttlDays: 7 }, { providerName: "stub" });
  await AN.sync(A, "stub");
  OM.match(A, { channel: "stub", publish: true });   // 2 oportunidades → business_signals

  // aprovação pendente (proposta, não aprovada)
  GP.propose(A, { channel: "stub", caption: "pend", mediaRef: "art:1", variantKey: "sig:A" });
  // resultado medido + aprendizado (chain completa)
  const done = GP.propose(A, { channel: "stub", caption: "ok", mediaRef: "art:2", variantKey: "sig:B" });
  DA.approve(A, done.id, approver, {});
  const ex = await GP.execute(A, done.id);
  db.prepare(`INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, published_at, likes, comments, shares, saves, analytics_available)
              VALUES (?, ?, 'stub', ?, '2026-08-13T12:00:00Z', 60, 5, 3, 2, 1)`).run(randomUUID(), A, ex.result.externalRef);
  ATTR.resolvePending(A);
  for (let i = 0; i < 40; i++) { await tick(); if ((db.prepare(`SELECT status FROM decision_actions WHERE id = ?`).get(done.id) as any)?.status === "done") break; }
  CL.learnFromAction(A, done.id);

  // ═══════════════ 1. digest compõe as 4 partes ═══════════════
  const d = SP.digest(A);
  check("1.1 oportunidades (F7) no digest", d.opportunities.length === 2 && d.opportunities.every((o: any) => !!o.summary));
  check("1.2 aprovação pendente (F11) no digest", d.pendingApprovals.length === 1 && d.pendingApprovals[0].channel === "stub");
  check("1.3 resultado medido (F12) no digest", d.recentResults.length === 1 && d.recentResults[0].engagement === 70);
  check("1.4 o que funciona (F13) no digest", d.learning.length === 1 && d.learning[0].acted === 1);
  check("1.5 headline humana só do que existe", typeof d.headline === "string" && /oportunidade/.test(d.headline!) && /aprovar/.test(d.headline!));

  // ═══════════════ 2. oportunidade surge no attention() com summary HUMANO ═══════════════
  const att = BS.attention(A, {});
  const oppItem = att.items.find((i: any) => i.domain === "social" && i.type === "content_opportunity");
  check("2.1 oportunidade social no attention()/Smart Inbox", !!oppItem);
  const sum = String(oppItem?.summary || "");
  check("2.2 summary HUMANO (frase real, não 'content opportunity' cru)", sum.length > 15 && !/^content.opportunity$/i.test(sum));

  // ═══════════════ 3. isolamento ═══════════════
  const dB = SP.digest(B);
  check("3.1 org B: digest vazio + headline null", dB.opportunities.length === 0 && dB.pendingApprovals.length === 0 && dB.recentResults.length === 0 && dB.headline === null);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} social-proactivity: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
