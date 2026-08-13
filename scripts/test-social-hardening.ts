/**
 * TEST — Social Intelligence Hardening (PRD 10 / ADR-167 F16). DB-backed, determinístico.
 * CODIFICA os guardrails RN-SI/RN-EI como REGRESSÃO (doc-of-record executável), tocando
 * os serviços REAIS das F1–F15. Se algum invariante quebrar, este teste falha.
 *
 *   RN-SI-05  segredos nunca vazam (config CIFRADA; status REDIGIDO)
 *   RN-SI-06  capacidade DESCOBERTA, não presumida; degrada explícito (não finge)
 *   RN-SI-08  publicação IDEMPOTENTE (durável via choke-point governado)
 *   RN-SI-11  inteligência competitiva só de fonte pública/legal; RN-EI-6 não inventa live
 *   RN-EI-5   grounding: live sem fonte → null
 *   RN-SI-12  métrica ausente → NULL nunca 0
 *   RN-SI-03  PUBLISHED ≠ RESULTADO (oportunidade é hipótese; confirmação fica pending)
 *   RN-SI-14  gate de plano SERVER-SIDE (não é esconder botão)
 *   §42       sem tabela de alerta paralela / sem runtime paralelo (usa business_signals +
 *             decision_actions); nunca inventa dinheiro
 *   convenção#1 isolamento multi-tenant
 *
 * Uso: npm run test:social-hardening
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-shard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-shard-1";
process.env.MASTER_ADMIN_EMAIL = "master@test.zap";
delete process.env.COMPETITIVE_INTEL_SOURCE_URL;

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SocialConnectionService: SC } = await import("../src/server/SocialConnectionService.js");
  const { CompetitiveIntelligenceProvider } = await import("../src/server/CompetitiveIntelligenceProvider.js");
  const { SocialAnalyticsService: AN } = await import("../src/server/SocialAnalyticsService.js");
  const { OpportunityMatchingService: OM } = await import("../src/server/OpportunityMatchingService.js");
  const { GovernedPublishService: GP } = await import("../src/server/GovernedPublishService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");
  const { ConfirmationEngine } = await import("../src/server/ConfirmationEngine.js");
  const { SocialEntitlementService: SE } = await import("../src/server/SocialEntitlementService.js");
  const { VerticalIntelligenceService: VI } = await import("../src/server/VerticalIntelligenceService.js");

  const A = "org_h_A", B = "org_h_B";
  db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status, vertical, external_intelligence_enabled) VALUES (?, ?, 'X', 'active', 'moda', 1)`).run("os-A", A);
  db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run("os-B", B);

  // ═══════════════ RN-SI-05 — segredos ═══════════════
  SC.setConfig(A, "instagram", { token: "SECRET-TOK-999" }, { provider: "stub", enabled: true });
  const raw = db.prepare(`SELECT config_enc FROM social_connections WHERE organization_id=? AND channel='instagram'`).get(A) as any;
  check("RN-SI-05 config CIFRADA em repouso (sem token cru)", typeof raw.config_enc === "string" && !raw.config_enc.includes("SECRET-TOK-999"));
  check("RN-SI-05 status REDIGIDO não vaza token", !JSON.stringify(SC.status(A, "instagram")).includes("SECRET-TOK-999"));

  // ═══════════════ RN-SI-06 — capacidade descoberta / degrada ═══════════════
  SC.setConfig(A, "tiktok", { capabilities: { canPublish: false } }, { provider: "stub", enabled: true });
  const ro = SC.providerFor(A, "tiktok");
  const pub = await ro.publish({ kind: "image", idempotencyKey: "k" });
  check("RN-SI-06 sem capacidade → manual_required (não finge)", pub.status === "manual_required" && !ro.capabilities.includes("publish" as any));

  // ═══════════════ RN-SI-11 / RN-EI-5/6 — competitiva honesta ═══════════════
  const cip = new CompetitiveIntelligenceProvider();
  const r = await cip.research({ vertical: "moda", topic: "concorrência", query: "moda concorrência" });
  check("RN-SI-11/RN-EI-6 sem fonte → model_knowledge (não inventa live)", r.evidenceMode === "model_knowledge" && r.sourceEvidence.length === 0);
  check("RN-EI-5 grounding: live sem fonte → null", cip.parse(JSON.stringify({ competitors: [{ h: "x" }], sources: [] }), { vertical: "moda", topic: "t", query: "q" }, "2026-08-13T00:00:00Z") === null);

  // ═══════════════ RN-SI-12 — null≠0 ═══════════════
  await AN.sync(A, "stub");   // SP-2 do stub tem métricas parciais → NULL
  const sp2 = AN.list(A, "stub").find((p: any) => p.post_external_id === "SP-2");
  check("RN-SI-12 métrica ausente → NULL nunca 0", sp2 && sp2.comments === null && sp2.shares === null);

  // ═══════════════ RN-SI-03 / §42 / não inventa dinheiro — oportunidade ═══════════════
  await VI.runResearch({ userId: "m", organizationId: null }, { vertical: "moda", topic: "concorrência", ttlDays: 7 }, { providerName: "stub" });
  OM.match(A, { channel: "stub", publish: true });
  const sig = db.prepare(`SELECT basis, impact_amount FROM business_signals WHERE organization_id=? AND signal_type='content_opportunity' LIMIT 1`).get(A) as any;
  check("RN-SI-03 oportunidade é HIPÓTESE (basis)", sig?.basis === "hypothesis");
  check("§42 não inventa dinheiro (impact null)", sig?.impact_amount === null);
  // §42 — não existe tabela de alerta social paralela; oportunidade vive em business_signals.
  const noParallel = db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('social_alerts','social_opportunities')`).get() as any;
  check("§42 sem tabela de alerta/oportunidade paralela", noParallel.n === 0);

  // ═══════════════ RN-SI-08 / RN-SI-03 — publicação governada idempotente ═══════════════
  const act = GP.propose(A, { channel: "stub", caption: "c", mediaRef: "m", idempotencyKey: "x" } as any);
  DA.approve(A, act.id, "appr", {});
  await GP.execute(A, act.id);
  check("RN-SI-03 PUBLISHED≠RESULTADO: confirmação social_publish fica pending", ConfirmationEngine.getForAction(A, act.id)?.status === "pending");
  let dup = false; try { await GP.execute(A, act.id); } catch (e: any) { dup = /idempot|already/i.test(String(e?.message)); }
  check("RN-SI-08 idempotência durável: 2º execute barrado", dup);
  // §42 — publicação é decision_action governada, não runtime paralelo.
  check("§42 publicação é decision_action governada (sem runtime paralelo)", (db.prepare(`SELECT action_type FROM decision_actions WHERE id=?`).get(act.id) as any)?.action_type === "social_publish");

  // ═══════════════ RN-SI-14 — gate server-side ═══════════════
  let denied = false; try { SE.assertAllowed(A, { email: "user@x.com", userId: "u" }, "execute"); } catch (e: any) { denied = e?.code === "entitlement_denied"; }
  check("RN-SI-14 gate de plano server-side (recusa fora do plano)", denied);
  check("RN-SI-14 master passa (bypass de design)", SE.check(A, { email: "master@test.zap" }, "execute").allowed === true);

  // ═══════════════ convenção #1 — isolamento ═══════════════
  check("conv#1 B não vê conexões de A", SC.list(B).length === 0);
  check("conv#1 B não vê analytics de A", AN.list(B, "stub").length === 0);
  check("conv#1 B não vê oportunidades de A", (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id=?`).get(B) as any).n === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} social-hardening: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
