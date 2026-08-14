/**
 * TEST — Content & Growth Hardening / Production Readiness (PRD 11 / ADR-168 F18). FECHA o ADR-168.
 *
 * Dupla função (doc-of-record executável):
 *  A) CODIFICA os guardrails RN-CG como REGRESSÃO tocando os serviços REAIS F1–F17. Se um
 *     invariante quebrar (o like passar a mandar, a atribuição inventar dinheiro, a otimização
 *     auto-executar), a CI pega.
 *  B) Verifica a FIAÇÃO de produção — serviços importáveis, rotas montadas, passes no Scheduler,
 *     testes de regressão wired, runbook presente.
 *
 *   RN-CG-01  ENGAGEMENT ≠ BUSINESS VALUE (o vencedor de negócio sobrepõe o de engajamento)
 *   RN-CG-02  atribuição pergunta ao system-of-record (SQL), nunca inventa lead
 *   RN-CG-03  não inventa dinheiro; fact ≠ estimate; margem null sem custo
 *   RN-CG-06  dinheiro role-gated (o SINAL de produto só carrega banda qualitativa)
 *   RN-CG-08  decidir/propor ≠ executar (otimização nasce awaiting_approval)
 *   RN-CG-09  grounded (proposta obsoleta recusada; hook sem tópico recusado)
 *   RN-CG-10  shadow-first (autopilot rejeita 'auto')
 *   §37       sem motor/tabela/runtime paralelo (business_signals + decision_actions + registry)
 *   convenção#1 isolamento multi-tenant
 *
 * Uso: npm run test:content-growth-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const ROOT = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cgh-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-cgh-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { CreativeExperimentService: EXP } = await import("../src/server/CreativeExperimentService.js");
  const { ContentLeadAttributionService: LEAD } = await import("../src/server/ContentLeadAttributionService.js");
  const { ContentRevenueAttributionService: REV } = await import("../src/server/ContentRevenueAttributionService.js");
  const { ProductOpportunityService: PROD } = await import("../src/server/ProductOpportunityService.js");
  const { GrowthAutopilotService: AP } = await import("../src/server/GrowthAutopilotService.js");
  const { GrowthOptimizationService: OPT } = await import("../src/server/GrowthOptimizationService.js");
  const { HookIntelligenceService: HOOK } = await import("../src/server/HookIntelligenceService.js");
  const { CommandExecutorService } = await import("../src/server/CommandExecutorService.js");

  const A = "org_cgh_A", B = "org_cgh_B";
  for (const o of [A, B]) db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status, vertical, pattern_memory) VALUES (?, ?, 'X', 'active', 'moda', 1)`).run(`os-${o}`, o);

  // ═══════════════ RN-CG-01 — ENGAGEMENT ≠ BUSINESS VALUE ═══════════════
  const corrA = "corr:cgh:A", corrB = "corr:cgh:B";
  const e = EXP.create(A, "u", { hypothesis: "engaja x vende", minSample: 100, variants: [
    { variantKey: "cgh:A", label: "engaja", correlationId: corrA },
    { variantKey: "cgh:B", label: "vende", correlationId: corrB },
  ] });
  // A domina o engajamento; B quase não engaja.
  db.prepare(`INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, impressions, likes, comments, shares, saves, variant_key, analytics_available) VALUES (?, ?, 'instagram', ?, 500, 240, 5, 3, 2, 'cgh:A', 1)`).run(randomUUID(), A, "pA");
  db.prepare(`INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, impressions, likes, comments, shares, saves, variant_key, analytics_available) VALUES (?, ?, 'instagram', ?, 500, 6, 1, 0, 1, 'cgh:B', 1)`).run(randomUUID(), A, "pB");
  // B gerou a venda (fact).
  const cB = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'C', ?)`).run(cB, A, `id-${cB}`);
  LEAD.attribute(A, { correlationId: corrB, contactId: cB, source: "content" });
  const ord = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount) VALUES (?, ?, ?, 'pago', 400)`).run(ord, A, cB);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, unit_cost, quantity) VALUES (?, ?, ?, 'P', 400, 150, 1)`).run(randomUUID(), ord, A);
  REV.attributeLeads(A, corrB);
  const m = EXP.measure(A, e.id);
  const rA = m.find((x: any) => x.variantKey === "cgh:A")!.rate!, rB = m.find((x: any) => x.variantKey === "cgh:B")!.rate!;
  const dec = EXP.decide(A, e.id, "owner");
  check("RN-CG-01 A vence o engajamento (proxy)", rA > rB);
  check("RN-CG-01 mas o vencedor é B (por resultado de negócio)", dec.basis === "business_outcome" && dec.winnerVariantKey === "cgh:B");

  // ═══════════════ RN-CG-02 — atribuição pergunta ao SoR, nunca inventa lead ═══════════════
  let leadThrew = false;
  try { LEAD.attribute(A, { correlationId: "corr:x", contactId: "nao-existe" }); } catch { leadThrew = true; }
  check("RN-CG-02 lead exige contato REAL na org (não inventa)", leadThrew);

  // ═══════════════ RN-CG-03 — não inventa dinheiro; fact ≠ estimate; margem null sem custo ═══════════════
  const sum = REV.revenueFor(A, corrB);
  check("RN-CG-03 receita é fact (400), estimate separado (0)", sum.revenueFact === 400 && sum.revenueEstimate === 0);
  check("RN-CG-03 margem fact conhecida (250)", sum.marginFact === 250);
  // contato sem prova de valor → não atribui (revenue null).
  const cNo = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'NoVal', ?)`).run(cNo, A, `id-${cNo}`);
  check("RN-CG-03 sem prova de valor → não inventa receita", REV.valueForContact(A, cNo).revenue === null);
  // margem null quando custo desconhecido.
  const ord2 = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount) VALUES (?, ?, ?, 'pago', 200)`).run(ord2, A, cNo);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, unit_cost, quantity) VALUES (?, ?, ?, 'SemCusto', 200, 0, 1)`).run(randomUUID(), ord2, A);
  check("RN-CG-03 margem null quando custo desconhecido (não inventa lucro)", REV.marginForOrder(A, ord2).margin === null);

  // ═══════════════ RN-CG-06 — dinheiro role-gated: o SINAL de produto não carrega R$ ═══════════════
  const pid = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Camisa', 100, 1)`).run(pid, A);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 10, 40)`).run(randomUUID(), A, pid);
  const pm = PROD.match(A, { publish: true });
  check("RN-CG-06 oportunidade de produto publicada", pm.matched >= 1);
  const sig = db.prepare(`SELECT impact_amount, evidence_json FROM business_signals WHERE organization_id=? AND signal_type='product_opportunity' LIMIT 1`).get(A) as any;
  check("RN-CG-06 sinal SEM R$ (impact null, sem custo/preço absoluto no evidence)", sig && sig.impact_amount === null && !/\"price\"|\"avgCost\"|\"margin\"\s*:/.test(String(sig.evidence_json)));

  // ═══════════════ RN-CG-08/10 — decidir≠executar; shadow-first ═══════════════
  let autoThrew = false;
  try { AP.setMode(A, "auto"); } catch { autoThrew = true; }
  check("RN-CG-10 autopilot rejeita 'auto' (shadow-first)", autoThrew);
  AP.setMode(A, "shadow");
  const before = (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n;
  const plan = AP.plan(A);
  const after = (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n;
  check("RN-CG-08 plan() é read-only (zero decision_actions)", before === after && plan.proposals.every((p: any) => p.requiresApproval === true && p.wouldExecute === false));
  const champ = plan.proposals.find((p: any) => p.kind === "promote_champion");
  const gov = champ ? OPT.propose(A, { kind: "promote_champion", ref: champ.ref }, "owner") : null;
  check("RN-CG-08 otimização vira comando GOVERNADO awaiting_approval", !!gov && gov.status === "awaiting_approval" && gov.command_type === "growth_optimization");

  // ═══════════════ RN-CG-09 — grounded ═══════════════
  let staleThrew = false;
  try { OPT.propose(A, { kind: "promote_champion", ref: "nao-existe" }, "owner"); } catch { staleThrew = true; }
  check("RN-CG-09 proposta obsoleta recusada (grounded)", staleThrew);
  const hookEmpty = await HOOK.generate(A, { topic: "", count: 3 }).then(() => false).catch(() => true);
  check("RN-CG-09 hook sem tópico recusado (grounded)", hookEmpty);

  // ═══════════════ §37 — sem runtime paralelo: growth_optimization no MESMO registry ═══════════════
  check("§37 growth_optimization registrado no executor canônico", CommandExecutorService.canHandle("growth_optimization"));

  // ═══════════════ convenção#1 — isolamento ═══════════════
  check("isolamento: org B não vê experimentos/sinais/ações de A", EXP.list(B).length === 0 && (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(B) as any).n === 0);

  // ═══════════════ FIAÇÃO DE PRODUÇÃO ═══════════════
  const SERVICES = [
    "BrandDnaService", "CampaignObjectiveContractService", "HookIntelligenceService",
    "ScriptIntelligenceService", "ChannelAdaptationService", "CreativeExperimentService",
    "ContentLeadAttributionService", "ContentRevenueAttributionService", "ProductOpportunityService",
    "SocialProactivityService", "FacebookChannelProvider", "GrowthAutopilotService",
    "GrowthOptimizationService", "GrowthOptimizationCommandHandler",
  ];
  for (const s of SERVICES) {
    let ok = false;
    try { const mod = await import(`../src/server/${s}.js`); ok = !!(mod as any)[s] || !!(mod as any).default; } catch { ok = false; }
    check(`serviço importável: ${s}`, ok);
  }
  // rotas montadas
  const social = read("src/server/routes/social.ts");
  for (const r of ["/experiments", "/attribution/lead", "/attribution/revenue", "/product-opportunities", "/growth-brief", "/growth-autopilot", "/growth-optimizations"]) {
    check(`rota social presente: ${r}`, social.includes(`"${r}"`));
  }
  const studio = read("src/server/routes/studio.ts");
  for (const r of ["/brand-dna", "/hooks", "/script", "/channel-adaptation", "/campaign-contracts"]) {
    check(`rota studio presente: ${r}`, studio.includes(`"${r}"`));
  }
  // passe no Scheduler (§37 — sem 2º Scheduler)
  check("passe no Scheduler.tick: ProductOpportunityService.pass()", /ProductOpportunityService\.pass\(\)/.test(read("src/server/Scheduler.ts")));
  // handler registrado no registry canônico
  const h = read("src/server/GrowthOptimizationCommandHandler.ts");
  check("GrowthOptimizationCommandHandler registra 'growth_optimization'", /commandTypes:\s*\["growth_optimization"\]/.test(h) && /CommandExecutorService\.registerHandler\(GrowthOptimizationCommandHandler\)/.test(h));
  // testes de regressão wired (a CI matrix deriva daqui)
  const pkg = JSON.parse(read("package.json"));
  const TESTS = [
    "brand-dna", "campaign-objective", "hook-intelligence", "script-intelligence", "channel-adaptation",
    "creative-experiment", "content-lead-attribution", "content-revenue-attribution", "objective-aware-winner",
    "creative-learning-2", "product-opportunity", "growth-goal", "growth-brief", "social-provider-facebook",
    "growth-autopilot", "growth-optimization", "growth-golden-paths",
  ];
  for (const t of TESTS) check(`test wired: test:${t}`, typeof pkg.scripts[`test:${t}`] === "string");
  // runbook presente
  check("runbook growth presente", fs.existsSync(path.join(ROOT, "docs/runbook/growth-operacao.md")));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} content-growth-hardening: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
