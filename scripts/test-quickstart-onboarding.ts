/**
 * TEST — Quick-Start → card de onboarding no Dashboard (ADR-093 §1).
 *
 * Trava o sinal que o Dashboard usa: aplicar o pack marca
 * organization_settings.quickstart_applied = 1, então o card some. Idempotente.
 *
 * Uso: npm run test:quickstart-onboarding
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-qs-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-qs-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OnboardingTemplateService } = await import("../src/server/OnboardingTemplateService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'varejo')`).run(randomUUID(), orgId);
  const applied = () => (db.prepare(`SELECT quickstart_applied FROM organization_settings WHERE organization_id = ?`).get(orgId) as any)?.quickstart_applied;

  // ===== 1. Coluna existe e começa em 0 =====
  const cols = (db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[]).map(c => c.name);
  check("coluna quickstart_applied existe", cols.includes("quickstart_applied"));
  check("Quick-Start ainda não aplicado (card aparece)", !applied());

  // ===== 2. availablePacks traz o pack da vertical com summary =====
  const packs = OnboardingTemplateService.availablePacks();
  const varejo = packs.find((p: any) => p.vertical === "varejo");
  check("pack de varejo existe com summary", !!varejo && typeof varejo.summary?.cadences === "number");

  // ===== 3. Aplicar o pack marca quickstart_applied = 1 (card some) =====
  await OnboardingTemplateService.applyPack(orgId, "varejo", { skipFaq: true });
  check("após aplicar, quickstart_applied = 1", applied() === 1);

  // ===== 4. Idempotente: reaplicar não quebra e mantém aplicado =====
  await OnboardingTemplateService.applyPack(orgId, "varejo", { skipFaq: true });
  check("reaplicar mantém aplicado", applied() === 1);

  // --- Relatório ---
  console.log("\n=== TEST: Quick-Start onboarding (ADR-093 §1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Quick-Start onboarding OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
