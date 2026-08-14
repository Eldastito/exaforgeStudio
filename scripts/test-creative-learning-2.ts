/**
 * TEST — Creative Learning 2.0 (PRD 11 / ADR-168 F10). DB-backed, determinístico.
 * Prova: o desfecho de NEGÓCIO (receita via F8 / leads via F7, por correlation_id) SOBREPÕE
 * o engajamento na classificação que alimenta o MOTOR ÚNICO (PatternMemory, §184); sem
 * desfecho de negócio cai pro engajamento (RN-CG-01; 0-regressão do F13); realizedImpact
 * segue = engajamento (nunca mistura R$ com contagem, RN-CG-03).
 *
 * Uso: npm run test:creative-learning-2
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clearn2-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-clearn2-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const tick = () => new Promise((r) => setImmediate(r));

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { GovernedPublishService: GP } = await import("../src/server/GovernedPublishService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");
  const { SocialAttributionService: ATTR } = await import("../src/server/SocialAttributionService.js");
  const { CreativeLearningService: CL } = await import("../src/server/CreativeLearningService.js");
  const { ContentLeadAttributionService: LEAD } = await import("../src/server/ContentLeadAttributionService.js");

  const A = "org_cl2_A";
  db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(`os-${A}`, A);
  db.prepare(`UPDATE organization_settings SET vertical='moda', pattern_memory=1 WHERE organization_id = ?`).run(A);

  const contact = () => { const id = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'L', ?)`).run(id, A, id); return id; };
  // Publica governado + confirma via F12 → assured. correlationId explícito p/ atribuição.
  const pub = async (variantKey: string, corr: string, likes: number) => {
    const a = GP.propose(A, { channel: "stub", caption: "c", mediaRef: "art:1", variantKey, correlationId: corr });
    DA.approve(A, a.id, "appr", {});
    const ex = await GP.execute(A, a.id);
    db.prepare(`INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, published_at, likes, comments, shares, saves, analytics_available) VALUES (?, ?, 'stub', ?, '2026-08-13T12:00:00Z', ?, 0,0,0, 1)`).run(randomUUID(), A, ex.result?.externalRef, likes);
    ATTR.resolvePending(A);
    for (let i = 0; i < 40; i++) { await tick(); if ((db.prepare(`SELECT status FROM decision_actions WHERE id=?`).get(a.id) as any)?.status === "done") break; }
    return a.id;
  };

  // ── 1. Venda SOBREPÕE engajamento: post com ZERO engajamento mas VENDA → worked por receita ──
  const corr1 = "corr:sale";
  const p1 = await pub("s1:A", corr1, 0);              // engajamento 0
  const c1 = contact(); LEAD.attribute(A, { correlationId: corr1, contactId: c1 });
  db.prepare(`INSERT INTO content_sale_attributions (id, organization_id, correlation_id, contact_id, revenue, revenue_basis, source) VALUES (?, ?, ?, ?, 500, 'fact', 'orders')`).run(randomUUID(), A, corr1, c1);
  const l1 = CL.learnFromAction(A, p1);
  check("1.1 aprende mesmo com engajamento 0 (por negócio)", l1.learned === true && l1.outcome === "worked");
  check("1.2 basis é receita (não engajamento)", l1.businessBasis === "revenue" && l1.businessValue === 500);
  check("1.3 engajamento medido segue 0 (não inventa)", l1.engagement === 0);

  // ── 2. Só engajamento (sem negócio) → cai pro engajamento (0-regressão F13) ──
  const p2 = await pub("s2:A", "corr:eng", 40);        // engajamento 40, sem lead/venda
  const l2 = CL.learnFromAction(A, p2);
  check("2.1 sem negócio → basis engagement", l2.businessBasis === "engagement");
  check("2.2 worked por engajamento", l2.outcome === "worked" && l2.engagement === 40);

  // ── 3. Lead (sem venda) → worked por leads ──
  const corr3 = "corr:lead";
  const p3 = await pub("s3:A", corr3, 0);
  const c3 = contact(); LEAD.attribute(A, { correlationId: corr3, contactId: c3 });
  const l3 = CL.learnFromAction(A, p3);
  check("3.1 lead sem venda → basis leads", l3.businessBasis === "leads" && l3.businessValue === 1 && l3.outcome === "worked");

  // ── 4. Sem engajamento e sem negócio → no_effect ──
  const p4 = await pub("s4:A", "corr:nada", 0);
  const l4 = CL.learnFromAction(A, p4);
  check("4.1 nada medido → no_effect", l4.outcome === "no_effect" && l4.businessBasis === "engagement");

  // ── 5. Idempotência (motor único, RN-EL-4) ──
  const again = CL.learnFromAction(A, p1);
  check("5.1 reaprender é no-op", again.idempotent === true && again.learned === false);
  check("5.2 não dobra o ledger", (db.prepare(`SELECT COUNT(*) n FROM business_pattern_outcomes WHERE action_id = ?`).get(p1) as any).n === 1);

  // ── 6. Eficácia por assinatura no motor único ──
  check("6.1 eficácia agregada (≥1 padrão)", CL.effectiveness(A).length >= 1);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} creative-learning-2: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
