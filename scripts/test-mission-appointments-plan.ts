/**
 * TEST — Plano reverso de AGENDA (ADR-189 F22). Estende o MissionReversePlanner à métrica
 * `appointments` (encher a agenda) — torna as verticais de agendamento (clínica/petshop/beleza/
 * serviços) primeira-classe no Mission OS. Determinístico, honesto (sem premissa → unknown; taxa de
 * comparecimento DERIVADA do histórico, nunca inventada). Regressão do caminho de receita segue intacta.
 *
 * Uso: npm run test:mission-appointments-plan
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mappt-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mappt-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionService: M } = await import("../src/server/MissionService.js");
  const { MissionReversePlanner: RP } = await import("../src/server/MissionReversePlanner.js");
  const { MissionNextStepService: NS } = await import("../src/server/MissionNextStepService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status, mission_layer_enabled) VALUES (?, ?, 'Clínica', 'active', 'clinica', 'autonomo', '[]', 'active', 1)`).run(randomUUID(), A);
  // Histórico de atendimentos: 80 completados, 20 faltas/cancelados → comparecimento 80%.
  const mkAppt = (status: string) => db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, status, scheduled_start) VALUES (?, ?, 'ct', 'Consulta', ?, '2026-07-10 09:00:00')`).run(randomUUID(), A, status);
  for (let i = 0; i < 80; i++) mkAppt("completed");
  for (let i = 0; i < 15; i++) mkAppt("no_show");
  for (let i = 0; i < 5; i++) mkAppt("cancelled");
  // Base de 300 contatos.
  for (let i = 0; i < 300; i++) db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'C', ?)`).run(randomUUID(), A, `c${i}`);

  // Missão de AGENDA: 200 atendimentos no mês.
  const mission = M.create(A, { title: "200 atendimentos no mês", targetMetric: "appointments", targetValue: 200, targetUnit: "count", deadline: "2027-06-30" });
  const stage = (p: any, n: string) => p.chain.find((s: any) => s.stage === n);

  // ── 1. Comparecimento DERIVADO do histórico (80/100 = 0.8) ──
  const plan = RP.plan(A, mission.id, { bookingConversionRate: 0.25 });
  check("1.1 applicable (agenda tem cadeia agora)", plan.applicable === true && plan.targetMetric === "appointments");
  check("1.2 comparecimento derivado do histórico = 0.8", plan.assumptions.showRate === 0.8 && plan.assumptions.showRateSource === "history");
  check("1.3 atendimentos alvo = 200 (target)", stage(plan, "appointments")?.value === 200 && stage(plan, "appointments")?.basis === "target");
  check("1.4 agendamentos = ceil(200/0.8) = 250 (derived)", stage(plan, "bookings")?.value === 250 && stage(plan, "bookings")?.basis === "derived");
  check("1.5 contatos = ceil(250/0.25) = 1000 (assumed)", stage(plan, "contacts")?.value === 1000);
  check("1.6 gap vs base 300 = 700 + gargalo contatos", plan.gap?.missing === 700 && plan.criticalStage === "contacts");
  check("1.7 último momento seguro derivado do prazo", !!plan.lastSafeMoment?.date);

  // ── 2. Premissa faltante (sem bookingConversionRate) → cadeia PARA em contatos (honesto) ──
  const p2 = RP.plan(A, mission.id, {});
  check("2.1 agendamentos ainda calculam (comparecimento do histórico)", stage(p2, "bookings")?.value === 250);
  check("2.2 contatos unknown sem a taxa (nunca inventa)", stage(p2, "contacts")?.value === null && stage(p2, "contacts")?.basis === "unknown" && p2.criticalStage === "contacts");

  // ── 3. Sem histórico de agenda → comparecimento unknown (não inventa taxa) ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, mission_layer_enabled) VALUES (?, ?, 'Nova', 'active', 'clinica', 1)`).run(randomUUID(), B);
  const mB = M.create(B, { title: "50 atendimentos", targetMetric: "appointments", targetValue: 50, targetUnit: "count" });
  const pB = RP.plan(B, mB.id, {});
  check("3.1 sem histórico → comparecimento null + agendamentos unknown", pB.assumptions.showRate === null && stage(pB, "bookings")?.basis === "unknown" && pB.criticalStage === "bookings");

  // ── 4. Próximo passo (F15) agora funciona pra agenda: alavanca de campanha, impacto em count ──
  const step = NS.suggest(A, mission.id, { bookingConversionRate: 0.25 });
  check("4.1 next-step suggestable com alavanca de campanha", step.suggestable === true && step.lever?.commandType === "prepare_campaign");
  check("4.2 impacto em atendimentos (count), não R$", step.lever?.impactUnit === "count" && typeof step.lever?.expectedImpact === "number");

  // ── 5. Regressão: receita segue intacta ──
  const C = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, mission_layer_enabled) VALUES (?, ?, 'Loja', 'active', 'varejo', 1)`).run(randomUUID(), C);
  const mC = M.create(C, { title: "R$10k", targetMetric: "revenue", targetValue: 10000, targetUnit: "BRL" });
  const pC = RP.plan(C, mC.id, { avgTicket: 500, saleConversionRate: 0.25, contactConversionRate: 0.4 });
  check("5.1 receita ainda monta a cadeia (0-regressão)", pC.applicable === true && pC.chain.some((s: any) => s.stage === "sales" && s.value === 20));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-appointments-plan: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
