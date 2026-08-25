/**
 * TEST — Mission Layer enablement (ADR-189 F18). Habilitação do PILOTO: liga/desliga a flag
 * `mission_layer_enabled` de forma governada e REVERSÍVEL, e a rota é alcançável mesmo com a flag
 * OFF (senão o dono nunca ligaria — ovo-e-galinha). Desligar preserva histórico; idempotente; isolado.
 *
 * Uso: npm run test:mission-enablement
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-menbl-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-menbl-123456";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionService: M } = await import("../src/server/MissionService.js");

  // Org NASCE com o Mission Layer desligado (default 0).
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status, mission_layer_enabled) VALUES (?, ?, 'Loja', 'active', 'varejo', 'autonomo', '[]', 'active', 0)`).run(randomUUID(), A);

  // ── 1. Estado inicial: desligado, sem missões ──
  check("1.1 nasce desligado (isEnabled false)", M.isEnabled(A) === false);
  const s0 = M.settings(A);
  check("1.2 settings honesto (enabled false, proactive off, 0 missões)", s0.enabled === false && s0.proactiveMode === "off" && s0.missionCount === 0);

  // ── 2. Ligar (habilita o piloto) ──
  const on = M.setEnabled(A, true);
  check("2.1 setEnabled(true) → habilitado", on.enabled === true && M.isEnabled(A) === true);

  // ── 3. Com o layer ligado, o dono cria a 1ª missão do piloto ──
  const mission = M.create(A, { title: "Piloto: R$30 mil no mês", targetMetric: "revenue", targetValue: 30000, targetUnit: "BRL" });
  check("3.1 missão do piloto criada", !!mission && M.settings(A).missionCount === 1);

  // ── 4. Reversível: desligar NÃO apaga histórico (convenção nº 9) — só some das superfícies ──
  const off = M.setEnabled(A, false);
  check("4.1 setEnabled(false) → desabilitado", off.enabled === false && M.isEnabled(A) === false);
  check("4.2 desligar preserva a missão (histórico intacto)", M.settings(A).missionCount === 1 && !!M.get(A, mission.id));

  // ── 5. Idempotente ──
  M.setEnabled(A, true); M.setEnabled(A, true);
  check("5.1 idempotente (ligar 2x → ligado)", M.isEnabled(A) === true);

  // ── 6. Isolamento: ligar A não liga B ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', 0)`).run(randomUUID(), B);
  check("6.1 isolamento (B segue desligado)", M.isEnabled(B) === false && M.setEnabled(A, true) && M.isEnabled(B) === false);

  // ── 7. FIAÇÃO: a rota /enablement fica ANTES do gate requireMissionLayer (alcançável com flag OFF) ──
  const route = fs.readFileSync(path.join(ROOT, "src/server/routes/missions.ts"), "utf8");
  const idxEnable = route.indexOf('"/enablement"');
  const idxGate = route.indexOf("requireMissionLayer)");
  check("7.1 rota /enablement definida antes do gate (bootstrapping)", idxEnable > 0 && idxGate > 0 && idxEnable < idxGate);
  check("7.2 GET + PUT /enablement presentes", route.includes('router.get("/enablement"') && route.includes('router.put("/enablement"'));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-enablement: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
