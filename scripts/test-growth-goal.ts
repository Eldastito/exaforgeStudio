/**
 * TEST — Growth Goal metric + goal↔content (PRD 11 / ADR-168 F12). DB-backed, determinístico.
 * Prova: content_revenue/content_leads entram no registro schema-free de metas
 * (BusinessGoalService); derivam por query do mês (F7/F8); só `fact` conta na receita
 * (RN-CG-03); a meta de negócio passa a poder ser "o que o CONTEÚDO gerou"; Campaign
 * Objective Contract (F2) liga a ela; isolamento multi-tenant.
 *
 * Uso: npm run test:growth-goal
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-growth-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-growth-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { BusinessGoalService } = await import("../src/server/BusinessGoalService.js");
  const { CampaignObjectiveContractService: COC } = await import("../src/server/CampaignObjectiveContractService.js");

  const org = `org_gg_${randomUUID().slice(0, 8)}`;
  const orgB = `org_gg_${randomUUID().slice(0, 8)}`;
  for (const o of [org, orgB]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);

  const sale = (o: string, revenue: number, basis: string) => db.prepare(`INSERT INTO content_sale_attributions (id, organization_id, correlation_id, contact_id, revenue, revenue_basis, source) VALUES (?, ?, ?, ?, ?, ?, 'orders')`).run(randomUUID(), o, "c:x", randomUUID(), revenue, basis);
  const lead = (o: string) => db.prepare(`INSERT INTO content_lead_attributions (id, organization_id, correlation_id, contact_id) VALUES (?, ?, ?, ?)`).run(randomUUID(), o, "c:x", randomUUID());

  // ── 1. Métricas de crescimento no catálogo (extensão schema-free) ──
  const cat = BusinessGoalService.catalog();
  const metrics = cat.map((c: any) => c.metric);
  check("1.1 content_revenue no catálogo (BRL)", cat.some((c: any) => c.metric === "content_revenue" && c.unit === "BRL"));
  check("1.2 content_leads no catálogo (count)", cat.some((c: any) => c.metric === "content_leads" && c.unit === "count"));
  check("1.3 métricas legadas preservadas", metrics.includes("revenue") && metrics.includes("appointments"));
  check("1.4 isKnownMetric aceita content_revenue", BusinessGoalService.isKnownMetric("content_revenue"));

  // ── 2. content_revenue deriva do mês; só fact conta (RN-CG-03) ──
  sale(org, 300, "fact"); sale(org, 400, "fact"); sale(org, 999, "estimate"); // estimate NÃO conta
  BusinessGoalService.set(org, { metric: "content_revenue", targetAmount: 1000, actor: "owner" });
  const prog = BusinessGoalService.progress(org, { asOf: "2026-08-14T12:00:00Z", includeInactive: true });
  const gRev = prog.goals.find((g: any) => g.metric === "content_revenue")!;
  check("2.1 current = 700 (só fact, estimate fora)", gRev.current === 700);
  check("2.2 remaining = 300", gRev.remaining === 300);
  check("2.3 attainmentPct = 70", gRev.attainmentPct === 70);

  // ── 3. content_leads deriva a contagem do mês ──
  lead(org); lead(org); lead(org);
  BusinessGoalService.set(org, { metric: "content_leads", targetAmount: 10, actor: "owner" });
  const gLead = BusinessGoalService.progress(org, { includeInactive: true }).goals.find((g: any) => g.metric === "content_leads")!;
  check("3.1 content_leads current = 3", gLead.current === 3);

  // ── 4. goal↔content: Campaign Objective Contract (F2) liga a content_revenue ──
  const c1 = COC.create(org, "u", { objectiveId: "vendas", goalMetric: "content_revenue" });
  check("4.1 contrato liga objetivo→content_revenue", c1.goalMetric === "content_revenue" && c1.hasBusinessMetric === true);
  const cprog = COC.progress(org, c1.id, { asOf: "2026-08-14T12:00:00Z" })!;
  check("4.2 progresso do contrato rastreia a receita de conteúdo", cprog.goalDefined === true && cprog.goal?.metric === "content_revenue" && cprog.goal?.current === 700);

  // ── 5. Sem alvo definido → contrato honesto (goalDefined false) ──
  const c2 = COC.create(org, "u", { objectiveId: "engajamento", goalMetric: "content_leads" });
  // (há meta content_leads definida na etapa 3 → goalDefined true; testa o caminho sem meta noutra métrica)
  const c3 = COC.create(orgB, "u", { objectiveId: "vendas", goalMetric: "content_revenue" });
  check("5.1 sem alvo (org B) → goalDefined false (não inventa)", COC.progress(orgB, c3.id)!.goalDefined === false);

  // ── 6. Isolamento multi-tenant ──
  check("6.1 org B sem receita de conteúdo (0)", (() => { BusinessGoalService.set(orgB, { metric: "content_revenue", targetAmount: 500, actor: "o" }); return BusinessGoalService.progress(orgB, { includeInactive: true }).goals.find((g: any) => g.metric === "content_revenue")!.current === 0; })());

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} growth-goal: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
