/**
 * TEST — GrimoireService camada por-org / brand voice (ADR-155 F1.3).
 *
 * Prova: colunas aditivas + defaults, gating pela flag brand_voice_enabled
 * (off => promptForOrg retorna "" = zero injeção em prod), injeção combinada
 * (rubrica global + <contexto_marca>) quando on, e ISOLAMENTO multi-tenant
 * (contexto de uma org nunca vaza pra outra).
 *
 * Uso: npm run test:grimoire-brand-voice
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-grim-bv-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-grim-bv-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function mkOrg(db: any): string {
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'varejo')`).run(randomUUID(), orgId);
  return orgId;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { GrimoireService } = await import("../src/server/GrimoireService.js");

  // ===== 1. Colunas aditivas + defaults =====
  const cols = (db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[]).map((c) => c.name);
  check("coluna brand_voice_context existe", cols.includes("brand_voice_context"));
  check("coluna brand_voice_enabled existe", cols.includes("brand_voice_enabled"));

  const orgA = mkOrg(db);
  const orgB = mkOrg(db);

  const defA = await GrimoireService.getBrandVoice(orgA);
  check("default: enabled=false", defA.enabled === false);
  check("default: context=null", defA.context === null);

  // ===== 2. Gating: flag OFF => nada injetado (zero mudança em prod) =====
  const off = await GrimoireService.promptForOrg(orgA, "cobranca", ["compose"]);
  check("flag OFF → promptForOrg vazio", off === "");

  // ===== 3. Flag ON, sem contexto => só a rubrica global (sem <contexto_marca>) =====
  await GrimoireService.setBrandVoice(orgA, { enabled: true });
  const onNoCtx = await GrimoireService.promptForOrg(orgA, "cobranca", ["compose"]);
  check("flag ON sem contexto → inclui rubrica global (dunning)", onNoCtx.includes('id="dunning-cadence"'));
  check("flag ON sem contexto → NÃO tem bloco <contexto_marca>", !onNoCtx.includes("<contexto_marca>"));

  // ===== 4. Flag ON + contexto => rubrica global + <contexto_marca> com o texto =====
  await GrimoireService.setBrandVoice(orgA, { context: "Tom informal, gente boa, chamar de você. Marca: Loja do Zé." });
  const onCtx = await GrimoireService.promptForOrg(orgA, "cobranca", ["compose"]);
  check("flag ON + contexto → inclui rubrica global", onCtx.includes('id="dunning-cadence"'));
  check("flag ON + contexto → inclui bloco <contexto_marca>", onCtx.includes("<contexto_marca>") && onCtx.includes("</contexto_marca>"));
  check("flag ON + contexto → inclui o texto da marca", onCtx.includes("Loja do Zé"));

  // ===== 5. ISOLAMENTO multi-tenant =====
  const bBefore = await GrimoireService.promptForOrg(orgB, "cobranca", ["compose"]);
  check("ISOLAMENTO: orgB (flag off) → vazio, não herda orgA", bBefore === "");
  await GrimoireService.setBrandVoice(orgB, { enabled: true });
  const bOn = await GrimoireService.promptForOrg(orgB, "cobranca", ["compose"]);
  check("ISOLAMENTO: contexto da orgA NÃO vaza pra orgB", !bOn.includes("Loja do Zé"));
  check("getBrandVoice(orgB) não tem contexto da orgA", (await GrimoireService.getBrandVoice(orgB)).context === null);
  check("getBrandVoice(orgA) preserva o próprio contexto", ((await GrimoireService.getBrandVoice(orgA)).context ?? "").includes("Loja do Zé"));

  // ===== 6. setBrandVoice parcial: desligar preserva o contexto salvo =====
  await GrimoireService.setBrandVoice(orgA, { enabled: false });
  check("desligar a flag zera a injeção", (await GrimoireService.promptForOrg(orgA, "cobranca", ["compose"])) === "");
  check("desligar a flag PRESERVA o contexto salvo", ((await GrimoireService.getBrandVoice(orgA)).context ?? "").includes("Loja do Zé"));

  // ===== resultado =====
  console.log("\n=== GrimoireService brand voice — F1.3 ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checagens ok`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s)`); process.exit(1); }
  console.log("\n✅ brand voice por org íntegro");
}

main();
