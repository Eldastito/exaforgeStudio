/**
 * TEST — Leitura executiva no "Hoje" (ADR-190 F9, CEO Operating Layer). O bloco "Hoje"
 * do Fala Tu ganha "Como está minha empresa?" por EXCEÇÃO (§115 — invisible UX, sem menu):
 * FalaTuHomeService.executiveToday COMPÕE a restrição/pior-pilar (F5). Honesto: sem desvio
 * → worstPillar/constraint null + linha calma; restrição é HIPÓTESE; role-scoped pelo caller.
 *
 * Uso: npm run test:executive-today-block
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-etoday-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-etoday-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuHomeService: H } = await import("../src/server/FalaTuHomeService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  const O = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Clínica', 'active')`).run(randomUUID(), O);

  // ── 1. Sem desvio → linha calma, sem worstPillar/constraint ──
  const t0 = H.executiveToday(O);
  check("1.1 sem desvio → worstPillar null", t0.worstPillar === null);
  check("1.2 sem desvio → constraint null", t0.constraint === null);
  check("1.3 linha calma", t0.line.includes("sob controle"));
  check("1.4 os 3 pilares sempre presentes (saúde)", t0.pillarsHealth.length === 3);

  // ── 2. Desvio financeiro crítico → pior pilar + restrição (hipótese) + linha de atenção ──
  BusinessSignalService.publish(O, {
    domain: "finance", signalType: "overdue_spike", severity: "critical", basis: "fact", confidence: 1,
    impactAmount: 6000, impactUnit: "BRL", sourceService: "test", evidence: { n: 4 }, dedupeKey: "fin-crit-1",
  });
  const t1 = H.executiveToday(O);
  check("2.1 worstPillar = finance", t1.worstPillar?.pillar === "finance" && t1.worstPillar?.health === "critical");
  check("2.2 constraint presente + basis do desvio preservado (fact)", !!t1.constraint && t1.constraint?.basis === "fact");
  check("2.3 linha aponta o Financeiro", t1.line.includes("Financeiro") && t1.line.includes("atenção"));

  // ── 3. Redação de dinheiro (§73): includeMoney false não quebra + segue coerente ──
  const t1r = H.executiveToday(O, { includeMoney: false });
  check("3.1 sem dinheiro → constraint ainda presente (fato de priorização)", !!t1r.constraint);

  // ── 4. Isolamento ──
  const P = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), P);
  const tp = H.executiveToday(P);
  check("4.1 org P sem constraint (isolada)", tp.constraint === null && tp.worstPillar === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} executive-today-block: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
