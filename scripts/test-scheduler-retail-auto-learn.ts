/**
 * TESTE — Aprendizado de padrões de varejo SEMANAL e automático (Scheduler).
 * ------------------------------------------------------------------------------
 * Prova, offline, o gate + dedupe do Scheduler.retailPatternLearnPass:
 *   - só roda para orgs com o aprendizado ligado (retail_pattern_memory=1);
 *   - marca retail_pattern_last_learn ao rodar (dedupe de 7 dias);
 *   - org com last_learn recente NÃO roda de novo (não regride o carimbo);
 *   - org sem o aprendizado nunca é tocada.
 *
 * (Sem dados de varejo → 0 candidatos → não chama a IA; testa o agendamento,
 * não o conteúdo do aprendizado, que tem teste próprio.)
 *
 * Uso:  npm run test:scheduler-retail-auto-learn
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sched-learn-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-sched-learn-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { Scheduler } = await import("../src/server/Scheduler.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`; // aprendizado LIGADO
  const B = `org_B_${randomUUID().slice(0, 6)}`; // aprendizado DESLIGADO
  const C = `org_C_${randomUUID().slice(0, 6)}`; // ligado, mas com last_learn recente
  for (const org of [A, B, C]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  db.prepare(`UPDATE organization_settings SET retail_pattern_memory = 1 WHERE organization_id IN (?, ?)`).run(A, C);
  // C já aprendeu no futuro (definitivamente dentro dos 7 dias) → deve ser pulado.
  db.prepare(`UPDATE organization_settings SET retail_pattern_last_learn = '2099-01-01 00:00:00' WHERE organization_id = ?`).run(C);

  const lastLearn = (org: string) => (db.prepare(`SELECT retail_pattern_last_learn AS t FROM organization_settings WHERE organization_id = ?`).get(org) as any)?.t || null;

  await Scheduler.retailPatternLearnPass();

  check("A (ligado, nunca aprendeu) → carimbo gravado", lastLearn(A) != null, `t=${lastLearn(A)}`);
  check("B (desligado) → nunca tocado (carimbo null)", lastLearn(B) == null, `t=${lastLearn(B)}`);
  check("C (recente) → dedupe: carimbo inalterado (2099)", String(lastLearn(C)).startsWith("2099"), `t=${lastLearn(C)}`);

  // Segunda passada imediata: A agora tem carimbo recente → não roda de novo.
  const aBefore = lastLearn(A);
  await Scheduler.retailPatternLearnPass();
  check("A não re-roda na 2ª passada (dedupe de 7 dias)", lastLearn(A) === aBefore, `antes=${aBefore} depois=${lastLearn(A)}`);

  console.log("\n=== Aprendizado semanal automático de padrões (Scheduler) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
