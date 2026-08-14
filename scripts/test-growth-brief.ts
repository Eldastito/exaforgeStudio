/**
 * TEST — Fala Tu Growth Brief (PRD 11 / ADR-168 F13). DB-backed, determinístico.
 * Prova: growthBrief COMPÕE (read-only) o que postar (conteúdo F7 + produto F11), o impacto
 * esperado (metas de conteúdo F12) e o campeão atual (F6/F9); honesto (org vazia → tudo
 * vazio, headline null); produto sem R$ (marginBand); isolamento; digest() intacto (0-regressão).
 *
 * Uso: npm run test:growth-brief
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-gbrief-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-gbrief-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SocialProactivityService: SP } = await import("../src/server/SocialProactivityService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { BusinessGoalService } = await import("../src/server/BusinessGoalService.js");
  const { CreativeExperimentService: EXP } = await import("../src/server/CreativeExperimentService.js");

  const org = `org_gb_${randomUUID().slice(0, 8)}`;
  const orgB = `org_gb_${randomUUID().slice(0, 8)}`;
  for (const o of [org, orgB]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);

  // ── 0. Org vazia → brief honesto (tudo vazio) ──
  const empty = SP.growthBrief(org);
  check("0.1 org vazia: whatToPost vazio", empty.whatToPost.length === 0);
  check("0.2 org vazia: sem meta", empty.goals.length === 0);
  check("0.3 org vazia: sem campeão", empty.champions.length === 0);
  check("0.4 org vazia: headline null", empty.headline === null);

  // ── setup: conteúdo (F7) + produto (F11) + meta (F12) + campeão (F6/F9) ──
  // Oportunidade de conteúdo na espinha.
  BusinessSignalService.publish(org, {
    domain: "social", signalType: "content_opportunity", severity: "attention", basis: "hypothesis",
    confidence: 0.5, impactAmount: null, sourceService: "test", subjectType: "opportunity",
    subjectId: "social_opportunity:moda:linho:instagram", dedupeKey: "social_opportunity:moda:linho:instagram",
    evidence: { vertical: "moda", topic: "linho", channel: "instagram", note: "Assunto em alta." },
  });
  // Produto de alta margem em estoque sem venda.
  const pid = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Camisa linho', 100, 1)`).run(pid, org);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 10, 40)`).run(randomUUID(), org, pid);
  // Meta de conteúdo + uma venda atribuída este mês.
  BusinessGoalService.set(org, { metric: "content_revenue", targetAmount: 1000, actor: "owner" });
  db.prepare(`INSERT INTO content_sale_attributions (id, organization_id, correlation_id, contact_id, revenue, revenue_basis, source) VALUES (?, ?, 'corr:champ', ?, 300, 'fact', 'orders')`).run(randomUUID(), org, randomUUID());
  // Experimento com campeão por negócio (F9).
  const e = EXP.create(org, "u", { hypothesis: "qual vende", variants: [{ variantKey: "x:A", correlationId: "corr:champ" }, { variantKey: "x:B", correlationId: "corr:other" }] });
  EXP.decide(org, e.id);

  // ── 1. whatToPost: conteúdo + produto ──
  const b = SP.growthBrief(org);
  check("1.1 whatToPost inclui conteúdo (linho)", b.whatToPost.some((w: any) => w.kind === "content" && w.label === "linho"));
  check("1.2 whatToPost inclui produto (Camisa linho)", b.whatToPost.some((w: any) => w.kind === "product" && w.label === "Camisa linho"));
  const prod = b.whatToPost.find((w: any) => w.kind === "product")!;
  check("1.3 produto traz marginBand qualitativo (sem R$)", prod.marginBand === "high" && !/\d{2,}/.test(prod.reason));

  // ── 2. Impacto esperado: meta de conteúdo com distância-à-meta ──
  const gRev = b.goals.find((g: any) => g.metric === "content_revenue");
  check("2.1 meta content_revenue presente", !!gRev && gRev.target === 1000);
  check("2.2 distância-à-meta derivada (current 300, remaining 700)", gRev!.current === 300 && gRev!.remaining === 700);

  // ── 3. Campeão atual ──
  check("3.1 campeão do experimento decidido", b.champions.some((c: any) => c.experimentId === e.id && c.winnerVariantKey === "x:A"));

  // ── 4. Headline humana ──
  check("4.1 headline compõe as seções", !!b.headline && /ideia/.test(b.headline) && /meta/.test(b.headline) && /campe/.test(b.headline));

  // ── 5. digest() intacto (0-regressão) ──
  const dig = SP.digest(org);
  check("5.1 digest ainda funciona", Array.isArray(dig.opportunities) && dig.opportunities.some((o: any) => o.topic === "linho"));

  // ── 6. Isolamento ──
  const bb = SP.growthBrief(orgB);
  check("6.1 org B não vê nada de A", bb.whatToPost.length === 0 && bb.goals.length === 0 && bb.champions.length === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} growth-brief: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
