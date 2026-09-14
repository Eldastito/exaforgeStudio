/**
 * TESTE — Conferência semanal de fechamentos (loja × 7 dias)
 * ----------------------------------------------------------------------------
 * Prova RetailClosingService.listWeek: grade segunda→domingo da semana da data;
 * células por loja/dia (informado/sistema/cota); totais da semana; loja sem
 * fechamento vem com células vazias; isolamento por org.
 *
 * Uso:  npm run test:retail-closing-week
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-closing-week-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-closing-week-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailClosingService } = await import("../src/server/RetailOpsService.js");

  const org = `org_${randomUUID().slice(0, 8)}`;
  const mkStore = (name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, ?, 1)`).run(id, org, name); return id; };
  const carioca = mkStore("Carioca");
  const iguacu = mkStore("Nova Iguaçu");
  const semFech = mkStore("Sem fechamento");

  const mkClosing = (store: string, date: string, informed: number, system: number, quota: number) => {
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total, quota_amount, variance_amount) VALUES (?, ?, ?, ?, 'received', ?, ?, ?, ?)`)
      .run(randomUUID(), org, store, date, informed, system, quota, informed - quota);
  };
  // Semana de 2026-09-14 (segunda) a 2026-09-20 (domingo).
  mkClosing(carioca, "2026-09-14", 1000, 1000, 900); // bate
  mkClosing(carioca, "2026-09-15", 1200, 1150, 900); // DIVERGE (informado ≠ sistema)
  mkClosing(iguacu, "2026-09-14", 800, 800, 700);
  // fechamento fora da semana (não deve entrar)
  mkClosing(carioca, "2026-09-21", 999, 999, 900);

  // consulta pela QUARTA da semana → deve ancorar na segunda 14
  const wk = RetailClosingService.listWeek(org, "2026-09-16");
  check("1 âncora na segunda-feira", wk.start === "2026-09-14", wk.start);
  check("2 7 dias seg→dom", wk.days.length === 7 && wk.days[0] === "2026-09-14" && wk.days[6] === "2026-09-20", wk.days.join(","));
  check("3 todas as lojas ativas viram linha", wk.stores.length === 3, String(wk.stores.length));

  const cRow = wk.stores.find((s: any) => s.store_id === carioca);
  check("4 célula do dia certo", cRow.cells["2026-09-14"]?.informed_total === 1000);
  check("5 fechamento fora da semana não entra", !cRow.cells["2026-09-21"]);
  check("6 total da semana (informado) soma só os 2 dias", cRow.weekInformed === 2200, String(cRow.weekInformed));
  check("7 total da semana (sistema)", cRow.weekSystem === 2150, String(cRow.weekSystem));
  const diverge = Number(cRow.cells["2026-09-15"].informed_total) !== Number(cRow.cells["2026-09-15"].system_total);
  check("8 dia divergente detectável (informado ≠ sistema)", diverge);

  const empty = wk.stores.find((s: any) => s.store_id === semFech);
  check("9 loja sem fechamento vem com células vazias", Object.keys(empty.cells).length === 0 && empty.weekInformed === 0);

  // Isolamento
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const wkB = RetailClosingService.listWeek(orgB, "2026-09-16");
  check("10 outra org não vê as lojas/fechamentos", wkB.stores.length === 0);

  console.log("\n=== TEST: Conferência semanal de fechamentos ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
