/**
 * TEST — Comigo/Graduação MEI + nota fiscal (ADR-122 / ADR-088 graduação).
 *
 * Uso: npm run test:comigo-graduation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-grad-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-grad-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 1) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoGraduationService: G, MEI_ANNUAL_LIMIT } = await import("../src/server/ComigoGraduationService.js");

  // Cria org com um faturamento-alvo nos últimos 90 dias (projeção = média×12).
  function orgWithMonthly(target: number) {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);
    // 3 meses × `target`/mês nos últimos 90 dias.
    for (let m = 0; m < 3; m++) {
      db.prepare(`INSERT INTO comigo_orders (id, organization_id, status, paid_via, total, created_at) VALUES (?, ?, 'paid', 'cash', ?, datetime('now', ?))`)
        .run(randomUUID(), orgId, target, `-${m * 30 + 5} days`);
    }
    return orgId;
  }

  // ===== Níveis de prontidão pelos cortes =====
  const cedo = G.status(orgWithMonthly(500));       // ~6k/ano
  check("R$500/mês → 'cedo'", cedo.readiness === "cedo");
  check("cedo: projeção anual ~6000", near(cedo.projectedAnnual, 6000, 10));
  check("cedo: informal, não pode nota", cedo.formalized === false && cedo.notaFiscal.canIssue === false);
  check("cedo: traz os passos do MEI", cedo.steps.length >= 4);

  const vale = G.status(orgWithMonthly(3000));      // ~36k/ano
  check("R$3.000/mês → 'vale_formalizar'", vale.readiness === "vale_formalizar");

  const perto = G.status(orgWithMonthly(6500));     // ~78k/ano (entre 70k e 81k)
  check("R$6.500/mês → 'perto_do_teto'", perto.readiness === "perto_do_teto");

  const acima = G.status(orgWithMonthly(8000));     // ~96k/ano (> 81k)
  check("R$8.000/mês → 'acima_mei'", acima.readiness === "acima_mei");
  check("teto MEI exposto (81000)", acima.meiLimit === MEI_ANNUAL_LIMIT && MEI_ANNUAL_LIMIT === 81000);

  // ===== declare: formaliza e troca o guia para nota fiscal =====
  const org = orgWithMonthly(3000);
  check("antes: informal", G.status(org).formalization === "informal");
  const dec = G.declare(org, { type: "mei", cnpj: "12.345.678/0001-99" });
  check("declare vira MEI", dec.formalization === "mei");
  check("MEI já pode emitir nota", dec.notaFiscal.canIssue === true);
  check("MEI não mostra mais os passos de abertura", dec.steps.length === 0);
  check("CNPJ guardado só com dígitos", dec.cnpj === "12345678000199");

  // ===== Isolamento =====
  const other = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), other);
  const so = G.status(other);
  check("isolamento: org sem vendas → cedo/informal", so.readiness === "cedo" && so.projectedAnnual === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Comigo — Graduação MEI (ADR-122) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Graduação MEI OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
