/**
 * TEST — Growth Autopilot shadow (PRD 11 / ADR-168 F15). DB-backed, determinístico.
 * Prova: postura shadow-first (off|shadow, 'auto' rejeitado RN-CG-10); plan() PROPÕE
 * (promover campeão F9 / produto F11 / criar conteúdo F7) mas NUNCA executa (RN-CG-08 — nada
 * em decision_actions; requiresApproval sempre true); isolamento.
 *
 * Uso: npm run test:growth-autopilot
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-autopilot-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-autopilot-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { GrowthAutopilotService: AP } = await import("../src/server/GrowthAutopilotService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { CreativeExperimentService: EXP } = await import("../src/server/CreativeExperimentService.js");

  const org = `org_ap_${randomUUID().slice(0, 8)}`;
  const orgB = `org_ap_${randomUUID().slice(0, 8)}`;
  for (const o of [org, orgB]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);

  // ── 1. Postura shadow-first ──
  check("1.1 default off", AP.mode(org) === "off");
  check("1.2 setMode shadow ok", AP.setMode(org, "shadow").mode === "shadow" && AP.mode(org) === "shadow");
  let threw = false;
  try { AP.setMode(org, "auto"); } catch { threw = true; }
  check("1.3 'auto' REJEITADO (RN-CG-10 — nunca executa direto)", threw && AP.mode(org) === "shadow");

  // ── setup: campeão (F9) + produto (F11) + conteúdo (F7) ──
  BusinessSignalService.publish(org, {
    domain: "social", signalType: "content_opportunity", severity: "attention", basis: "hypothesis",
    confidence: 0.5, impactAmount: null, sourceService: "test", subjectType: "opportunity",
    subjectId: "social_opportunity:moda:linho:instagram", dedupeKey: "social_opportunity:moda:linho:instagram",
    evidence: { vertical: "moda", topic: "linho", channel: "instagram", note: "Em alta." },
  });
  const pid = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Camisa linho', 100, 1)`).run(pid, org);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 10, 40)`).run(randomUUID(), org, pid);
  db.prepare(`INSERT INTO content_sale_attributions (id, organization_id, correlation_id, contact_id, revenue, revenue_basis, source) VALUES (?, ?, 'corr:champ', ?, 300, 'fact', 'orders')`).run(randomUUID(), org, randomUUID());
  const e = EXP.create(org, "u", { hypothesis: "qual vende", variants: [{ variantKey: "x:A", correlationId: "corr:champ" }, { variantKey: "x:B", correlationId: "corr:other" }] });
  EXP.decide(org, e.id);

  // ── 2. plan(): propõe as 3 espécies, sempre requiresApproval + nunca executa ──
  const plan = AP.plan(org);
  check("2.1 shadow → active true", plan.mode === "shadow" && plan.active === true);
  check("2.2 propõe promover campeão", plan.proposals.some((p: any) => p.kind === "promote_champion" && p.label === "x:A"));
  check("2.3 propõe promover produto", plan.proposals.some((p: any) => p.kind === "promote_product" && p.label === "Camisa linho"));
  check("2.4 propõe criar conteúdo", plan.proposals.some((p: any) => p.kind === "create_content" && p.label === "linho"));
  check("2.5 TODA proposta exige aprovação (RN-CG-10)", plan.proposals.every((p: any) => p.requiresApproval === true));
  check("2.6 NENHUMA executa (RN-CG-08)", plan.proposals.every((p: any) => p.wouldExecute === false));

  // ── 3. RN-CG-08: plan NÃO escreve decision_actions (não executa nem propõe comando) ──
  check("3.1 nenhuma decision_action criada pelo autopilot", (db.prepare(`SELECT COUNT(*) AS n FROM decision_actions WHERE organization_id = ?`).get(org) as any).n === 0);

  // ── 4. off → active false (não surface proativamente), mas plan ainda computa a prévia ──
  AP.setMode(org, "off");
  const off = AP.plan(org);
  check("4.1 off → active false", off.mode === "off" && off.active === false);
  check("4.2 off ainda computa a prévia (read-only)", off.proposals.length >= 3);

  // ── 5. Isolamento ──
  const bplan = AP.plan(orgB);
  check("5.1 org B vazio (isolamento)", bplan.proposals.length === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} growth-autopilot: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
