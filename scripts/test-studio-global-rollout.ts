/**
 * TESTE — Estúdio de Criação GLOBAL (módulo `estudio`).
 * ------------------------------------------------------------------------------
 * Prova, offline:
 *   1. o módulo `estudio` está no preset de TODAS as verticais (global por default);
 *   2. ModuleService.enableOptionalModuleForAllOrgs('estudio') é ADITIVO e idempotente:
 *      - org com lista explícita sem `estudio` → passa a ter (sem perder os outros);
 *      - org com `estudio` já presente → intocada (não duplica);
 *      - org com enabled_modules NULL → intocada (legado já vê tudo);
 *      - rodar 2x não muda mais nada.
 *
 * Uso:  npm run test:studio-global-rollout
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-studio-global-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-studio-global-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { VERTICALS } = await import("../src/server/verticals.js");

  // ===== 1. preset global =====
  const semEstudio = VERTICALS.filter((v: any) => !v.modules.includes("estudio")).map((v: any) => v.key);
  check("1.1 TODAS as verticais têm `estudio` no preset", semEstudio.length === 0, `sem estúdio: ${semEstudio.join(", ")}`);

  // ===== 2. rollout aditivo/idempotente =====
  const mkOrg = (enabled: string[] | null) => {
    const org = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
    if (enabled != null) db.prepare(`UPDATE organization_settings SET enabled_modules = ? WHERE organization_id = ?`).run(JSON.stringify(enabled), org);
    return org;
  };
  const em = (org: string) => {
    const r = db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id = ?`).get(org) as any;
    return r?.enabled_modules == null ? null : JSON.parse(r.enabled_modules);
  };

  const oNull = mkOrg(null);                              // legado: NULL = tudo ligado
  const oSem = mkOrg(["catalogo", "vendas", "diretor"]);  // explícito, sem estúdio
  const oCom = mkOrg(["catalogo", "estudio", "diretor"]); // explícito, já com estúdio

  const r1 = ModuleService.enableOptionalModuleForAllOrgs("estudio");
  check("2.1 rollout atualizou só as 2 orgs explícitas sem estúdio? (1)", r1.updated === 1, `updated=${r1.updated}`);
  check("2.2 org NULL segue intocada (legado vê tudo)", em(oNull) === null);
  check("2.3 org explícita sem estúdio passou a ter", em(oSem).includes("estudio"));
  check("2.4 rollout preservou os módulos que já existiam", ["catalogo", "vendas", "diretor"].every(m => em(oSem).includes(m)));
  check("2.5 org que já tinha estúdio não duplicou", em(oCom).filter((m: string) => m === "estudio").length === 1);

  // Idempotência: 2ª passada não muda nada.
  const r2 = ModuleService.enableOptionalModuleForAllOrgs("estudio");
  check("2.6 2ª passada não atualiza ninguém", r2.updated === 0, `updated=${r2.updated}`);

  // Guardrail: módulo inválido é rejeitado.
  let rejected = false;
  try { ModuleService.enableOptionalModuleForAllOrgs("modulo_que_nao_existe"); } catch { rejected = true; }
  check("2.7 módulo opcional desconhecido é rejeitado", rejected);

  console.log("\n=== TEST: Estúdio de Criação global (preset + rollout) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
