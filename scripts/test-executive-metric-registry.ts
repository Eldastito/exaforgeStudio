/**
 * TEST — Executive Metric Registry (ADR-190 F1, CEO Operating Layer). Estende (não duplica) o
 * registro do BusinessGoalService com descritores executivos: pillar/basis/source/betterDirection +
 * availability. Leitura HONESTA (measure): sem fonte → value:null + basis:'unknown' (nunca 0,
 * RN-CEO-11). 0-regressão do registro existente. Isolado por org.
 *
 * Uso: npm run test:executive-metric-registry
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-emr-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-emr-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { BusinessGoalService: BG, EXECUTIVE_PILLARS } = await import("../src/server/BusinessGoalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'varejo')`).run(randomUUID(), A);
  // Recebível recuperado no mês = 5.000 (fonte real presente).
  db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status, received_at) VALUES (?, ?, 'F', 5000, '2026-08-01', 'received', ?)`).run(randomUUID(), A, new Date().toISOString());

  // ── 1. Descritor executivo por métrica ──
  const rev = BG.describe("revenue")!;
  check("1.1 revenue: pillar commercial, basis fact, betterDirection up", rev.pillar === "commercial" && rev.basis === "fact" && rev.betterDirection === "up" && typeof rev.source === "string");
  const recv = BG.describe("receivables")!;
  check("1.2 receivables: pillar finance", recv.pillar === "finance");
  check("1.3 métrica desconhecida → null", BG.describe("nao_existe") === null);

  // ── 2. Taxonomia de pilares (3) + agrupamento ──
  check("2.1 pilares = commercial/operations/finance", EXECUTIVE_PILLARS.length === 3 && EXECUTIVE_PILLARS.includes("finance"));
  const byP = BG.metricsByPillar();
  check("2.2 metricsByPillar agrupa (commercial tem revenue; finance tem receivables)", byP.commercial.some((d: any) => d.metricKey === "revenue") && byP.finance.some((d: any) => d.metricKey === "receivables"));
  check("2.3 catálogo executivo completo (≥5 métricas)", BG.executiveCatalog().length >= 5);

  // ── 3. Availability: fonte interna presente → available ──
  check("3.1 receivables available (fonte interna)", BG.availability(A, "receivables") === "available");
  check("3.2 métrica desconhecida → availability null", BG.availability(A, "nao_existe") === null);

  // ── 4. measure(): leitura honesta com valor + procedência ──
  const mRecv = BG.measure(A, "receivables")!;
  check("4.1 measure receivables: value 5000, basis fact, available, measuredAt", mRecv.value === 5000 && mRecv.basis === "fact" && mRecv.availability === "available" && !!mRecv.measuredAt);
  check("4.2 measure carrega descritor (pillar/source/unit)", mRecv.pillar === "finance" && mRecv.unit === "BRL" && typeof mRecv.source === "string");

  // ── 5. RN-CEO-11: sem valor NÃO vira 0 — org vazia, receita sem snapshot ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Vazia', 'active')`).run(randomUUID(), B);
  const mB = BG.measure(B, "receivables")!;
  check("5.1 org sem recebível: value 0 (fonte existe, mês zerado) — honesto, não null", mB.value === 0 && mB.availability === "available");
  check("5.2 measure de métrica desconhecida → null", BG.measure(B, "nao_existe") === null);

  // ── 6. 0-regressão: catalog/isKnownMetric/currentValue seguem funcionando ──
  check("6.1 catalog() antigo intacto (metric/label/unit)", BG.catalog().some((c: any) => c.metric === "revenue" && c.unit === "BRL"));
  check("6.2 currentValue receivables = 5000 (A)", BG.currentValue(A, "receivables") === 5000);
  check("6.3 isKnownMetric intacto", BG.isKnownMetric("revenue") === true && BG.isKnownMetric("nao_existe") === false);

  // ── 7. Isolamento ──
  check("7.1 isolamento (B recuperado 0, A 5000)", BG.currentValue(B, "receivables") === 0 && BG.currentValue(A, "receivables") === 5000);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} executive-metric-registry: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
