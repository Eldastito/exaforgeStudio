/**
 * TEST — Régua de inadimplência + modo somente-leitura (ADR-091 Bloco B, PR B2).
 *
 * billingDunningPass avança o estágio conforme os dias de atraso, é idempotente
 * (só age na mudança de estágio), transiciona past_due→suspended→cancelled, e
 * — money-critical — NÃO suspende quem o ASAAS confirma como pago. 'suspended'
 * desliga a IA (aiAllowed) e liga o modo somente-leitura.
 *
 * Uso: npm run test:billing-dunning
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dunning-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-dunning-1234567890";
// ASAAS_API_KEY deixado em branco de propósito: cancel/list não batem em rede;
// mockamos listInvoices só onde o teste precisa (guarda de pagamento).

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { Scheduler } = await import("../src/server/Scheduler.js");
  const { PlanService } = await import("../src/server/PlanService.js");
  const { AsaasService } = await import("../src/server/AsaasService.js");

  const dateOffset = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  let orgPaid = ""; // a org cujo ASAAS "confirma" pagamento
  (AsaasService as any).listInvoices = async (orgId: string) =>
    orgId === orgPaid ? [{ id: "pay", status: "CONFIRMED", value: 597, dueDate: dateOffset(-12), invoiceUrl: "" }] : [];

  function seedOrg(tag: string, periodEndOffsetDays: number, billing = "active") {
    const orgId = `org_${tag}_${randomUUID().slice(0, 5)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status, payment_provider, external_subscription_id, current_period_end)
      VALUES (?, ?, ?, 'active', 'growth', ?, 'asaas', ?, ?)`)
      .run(randomUUID(), orgId, tag, billing, `sub_${tag}`, dateOffset(periodEndOffsetDays));
    return orgId;
  }
  const billingOf = (o: string) => (db.prepare(`SELECT billing_status, billing_dunning_stage FROM organization_settings WHERE organization_id=?`).get(o) as any);

  const orgPre = seedOrg("pre", 3);       // vence em 3 dias
  const orgD1 = seedOrg("d1", -2);        // 2 dias de atraso
  const orgSusp = seedOrg("susp", -12);   // 12 dias → suspende
  const orgOk = seedOrg("ok", -12);       // 12 dias mas PAGO no ASAAS
  const orgCancel = seedOrg("cancel", -35); // 35 dias → cancela
  orgPaid = orgOk;

  await Scheduler.billingDunningPass();

  // ===== 1. Pré-vencimento: avisa, não muda billing =====
  check("pré-vencimento vira estágio D-5", billingOf(orgPre).billing_dunning_stage === "D-5");
  check("pré-vencimento continua active", billingOf(orgPre).billing_status === "active");

  // ===== 2. Atraso inicial → past_due (IA continua) =====
  check("2 dias de atraso → past_due", billingOf(orgD1).billing_status === "past_due" && billingOf(orgD1).billing_dunning_stage === "D+1");
  check("past_due NÃO desliga a IA (grace)", PlanService.aiAllowed(orgD1).allowed === true);

  // ===== 3. D+10 → suspended (IA off + somente-leitura) =====
  check("12 dias → suspended", billingOf(orgSusp).billing_status === "suspended" && billingOf(orgSusp).billing_dunning_stage === "D+10");
  check("suspended desliga a IA (aiAllowed=false)", PlanService.aiAllowed(orgSusp).allowed === false);

  // ===== 4. Guarda money-critical: ASAAS confirma pago → NÃO suspende =====
  check("org paga no ASAAS volta pra active (não suspende)", billingOf(orgOk).billing_status === "active");
  check("org paga tem régua zerada", billingOf(orgOk).billing_dunning_stage == null);

  // ===== 5. D+30 → cancelled =====
  check("35 dias → cancelled", billingOf(orgCancel).billing_status === "cancelled" && billingOf(orgCancel).billing_dunning_stage === "D+30");

  // ===== 6. Idempotência: rodar de novo não re-age =====
  const beforeStage = billingOf(orgSusp).billing_dunning_stage;
  PlanService.setBillingStatus(orgSusp, "suspended"); // garante que segue suspenso
  await Scheduler.billingDunningPass();
  check("2ª passada não muda o estágio (idempotente)", billingOf(orgSusp).billing_dunning_stage === beforeStage);

  // --- Relatório ---
  console.log("\n=== TEST: Régua de inadimplência (ADR-091 Bloco B) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Régua de inadimplência OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
