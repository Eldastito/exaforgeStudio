/**
 * TEST — Commercial Proof / Growth Golden Paths (PRD 11 / ADR-168 F17). DB-backed, determinístico.
 *
 * Prova a REGRA FUNDANTE `ENGAGEMENT ≠ BUSINESS VALUE` ponta-a-ponta pra 3 nichos
 * (Moda/Clínica/Restaurante), compondo os serviços REAIS já mergeados (§37 — nada novo):
 *
 *   Brand DNA (F1) → Hook/Script/Channel (F3/F4/F5) → experimento com 2 variantes (F6):
 *   a variante A ganha o ENGAJAMENTO (like), a B gera a VENDA. Conteúdo→lead→venda→receita→
 *   margem (F7/F8) atribui a B. `decide()` (F9) escolhe a B pelo RESULTADO DE NEGÓCIO,
 *   SOBREPONDO o engajamento — o coração da prova. A meta de conteúdo (F12) reflete a receita
 *   `fact`; o Growth Brief (F13) mostra o campeão; o Autopilot (F15) propõe promover o campeão
 *   e a Governed optimization (F16) transforma isso num comando GOVERNADO (awaiting_approval,
 *   nunca executa direto).
 *
 * Se a espinha de crescimento quebrar (o like passar a mandar, a atribuição inventar dinheiro,
 * a otimização auto-executar), este teste falha.
 *
 * Uso: npm run test:growth-golden-paths
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ggp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ggp-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { BrandDnaService: DNA } = await import("../src/server/BrandDnaService.js");
  const { HookIntelligenceService: HOOK } = await import("../src/server/HookIntelligenceService.js");
  const { ScriptIntelligenceService: SCRIPT } = await import("../src/server/ScriptIntelligenceService.js");
  const { ChannelAdaptationService: CHAN } = await import("../src/server/ChannelAdaptationService.js");
  const { CreativeExperimentService: EXP } = await import("../src/server/CreativeExperimentService.js");
  const { ContentLeadAttributionService: LEAD } = await import("../src/server/ContentLeadAttributionService.js");
  const { ContentRevenueAttributionService: REV } = await import("../src/server/ContentRevenueAttributionService.js");
  const { BusinessGoalService: GOAL } = await import("../src/server/BusinessGoalService.js");
  const { SocialProactivityService: SP } = await import("../src/server/SocialProactivityService.js");
  const { GrowthAutopilotService: AP } = await import("../src/server/GrowthAutopilotService.js");
  const { GrowthOptimizationService: OPT } = await import("../src/server/GrowthOptimizationService.js");

  async function runGoldenPath(vertical: string, topic: string) {
    const org = `org_ggp_${vertical}`;
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status, vertical, pattern_memory) VALUES (?, ?, 'Negócio', 'active', ?, 1)`).run(`os-${org}`, org, vertical);

    // 1. Brand DNA 2.0 (F1) — identidade estruturada + voz unificada.
    await DNA.save(org, "owner", { persona: "especialista próximo", audience: `público de ${vertical}`, positioning: "qualidade acessível", voice: "caloroso e direto" });

    // 2. Pipeline criativo (F3/F4/F5) grounded no tópico + objetivo.
    const hooks = await HOOK.generate(org, { topic, objectiveId: "vendas", count: 3 });
    const script = await SCRIPT.generate(org, { topic, objectiveId: "vendas", format: "reels" });
    const channels = CHAN.adaptMany({ caption: `Novidade sobre ${topic}!`, hashtags: ["oferta"] }, ["instagram", "facebook"]);

    // 3. Experimento com 2 variantes (F6). A liga a corrA, B liga a corrB (fio pra atribuição).
    const corrA = `corr:${org}:A`; const corrB = `corr:${org}:B`;
    const e = EXP.create(org, "u", {
      hypothesis: `qual criativo de ${topic} converte`,
      variants: [
        { variantKey: `${org}:A`, label: "A (benefício)", correlationId: corrA },
        { variantKey: `${org}:B`, label: "B (identidade)", correlationId: corrB },
      ],
      minSample: 100,
    });

    // 4. ENGAJAMENTO: A é o queridinho (alta taxa), B engaja pouco. Se o like mandasse, A venceria.
    db.prepare(`INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, published_at, impressions, likes, comments, shares, saves, variant_key, analytics_available) VALUES (?, ?, 'instagram', ?, '2026-08-13T12:00:00Z', 500, 240, 5, 3, 2, ?, 1)`).run(randomUUID(), org, `${org}:postA`, `${org}:A`);
    db.prepare(`INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, published_at, impressions, likes, comments, shares, saves, variant_key, analytics_available) VALUES (?, ?, 'instagram', ?, '2026-08-13T12:00:00Z', 500, 8, 1, 0, 1, ?, 1)`).run(randomUUID(), org, `${org}:postB`, `${org}:B`);

    // 5. NEGÓCIO: a variante B gerou lead → venda PAGA com custo conhecido (receita+margem fact).
    const contact = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente B', ?)`).run(contact, org, `id-${contact}`);
    LEAD.attribute(org, { correlationId: corrB, contactId: contact, source: "content" });
    const orderId = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount) VALUES (?, ?, ?, 'pago', 400)`).run(orderId, org, contact);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, unit_cost, quantity) VALUES (?, ?, ?, 'Produto', 400, 150, 1)`).run(randomUUID(), orderId, org);
    const revSummary = REV.attributeLeads(org, corrB);

    // 6. Meta de conteúdo (F12) na receita atribuída.
    GOAL.set(org, { metric: "content_revenue", targetAmount: 1000, actor: "owner" });

    // 7. Decisão objective-aware (F9) — o coração da prova.
    const measure = EXP.measure(org, e.id);
    const rateA = measure.find((m: any) => m.variantKey === `${org}:A`)!.rate!;
    const rateB = measure.find((m: any) => m.variantKey === `${org}:B`)!.rate!;
    const decision = EXP.decide(org, e.id, "owner");

    // 8. Superfície proativa (F13) — campeão + meta.
    const brief = SP.growthBrief(org);

    // 9. Autopilot (F15) propõe promover o campeão; Governed optimization (F16) governa.
    AP.setMode(org, "shadow");
    const plan = AP.plan(org);
    const champ = plan.proposals.find((p: any) => p.kind === "promote_champion");
    const governed = champ ? OPT.propose(org, { kind: "promote_champion", ref: champ.ref }, "owner") : null;

    return { org, corrB, e, rateA, rateB, decision, revSummary, brief, plan, governed, hooks, script, channels, orderId };
  }

  const paths: Record<string, string> = { moda: "linho", clinica: "harmonizacao", restaurante: "brunch" };
  for (const [vertical, topic] of Object.entries(paths)) {
    const g = await runGoldenPath(vertical, topic);

    // pipeline criativo grounded
    check(`${vertical}: hooks grounded no tópico`, g.hooks.hooks.length === 3 && g.hooks.hooks.every((h: any) => typeof h.text === "string" && h.text.length > 0));
    check(`${vertical}: roteiro em 5 beats (gancho→CTA)`, g.script.beats.length === 5);
    check(`${vertical}: adaptação multicanal (IG+FB)`, g.channels.adaptations.length === 2);

    // A vence o ENGAJAMENTO...
    check(`${vertical}: A é o campeão de ENGAJAMENTO (proxy)`, g.rateA > g.rateB);
    // ...mas o RESULTADO DE NEGÓCIO manda: B vence.
    check(`${vertical}: decisão por RESULTADO DE NEGÓCIO (não engajamento)`, g.decision.basis === "business_outcome");
    check(`${vertical}: campeão é B (a que VENDEU), não A (a que só engajou)`, g.decision.winnerVariantKey === `${g.org}:B`);
    check(`${vertical}: ENGAGEMENT ≠ BUSINESS VALUE provado`, g.rateA > g.rateB && g.decision.winnerVariantKey === `${g.org}:B`);

    // dinheiro é fact, com margem fact (não inventado)
    check(`${vertical}: receita atribuída é fact (R$ 400)`, g.revSummary.revenueFact === 400 && g.revSummary.revenueEstimate === 0);
    check(`${vertical}: margem fact (400−150=250)`, g.revSummary.marginFact === 250);

    // meta de conteúdo reflete a receita fact
    const prog = GOAL.progress(g.org).goals.find((x: any) => x.metric === "content_revenue");
    check(`${vertical}: meta content_revenue reflete o fact (current=400)`, !!prog && prog.current === 400);

    // superfície proativa mostra o campeão
    check(`${vertical}: Growth Brief mostra o campeão decidido`, g.brief.champions.some((c: any) => c.winnerVariantKey === `${g.org}:B`));

    // autopilot propõe, governed optimization governa (nunca executa direto)
    check(`${vertical}: autopilot propõe promover o campeão`, !!g.governed);
    check(`${vertical}: otimização vira comando GOVERNADO awaiting_approval (RN-CG-08/10)`, !!g.governed && g.governed.status === "awaiting_approval" && g.governed.command_type === "growth_optimization");
  }

  // Isolamento cruzado entre os golden paths.
  const modaExp = EXP.list("org_ggp_moda");
  check("isolamento: cada nicho vê só os seus experimentos", modaExp.length === 1 && EXP.list("org_ggp_clinica").length === 1);
  check("isolamento: receita de um nicho não vaza pro outro", GOAL.progress("org_ggp_moda").goals.find((x: any) => x.metric === "content_revenue")!.current === 400);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} growth-golden-paths: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
