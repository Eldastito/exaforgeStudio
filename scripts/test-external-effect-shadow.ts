/**
 * TEST — External Effect Shadow (F1.1 B1, PRD-ZF-UNIFIED-GAP-CLOSURE-03). Prontidão de
 * migração do choke-point: read-only, zero-touch nos caminhos de envio.
 *
 * Cobre: 6 sinks mapeados · org SEM política → wouldAutoExecute (auto-semeado, sem divergência)
 * · org COM política restritiva (execution_mode='assisted' ou autonomy!=execute) → divergência
 * · flag já ON → sem divergência (já governado) · resumo readyToFlip · analyzeAll separa prontas
 * de divergentes · isolamento · NÃO liga flag / NÃO semeia política (read-only).
 *
 * Uso: npm run test:external-effect-shadow
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-shadow-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-shadow-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExternalEffectShadowService: SH, EXTERNAL_SINKS } = await import("../src/server/ExternalEffectShadowService.js");

  // ── Org A: sem política nenhuma → todos os sinks enviariam (auto-semeado), sem divergência ──
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const rA = SH.analyze(A);
  check("1.1 mapeia 6 sinks", rA.sinks.length === 6 && EXTERNAL_SINKS.length === 6);
  check("1.2 sem política → todos wouldAutoExecute", rA.sinks.every((s) => s.wouldAutoExecute === true && s.policyExists === false));
  check("1.3 sem divergência (flip seguro)", rA.summary.divergences === 0 && rA.summary.readyToFlip === true);

  // ── Org B: política restritiva pra collection_followup (mode 'assisted') → divergência ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'collection', 'collection_followup', 'execute', 'assisted', 1)`).run(randomUUID(), B);
  const rB = SH.analyze(B);
  const fu = rB.sinks.find((s) => s.actionType === "collection_followup")!;
  check("2.1 política existente detectada", fu.policyExists === true);
  check("2.2 mode 'assisted' → NÃO auto-executa (seguraria)", fu.wouldAutoExecute === false);
  check("2.3 divergência sinalizada (flag off + seguraria)", fu.divergence === true && /SEGURA/.test(fu.reason));
  check("2.4 resumo aponta não-pronto", rB.summary.divergences >= 1 && rB.summary.readyToFlip === false);
  // outros sinks de B (sem política) seguem sem divergência
  check("2.5 sinks sem política de B seguem ok", rB.sinks.filter((s) => s.actionType !== "collection_followup").every((s) => s.divergence === false));

  // ── Org C: política execute/approved_execution → envia (sem divergência) ──
  const C = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'C', 'active')`).run(randomUUID(), C);
  db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'sales', 'sales_recovery_send', 'execute', 'approved_execution', 1)`).run(randomUUID(), C);
  const sc = SH.analyze(C).sinks.find((s) => s.actionType === "sales_recovery_send")!;
  check("3.1 política execute/approved_execution → auto-executa", sc.wouldAutoExecute === true && sc.divergence === false);

  // ── Org D: flag JÁ ligada → já governado, sem divergência mesmo com política restritiva ──
  const D = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, prospect_via_executor_enabled) VALUES (?, ?, 'D', 'active', 1)`).run(randomUUID(), D);
  db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'prospect', 'prospect_outreach_whatsapp', 'suggest', 'assisted', 1)`).run(randomUUID(), D);
  const pw = SH.analyze(D).sinks.find((s) => s.actionType === "prospect_outreach_whatsapp")!;
  check("4.1 flag ON → sem divergência (já governado, não é 'mudança')", pw.flagOn === true && pw.divergence === false);

  // ── analyzeAll separa prontas de divergentes ──
  const all = SH.analyzeAll({ limit: 100 });
  check("5.1 conta orgs + separa prontas/divergentes", all.orgsAnalyzed >= 4 && all.orgsReady >= 2 && all.orgsWithDivergence.some((o) => o.orgId === B));

  // ── Read-only: não ligou flag nem semeou política ──
  const bFlag = db.prepare(`SELECT COALESCE(collection_cadence_via_executor_enabled,0) v FROM organization_settings WHERE organization_id = ?`).get(B) as any;
  check("6.1 NÃO ligou flag de B (read-only)", Number(bFlag.v) === 0);
  const aPolicies = db.prepare(`SELECT COUNT(*) c FROM agent_policies WHERE organization_id = ?`).get(A) as any;
  check("6.2 NÃO semeou política em A (read-only)", Number(aPolicies.c) === 0);

  // ── Isolamento ──
  check("7.1 A e B independentes", SH.analyze(A).summary.divergences === 0 && SH.analyze(B).summary.divergences >= 1);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} external-effect-shadow: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
