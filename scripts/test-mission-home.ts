/**
 * TEST — Mission "Hoje" block (ADR-189 F7, Mission OS). DB-backed, determinístico.
 * Prova: bloco null quando a flag off (0-regressão); quando on, compõe por EXCEÇÃO (em andamento /
 * precisa de você / em risco por sinal / concluídas na semana); items traz só exceção (aguardando +
 * em risco), até 3; line humana; isolamento.
 *
 * Uso: npm run test:mission-home
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mhome-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mhome-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuHomeService: H } = await import("../src/server/FalaTuHomeService.js");
  const { MissionService: M } = await import("../src/server/MissionService.js");
  const { MissionCheckpointService: CP } = await import("../src/server/MissionCheckpointService.js");

  const mkOrg = (flag = 1) => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', ?)`).run(randomUUID(), o, flag); return o; };

  // 1. Flag off → bloco null (0-regressão).
  const off = mkOrg(0);
  check("1.1 flag off → missionsBlock null", H.missionsBlock(off) === null);

  const A = mkOrg(1);
  // Sem missões → bloco vazio honesto.
  const empty = H.missionsBlock(A)!;
  check("2.1 sem missões → tudo zero + 'Nenhuma missão ativa.'", empty.inFlight === 0 && empty.needsYou === 0 && empty.line === "Nenhuma missão ativa." && empty.items.length === 0);

  // 3. Missão aguardando você (waiting_approval).
  const mW = M.create(A, { title: "Recuperar inadimplência" });
  M.setStatus(A, mW.id, "waiting_approval");
  const b3 = H.missionsBlock(A)!;
  check("3.1 waiting_approval conta em needsYou + inFlight", b3.needsYou === 1 && b3.inFlight === 1);
  check("3.2 line 'aguardando você'", /aguardando você/.test(b3.line));
  check("3.3 item de exceção presente", b3.items.some((i) => i.id === mW.id));

  // 4. Missão em risco (via sinal de checkpoint) entra em atRisk + items.
  const nextYear = `${new Date().getUTCFullYear() + 1}-06-30`;
  const mR = M.create(A, { title: "R$1000", targetMetric: "revenue", targetValue: 1000, targetUnit: "BRL", deadline: nextYear });
  M.setStatus(A, mR.id, "running");
  CP.publishCheckpointSignal(A, mR.id, { asOf: `${new Date().getUTCFullYear() + 1}-06-01`, actualValue: 100 }); // off_track → sinal
  const b4 = H.missionsBlock(A)!;
  check("4.1 atRisk derivado do sinal aberto (>=1)", b4.atRisk >= 1);
  check("4.2 missão em risco aparece em items", b4.items.some((i) => i.id === mR.id && i.status === "at_risk"));

  // 5. Concluída na semana entra em achievedRecently.
  const mA = M.create(A, { title: "meta batida" });
  M.setStatus(A, mA.id, "achieved");
  const b5 = H.missionsBlock(A)!;
  check("5.1 achievedRecently >= 1", b5.achievedRecently >= 1);

  // 6. items no máximo 3 (não é dashboard).
  for (let i = 0; i < 5; i++) { const m = M.create(A, { title: `w${i}` }); M.setStatus(A, m.id, "waiting_approval"); }
  check("6.1 items <= 3 (por exceção, não dashboard)", H.missionsBlock(A)!.items.length <= 3);

  // 7. Isolamento.
  const B = mkOrg(1);
  check("7.1 bloco de B vazio (isolado de A)", H.missionsBlock(B)!.inFlight === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-home: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
