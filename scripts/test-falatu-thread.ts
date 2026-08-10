/**
 * TEST — PRD 1 Fase 6 (§48-52): status de execução + threads por correlation_id.
 *
 * Prova (determinístico; espinha ADR-158 real):
 *   - executionStatus (§48): agrega processos ATIVOS por tipo (ignora concluídos);
 *   - thread (§51-52): monta a linha do tempo do que compartilha correlation_id,
 *     em ordem entrada→sinal→decisão→execução→resultado;
 *   - filtro por papel: vendedor não vê os estágios de domínio procurement;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:falatu-thread
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-thread-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-thread-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const NOW = Date.parse("2026-08-10T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuThreadService: FT } = await import("../src/server/FalaTuThreadService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PermissionService.seedSystemProfiles(id); return id; };
  const org = mkOrg();
  const userFor = (key: string) => ({ userId: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id, role: key });
  const owner = userFor("owner"), vendedor = userFor("vendedor");

  const CID = "corr-CASE-1";
  // Cadeia correlacionada (procurement): entrada → sinal → decisão → execução → resultado
  db.prepare(`INSERT INTO falatu_inbox_items (id, organization_id, user_id, source, content, summary, intent, status, correlation_id, created_at) VALUES (?, ?, ?, 'webapp', 'fornecedor atrasou', 'Fornecedor atrasou', 'NOTE', 'confirmed', ?, ?)`).run(randomUUID(), org, owner.userId, CID, iso(NOW));
  db.prepare(`INSERT INTO business_signals (id, organization_id, domain, signal_type, severity, basis, confidence, source_service, evidence_json, dedupe_key, status, detected_at, correlation_id) VALUES (?, ?, 'procurement', 'supplier_delay', 'risk', 'fact', 0.9, 'test', '{}', 'd1', 'open', ?, ?)`).run(randomUUID(), org, iso(NOW + 60e3), CID);
  const actId = randomUUID();
  const procId = randomUUID();
  db.prepare(`INSERT INTO process_instances (id, organization_id, process_definition_id, process_type, status, priority, context_json, started_at, completed_at) VALUES (?, ?, 'def', 'compra', 'completed', 0, '{}', ?, ?)`).run(procId, org, iso(NOW + 240e3), iso(NOW + 300e3));
  db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, approval_policy, created_by, created_at, approved_at, correlation_id, process_instance_id) VALUES (?, ?, 'procurement', 'create_purchase_order', 'Comprar do fornecedor B', 'approved', 'single', 'rule', ?, ?, ?, ?)`).run(actId, org, iso(NOW + 120e3), iso(NOW + 180e3), CID, procId);
  db.prepare(`INSERT INTO action_outcomes (id, organization_id, action_id, expected_value, realized_value, basis, measurement_method, measured_at, correlation_id) VALUES (?, ?, ?, 100, 120, 'fact', 'manual', ?, ?)`).run(randomUUID(), org, actId, iso(NOW + 360e3), CID);

  // ===== 1. thread: linha do tempo completa (owner) =====
  const th = FT.thread(org, owner, CID);
  const stages = th.events.map((e: any) => e.stage);
  check("1.1 thread traz os 5 estágios em ordem", JSON.stringify(stages) === JSON.stringify(["entrada", "sinal", "decisao", "execucao", "resultado"]));
  check("1.2 estágio decisão reflete o status approved", th.events.find((e: any) => e.stage === "decisao")?.status === "approved");
  check("1.3 resultado traz esperado→realizado", /100.*120/.test(th.events.find((e: any) => e.stage === "resultado")?.detail || ""));

  // ===== 2. Filtro por papel: caso de procurement é invisível pro vendedor =====
  const thV = FT.thread(org, vendedor, CID);
  const vStages = thV.events.map((e: any) => e.stage);
  check("2.1 vendedor NÃO vê sinal/decisão/resultado (domínio procurement)", !vStages.includes("sinal") && !vStages.includes("decisao") && !vStages.includes("resultado"));
  check("2.2 vendedor não vê a entrada de OUTRO usuário (inbox pessoal)", !vStages.includes("entrada"));
  check("2.3 execução herda o gate da ação → também some pro vendedor (thread vazia)", !vStages.includes("execucao") && thV.events.length === 0);

  // ===== 3. executionStatus: agrega ativos por tipo =====
  const mkProc = (type: string, status: string) => db.prepare(`INSERT INTO process_instances (id, organization_id, process_definition_id, process_type, status, priority, context_json, started_at) VALUES (?, ?, 'def', ?, ?, 0, '{}', ?)`).run(randomUUID(), org, type, status, iso(NOW));
  mkProc("cobranca", "executing"); mkProc("cobranca", "queued"); mkProc("recuperacao", "executing");
  const st = FT.executionStatus(org, owner);
  check("3.1 total de ativos = 3 (o 'compra' completed NÃO conta)", st.total === 3);
  check("3.2 agrupa por tipo: 2 cobranças + 1 recuperação", st.byType.find((b: any) => b.type === "cobranca")?.count === 2 && st.byType.find((b: any) => b.type === "recuperacao")?.count === 1);

  // ===== 4. Isolamento multi-tenant =====
  const orgB = mkOrg();
  check("4.1 thread da cadeia não existe em outra org", FT.thread(orgB, owner, CID).events.length === 0);

  console.log("\n=== TEST: Threads + status de execução (PRD 1 Fase 6) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Threads + status de execução (Fase 6) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
