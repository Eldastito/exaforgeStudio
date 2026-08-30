/**
 * TESTE — Importação da ESCALA por foto: transformador puro
 * (buildScheduleFromExtraction) + RetailScheduleImportService.extractFromImage
 * com extrator FAKE (sem IA/rede).
 *
 * Prova o pedido: a loja manda a escala; a IA lê trabalha/folga por dia; o
 * sistema casa o nome com o cadastro (mat:) e o dia-da-semana com as datas da
 * semana que o gestor está vendo. Férias = folga. Nome fora do cadastro vira
 * nom: e é sinalizado em `unmatched`.
 *
 * Uso:  npm run test:retail-schedule-import
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-escala-import-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-escala-import-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

// Semana de referência: domingo 30/ago → sábado 05/set (como a folha do cliente).
const WEEK = ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { buildScheduleFromExtraction, RetailScheduleImportService, _setScheduleExtractor } = await import("../src/server/RetailScheduleImportService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const loja = RetailStoreService.create(A, { name: "Toulon", code: "1" });

  // Cadastro de vendedores da org (o transformador casa por nome).
  const sellers = [
    { matricula: "1001", name: "Estefânio" },
    { matricula: "1002", name: "Raissa" },
    { matricula: "1003", name: "Rafaela" },
    { matricula: "1004", name: "Júlia" },
    { matricula: "1005", name: "Beto" },
  ];
  const insSeller = db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, ?, ?, 1)`);
  for (const s of sellers) insSeller.run(randomUUID(), A, s.matricula, s.name);

  // ===== 1. transformador puro: nomes + dias → entries/grid =====
  const parsed = {
    vendedores: [
      // acento/caixa diferentes do cadastro → ainda casa (mat:)
      { nome: "estefanio", dias: { dom: "folga", seg: "trabalha", ter: "folga", qua: "folga", qui: "folga", sex: "folga", sab: "folga" } },
      { nome: "Raissa", dias: { dom: "folga", seg: "trabalha", ter: "trabalha", qua: "folga", qui: "trabalha", sex: "trabalha", sab: "trabalha" } },
      { nome: "Júlia", dias: { dom: null, seg: "trabalha", ter: "trabalha", qua: "trabalha", qui: "férias", sex: "trabalha", sab: "trabalha" } }, // férias = off
      { nome: "Karol", dias: { dom: "trabalha", seg: "folga" } }, // fora do cadastro → nom:
    ],
    confidence: 82,
  };
  const built = buildScheduleFromExtraction(parsed, sellers, WEEK);

  check("1.1 Estefânio casou no cadastro (mat:1001)", built.grid["2026-08-31"]?.["mat:1001"] === "work", JSON.stringify(built.grid["2026-08-31"]));
  check("1.2 Estefânio domingo = folga (off)", built.grid["2026-08-30"]?.["mat:1001"] === "off");
  check("1.3 Raissa terça (01/set) = trabalha", built.grid["2026-09-01"]?.["mat:1002"] === "work");
  check("1.4 Júlia quinta = FÉRIAS vira off", built.grid["2026-09-03"]?.["mat:1004"] === "off", JSON.stringify(built.grid["2026-09-03"]));
  check("1.5 Júlia domingo (null) não gera entrada", !("mat:1004" in (built.grid["2026-08-30"] || {})));
  check("1.6 Karol (fora do cadastro) vira nom:", built.grid["2026-08-30"]?.["nom:karol"] === "work", JSON.stringify(built.grid["2026-08-30"]));
  check("1.7 unmatched lista 'Karol'", built.unmatched.includes("Karol") && built.unmatched.length === 1, JSON.stringify(built.unmatched));
  check("1.8 matched conta os 3 do cadastro", built.matched === 3, `${built.matched}`);

  // entries batem com a grade (mesma quantidade de status marcados)
  const gridCount = Object.values(built.grid).reduce((a, day) => a + Object.keys(day).length, 0);
  check("1.9 entries == células da grade", built.entries.length === gridCount, `${built.entries.length} vs ${gridCount}`);
  check("1.10 toda entrada tem data da semana", built.entries.every((e: any) => WEEK.includes(e.date)));

  // ===== 2. defensivo =====
  check("2.1 sem vendedores → vazio", buildScheduleFromExtraction({}, sellers, WEEK).entries.length === 0);
  check("2.2 dia inválido ignorado", buildScheduleFromExtraction({ vendedores: [{ nome: "Raissa", dias: { seg: "??" } }] }, sellers, WEEK).entries.length === 0);
  check("2.3 nome vazio ignorado", buildScheduleFromExtraction({ vendedores: [{ nome: "  ", dias: { seg: "trabalha" } }] }, sellers, WEEK).entries.length === 0);

  // ===== 3. extractFromImage com extrator FAKE (usa o roster do banco) =====
  _setScheduleExtractor(async (_b: string, _m: string, names: string[]) => {
    // confirma que o roster da loja/org foi passado pra IA
    if (!names.includes("Rafaela")) throw new Error("roster não chegou ao extrator");
    return JSON.stringify({ vendedores: [{ nome: "Rafaela", dias: { dom: "trabalha", seg: "folga" } }], confidence: 70 });
  });
  const out = await RetailScheduleImportService.extractFromImage(A, loja.id, "ZmFrZQ==", "image/jpeg", WEEK);
  check("3.1 extractFromImage casa Rafaela (mat:1003)", out.grid["2026-08-30"]?.["mat:1003"] === "work", JSON.stringify(out.grid));
  check("3.2 Rafaela segunda = folga", out.grid["2026-08-31"]?.["mat:1003"] === "off");
  check("3.3 confidence propagado", out.confidence === 70, `${out.confidence}`);
  _setScheduleExtractor(null);

  console.log("\n=== TEST: Importação da escala por foto ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
