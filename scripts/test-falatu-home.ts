/**
 * TEST — PRD 1 Fase 9 (§zero-training): a "home" do Fala Tu. Ao abrir, tudo que
 * importa num payload só — pura composição da Smart Inbox (F3) + aprovações (F4)
 * + execução (F6) + proativo (F8), sempre no escopo do papel.
 *
 * Prova (determinístico; `now` fixo):
 *   - saudação pela hora (SP);
 *   - resumo = contagens por categoria; highlights ranqueados por score;
 *   - approvals e execution presentes;
 *   - escopo por papel: a home do vendedor não vaza finanças.
 *
 * Uso: npm run test:falatu-home
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-home-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-home-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const MORNING = new Date("2026-08-10T13:00:00Z"); // 10h SP → "Bom dia"
const EVENING = new Date("2026-08-10T23:00:00Z"); // 20h SP → "Boa noite"

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuHomeService: FH } = await import("../src/server/FalaTuHomeService.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, falatu_proactive_alerts_enabled) VALUES (?, ?, 'X', 'active', 1)`).run(randomUUID(), org);
  PermissionService.seedSystemProfiles(org);
  const userFor = (key: string) => ({ userId: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id, role: key });
  const owner = userFor("owner"), vendedor = userFor("vendedor");

  // Itens: aprovação (sales) + risco crítico (finance) + oportunidade (sales) + processo ativo.
  db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, approval_policy, created_by, priority_score, expected_impact, impact_unit) VALUES (?, ?, 'sales', 'refund', 'Aprovar compra', 'awaiting_approval', 'single', 'rule', 10, 5000, 'BRL')`).run(randomUUID(), org);
  BS.publish(org, { domain: "finance", signalType: "cash_low", severity: "critical", basis: "fact", confidence: 0.9, sourceService: "test", dedupeKey: "r1", impactAmount: 9000, impactUnit: "BRL", evidence: {} });
  BS.publish(org, { domain: "sales", signalType: "sales_opportunity_upsell", severity: "attention", basis: "estimate", confidence: 0.7, sourceService: "test", dedupeKey: "o1", impactAmount: 1200, impactUnit: "BRL", evidence: {} });
  db.prepare(`INSERT INTO process_instances (id, organization_id, process_definition_id, process_type, status, priority, context_json, started_at) VALUES (?, ?, 'def', 'cobranca', 'executing', 5, '{}', ?)`).run(randomUUID(), org, MORNING.toISOString());

  // ===== 1. Estrutura + saudação =====
  const h = FH.home(org, owner, { now: MORNING });
  check("1.1 saudação pela hora (Bom dia às 10h SP)", h.greeting === "Bom dia");
  check("1.2 saudação muda à noite", FH.home(org, owner, { now: EVENING }).greeting === "Boa noite");
  check("1.3 resumo traz contagens por categoria", h.summary.needsApproval === 1 && h.summary.risk === 1 && h.summary.opportunity === 1 && h.summary.inExecution === 1);
  check("1.4 proactiveEnabled reflete o opt-in da org", h.proactiveEnabled === true);

  // ===== 2. Highlights ranqueados (o que pede ação) =====
  check("2.1 highlights traz até 5 itens de ação, ranqueados por score", h.highlights.length === 3 && h.highlights.every((x: any, i: number) => i === 0 || x.score <= h.highlights[i - 1].score));
  check("2.2 highlights inclui a aprovação e o risco crítico", h.highlights.some((x: any) => x.category === "needsApproval") && h.highlights.some((x: any) => x.category === "risk"));

  // ===== 3. Aprovações + execução compostas =====
  check("3.1 approvals traz a aprovação pendente", h.approvals.total === 1 && h.approvals.items[0].canApprove === true);
  check("3.2 execution traz o processo ativo agrupado", h.execution.total === 1 && h.execution.byType[0].type === "cobranca");

  // ===== 4. Escopo por papel: a home do vendedor não vaza finanças =====
  const hv = FH.home(org, vendedor, { now: MORNING });
  check("4.1 vendedor: resumo sem risco financeiro", hv.summary.risk === 0);
  check("4.2 vendedor: highlights não incluem finance", !hv.highlights.some((x: any) => x.domain === "finance"));
  check("4.3 vendedor: ainda vê aprovação de sales + oportunidade", hv.approvals.total === 1 && hv.summary.opportunity === 1);

  console.log("\n=== TEST: Home do Fala Tu (PRD 1 Fase 9) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Home do Fala Tu (Fase 9) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
