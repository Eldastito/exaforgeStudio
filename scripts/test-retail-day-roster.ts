/**
 * TESTE — Escala do dia agrupada por loja (ROSTER-001).
 *
 * Pedido do lojista: no card "quem folga hoje" mostrar TAMBÉM quem está
 * trabalhando (verde) ao lado de quem está de folga (vermelho), separado POR
 * LOJA (nome da loja no topo) — com muitas lojas a lista chapada de nomes
 * ficava enorme.
 *
 * Cobre RetailScheduleTemplateService.dayRoster:
 *  - agrupa por loja com working[] (grade 'work') e off[] (grade 'off' + template);
 *  - resolve nome da loja mesmo quando só há gente trabalhando;
 *  - respeita filtro por storeId;
 *  - só entram lojas com alguém na escala do dia.
 *
 * Uso:  npm run test:retail-day-roster
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-day-roster-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-day-roster-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

// 2026-08-30 é um DOMINGO (dow=0) — usado pro template.
const DATE = "2026-08-30";

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailScheduleTemplateService } = await import("../src/server/RetailScheduleTemplateService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);
  const americana = RetailStoreService.create(A, { name: "Americana", code: "1" }).id;
  const grandeRio = RetailStoreService.create(A, { name: "Grande Rio", code: "2" }).id;
  const semEscala = RetailStoreService.create(A, { name: "Sem Escala", code: "3" }).id;

  const sch = db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // Americana: Zé Felipe e Rogério trabalham; Rafael folga.
  sch.run(randomUUID(), A, americana, DATE, "mat:1", "Zé Felipe", "work");
  sch.run(randomUUID(), A, americana, DATE, "mat:2", "Rogério", "work");
  sch.run(randomUUID(), A, americana, DATE, "mat:3", "Rafael", "off");
  // Grande Rio: só gente trabalhando (testa resolução de nome de loja sem off).
  sch.run(randomUUID(), A, grandeRio, DATE, "mat:4", "Bruno", "work");
  // Template: MC folga aos domingos na Americana e ainda não tem linha na grade.
  db.prepare(`INSERT INTO retail_seller_off_pattern (id, organization_id, store_id, seller_key, seller_name, day_of_week) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), A, americana, "mat:5", "MC", 0);

  const all = RetailScheduleTemplateService.dayRoster(A, DATE);
  const byId = new Map(all.map((s) => [s.storeId, s]));

  // ===== 1. agrupamento + nomes =====
  check("1.1 duas lojas com escala aparecem (semEscala fora)", all.length === 2, `len=${all.length}`);
  check("1.2 loja sem escala não vira bloco", !byId.has(semEscala));
  const am = byId.get(americana);
  const gr = byId.get(grandeRio);
  check("1.3 Americana tem nome resolvido", am?.storeName === "Americana", am?.storeName || "");
  check("1.4 Grande Rio (só trabalhando) tem nome resolvido", gr?.storeName === "Grande Rio", gr?.storeName || "");
  check("1.5 ordenado por nome de loja (Americana < Grande Rio)", all[0].storeId === americana);

  // ===== 2. working (verde) =====
  const amWork = (am?.working || []).map((w) => w.sellerName).sort();
  check("2.1 Americana trabalhando = Rogério, Zé Felipe", JSON.stringify(amWork) === JSON.stringify(["Rogério", "Zé Felipe"]), JSON.stringify(amWork));
  check("2.2 Grande Rio trabalhando = Bruno", (gr?.working || []).map((w) => w.sellerName).join(",") === "Bruno");
  check("2.3 Grande Rio sem ninguém de folga", (gr?.off || []).length === 0);

  // ===== 3. off (vermelho) = grade 'off' + template =====
  const amOff = (am?.off || []).map((o) => `${o.sellerName}:${o.source}`).sort();
  check("3.1 Americana folga inclui Rafael (grid) e MC (template)",
    JSON.stringify(amOff) === JSON.stringify(["MC:template", "Rafael:grid"]), JSON.stringify(amOff));

  // ===== 4. filtro por storeId =====
  const onlyGr = RetailScheduleTemplateService.dayRoster(A, DATE, { storeId: grandeRio });
  check("4.1 filtro storeId retorna só a loja pedida", onlyGr.length === 1 && onlyGr[0].storeId === grandeRio);

  // ===== 5. data sem escala nenhuma → vazio =====
  const vazio = RetailScheduleTemplateService.dayRoster(A, "2026-08-25");
  check("5.1 dia sem escala → lista vazia", vazio.length === 0);

  console.log("\n=== TEST: Escala do dia agrupada por loja ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
