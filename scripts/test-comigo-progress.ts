/**
 * TEST — Comigo/Progressão pedagógica (ADR-121 / ADR-088 D10).
 *
 * Uso: npm run test:comigo-progress
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-prog-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-prog-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoProgressService: P } = await import("../src/server/ComigoProgressService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);

  const sale = () => db.prepare(`INSERT INTO comigo_orders (id, organization_id, status, paid_via, total) VALUES (?, ?, 'paid', 'cash', 10)`).run(randomUUID(), orgId);
  const recipeWithCost = () => {
    const rid = randomUUID();
    db.prepare(`INSERT INTO comigo_recipes (id, organization_id, name, kind) VALUES (?, ?, 'Item', 'fabricacao')`).run(rid, orgId);
    db.prepare(`INSERT INTO comigo_recipe_costs (id, recipe_id, label, kind, amount) VALUES (?, ?, 'insumo', 'insumo', 5)`).run(randomUUID(), rid);
  };

  // ===== Estágio 0: sem nada → "vender" =====
  let s = P.status(orgId);
  check("dia 1: estágio 'vender'", s.stage === "vender" && s.stageIndex === 0);
  check("próximo passo = quanto_sobrou", s.next?.key === "quanto_sobrou");
  check("Balcão liberado; Saúde ainda não", s.unlocked.balcao === true && s.unlocked.saude === false);

  // ===== 1 venda → "quanto_sobrou" (revela Caderneta) =====
  sale();
  s = P.status(orgId);
  check("1 venda: estágio 'quanto_sobrou'", s.stage === "quanto_sobrou");
  check("Caderneta revelada", s.unlocked.caderneta === true);

  // ===== 3 vendas → "quanto_custa" (revela Precificação) =====
  sale(); sale();
  s = P.status(orgId);
  check("3 vendas: estágio 'quanto_custa'", s.stage === "quanto_custa");
  check("Precificação revelada", s.unlocked.precificacao === true);

  // ===== Ficha com custo → "quanto_cobrar" =====
  recipeWithCost();
  s = P.status(orgId);
  check("ficha com custo: estágio 'quanto_cobrar'", s.stage === "quanto_cobrar");
  check("próximo passo = metas", s.next?.key === "metas");

  // ===== +10 vendas → "metas" (revela Saúde) + graduação =====
  for (let i = 0; i < 7; i++) sale(); // total 10
  s = P.status(orgId);
  check("10 vendas + ficha: estágio 'metas'", s.stage === "metas");
  check("Saúde revelada", s.unlocked.saude === true);
  check("graduou (done)", s.done === true && !!s.doneMessage && s.next === null);

  // ===== Progressão consecutiva: 10 vendas SEM ficha trava em quanto_custa =====
  const org2 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), org2);
  for (let i = 0; i < 12; i++) db.prepare(`INSERT INTO comigo_orders (id, organization_id, status, paid_via, total) VALUES (?, ?, 'paid','cash', 10)`).run(randomUUID(), org2);
  const s2 = P.status(org2);
  check("muitas vendas SEM ficha trava em 'quanto_custa'", s2.stage === "quanto_custa" && s2.done === false);

  // ===== Isolamento =====
  const org3 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Z', 'active')`).run(randomUUID(), org3);
  check("isolamento: org nova começa em 'vender'", P.status(org3).stage === "vender");

  // --- Relatório ---
  console.log("\n=== TEST: Comigo — Progressão pedagógica (ADR-121) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Progressão pedagógica OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
