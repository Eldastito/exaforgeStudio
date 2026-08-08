/**
 * TEST — medição do programa de indicação (ADR-155 F6).
 *
 * Prova que o KPI é DERIVADO por query sobre o estado do ReferralService
 * (ADR-069): códigos emitidos, indicados que colaram código, cupons de
 * boas-vindas/recompensa, conversão. Publica `referral_program_result` em
 * business_signals (upsert idempotente). Isolamento multi-tenant.
 *
 * Uso: npm run test:referral-program-measurement
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-refkpi-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-refkpi-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ReferralProgramMeasurementService } = await import("../src/server/ReferralProgramMeasurementService.js");

  const mkOrg = () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, referral_enabled) VALUES (?, ?, 'Loja', 'active', 'varejo', 1)`).run(randomUUID(), orgId);
    return orgId;
  };
  const mkCode = (orgId: string) => db.prepare(`INSERT INTO referral_codes (id, organization_id, contact_id, code) VALUES (?, ?, ?, ?)`).run(randomUUID(), orgId, randomUUID(), randomUUID().slice(0, 6).toUpperCase());
  const mkReferred = (orgId: string) => db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, referred_by_contact_id) VALUES (?, ?, 'ch1', 'Indicado', ?, ?)`).run(randomUUID(), orgId, randomUUID(), randomUUID());
  const mkCoupon = (orgId: string, kind: string, status: string) => db.prepare(`INSERT INTO coupons (id, organization_id, owner_contact_id, kind, discount_percent, status) VALUES (?, ?, ?, ?, 10, ?)`).run(randomUUID(), orgId, randomUUID(), kind, status);

  const orgA = mkOrg();
  const orgB = mkOrg();

  // orgA: 5 códigos, 4 indicados, 4 welcome (2 used/2 active), 2 reward (1 used/1 active)
  for (let i = 0; i < 5; i++) mkCode(orgA);
  for (let i = 0; i < 4; i++) mkReferred(orgA);
  mkCoupon(orgA, "referral_welcome", "used"); mkCoupon(orgA, "referral_welcome", "used");
  mkCoupon(orgA, "referral_welcome", "active"); mkCoupon(orgA, "referral_welcome", "active");
  mkCoupon(orgA, "referral_reward", "used"); mkCoupon(orgA, "referral_reward", "active");

  // ===== 1. measure: tudo derivado por query =====
  const m = ReferralProgramMeasurementService.measure(orgA);
  check("codesIssued = 5", m.codesIssued === 5);
  check("referred = 4", m.referred === 4);
  check("welcomeIssued = 4", m.welcomeIssued === 4);
  check("qualified (reward) = 2", m.qualified === 2);
  check("couponsRedeemed (used) = 3", m.couponsRedeemed === 3);
  check("conversionRatePct = 50.0 (2/4)", m.conversionRatePct === 50.0);

  // ===== 2. publish → business_signal (upsert) =====
  check("publish retorna published", ReferralProgramMeasurementService.publish(orgA).published === true);
  const sig = db.prepare(`SELECT signal_type, severity, evidence_json, impact_amount, impact_unit, dedupe_key FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(orgA, `referrals:program_result:${orgA}`) as any;
  check("sinal referral_program_result publicado", sig?.signal_type === "referral_program_result" && sig?.severity === "info");
  check("sinal: impact_amount 2 (indicações convertidas)", Number(sig?.impact_amount) === 2 && sig?.impact_unit === "indicacoes_convertidas");
  const ev = sig ? JSON.parse(sig.evidence_json) : {};
  check("sinal.evidence.conversionRatePct = 50", ev?.conversionRatePct === 50.0);
  check("sinal.evidence tem os 6 campos", ev && ["codesIssued", "referred", "welcomeIssued", "qualified", "couponsRedeemed", "conversionRatePct"].every((k) => k in ev));
  // republicar → upsert (não duplica)
  ReferralProgramMeasurementService.publish(orgA);
  const cnt = (db.prepare(`SELECT COUNT(*) AS n FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(orgA, `referrals:program_result:${orgA}`) as any).n;
  check("republicar faz upsert (1 sinal, não duplica)", Number(cnt) === 1);

  // ===== 3. conversão 0 quando ninguém colou código =====
  const orgC = mkOrg();
  for (let i = 0; i < 3; i++) mkCode(orgC); // códigos, mas nenhum indicado
  const mc = ReferralProgramMeasurementService.measure(orgC);
  check("orgC: referred 0 → conversionRatePct 0", mc.referred === 0 && mc.conversionRatePct === 0);
  check("orgC: publish published=true (tem código)", ReferralProgramMeasurementService.publish(orgC).published === true);

  // ===== 4. sem código → nada publicado =====
  check("orgB (sem código) → codesIssued 0", ReferralProgramMeasurementService.measure(orgB).codesIssued === 0);
  check("orgB → publish published=false", ReferralProgramMeasurementService.publish(orgB).published === false);
  check("orgB → sem sinal publicado", !db.prepare(`SELECT 1 FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(orgB, `referrals:program_result:${orgB}`));

  // ===== 5. ISOLAMENTO multi-tenant =====
  check("ISOLAMENTO: measure(orgA) não conta dados de orgC", ReferralProgramMeasurementService.measure(orgA).codesIssued === 5);
  const all = ReferralProgramMeasurementService.publishAll();
  check("publishAll agrega orgs com código", all.orgs >= 2 && all.published >= 2);

  // ===== resultado =====
  console.log("\n=== Referral program measurement — F6 ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checagens ok`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s)`); process.exit(1); }
  console.log("\n✅ medição do programa de indicação íntegra");
}

main();
