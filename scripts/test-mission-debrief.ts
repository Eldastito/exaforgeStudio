/**
 * TEST — Mission Debrief + Learning (ADR-189 F10, Mission OS). DB-backed, determinístico.
 * Prova: debrief read-model (objetivo/resultado/lições); aprendizado no MOTOR ÚNICO (PatternMemory)
 * só de missão TERMINAL (achieved→worked / failed→backfired), NUNCA em andamento/cancelled; idempotente
 * por mission:<id>; opt-in pattern_memory (off → não aprende); source 'assured'; isolamento.
 *
 * Uso: npm run test:mission-debrief
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mdeb-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mdeb-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionDebriefService: D } = await import("../src/server/MissionDebriefService.js");
  const { MissionService: M } = await import("../src/server/MissionService.js");

  const mkOrg = (pm = 1) => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, mission_layer_enabled, pattern_memory) VALUES (?, ?, 'O', 'active', 'varejo', 1, ?)`).run(randomUUID(), o, pm); return o; };
  const cnt = (org: string, pt: string) => (db.prepare(`SELECT COUNT(*) n FROM business_pattern_outcomes WHERE organization_id=? AND pattern_type=?`).get(org, pt) as any).n;

  const A = mkOrg(1);

  // 1. Debrief read-model de missão atingida.
  const m = M.create(A, { title: "Recuperar R$20k", targetMetric: "revenue", targetValue: 20000, source: "user" });
  M.setStatus(A, m.id, "achieved");
  const deb = D.debrief(A, m.id);
  check("1.1 debrief tem objetivo + status", deb.objective.title === "Recuperar R$20k" && deb.status === "achieved");
  check("1.2 lições geradas (atingida)", deb.lessons.some((l) => /funcionou/i.test(l)));

  // 2. Aprendizado forte de missão ACHIEVED → worked no motor único.
  const r = D.learn(A, m.id);
  check("2.1 aprendeu (worked) no PatternMemory", r.ok && r.learned && r.outcome === "worked");
  check("2.2 gravou no motor único (business_pattern_outcomes)", cnt(A, "mission:user:revenue") === 1);

  // 3. Idempotente por mission:<id>.
  const r2 = D.learn(A, m.id);
  check("3.1 idempotente (não conta 2×)", r2.idempotent === true && cnt(A, "mission:user:revenue") === 1);

  // 4. Missão FAILED → backfired.
  const mF = M.create(A, { title: "meta falha", targetMetric: "appointments", targetValue: 100, source: "system_proposed" });
  M.setStatus(A, mF.id, "failed");
  const rF = D.learn(A, mF.id);
  check("4.1 failed → backfired aprendido", rF.learned && rF.outcome === "backfired");

  // 5. Missão em andamento / cancelled → NÃO aprende.
  const mR = M.create(A, { title: "rodando" });
  M.setStatus(A, mR.id, "running");
  check("5.1 running → não aprende (não terminal)", D.learn(A, mR.id).reason === "nao_terminal");
  const mC = M.create(A, { title: "cancelada" });
  M.cancel(A, mC.id);
  check("5.2 cancelled → não aprende", D.learn(A, mC.id).reason === "nao_terminal");

  // 6. Opt-in: pattern_memory OFF → não aprende (mas debrief funciona).
  const B = mkOrg(0);
  const mB = M.create(B, { title: "x", targetMetric: "revenue", targetValue: 1000 });
  M.setStatus(B, mB.id, "achieved");
  check("6.1 pattern_memory off → não aprende", D.learn(B, mB.id).reason === "pattern_memory_off");
  check("6.2 debrief ainda funciona com a flag off", D.debrief(B, mB.id).status === "achieved");

  // 7. Isolamento: o padrão de A não aparece em B.
  check("7.1 isolado (B sem o outcome de A)", cnt(B, "mission:user:revenue") === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-debrief: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
