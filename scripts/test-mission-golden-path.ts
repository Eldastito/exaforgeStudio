/**
 * TEST — Mission golden path (ADR-189 F14). Prova de INTEGRAÇÃO: o ciclo inteiro do Mission OS
 * compõe ponta a ponta num fluxo real, com o fio (correlation_id) costurado de intenção a aprendizado.
 * Compõe os serviços REAIS F1–F11 (nada novo). Cenário: "atingir R$100 mil de faturamento".
 *
 *   intenção → missão → plano reverso → prontidão → execução GOVERNADA → trajetória (at_risk) →
 *   superfícies (Hoje + nav) → resultado ASSEGURADO → aprendizado (motor único) → debrief.
 *
 * Uso: npm run test:mission-golden-path
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mgold-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mgold-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionIntentService: MI } = await import("../src/server/MissionIntentService.js");
  const { MissionService: M } = await import("../src/server/MissionService.js");
  const { MissionReversePlanner: RP } = await import("../src/server/MissionReversePlanner.js");
  const { MissionReadinessService: RD } = await import("../src/server/MissionReadinessService.js");
  const { MissionRuntimeService: RT } = await import("../src/server/MissionRuntimeService.js");
  const { MissionCheckpointService: CP } = await import("../src/server/MissionCheckpointService.js");
  const { MissionDebriefService: DB } = await import("../src/server/MissionDebriefService.js");
  const { FalaTuHomeService: HOME } = await import("../src/server/FalaTuHomeService.js");
  const { NavigationManifestService: NAV } = await import("../src/server/NavigationManifestService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  // Org preparada: Mission Layer + pattern_memory ligados, canal conectado, vendas (ticket) e base.
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status, mission_layer_enabled, pattern_memory) VALUES (?, ?, 'Loja', 'active', 'varejo', 'autonomo', '[]', 'active', 1, 1)`).run(randomUUID(), A);
  PermissionService.seedSystemProfiles(A);
  const owner = { userId: "u1", role: "owner", role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id=? AND system_key='owner'`).get(A) as any).id, organizationId: A };
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp', 'wa', '5511', 'connected')`).run(randomUUID(), A);
  // ticket médio 500 (2 pedidos de 500) + base de 800 contatos.
  for (let i = 0; i < 2; i++) { const oid = randomUUID(); db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 500, '2026-06-10 10:00:00')`).run(oid, A); db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', 500, 1, 500, 200)`).run(randomUUID(), oid, A); }
  for (let i = 0; i < 800; i++) db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'C', ?)`).run(randomUUID(), A, `c${i}`);
  const nextYear = `${new Date().getUTCFullYear() + 1}-06-30`;

  // ── 1. Intenção → Missão (persistida) ──
  const prop = MI.propose(A, "quero atingir R$ 100 mil de faturamento no mês", { persist: true });
  const mission = prop.mission!;
  check("1.1 intenção → missão de receita (system_proposed, draft/off)", !!mission && mission.targetMetric === "revenue" && mission.targetValue === 100000 && mission.source === "system_proposed" && mission.status === "draft");
  M.update(A, mission.id, { deadline: nextYear });

  // ── 2. Plano reverso (§11): 100k ÷ ticket 500 → 200 vendas ÷ 25% → 800 opp ÷ 40% → 2000 contatos − base 800 = gap 1200 ──
  const plan = RP.plan(A, mission.id, { saleConversionRate: 0.25, contactConversionRate: 0.4 });
  const stage = (n: string) => plan.chain.find((s: any) => s.stage === n)?.value;
  check("2.1 ticket derivado de orders → 200 vendas", stage("sales") === 200);
  check("2.2 cadeia até contatos = 2000", stage("opportunities") === 800 && stage("contacts") === 2000);
  check("2.3 gap vs base (800) = 1200 + gargalo contacts", plan.gap?.missing === 1200 && plan.criticalStage === "contacts");
  check("2.4 último momento seguro derivado do prazo", !!plan.lastSafeMoment?.date);

  // ── 3. Prontidão: canal conectado + dados presentes ──
  const ready = RD.assess(A, mission.id, { saleConversionRate: 0.25, contactConversionRate: 0.4 });
  check("3.1 prontidão compõe (canal pronto, readyPct definido)", ready.readyPct >= 0 && ready.dimensions.some((d: any) => d.key === "channel" && d.ready === true));

  // ── 4. Execução GOVERNADA (fio costurado por correlation_id) ──
  M.setAutonomy(A, mission.id, "suggest");
  const act = RT.proposeAction(A, mission.id, { domain: "collection", actionType: "mission_outreach", title: "Ativar base" });
  check("4.1 efeito → decision_actions governada (nunca 'done')", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE id=? AND organization_id=?`).get(act.action.id, A) as any).n === 1 && act.action.status !== "done");
  check("4.2 fio: correlation_id = mission:<id>", act.action.correlationId === `mission:${mission.id}`);
  check("4.3 missão move por governança (waiting_approval/running)", ["waiting_approval", "running"].includes(act.mission.status));

  // ── 5. Trajetória: rodando + realizado baixo perto do prazo → at_risk (RESULTADO ≠ EXECUÇÃO) ──
  M.setStatus(A, mission.id, "running");
  const near = `${new Date().getUTCFullYear() + 1}-06-01`;
  const cp = CP.publishCheckpointSignal(A, mission.id, { asOf: near, actualValue: 10000 });
  check("5.1 checkpoint publica mission/at_risk", cp.published === true && !!db.prepare(`SELECT 1 FROM business_signals WHERE organization_id=? AND domain='mission' AND signal_type='at_risk' AND status='open'`).get(A));
  check("5.2 checkpoint NÃO marca achieved (resultado ≠ execução)", M.get(A, mission.id)!.status === "running");

  // ── 6. Superfícies: "Hoje" (por exceção) + nav (Executando→Missões) ──
  const block = HOME.missionsBlock(A)!;
  check("6.1 Hoje mostra a missão (inFlight + atRisk por sinal)", block.inFlight >= 1 && block.atRisk >= 1);
  const nav = NAV.forUser(A, owner);
  check("6.2 nav mostra 'missoes' (fusão §25)", nav.primary.some((p: any) => p.key === "missoes"));

  // ── 7. Resultado ASSEGURADO → aprendizado no MOTOR ÚNICO (só achieved ensina forte) ──
  M.setStatus(A, mission.id, "achieved");
  const learn = DB.learn(A, mission.id);
  check("7.1 achieved → worked no PatternMemory (assured)", learn.ok && learn.learned && learn.outcome === "worked");
  check("7.2 aprendizado gravado no motor único", (db.prepare(`SELECT COUNT(*) n FROM business_pattern_outcomes WHERE organization_id=? AND pattern_type LIKE 'mission:%'`).get(A) as any).n === 1);

  // ── 8. Debrief + self-healing do sinal (voltou pro azul ao concluir) ──
  const deb = DB.debrief(A, mission.id);
  check("8.1 debrief com lições (missão atingida)", deb.status === "achieved" && deb.lessons.some((l: string) => /funcionou/i.test(l)));

  // ── 9. Isolamento: nada vaza pra outra org ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', 1)`).run(randomUUID(), B);
  check("9.1 isolamento (B sem missões nem aprendizado de A)", M.list(B).length === 0 && (db.prepare(`SELECT COUNT(*) n FROM business_pattern_outcomes WHERE organization_id=?`).get(B) as any).n === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-golden-path: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
