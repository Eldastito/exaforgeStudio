/**
 * TEST — Mission Checkpoint + Replan (ADR-189 F6, Mission OS). DB-backed, determinístico.
 * Prova: classificação planned×actual×tempo (on_track/at_risk/off_track), sinal mission/at_risk
 * self-healing (publica fora da trajetória / resolve ao voltar), hypothesis+null, zero decision_action
 * no checkpoint (RESULTADO ≠ EXECUÇÃO — nunca achieved), missão qualitativa → not_applicable, replan
 * governado (proposeReplan → decision_action awaiting, nunca executa), isolamento.
 *
 * Uso: npm run test:mission-checkpoint
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mchk-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mchk-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionCheckpointService: CP } = await import("../src/server/MissionCheckpointService.js");
  const { MissionService: M } = await import("../src/server/MissionService.js");

  const mkOrg = () => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', 1)`).run(randomUUID(), o); return o; };
  const A = mkOrg();
  const sig = (org: string, mid: string) => db.prepare(`SELECT status, severity FROM business_signals WHERE organization_id=? AND dedupe_key=?`).get(org, `mission_checkpoint:${mid}`) as any;

  // Missão de receita: alvo R$1000, prazo daqui a ~1 ano (createdAt = agora).
  const nextYear = `${new Date().getUTCFullYear() + 1}-06-30`;
  const m = M.create(A, { title: "R$1000", targetMetric: "revenue", targetValue: 1000, targetUnit: "BRL", deadline: nextYear });
  const asOfLate = `${new Date().getUTCFullYear() + 1}-06-01`; // ~quase no fim do prazo → esperado alto

  // 1. Classificação (actual injetado p/ determinismo).
  const onT = CP.checkpoint(A, m.id, { asOf: asOfLate, actualValue: 1000 });
  check("1.1 atingiu o alvo → on_track", onT.status === "on_track");
  const atR = CP.checkpoint(A, m.id, { asOf: asOfLate, actualValue: 800 }); // 800 vs esperado ~1000
  check("1.2 800 de ~1000 esperado → at_risk", atR.status === "at_risk");
  const offT = CP.checkpoint(A, m.id, { asOf: asOfLate, actualValue: 300 }); // bem abaixo
  check("1.3 300 de ~1000 esperado → off_track", offT.status === "off_track");
  check("1.4 expectedByNow e attainment derivados", atR.expectedByNow != null && atR.attainmentPct === 80);

  // 2. Sinal self-healing: fora da trajetória publica; on_track resolve.
  db.prepare(`UPDATE missions SET mission_status='running' WHERE id=?`).run(m.id);
  const p1 = CP.publishCheckpointSignal(A, m.id, { asOf: asOfLate, actualValue: 300 });
  check("2.1 off_track → publica (severity risk)", p1.published === true && sig(A, m.id)?.severity === "risk");
  const row = db.prepare(`SELECT basis, impact_amount FROM business_signals WHERE organization_id=? AND dedupe_key=?`).get(A, `mission_checkpoint:${m.id}`) as any;
  check("2.2 hypothesis + impact null", row.basis === "hypothesis" && row.impact_amount == null);
  check("2.3 zero decision_action no checkpoint (RESULTADO ≠ EXECUÇÃO)", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n === 0);
  const p2 = CP.publishCheckpointSignal(A, m.id, { asOf: asOfLate, actualValue: 1000 });
  check("2.4 voltou pro azul → resolved", p2.published === false && sig(A, m.id)?.status === "resolved");

  // 3. Missão nunca vira achieved pelo checkpoint.
  check("3.1 missão continua 'running' (não achieved)", M.get(A, m.id)!.status === "running");

  // 4. Missão qualitativa → not_applicable.
  const mQ = M.create(A, { title: "reduzir tempo de resposta" });
  check("4.1 qualitativa → not_applicable", CP.checkpoint(A, mQ.id, {}).status === "not_applicable");

  // 5. Replan GOVERNADO: proposeReplan cria decision_action awaiting, nunca executa.
  M.setAutonomy(A, m.id, "suggest");
  const rep = CP.proposeReplan(A, m.id, {});
  check("5.1 replan → decision_action governada (nunca done)", rep.action.status !== "done" && (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=? AND action_type='mission_replan'`).get(A) as any).n === 1);

  // 6. Isolamento.
  let isolated = false; try { CP.checkpoint(mkOrg(), m.id, {}); } catch { isolated = true; }
  check("6.1 cross-org checkpoint → erro", isolated);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-checkpoint: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
