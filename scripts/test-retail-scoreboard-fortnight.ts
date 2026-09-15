/**
 * TEST — Metas do vendedor: coluna QUINZENA ocultável por empresa.
 * ----------------------------------------------------------------------------
 * A preferência `retail_scoreboard_hide_fortnight` (por-org, opt-in, padrão 0)
 * controla só a EXIBIÇÃO da coluna quinzena — o cálculo (o campo `fortnight`)
 * continua vindo no scoreboard 0-regressão. Prova, offline:
 *   - padrão: hideFortnight=false e o scoreboard traz `fortnight`;
 *   - ligar a preferência: hideFortnight=true, mas `fortnight` SEGUE calculado;
 *   - isolamento multi-tenant (a preferência de A não afeta B).
 *
 * Uso: npm run test:retail-scoreboard-fortnight
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-scoreboard-fort-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-scoreboard-fortnight-123456";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailCommissionRaceService } = await import("../src/server/RetailCommissionRaceService.js");

  const mkOrg = () => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), id);
    return id;
  };
  const A = mkOrg(), B = mkOrg();
  const storeA = RetailStoreService.create(A, { name: "Loja A", code: "100" });
  const readHide = (org: string) => Number((db.prepare(`SELECT retail_scoreboard_hide_fortnight AS h FROM organization_settings WHERE organization_id = ?`).get(org) as any)?.h || 0);
  const setHide = (org: string, hide: number) => db.prepare(`UPDATE organization_settings SET retail_scoreboard_hide_fortnight = ? WHERE organization_id = ?`).run(hide, org);

  // Padrão: preferência 0 (mostrar).
  check("coluna existe e nasce 0 (mostrar) — 0-regressão", readHide(A) === 0);

  // O scoreboard SEMPRE calcula a quinzena (o flag é só de exibição).
  const board = RetailCommissionRaceService.sellerPeriodScoreboard(A, storeA.id, "2026-09-12");
  check("scoreboard traz o período `fortnight` calculado", !!board?.periods?.fortnight?.start && !!board?.periods?.fortnight?.end, JSON.stringify(board?.periods?.fortnight));

  // Ligar a preferência (como faz a rota PUT).
  setHide(A, 1);
  check("preferência liga (hide=1)", readHide(A) === 1);
  const board2 = RetailCommissionRaceService.sellerPeriodScoreboard(A, storeA.id, "2026-09-12");
  check("com preferência ligada, o cálculo da quinzena PERMANECE (só a UI esconde)", !!board2?.periods?.fortnight?.start, JSON.stringify(board2?.periods?.fortnight));

  // Isolamento: B não é afetado pela preferência de A.
  check("isolamento multi-tenant: B segue mostrando (0)", readHide(B) === 0);

  // Desligar volta ao padrão.
  setHide(A, 0);
  check("preferência desliga (volta a mostrar)", readHide(A) === 0);

  console.log("\n=== TEST: Metas do vendedor — quinzena ocultável ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
