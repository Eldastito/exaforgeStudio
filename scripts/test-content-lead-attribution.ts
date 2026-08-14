/**
 * TEST — Content→Lead Attribution (PRD 11 / ADR-168 F7). DB-backed, determinístico.
 * Prova: registra lead→conteúdo (valida contato, idempotente RN-CG-03); ContentOutcomeResolver
 * no registry do PRD 8 (§37) responde confirmed/not_confirmed/unknown pela system-of-record;
 * ENGAGEMENT≠BUSINESS VALUE (lead é o 1º valor); isolamento multi-tenant.
 *
 * Uso: npm run test:content-lead-attribution
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clead-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-clead-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ContentLeadAttributionService: ATTR } = await import("../src/server/ContentLeadAttributionService.js");
  const { BusinessOutcomeResolverRegistry } = await import("../src/server/BusinessOutcomeResolver.js");

  const orgA = `org_cl_${randomUUID().slice(0, 8)}`;
  const orgB = `org_cl_${randomUUID().slice(0, 8)}`;
  for (const o of [orgA, orgB]) {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  }
  const contact = (org: string) => { const id = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', 'Lead', ?)`).run(id, org, id); return id; };
  const cA1 = contact(orgA); const cA2 = contact(orgA); const cB1 = contact(orgB);
  const corr = "campaign:xyz";

  // ── 1. Schema ──
  check("1.1 tabela content_lead_attributions", !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='content_lead_attributions'`).get());
  check("1.2 registry inclui domínio 'content'", BusinessOutcomeResolverRegistry.domains().includes("content"));

  // ── 2. attribute valida contato + idempotência (RN-CG-03) ──
  let threw = false;
  try { ATTR.attribute(orgA, { correlationId: corr, contactId: "inexistente" }); } catch { threw = true; }
  check("2.1 contato inexistente rejeitado (não inventa lead)", threw);
  const a1 = ATTR.attribute(orgA, { correlationId: corr, contactId: cA1, source: "utm" });
  check("2.2 1º atribui", a1.attributed === true && a1.alreadyExisted === false);
  const a1b = ATTR.attribute(orgA, { correlationId: corr, contactId: cA1, source: "utm" });
  check("2.3 reatribuir mesmo lead é no-op (sem dupla contagem)", a1b.attributed === false && a1b.alreadyExisted === true);
  check("2.4 leadCount = 1 (não dobrou)", ATTR.leadCount(orgA, corr) === 1);

  // ── 3. Resolver: sem correlation → unknown; sem lead → not_confirmed; com lead → confirmed ──
  const rNoCorr = BusinessOutcomeResolverRegistry.resolve(orgA, { command_type: "social_publish", correlation_id: null });
  check("3.1 sem correlation → unknown", rNoCorr.resolved === "unknown" && rNoCorr.reason === "no_correlation_link");

  const rNoLead = BusinessOutcomeResolverRegistry.resolve(orgA, { command_type: "social_publish", correlation_id: "campaign:sem-lead" });
  check("3.2 conteúdo sem lead → not_confirmed (não é falha, RN-OA-2)", rNoLead.resolved === "not_confirmed" && rNoLead.reason === "no_lead_yet");

  const rLead = BusinessOutcomeResolverRegistry.resolve(orgA, { command_type: "social_publish", correlation_id: corr });
  check("3.3 conteúdo com lead → confirmed", rLead.resolved === "confirmed" && rLead.reason === "lead_generated");
  check("3.4 basis system_of_record (nunca LLM, RN-CG-02)", rLead.basis === "system_of_record");
  check("3.5 evidência traz leadCount + stage lead", rLead.evidence?.leadCount === 1 && rLead.evidence?.stage === "lead");

  // ── 4. 2 leads no mesmo conteúdo → count 2 ──
  ATTR.attribute(orgA, { correlationId: corr, contactId: cA2, source: "whatsapp_ref" });
  check("4.1 leadCount = 2", ATTR.leadCount(orgA, corr) === 2);
  check("4.2 leadsFor lista os 2", ATTR.leadsFor(orgA, corr).length === 2);
  check("4.3 resolver reflete 2 leads", (BusinessOutcomeResolverRegistry.resolve(orgA, { command_type: "social_publish", correlation_id: corr }).evidence?.leadCount) === 2);

  // ── 5. appliesTo só social_publish (outro comando → resolver_pending/não-content) ──
  const rOther = BusinessOutcomeResolverRegistry.resolve(orgA, { command_type: "algo_qualquer", correlation_id: corr, domain: "x" });
  check("5.1 comando não-social não vira content", rOther.domain !== "content");

  // ── 6. Isolamento multi-tenant ──
  check("6.1 org B não conta o lead de A", ATTR.leadCount(orgB, corr) === 0);
  let threwB = false;
  try { ATTR.attribute(orgB, { correlationId: corr, contactId: cA1 }); } catch { threwB = true; } // contato de A não existe em B
  check("6.2 lead cross-tenant rejeitado", threwB);
  ATTR.attribute(orgB, { correlationId: corr, contactId: cB1 });
  check("6.3 org B isolado", ATTR.leadCount(orgB, corr) === 1 && ATTR.leadCount(orgA, corr) === 2);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} content-lead-attribution: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
