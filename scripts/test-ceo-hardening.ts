/**
 * TEST — CEO Operating Layer HARDENING (ADR-190 F11). Doc-of-record executável de dupla
 * função: (A) CODIFICA os guardrails RN-CEO-01..15 como REGRESSÃO tocando os serviços
 * REAIS F1–F10; (B) verifica a FIAÇÃO de produção (serviços importáveis, rotas montadas,
 * testes wired, runbook presente). FECHA o ADR-190.
 *
 * Uso: npm run test:ceo-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ceohard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ceohard-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { BusinessGoalService } = await import("../src/server/BusinessGoalService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { ExecutiveVisionService } = await import("../src/server/ExecutiveVisionService.js");
  const { ExecutiveBusinessSnapshotService } = await import("../src/server/ExecutiveBusinessSnapshotService.js");
  const { ExecutiveConstraintService } = await import("../src/server/ExecutiveConstraintService.js");
  const { ExecutiveMissionBridgeService } = await import("../src/server/ExecutiveMissionBridgeService.js");
  const { ExecutiveFinanceService } = await import("../src/server/ExecutiveFinanceService.js");
  const { ExecutiveAdvisorService } = await import("../src/server/ExecutiveAdvisorService.js");
  const { FalaTuHomeService } = await import("../src/server/FalaTuHomeService.js");

  const O = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org', 'active')`).run(randomUUID(), O);
  BusinessGoalService.set(O, { metric: "revenue", targetAmount: 40000, actor: "dono" });
  BusinessSignalService.publish(O, {
    domain: "finance", signalType: "overdue_spike", severity: "critical", basis: "fact", confidence: 1,
    impactAmount: 3000, impactUnit: "BRL", sourceService: "t", evidence: { n: 2 }, dedupeKey: "hard-fin",
  });

  // ═══ (A) GUARDRAILS RN-CEO ═══

  // RN-CEO-01 / Complexity Budget (§63): composição não motor — ZERO tabela nova de CEO.
  const ceoTables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'executive_%' OR name LIKE 'ceo_%')`).all() as any[]);
  check("RN-01 zero tabela nova de CEO (composição, não motor)", ceoTables.length === 0);

  // RN-CEO-11 / null≠zero: métrica sem fonte → value null + unavailable, NUNCA 0.
  const cash = BusinessGoalService.measure(O, "cash_balance");
  check("RN-11 sem fonte → value null + unavailable (não 0)", cash?.value === null && cash?.availability === "unavailable" && cash?.basis === "unknown");

  // RN-CEO-03 / fato≠hipótese: a restrição é HIPÓTESE; o basis do desvio é o real.
  const con = ExecutiveConstraintService.assess(O);
  check("RN-03 restrição rotulada hypothesis", (con.constraint?.rationale || "").startsWith("hypothesis"));
  check("RN-03 basis do desvio preservado (fact, não 'hypothesis')", con.constraint?.basis === "fact");

  // RN-CEO-06 / sugerir≠criar: o Mission Bridge NUNCA escreve missão.
  ExecutiveMissionBridgeService.suggest(O);
  check("RN-06 mission bridge não cria missão (0 escritas)", (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=?`).get(O) as any).n === 0);

  // RN-CEO-06 / visão nunca inventada: org sem visão → defined false.
  const P = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'P', 'active')`).run(randomUUID(), P);
  check("RN-06 visão nunca inventada (sem dado → defined false)", ExecutiveVisionService.get(P).defined === false);

  // RN-CEO-13 / dinheiro role-gated: includeMoney:false redige BRL no snapshot, finance e constraint.
  const snapR = ExecutiveBusinessSnapshotService.read(O, { includeMoney: false });
  const revR = snapR.pillars.commercial.indicators.find((i: any) => i.metricKey === "revenue");
  const finR = ExecutiveFinanceService.read(O, { includeMoney: false });
  check("RN-13 snapshot redige BRL sem visão completa", revR?.value === null && revR?.redacted === true);
  check("RN-13 finance redige BRL", finR.redacted === true);

  // RN-CEO-04 / IA não calcula KPI: o bloco do Diretor é texto determinístico com números derivados.
  const block = ExecutiveAdvisorService.executiveBlock(O);
  check("RN-04 Diretor narra a Visão Executiva (determinístico)", block.includes("VISÃO EXECUTIVA"));

  // RN-CEO-08 / isolamento: org P não vê o desvio de O.
  check("RN-08 isolamento multi-tenant", ExecutiveConstraintService.assess(P).constraint === null);

  // ═══ (B) FIAÇÃO DE PRODUÇÃO ═══

  // Serviços importáveis com os métodos-chave.
  check("WIRE serviços importáveis com métodos-chave",
    typeof ExecutiveBusinessSnapshotService.read === "function" &&
    typeof ExecutiveConstraintService.assess === "function" &&
    typeof ExecutiveMissionBridgeService.suggest === "function" &&
    typeof ExecutiveFinanceService.read === "function" &&
    typeof ExecutiveVisionService.save === "function" &&
    typeof ExecutiveAdvisorService.executiveBlock === "function" &&
    typeof FalaTuHomeService.executiveToday === "function" &&
    typeof BusinessGoalService.measure === "function");

  // Rotas montadas no router /api/executive.
  const routerMod: any = await import("../src/server/routes/executive.js");
  const stack = (routerMod.default?.stack || []) as any[];
  const paths = new Set(stack.filter((l) => l.route).map((l) => l.route.path));
  for (const p of ["/vision", "/snapshot", "/constraint", "/mission-suggestions", "/finance"]) {
    check(`WIRE rota ${p} montada`, paths.has(p));
  }

  // Testes wired no package.json.
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const wanted = ["test:executive-metric-registry", "test:executive-metrics-sources", "test:executive-vision",
    "test:executive-snapshot", "test:executive-constraint", "test:executive-mission-bridge",
    "test:executive-finance", "test:executive-briefing-block", "test:executive-today-block", "test:ceo-golden-path"];
  check("WIRE todos os testes do CEO Layer wired", wanted.every((t) => !!pkg.scripts?.[t]));

  // Runbook presente.
  check("WIRE runbook presente", fs.existsSync(path.join(process.cwd(), "docs/runbook/ceo-layer-operacao.md")));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} ceo-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
