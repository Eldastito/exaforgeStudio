/**
 * TESTE — Probe leve de saúde da API (PDR TOULON, Fatia 5 / CONN-003).
 * ---------------------------------------------------------------------------
 * Prova, offline (HealthProbeService.ping):
 *   - responde ok=true com o banco acessível (SELECT 1);
 *   - carrega `ts` (hora do servidor) e `dbMs` numérico (latência do banco);
 *   - `now` injetável (determinismo do timestamp).
 *
 * O probe NÃO toca dado de negócio — é barato de rodar em intervalo curto.
 *
 * Uso:  npm run test:health-probe
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-health-probe-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-health-probe-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { HealthProbeService } = await import("../src/server/HealthProbeService.js");

  const p = HealthProbeService.ping();
  check("ping ok=true com banco acessível", p.ok === true);
  check("ping db=true", p.db === true);
  check("ping ts é ISO", typeof p.ts === "string" && /\d{4}-\d{2}-\d{2}T/.test(p.ts));
  check("ping dbMs é número >= 0", typeof p.dbMs === "number" && p.dbMs >= 0, String(p.dbMs));

  const fixed = "2026-08-18T10:00:00.000Z";
  check("now injetável reflete no ts", HealthProbeService.ping(fixed).ts === fixed);

  console.log("\n=== TEST: Probe de saúde (Fatia 5 / CONN-003) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
