/**
 * TEST — PRD 1 Fase 3 (§20-23, §60): Smart Inbox. COMPÕE signals +
 * decision_actions + runtime em categorias por AÇÃO, ranqueadas (não cronológicas)
 * e filtradas por papel. Não cria fonte de alertas nova (CA15).
 *
 * Prova (determinístico; `now` fixo; engines canônicos reais):
 *   - categorização (§21): aprovação/decisão (actions), risco/oportunidade/info
 *     (signals), execução/resolvido (processes);
 *   - "resolvido" só o recente (janela 48h);
 *   - ranking por score desc (§22), não cronologia;
 *   - escopo por papel: vendedor não vê finance (risco) nem procurement (decisão).
 *
 * Uso: npm run test:smart-inbox
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-smart-inbox-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-smart-inbox-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const NOW = Date.parse("2026-08-10T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SmartInboxService: SI } = await import("../src/server/SmartInboxService.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  PermissionService.seedSystemProfiles(org);
  const userFor = (key: string) => ({ userId: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id, role: key });
  const owner = userFor("owner"), vendedor = userFor("vendedor");

  // ── Sinais (via publish) ──
  BS.publish(org, { domain: "finance", signalType: "cash_low", severity: "critical", basis: "fact", confidence: 0.9, sourceService: "test", dedupeKey: "f1", impactAmount: 8000, impactUnit: "BRL", evidence: {} });
  BS.publish(org, { domain: "sales", signalType: "sales_opportunity_upsell", severity: "attention", basis: "estimate", confidence: 0.7, sourceService: "test", dedupeKey: "o1", impactAmount: 1200, impactUnit: "BRL", evidence: {} });
  BS.publish(org, { domain: "tasks", signalType: "tasks_summary", severity: "info", basis: "fact", confidence: 1, sourceService: "test", dedupeKey: "i1", evidence: {} });

  // ── Ações (insert direto p/ controlar status) ──
  const act = (domain: string, title: string, status: string, extra: Record<string, any> = {}) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, priority_score, expected_impact, impact_unit, status, approval_policy, created_by, due_at, completed_at) VALUES (?, ?, ?, 'x', ?, ?, ?, 'BRL', ?, 'single', 'rule', ?, ?)`)
      .run(id, org, domain, title, extra.priority ?? 0, extra.impact ?? null, status, extra.dueAt ?? null, extra.completedAt ?? null);
    return id;
  };
  const apprA = act("sales", "Aprovar compra", "awaiting_approval", { priority: 10, impact: 5000, dueAt: iso(NOW + 12 * 3600e3) });
  const apprB = act("sales", "Aprovar reembolso", "awaiting_approval", { priority: 1, impact: 300 });
  act("procurement", "Decidir fornecedor", "proposed", { priority: 5 });
  act("sales", "Recuperação feita", "done", { completedAt: iso(NOW - 3600e3) });          // recente → resolvido
  act("sales", "Coisa antiga", "done", { completedAt: iso(NOW - 3 * 24 * 3600e3) });        // 3 dias → NÃO

  // ── Processos ──
  const proc = (type: string, status: string, extra: Record<string, any> = {}) => {
    db.prepare(`INSERT INTO process_instances (id, organization_id, process_definition_id, process_type, status, priority, risk_level, context_json, started_at, completed_at) VALUES (?, ?, 'def', ?, ?, ?, ?, '{}', ?, ?)`)
      .run(randomUUID(), org, type, status, extra.priority ?? 0, extra.risk ?? null, iso(NOW - 7200e3), extra.completedAt ?? null);
  };
  proc("cobranca", "executing", { priority: 20, risk: "high" });
  proc("recuperacao", "measured", { completedAt: iso(NOW - 3600e3) });                      // resolvido recente

  // ===== 1. Categorização (owner vê tudo) =====
  const inbox = SI.build(org, owner, { now: NOW });
  const ids = (c: string) => inbox.categories[c as keyof typeof inbox.categories].map((i: any) => i.id);
  check("1.1 needsApproval traz as 2 aprovações", inbox.counts.needsApproval === 2 && ids("needsApproval").includes(apprA));
  check("1.2 needsDecision traz a proposta", inbox.counts.needsDecision === 1);
  check("1.3 risk traz o sinal financeiro crítico", inbox.categories.risk.some((i: any) => i.domain === "finance" && i.severity === "critical"));
  check("1.4 opportunity traz o sinal de upsell", inbox.categories.opportunity.some((i: any) => /upsell/.test(i.title) || i.domain === "sales") && inbox.counts.opportunity === 1);
  check("1.5 info traz o sinal informativo", inbox.counts.info === 1 && inbox.categories.info[0].domain === "tasks");
  check("1.6 inExecution traz o processo ativo", inbox.counts.inExecution === 1 && inbox.categories.inExecution[0].status === "executing");

  // ===== 2. Resolvido só o recente (janela 48h) =====
  check("2.1 resolved traz ação + processo recentes (2), não o antigo", inbox.counts.resolved === 2 && !ids("resolved").includes("") );

  // ===== 3. Ranking por score desc (§22, não cronologia) =====
  check("3.1 needsApproval ordenado por score: apprA (impacto+prazo) antes de apprB", ids("needsApproval")[0] === apprA && ids("needsApproval")[1] === apprB);
  check("3.2 todo item carrega score numérico", inbox.categories.needsApproval.every((i: any) => typeof i.score === "number"));

  // ===== 4. Escopo por papel (segurança) =====
  const vInbox = SI.build(org, vendedor, { now: NOW });
  check("4.1 vendedor NÃO vê risco financeiro (domínio finance)", !vInbox.categories.risk.some((i: any) => i.domain === "finance"));
  check("4.2 vendedor NÃO vê decisão de procurement (domínio compras)", vInbox.counts.needsDecision === 0);
  check("4.3 vendedor VÊ as aprovações de vendas + a oportunidade de sales", vInbox.counts.needsApproval === 2 && vInbox.counts.opportunity === 1);

  console.log("\n=== TEST: Smart Inbox (PRD 1 Fase 3) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Smart Inbox (Fase 3) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
