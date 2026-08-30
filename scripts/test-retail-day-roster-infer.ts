/**
 * TESTE — Escala do dia: INFERE quem trabalha = todo mundo que não folga
 * (ROSTER-002).
 *
 * Pedido do lojista: numa loja onde só as FOLGAS foram lançadas, o resto da
 * equipe (lotada na loja) já deve aparecer TRABALHANDO, sem marcar cada um.
 * A inferência preenche lojas que JÁ aparecem e nunca ressuscita loja fechada
 * (todos de folga → ninguém trabalha).
 *
 * Uso:  npm run test:retail-day-roster-infer
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-roster-infer-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-roster-infer-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const DATE = "2026-09-02"; // quarta (dow=3), sem template

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailScheduleTemplateService } = await import("../src/server/RetailScheduleTemplateService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);
  const toulon = RetailStoreService.create(A, { name: "Toulon", code: "1" }).id;
  const fechada = RetailStoreService.create(A, { name: "Fechada", code: "2" }).id;
  const semEscala = RetailStoreService.create(A, { name: "Sem Escala", code: "3" }).id;

  // Equipe lotada (assignments) — Toulon: Ana, Bia, Carla, Duda; Fechada: Edu, Fá.
  const seller = db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, ?, ?, 1)`);
  const assign = db.prepare(`INSERT INTO retail_seller_store_assignments (id, organization_id, seller_id, store_id, active) VALUES (?, ?, ?, ?, 1)`);
  const mk = (mat: string, name: string, store: string) => { const id = randomUUID(); seller.run(id, A, mat, name); assign.run(randomUUID(), A, id, store); };
  mk("1", "Ana", toulon); mk("2", "Bia", toulon); mk("3", "Carla", toulon); mk("4", "Duda", toulon);
  mk("5", "Edu", fechada); mk("6", "Fá", fechada);
  // Vendedora lotada na loja sem escala — não deve aparecer (loja não entra).
  mk("7", "Gina", semEscala);

  const sch = db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // Toulon: SÓ a folga da Ana foi lançada. Bia/Carla/Duda inferidas trabalhando.
  sch.run(randomUUID(), A, toulon, DATE, "mat:1", "Ana", "off");
  // Fechada: todos de folga → ninguém trabalha.
  sch.run(randomUUID(), A, fechada, DATE, "mat:5", "Edu", "off");
  sch.run(randomUUID(), A, fechada, DATE, "mat:6", "Fá", "off");
  // semEscala: nada lançado.

  const all = RetailScheduleTemplateService.dayRoster(A, DATE);
  const byId = new Map(all.map((s) => [s.storeId, s]));
  const tou = byId.get(toulon);
  const fec = byId.get(fechada);

  // ===== 1. inferência na Toulon =====
  const touWork = (tou?.working || []).map((w) => `${w.sellerName}:${w.source}`).sort();
  check("1.1 Bia/Carla/Duda inferidas trabalhando (source roster)",
    JSON.stringify(touWork) === JSON.stringify(["Bia:roster", "Carla:roster", "Duda:roster"]), JSON.stringify(touWork));
  check("1.2 Ana continua de folga (não é inferida trabalhando)",
    (tou?.off || []).some((o) => o.sellerName === "Ana") && !(tou?.working || []).some((w) => w.sellerName === "Ana"));

  // ===== 2. loja fechada (todos de folga) NÃO ressuscita =====
  check("2.1 Fechada aparece (tem folgas lançadas)", !!fec);
  check("2.2 Fechada com working vazio (ninguém trabalha)", (fec?.working || []).length === 0, JSON.stringify(fec?.working));

  // ===== 3. loja sem escala não entra (mesmo com gente lotada) =====
  check("3.1 Sem Escala fora do resultado", !byId.has(semEscala));

  // ===== 4. explícito 'work' + inferência não duplica =====
  db.prepare(`DELETE FROM retail_schedule_entries WHERE organization_id = ? AND store_id = ? AND work_date = ? AND seller_key = 'mat:2'`).run(A, toulon, DATE);
  sch.run(randomUUID(), A, toulon, DATE, "mat:2", "Bia", "work"); // Bia agora explícita
  const all2 = RetailScheduleTemplateService.dayRoster(A, DATE);
  const tou2 = all2.find((s) => s.storeId === toulon);
  const bia = (tou2?.working || []).filter((w) => w.sellerName === "Bia");
  check("4.1 Bia aparece só uma vez", bia.length === 1, String(bia.length));
  check("4.2 Bia explícita vira source 'grid'", bia[0]?.source === "grid", bia[0]?.source);

  console.log("\n=== TEST: Escala do dia — infere quem trabalha ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
