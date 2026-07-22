/**
 * TEST — Add-on opt-in pelo dono em Configurações › Módulos (ADR-084/105).
 *
 * Prova que o dono liga um ADD-ON (ex.: Retail Ops) sozinho, independente do
 * teto do plano (billing mockado):
 *   - overview: add-on aparece como 'available' (não 'upgrade') e addon=true,
 *     mesmo quando o plano não o inclui;
 *   - setModules com o add-on → isEnabled(add-on) = true apesar do teto do plano;
 *   - módulo COMUM acima do teto continua barrado (regra do plano intacta).
 *
 * Uso: npm run test:module-addon-selfservice
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-addon-self-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-addon-self-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { PlanService } = await import("../src/server/PlanService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'A', 'active', 'moda')`).run(randomUUID(), A);

  // Simula um plano que NÃO inclui retail nem diretor (teto de módulos).
  (PlanService as any).modulesForPlan = (_orgId: string) => ["catalogo", "vendas", "loja"];

  // ===== 1. overview: retail é 'available' (não 'upgrade') e addon=true =====
  const ov = ModuleService.overview(A);
  const retail = ov.items.find((i: any) => i.key === "retail");
  check("retail aparece no overview", !!retail);
  check("retail é ligável ('available', não 'upgrade')", retail?.section === "available", retail?.section);
  check("retail marcado como add-on", retail?.addon === true);
  const diretor = ov.items.find((i: any) => i.key === "diretor");
  check("módulo comum acima do teto continua 'upgrade'", diretor?.section === "upgrade", diretor?.section);

  // ===== 2. dono liga retail → isEnabled apesar do teto do plano =====
  check("antes: retail desligado", ModuleService.isEnabled(A, "retail") === false);
  ModuleService.setModules(A, ["catalogo", "vendas", "loja", "retail"]);
  check("depois de ligar: retail habilitado mesmo fora do plano", ModuleService.isEnabled(A, "retail") === true);

  // ===== 3. módulo comum fora do plano continua barrado =====
  ModuleService.setModules(A, ["catalogo", "vendas", "loja", "retail", "diretor"]);
  check("módulo comum fora do teto do plano continua barrado", ModuleService.isEnabled(A, "diretor") === false);
  check("retail segue habilitado", ModuleService.isEnabled(A, "retail") === true);

  console.log("\n=== TEST: Add-on opt-in pelo dono (Módulos) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
