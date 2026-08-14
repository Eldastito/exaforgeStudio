/**
 * TEST — Objective-aware Winner (PRD 11 / ADR-168 F9). DB-backed, determinístico.
 * Prova: quando HÁ resultado de negócio atribuído (receita/leads via F7/F8), o vencedor é
 * escolhido pelo NEGÓCIO, sobrepondo o engajamento (RN-CG-01); sem desfecho de negócio, cai
 * pro engajamento (F6, 0-regressão); dinheiro provado antes de lead; empate → inconclusive.
 *
 * Uso: npm run test:objective-aware-winner
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-oaw-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-oaw-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { CreativeExperimentService: EXP } = await import("../src/server/CreativeExperimentService.js");

  const org = `org_oaw_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${org}`, org);

  const contact = () => { const id = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'L', ?)`).run(id, org, id); return id; };
  const post = (variantKey: string, impressions: number, engagement: number) => db.prepare(`INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, published_at, likes, comments, shares, saves, impressions, analytics_available, variant_key) VALUES (?, ?, 'instagram', ?, '2026-08-13T12:00:00Z', ?, 0,0,0, ?, 1, ?)`).run(randomUUID(), org, randomUUID(), engagement, impressions, variantKey);
  const lead = (corr: string) => { const c = contact(); db.prepare(`INSERT INTO content_lead_attributions (id, organization_id, correlation_id, contact_id) VALUES (?, ?, ?, ?)`).run(randomUUID(), org, corr, c); return c; };
  const sale = (corr: string, contactId: string, revenue: number) => db.prepare(`INSERT INTO content_sale_attributions (id, organization_id, correlation_id, contact_id, revenue, revenue_basis, source) VALUES (?, ?, ?, ?, ?, 'fact', 'orders')`).run(randomUUID(), org, corr, contactId, revenue);

  // ── 1. Negócio SOBREPÕE engajamento: A engaja mais, mas B vende mais → B vence ──
  const corrA = "campaign:A", corrB = "campaign:B";
  const e1 = EXP.create(org, "u", { hypothesis: "qual vende mais", variants: [
    { variantKey: "e1:A", label: "Muito like", correlationId: corrA },
    { variantKey: "e1:B", label: "Mais venda", correlationId: corrB },
  ]});
  // Engajamento: A domina (30% vs 10%).
  post("e1:A", 1000, 300); post("e1:B", 1000, 100);
  // Negócio: B vende (R$ 500 fact), A não vende.
  const lb = lead(corrB); sale(corrB, lb, 500);
  const d1 = EXP.decide(org, e1.id, "u");
  check("1.1 decisão por resultado de negócio (basis)", d1.basis === "business_outcome");
  check("1.2 vencedor é B (vendeu), não A (engajou)", d1.decision === "winner" && d1.winnerVariantKey === "e1:B");
  check("1.3 razão cita RESULTADO DE NEGÓCIO", /RESULTADO DE NEGÓCIO|BUSINESS VALUE/.test(d1.reason));
  check("1.4 outcomes expõem receita por variante", d1.outcomes?.find((o: any) => o.variantKey === "e1:B")?.revenueFact === 500);
  const g1 = EXP.get(org, e1.id);
  check("1.5 campeão marcado em B", g1.variants.find((v: any) => v.variantKey === "e1:B").isChampion === 1 && g1.variants.find((v: any) => v.variantKey === "e1:A").isChampion === 0);

  // ── 2. Sem desfecho de negócio → cai pro ENGAJAMENTO (F6, 0-regressão) ──
  const e2 = EXP.create(org, "u", { hypothesis: "só engajamento", variants: [
    { variantKey: "e2:A", label: "A" }, { variantKey: "e2:B", label: "B" },
  ]});
  post("e2:A", 1000, 300); post("e2:B", 1000, 190); // A 30% vs B 19% → z alto
  const d2 = EXP.decide(org, e2.id);
  check("2.1 basis engagement (sem negócio)", d2.basis === "engagement");
  check("2.2 vencedor por engajamento = A", d2.decision === "winner" && d2.winnerVariantKey === "e2:A");
  check("2.3 z calculado", (d2.z || 0) >= 1.96);

  // ── 3. Dinheiro provado ANTES de lead: A tem 5 leads, B tem 1 venda (R$100) → B vence ──
  const corrC = "campaign:C", corrD = "campaign:D";
  const e3 = EXP.create(org, "u", { hypothesis: "receita > leads", variants: [
    { variantKey: "e3:A", label: "Muitos leads", correlationId: corrC },
    { variantKey: "e3:B", label: "Uma venda", correlationId: corrD },
  ]});
  for (let i = 0; i < 5; i++) lead(corrC);           // A: 5 leads, 0 receita
  const ld = lead(corrD); sale(corrD, ld, 100);       // B: 1 lead, R$100 fact
  const d3 = EXP.decide(org, e3.id);
  check("3.1 receita fact vence leads", d3.decision === "winner" && d3.winnerVariantKey === "e3:B" && d3.basis === "business_outcome");

  // ── 4. Empate no negócio → inconclusive (não decide no ruído) ──
  const corrE = "campaign:E", corrF = "campaign:F";
  const e4 = EXP.create(org, "u", { hypothesis: "empate", variants: [
    { variantKey: "e4:A", correlationId: corrE }, { variantKey: "e4:B", correlationId: corrF },
  ]});
  const la = lead(corrE); sale(corrE, la, 200);
  const lf = lead(corrF); sale(corrF, lf, 200); // mesma receita → empate
  const d4 = EXP.decide(org, e4.id);
  check("4.1 empate de receita → inconclusive", d4.decision === "inconclusive" && d4.winnerVariantKey === null);

  // ── 5. Leads decidem quando não há receita ──
  const corrG = "campaign:G", corrH = "campaign:H";
  const e5 = EXP.create(org, "u", { hypothesis: "leads decidem", variants: [
    { variantKey: "e5:A", correlationId: corrG }, { variantKey: "e5:B", correlationId: corrH },
  ]});
  for (let i = 0; i < 3; i++) lead(corrG); // A: 3 leads
  lead(corrH);                              // B: 1 lead
  const d5 = EXP.decide(org, e5.id);
  check("5.1 mais leads vence (sem receita)", d5.decision === "winner" && d5.winnerVariantKey === "e5:A" && d5.basis === "business_outcome");

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} objective-aware-winner: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
