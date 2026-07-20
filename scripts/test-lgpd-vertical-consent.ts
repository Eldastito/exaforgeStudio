/**
 * TEST — Pré-população de consentimento LGPD por vertical (ADR-093 §3).
 *
 * Ao definir a vertical (ModuleService.applyVertical), as categorias de
 * consentimento são semeadas conforme o segmento — mas NUNCA sobrescrevem uma
 * config que o dono já ajustou. Saúde inclui dados_sensiveis.
 *
 * Uso: npm run test:lgpd-vertical-consent
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-lgpd-vert-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-lgpd-vert-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  const seedOrg = (tag: string) => {
    const orgId = `org_${tag}_${randomUUID().slice(0, 5)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgId, tag);
    return orgId;
  };
  const cats = (orgId: string) => LgpdService.getConsentConfig(orgId).categories;

  // ===== 1. Moda: marketing + dados_pessoais + perfilamento =====
  const orgModa = seedOrg("moda");
  ModuleService.applyVertical(orgModa, "moda");
  check("moda semeia marketing/dados_pessoais/perfilamento", ["marketing", "dados_pessoais", "perfilamento"].every(c => cats(orgModa).includes(c)));
  check("moda NÃO inclui dados_sensiveis", !cats(orgModa).includes("dados_sensiveis"));

  // ===== 2. Saúde: inclui dados_sensiveis =====
  const orgSaude = seedOrg("saude");
  ModuleService.applyVertical(orgSaude, "saude");
  check("saúde inclui dados_sensiveis (base legal reforçada)", cats(orgSaude).includes("dados_sensiveis"));

  // ===== 3. NÃO sobrescreve config já customizada pelo dono =====
  const orgCustom = seedOrg("custom");
  LgpdService.updateConsentConfig(orgCustom, { categories: ["so_uma"] });
  ModuleService.applyVertical(orgCustom, "moda"); // não deve mexer
  check("config customizada é preservada (não sobrescreve)", cats(orgCustom).length === 1 && cats(orgCustom)[0] === "so_uma");

  // ===== 4. seedConsentForVertical é idempotente após já semear =====
  const before = JSON.stringify(cats(orgModa));
  const seededAgain = LgpdService.seedConsentForVertical(orgModa, "saude");
  check("re-semear não age quando já configurado", seededAgain === false && JSON.stringify(cats(orgModa)) === before);

  // --- Relatório ---
  console.log("\n=== TEST: Consentimento LGPD por vertical (ADR-093 §3) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Consentimento por vertical OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
