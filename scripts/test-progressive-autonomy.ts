/**
 * TEST — ADR-159 F5 (D5): progressive autonomy (propõe elevação; nunca aplica).
 *
 * Prova, determinístico:
 *   - evaluate PROPÕE (sinal governance/autonomy_raise_proposed) quando a
 *     evidência é forte (≥ minDecided, ≥90% aprovação, 0 reversões, p90 dos
 *     valores aprovados > teto atual) — com evidência DERIVADA (RN-004);
 *   - NÃO propõe se amostra pequena, se houve reversão, ou se não há teto a subir;
 *   - a IA NUNCA aplica sozinha — o teto de auto NÃO muda até o accept;
 *   - accept (humano) exige actorId + motivo, aplica uma banda F3 (allow até o
 *     teto), audita (AUTONOMY_RAISE_APPLIED) e resolve o sinal;
 *   - accept sem motivo/identidade → lança; accept de sinal resolvido → lança;
 *   - isolamento por org.
 *
 * Uso: npm run test:progressive-autonomy
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-prog-autonomy-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-prog-autonomy-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
function throws(fn: () => any): boolean { try { fn(); return false; } catch { return true; } }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ProgressiveAutonomyService: PA } = await import("../src/server/ProgressiveAutonomyService.js");
  const { ApprovalPolicyService: AP } = await import("../src/server/ApprovalPolicyService.js");
  const { BusinessSignalService: SS } = await import("../src/server/BusinessSignalService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, progressive_autonomy_enabled) VALUES (?, ?, 'X', 'active', 1)`).run(randomUUID(), id); return id; };
  // Cria uma decisão histórica com status/valor dados (created_by='ai').
  const mkAction = (orgId: string, domain: string, actionType: string, status: string, amount: number | null, opts: { approved?: boolean } = {}) => {
    const id = randomUUID();
    const approvedAt = (opts.approved || ["approved", "done"].includes(status)) ? new Date().toISOString() : null;
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, expected_impact, created_by, approved_at) VALUES (?, ?, ?, ?, 'hist', ?, ?, 'ai', ?)`)
      .run(id, orgId, domain, actionType, status, amount, approvedAt);
    return id;
  };
  const proposalFor = (orgId: string) => SS.list(orgId, { status: "open", domain: "governance" }).find((s: any) => s.signal_type === "autonomy_raise_proposed");
  const auditCount = (orgId: string, ev: string) => (db.prepare(`SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND event_type = ?`).get(orgId, ev) as any).n;

  // ===== 1. Evidência forte → PROPÕE (não aplica) =====
  const orgA = mkOrg();
  // 12 aprovadas (valores 100..1200), 0 rejeitadas, 0 reversões.
  for (let i = 1; i <= 12; i++) mkAction(orgA, "procurement", "prepare_purchase", "approved", i * 100);
  const capBefore = AP.resolveContract(orgA, { domain: "procurement", actionType: "prepare_purchase", amount: 1 });
  const r1 = PA.evaluate(orgA);
  check("evaluate propõe 1 elevação (evidência forte)", r1.proposed === 1);
  const prop = proposalFor(orgA);
  check("proposta é governance/autonomy_raise_proposed", !!prop && prop.signal_type === "autonomy_raise_proposed");
  check("evidência DERIVADA: 12 decididas, 100% aprovação, 0 reversões", prop.evidence?.decided === 12 && prop.evidence?.approvalRate === 1 && prop.evidence?.reversed === 0);
  check("proposedCap = p90 dos aprovados (>0) + impactUnit BRL", prop.evidence?.proposedCap > 0 && prop.impact_unit === "BRL");
  check("IA NÃO aplicou sozinha: ainda não há banda enforced", capBefore.enforced === false && AP.resolveContract(orgA, { domain: "procurement", actionType: "prepare_purchase", amount: 1 }).enforced === false);

  // idempotência: re-evaluate não duplica a proposta viva
  const r1b = PA.evaluate(orgA);
  check("re-evaluate não duplica (dedupe)", r1b.proposed === 1 && SS.list(orgA, { status: "open", domain: "governance" }).length === 1);

  // ===== 2. accept exige identidade + motivo =====
  check("accept sem actorId → lança", throws(() => PA.accept(orgA, prop.id, { reason: "ok" })));
  check("accept sem motivo → lança", throws(() => PA.accept(orgA, prop.id, { actorId: "u-owner" })));

  // ===== 3. accept (humano) aplica banda F3 + audita + resolve =====
  const proposedCap = prop.evidence.proposedCap;
  const acc = PA.accept(orgA, prop.id, { actorId: "u-owner", reason: "histórico sólido, libero até o teto" });
  check("accept ok + aplica até o teto proposto", acc.ok === true && acc.applied.to === proposedCap);
  const after = AP.resolveContract(orgA, { domain: "procurement", actionType: "prepare_purchase", amount: proposedCap });
  check("banda aplicada: valor ≤ teto → allow (enforced)", after.state === "allow" && after.enforced === true);
  const above = AP.resolveContract(orgA, { domain: "procurement", actionType: "prepare_purchase", amount: proposedCap + 1 });
  check("acima do teto → require_approval", above.state === "require_approval");
  check("auditoria AUTONOMY_RAISE_APPLIED registrada", auditCount(orgA, "AUTONOMY_RAISE_APPLIED") === 1);
  check("sinal resolvido após accept", (db.prepare(`SELECT status FROM business_signals WHERE id = ?`).get(prop.id) as any)?.status === "resolved");
  check("accept de sinal já resolvido → lança", throws(() => PA.accept(orgA, prop.id, { actorId: "u-owner", reason: "de novo" })));

  // ===== 4. NÃO propõe: reversão presente =====
  const orgB = mkOrg();
  for (let i = 1; i <= 11; i++) mkAction(orgB, "sales", "discount", "approved", 200);
  mkAction(orgB, "sales", "discount", "cancelled", 200, { approved: true }); // aprovada e depois cancelada = reversão
  const r4 = PA.evaluate(orgB);
  check("reversão presente → NÃO propõe", r4.proposed === 0 && !proposalFor(orgB));

  // ===== 5. NÃO propõe: amostra pequena =====
  const orgC = mkOrg();
  for (let i = 1; i <= 5; i++) mkAction(orgC, "sales", "discount", "approved", 200);
  check("amostra < minDecided → NÃO propõe", PA.evaluate(orgC).proposed === 0);

  // ===== 6. NÃO propõe: teto atual já cobre (nada a subir) =====
  const orgD = mkOrg();
  for (let i = 1; i <= 12; i++) mkAction(orgD, "sales", "discount", "approved", 100);
  AP.setBands(orgD, "sales", "discount", [{ upTo: 100000, state: "allow" }]); // teto altíssimo
  check("teto já cobre → NÃO propõe", PA.evaluate(orgD).proposed === 0);

  // ===== 7. runAll varre só orgs opt-in + isolamento =====
  const orgOff = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, progressive_autonomy_enabled) VALUES (?, ?, 'X', 'active', 0)`).run(randomUUID(), orgOff);
  for (let i = 1; i <= 12; i++) mkAction(orgOff, "procurement", "prepare_purchase", "approved", i * 100);
  const all = PA.runAll();
  check("runAll ignora org sem flag (isolamento)", !proposalFor(orgOff) && all.orgs >= 1);

  console.log("\n=== TEST: Progressive Autonomy (ADR-159 F5/D5) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Progressive Autonomy (F5) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
