/**
 * TEST — CEO Operating Layer GOLDEN PATH (ADR-190 F10). Prova o North Star (§4)
 * ponta-a-ponta compondo os SERVIÇOS REAIS F1–F9 (nada novo): o dono pergunta
 * "Como está minha empresa?" e recebe pilares + desvios + restrição + missão
 * sugerida + financeiro + narração + "Hoje" — tudo honesto, role-gated e
 * consistente. Cenário: clínica com meta de receita atrasada + desvio financeiro
 * crítico + recebível vencido.
 *
 * Cadeia: measure/registry (F1/F2) → visão (F3) → snapshot (F4) → constraint (F5)
 * → mission bridge (F6) → finance (F7) → briefing block (F8) → today (F9).
 *
 * Uso: npm run test:ceo-golden-path
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ceogp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ceogp-123456";

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
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Clínica Premium', 'active')`).run(randomUUID(), O);

  // ═══ CENÁRIO: o dono monta o negócio ═══
  // Visão (F3), meta de receita ATRASADA (F1/F2), desvio financeiro crítico + recebível vencido.
  ExecutiveVisionService.save(O, { statement: "Ser a clínica premium referência da região", strategicPriority: "crescimento sustentável" }, "dono");
  BusinessGoalService.set(O, { metric: "revenue", targetAmount: 50000, actor: "dono" });
  BusinessSignalService.publish(O, {
    domain: "finance", signalType: "overdue_spike", severity: "critical", basis: "fact", confidence: 1,
    impactAmount: 8000, impactUnit: "BRL", sourceService: "cobranca", evidence: { vencidos: 5 }, dedupeKey: "gp-fin-crit",
  });
  db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'Consulta em atraso', 8000, '2026-01-01', 'open')`).run(randomUUID(), O);
  db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'A vencer', 12000, '2026-12-31', 'open')`).run(randomUUID(), O);

  // ═══ "COMO ESTÁ MINHA EMPRESA?" — a cadeia executiva responde ═══

  // ── F4: snapshot com 3 pilares, financeiro crítico, indicadores honestos ──
  const snap = ExecutiveBusinessSnapshotService.read(O);
  check("F4.1 três pilares presentes", !!snap.pillars.commercial && !!snap.pillars.operations && !!snap.pillars.finance);
  check("F4.2 pilar financeiro CRÍTICO (desvio)", snap.pillars.finance.health === "critical");
  check("F4.3 visão do dono compõe o snapshot", snap.vision?.defined === true && snap.vision?.statement?.includes("referência"));
  const cash = snap.pillars.finance.indicators.find((i: any) => i.metricKey === "cash_balance");
  check("F4.4 indicador sem fonte → null (honesto, não 0)", cash?.value === null && cash?.availability === "unavailable");

  // ── F5: pior pilar + restrição nº1 (hipótese) ──
  const con = ExecutiveConstraintService.assess(O);
  check("F5.1 pior pilar = Financeiro", con.worstPillar?.pillar === "finance");
  check("F5.2 restrição = o desvio financeiro", con.constraint?.type === "overdue_spike" && con.constraint?.pillar === "finance");
  check("F5.3 restrição rotulada HIPÓTESE (não causa provada)", (con.constraint?.rationale || "").startsWith("hypothesis"));
  check("F5.4 restrição ameaça a meta de receita", con.constraint?.threatensGoal?.metric === "revenue");

  // ── F6: missão SUGERIDA (nunca criada) pra recuperar a meta ameaçada ──
  const bridge = ExecutiveMissionBridgeService.suggest(O);
  const draft = bridge.suggestions.find((s: any) => s.draft?.targetMetric === "revenue");
  check("F6.1 missão sugerida pra recuperar a receita", !!draft?.draft && draft.draft.targetValue === 50000);
  check("F6.2 origem válida p/ o dono criar direto", draft?.draft?.source === "system_proposed");
  check("F6.3 nada foi criado (sugerir≠criar)", db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=?`).get(O) as any ? (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=?`).get(O) as any).n === 0 : true);

  // ── F7: financeiro rico, inadimplência real, escopo rotulado ──
  const fin = ExecutiveFinanceService.read(O);
  check("F7.1 a receber = 20000 (fact)", fin.receivables?.total === 20000);
  check("F7.2 vencido = 8000", fin.receivables?.overdue === 8000);
  check("F7.3 inadimplência = 8000/20000 = 40%", Math.abs((fin.receivables?.defaultRatePct ?? 0) - 40) < 0.5);

  // ── F8: o Diretor NARRA a Visão Executiva (números derivados, IA não calcula) ──
  const block = ExecutiveAdvisorService.executiveBlock(O);
  check("F8.1 bloco narra a Visão Executiva", block.includes("VISÃO EXECUTIVA"));
  check("F8.2 aponta o pior pilar (Financeiro) + restrição", block.includes("PIOR forma: Financeiro") && block.includes("RESTRIÇÃO nº1"));

  // ── F9: o "Hoje" (visão completa) traz a leitura executiva por exceção ──
  const today = FalaTuHomeService.executiveToday(O, { includeMoney: true });
  check("F9.1 today aponta o Financeiro em atenção", today.line.includes("Financeiro"));
  check("F9.2 today traz a restrição (fato de priorização)", !!today.constraint);

  // ═══ GUARDRAILS ponta-a-ponta ═══
  // Dinheiro role-gated: sem visão completa, o snapshot redige R$.
  const snapRedacted = ExecutiveBusinessSnapshotService.read(O, { includeMoney: false });
  const revR = snapRedacted.pillars.commercial.indicators.find((i: any) => i.metricKey === "revenue");
  check("G.1 dinheiro role-gated (revenue redigido)", revR?.value === null && revR?.redacted === true);

  // ═══ Isolamento multi-tenant ═══
  const P = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Outra Clínica', 'active')`).run(randomUUID(), P);
  const conP = ExecutiveConstraintService.assess(P);
  const finP = ExecutiveFinanceService.read(P);
  check("G.2 org P isolada (sem restrição, sem recebível de O)", conP.constraint === null && finP.receivables?.total === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} ceo-golden-path: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
