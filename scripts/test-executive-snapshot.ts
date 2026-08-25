/**
 * TEST — Executive Business Snapshot (ADR-190 F4, CEO Operating Layer). A primitiva
 * central que responde "Como está minha empresa?" (§4): 3 pilares (comercial/
 * operações/financeiro) + indicadores (measure honesto) + metas + exceções +
 * prioridades + missões + visão. Composição READ-ONLY, determinística.
 *
 * Cobre: composição dos 3 pilares · honestidade (sem fonte → value null, nunca 0) ·
 * mapeamento domínio→pilar das exceções · saúde qualitativa (critical/attention/ok) ·
 * redação de dinheiro (§73) · visão composta · isolamento multi-tenant.
 *
 * Uso: npm run test:executive-snapshot
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-esnap-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-esnap-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExecutiveBusinessSnapshotService: S } = await import("../src/server/ExecutiveBusinessSnapshotService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { BusinessGoalService } = await import("../src/server/BusinessGoalService.js");
  const { ExecutiveVisionService } = await import("../src/server/ExecutiveVisionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Clínica', 'active')`).run(randomUUID(), A);

  // ── 1. Composição: 3 pilares presentes, cada um com a estrutura completa ──
  const s0 = S.read(A);
  check("1.1 três pilares presentes", !!s0.pillars.commercial && !!s0.pillars.operations && !!s0.pillars.finance);
  check("1.2 cada pilar tem indicators/goals/exceptions/priorities/health", ["commercial", "operations", "finance"].every((p) => {
    const v = (s0.pillars as any)[p];
    return Array.isArray(v.indicators) && Array.isArray(v.goals) && Array.isArray(v.exceptions) && Array.isArray(v.priorities) && typeof v.health === "string";
  }));
  check("1.3 org sem exceção/meta → sem exceções nos pilares", s0.pillars.finance.exceptions.length === 0 && s0.pillars.commercial.exceptions.length === 0);

  // ── 2. Honestidade (RN-CEO-11): indicador sem fonte → value null, nunca 0 ──
  const finInd = s0.pillars.finance.indicators;
  const cash = finInd.find((i: any) => i.metricKey === "cash_balance");
  check("2.1 cash_balance sem fonte → value null + unavailable (não 0)", !!cash && cash.value === null && cash.availability === "unavailable" && cash.basis === "unknown");
  // revenue (pilar comercial) é fonte interna → available; org vazia mede 0 (FATO, não inventado).
  const rev = s0.pillars.commercial.indicators.find((i: any) => i.metricKey === "revenue");
  check("2.2 revenue fonte interna → available + value 0 (fato medido)", !!rev && rev.availability === "available" && rev.value === 0);

  // ── 3. Exceção financeira crítica → pilar finance health critical + exceção mapeada ──
  BusinessSignalService.publish(A, {
    domain: "finance", signalType: "overdue_spike", severity: "critical", basis: "fact", confidence: 1,
    impactAmount: 5000, impactUnit: "BRL", sourceService: "test", evidence: { n: 3 }, dedupeKey: "fin-crit-1",
  });
  const s1 = S.read(A);
  check("3.1 exceção financeira aparece no pilar finance", s1.pillars.finance.exceptions.some((e: any) => e.type === "overdue_spike"));
  check("3.2 finance health = critical", s1.pillars.finance.health === "critical");
  check("3.3 exceção financeira NÃO vaza pro comercial", !s1.pillars.commercial.exceptions.some((e: any) => e.type === "overdue_spike"));

  // ── 4. Exceção comercial de risco → pilar commercial health attention ──
  BusinessSignalService.publish(A, {
    domain: "sales", signalType: "conversion_drop", severity: "risk", basis: "fact", confidence: 0.8,
    sourceService: "test", evidence: { pct: -20 }, dedupeKey: "sales-risk-1",
  });
  const s2 = S.read(A);
  check("4.1 exceção comercial mapeia no pilar commercial", s2.pillars.commercial.exceptions.some((e: any) => e.type === "conversion_drop"));
  check("4.2 commercial health = attention (risco, sem crítico)", s2.pillars.commercial.health === "attention");

  // ── 5. Meta de revenue (pilar comercial) aparece no pilar certo ──
  BusinessGoalService.set(A, { metric: "revenue", targetAmount: 100000, actor: "u1" });
  const s3 = S.read(A);
  check("5.1 meta de revenue agrupa no pilar commercial", s3.pillars.commercial.goals.some((g: any) => g.metric === "revenue" && g.target === 100000));

  // ── 6. Redação de dinheiro (§73): includeMoney:false zera valores em BRL ──
  const sRedact = S.read(A, { includeMoney: false });
  const revR = sRedact.pillars.commercial.indicators.find((i: any) => i.metricKey === "revenue");
  check("6.1 indicador BRL redigido (value null + redacted)", !!revR && revR.value === null && revR.redacted === true);
  const goalR = sRedact.pillars.commercial.goals.find((g: any) => g.metric === "revenue");
  check("6.2 meta BRL redigida (target null + redacted)", !!goalR && goalR.target === null && goalR.redacted === true);
  const excR = sRedact.pillars.finance.exceptions.find((e: any) => e.type === "overdue_spike");
  check("6.3 impacto BRL da exceção redigido", !!excR && excR.impactAmount === null && excR.redacted === true);
  // includeMoney default (true) mantém o valor visível.
  check("6.4 default expõe R$ (revenue value === 0)", s3.pillars.commercial.indicators.find((i: any) => i.metricKey === "revenue")?.value === 0);

  // ── 7. Visão composta (F3) ──
  ExecutiveVisionService.save(A, { statement: "Ser a clínica premium da região" }, "u1");
  const s4 = S.read(A);
  check("7.1 snapshot compõe a visão declarada", s4.vision?.defined === true && s4.vision?.statement?.includes("premium") === true);

  // ── 8. Resumo de atenção coerente com os sinais publicados ──
  check("8.1 attention.total ≥ 2 (dois sinais abertos)", s4.attention.total >= 2 && s4.attention.bySeverity.critical >= 1);

  // ── 9. Isolamento multi-tenant ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), B);
  const sB = S.read(B);
  check("9.1 org B não vê exceções da org A", sB.attention.total === 0 && sB.pillars.finance.exceptions.length === 0);
  check("9.2 org B sem visão + sem meta", sB.vision?.defined === false && sB.pillars.finance.goals.length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} executive-snapshot: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
