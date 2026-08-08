/**
 * TEST — ADR-154 F2.2 (Fatia C): enforcement do FalaTu (o "cadeado").
 *
 * Fecha o "cobra e protege": quem não paga não usa. Cobre:
 * - past_due de um plano FalaTu TRAVA a IA (reason billing_past_due) — o gap
 *   que a Fatia C resolve (garantia = pagou-usou / não-pagou-travou);
 * - suspended/cancelled/blocked seguem travados; trialing/active liberados;
 * - REGRESSÃO: past_due de um plano B2B (growth) NÃO trava (grace do dunning
 *   preservado — o gate novo é escopado a falatu_*);
 * - cota de IA POR PLANO: falatu_solo (ai_monthly_limit=100) trava ao cruzar o
 *   teto contando ai_interactions_log do mês (a cota do plano vale de verdade);
 * - o capture do FalaTu propaga o bloqueio com a mensagem de paywall certa.
 *
 * Uso: npm run test:falatu-enforcement
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-enf-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-enf-123456";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PlanService } = await import("../src/server/PlanService.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");

  // Cria uma org com plano + billing_status + status controlados.
  function mkOrg(planId: string, billing: string, status = "active"): string {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'Org', ?, ?, ?)`)
      .run(randomUUID(), orgId, status, planId, billing);
    return orgId;
  }
  const allowed = (orgId: string) => PlanService.aiAllowed(orgId);

  // ===== 1. Matriz de billing pra um plano FalaTu (falatu_solo) =====
  check("FalaTu trialing → liberado", allowed(mkOrg("falatu_solo", "trialing")).allowed === true);
  check("FalaTu active → liberado", allowed(mkOrg("falatu_solo", "active")).allowed === true);
  const pastDue = allowed(mkOrg("falatu_solo", "past_due"));
  check("FalaTu past_due → TRAVADO (novo)", pastDue.allowed === false);
  check("FalaTu past_due → reason billing_past_due", pastDue.reason === "billing_past_due");
  check("FalaTu suspended → travado", allowed(mkOrg("falatu_solo", "suspended")).allowed === false);
  check("FalaTu cancelled → travado", allowed(mkOrg("falatu_solo", "cancelled")).allowed === false);

  // ===== 2. REGRESSÃO: past_due B2B mantém o grace do dunning =====
  check("B2B (growth) past_due → SEGUE liberado (grace preservado)", allowed(mkOrg("growth", "past_due")).allowed === true);

  // ===== 3. Cota de IA POR PLANO (falatu_solo = 100/mês) =====
  const quotaOrg = mkOrg("falatu_solo", "active");
  const insertUse = (n: number) => { for (let i = 0; i < n; i++) db.prepare(`INSERT INTO ai_interactions_log (id, organization_id, agent_used) VALUES (?, ?, 'falatu')`).run(randomUUID(), quotaOrg); };
  insertUse(99);
  check("99/100 usos → ainda liberado", allowed(quotaOrg).allowed === true);
  insertUse(1); // 100
  const overQuota = allowed(quotaOrg);
  check("100/100 usos → travado por cota do plano", overQuota.allowed === false && overQuota.reason === "monthly_limit");

  // ===== 4. Capture propaga o paywall (past_due) com a mensagem certa =====
  const capOrg = mkOrg("falatu_solo", "past_due");
  try { db.prepare(`UPDATE organization_settings SET falatu_enabled = 1 WHERE organization_id = ?`).run(capOrg); } catch { /* noop */ }
  const userId = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Dono', ?, 'owner', 'active')`).run(userId, capOrg, `${userId}@t.com`);
  let capMsg = "";
  try { await FalaTuService.capture(capOrg, userId, { text: "ligar pro contador" }); }
  catch (e: any) { capMsg = String(e?.message || e); }
  check("capture em org past_due lança paywall (atraso/regularize)", /atraso|regularize/i.test(capMsg));

  console.log("");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}`);
  console.log(failures === 0 ? "\nOK — 100% PASS" : `\nFALHOU — ${failures} checagem(ns)`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
});
