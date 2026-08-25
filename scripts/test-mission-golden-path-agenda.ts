/**
 * TEST — Mission golden path AGENDA (ADR-189 F23). PARIDADE cross-vertical: o mesmo ciclo do
 * golden-path de varejo (receita) roda ponta a ponta pra uma CLÍNICA (métrica appointments), provando
 * que o Mission OS atende as verticais de AGENDA (clínica/petshop/beleza/serviços) exatamente como as
 * de receita — o fio (correlation_id = mission:<id>) se costura igual, com plano reverso de agenda.
 * Compõe os serviços REAIS F1–F22 (nada novo). Cenário: "encher a agenda com 200 atendimentos".
 *
 * Uso: npm run test:mission-golden-path-agenda
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mgoldag-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mgoldag-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionIntentService: MI } = await import("../src/server/MissionIntentService.js");
  const { MissionService: M } = await import("../src/server/MissionService.js");
  const { MissionReversePlanner: RP } = await import("../src/server/MissionReversePlanner.js");
  const { MissionReadinessService: RD } = await import("../src/server/MissionReadinessService.js");
  const { MissionNextStepService: NS } = await import("../src/server/MissionNextStepService.js");
  const { MissionCheckpointService: CP } = await import("../src/server/MissionCheckpointService.js");
  const { MissionDebriefService: DB } = await import("../src/server/MissionDebriefService.js");
  const { FalaTuHomeService: HOME } = await import("../src/server/FalaTuHomeService.js");
  const { NavigationManifestService: NAV } = await import("../src/server/NavigationManifestService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  // Clínica: Mission Layer + pattern_memory ligados, canal conectado, histórico de agenda + base.
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status, mission_layer_enabled, pattern_memory) VALUES (?, ?, 'Clínica Vida', 'active', 'clinica', 'autonomo', '[]', 'active', 1, 1)`).run(randomUUID(), A);
  PermissionService.seedSystemProfiles(A);
  const owner = { userId: "u1", role: "owner", role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id=? AND system_key='owner'`).get(A) as any).id, organizationId: A };
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp', 'wa', '5511', 'connected')`).run(randomUUID(), A);
  // Histórico: 80 completados, 20 faltas/cancelados → comparecimento 80%.
  const mkAppt = (s: string) => db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, status, scheduled_start) VALUES (?, ?, 'ct', 'Consulta', ?, '2026-07-10 09:00:00')`).run(randomUUID(), A, s);
  for (let i = 0; i < 80; i++) mkAppt("completed");
  for (let i = 0; i < 15; i++) mkAppt("no_show");
  for (let i = 0; i < 5; i++) mkAppt("cancelled");
  for (let i = 0; i < 300; i++) db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'C', ?)`).run(randomUUID(), A, `c${i}`);
  const nextYear = `${new Date().getUTCFullYear() + 1}-06-30`;

  // ── 1. Intenção → Missão de AGENDA ──
  const prop = MI.propose(A, "quero encher a agenda com 200 atendimentos no mês", { persist: true });
  const mission = prop.mission!;
  check("1.1 intenção → missão de agenda (appointments/200, system_proposed)", !!mission && mission.targetMetric === "appointments" && mission.targetValue === 200 && mission.source === "system_proposed");
  M.update(A, mission.id, { deadline: nextYear });

  // ── 2. Plano reverso de AGENDA: 200 ÷ comparecimento 0.8 → 250 agend. ÷ 0.25 → 1000 contatos − 300 = gap 700 ──
  const plan = RP.plan(A, mission.id, { bookingConversionRate: 0.25 });
  const stage = (n: string) => plan.chain.find((s: any) => s.stage === n)?.value;
  check("2.1 comparecimento derivado do histórico (0.8) → 250 agendamentos", plan.assumptions.showRate === 0.8 && stage("bookings") === 250);
  check("2.2 cadeia até contatos = 1000", stage("appointments") === 200 && stage("contacts") === 1000);
  check("2.3 gap vs base (300) = 700 + gargalo contatos", plan.gap?.missing === 700 && plan.criticalStage === "contacts");
  check("2.4 último momento seguro derivado do prazo", !!plan.lastSafeMoment?.date);

  // ── 3. Prontidão: canal conectado + dados presentes ──
  const ready = RD.assess(A, mission.id, { bookingConversionRate: 0.25 });
  check("3.1 prontidão compõe (canal pronto)", ready.readyPct >= 0 && ready.dimensions.some((d: any) => d.key === "channel" && d.ready === true));

  // ── 4. Execução GOVERNADA via próximo passo (fio costurado por correlation_id) ──
  M.setAutonomy(A, mission.id, "suggest");
  const step = NS.propose(A, mission.id, { bookingConversionRate: 0.25 });
  check("4.1 efeito → decision_actions governada (nunca 'done')", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE id=? AND organization_id=?`).get(step.action.id, A) as any).n === 1 && step.action.status !== "done");
  check("4.2 fio: correlation_id = mission:<id>", step.action.correlationId === `mission:${mission.id}`);
  check("4.3 próximo passo em ATENDIMENTOS (count), não R$", step.step.lever?.impactUnit === "count");

  // ── 5. Trajetória: rodando + realizado baixo perto do prazo → at_risk (RESULTADO ≠ EXECUÇÃO) ──
  M.setStatus(A, mission.id, "running");
  const near = `${new Date().getUTCFullYear() + 1}-06-01`;
  const cp = CP.publishCheckpointSignal(A, mission.id, { asOf: near, actualValue: 40 });
  check("5.1 checkpoint publica mission/at_risk", cp.published === true && !!db.prepare(`SELECT 1 FROM business_signals WHERE organization_id=? AND domain='mission' AND signal_type='at_risk' AND status='open'`).get(A));
  check("5.2 checkpoint NÃO marca achieved (resultado ≠ execução)", M.get(A, mission.id)!.status === "running");

  // ── 6. Superfícies: "Hoje" + nav ──
  const block = HOME.missionsBlock(A)!;
  check("6.1 Hoje mostra a missão (inFlight + atRisk)", block.inFlight >= 1 && block.atRisk >= 1);
  const nav = NAV.forUser(A, owner);
  check("6.2 nav mostra 'missoes'", nav.primary.some((p: any) => p.key === "missoes"));

  // ── 7. Resultado ASSEGURADO → aprendizado no MOTOR ÚNICO ──
  M.setStatus(A, mission.id, "achieved");
  const learn = DB.learn(A, mission.id);
  check("7.1 achieved → worked no PatternMemory", learn.ok && learn.learned && learn.outcome === "worked");
  check("7.2 aprendizado gravado no motor único", (db.prepare(`SELECT COUNT(*) n FROM business_pattern_outcomes WHERE organization_id=? AND pattern_type LIKE 'mission:%'`).get(A) as any).n === 1);

  // ── 8. Debrief ──
  const deb = DB.debrief(A, mission.id);
  check("8.1 debrief com lições (missão atingida)", deb.status === "achieved" && deb.lessons.some((l: string) => /funcionou/i.test(l)));

  // ── 9. Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', 1)`).run(randomUUID(), B);
  check("9.1 isolamento (B sem missões nem aprendizado de A)", M.list(B).length === 0 && (db.prepare(`SELECT COUNT(*) n FROM business_pattern_outcomes WHERE organization_id=?`).get(B) as any).n === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-golden-path-agenda: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
