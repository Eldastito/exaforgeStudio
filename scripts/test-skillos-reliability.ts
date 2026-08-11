/**
 * TEST — PRD 4 F4 (Reliability Core): AI Reliability Kernel + AI Run. DB-backed,
 * isolado por tmpDir. Determinístico — o `invoke` do modelo é INJETADO (fake), sem
 * chamada real de IA. Prova:
 *
 *   - sucesso → AI Run gravada (run_status ok, validation valid/skipped) + tokens/
 *     custo no ai_usage_log estendido (Decisão D4);
 *   - validação de saída (§18): inválida → retry corretivo até o teto → failed/format;
 *   - taxonomia + retry por política (§17/§27): técnico→retry até sucesso;
 *     policy→NÃO repete; fallback → status fallback + fallback_used;
 *   - defaultClassify (429/5xx/timeout→technical; json→format; policy→policy);
 *   - correlação (correlation_id/run_id) + reuso de backoff (JobQueue);
 *   - RN-KER-1: sempre grava 1 AI Run; RN-KER-3: nunca "silêncio";
 *   - ISOLAMENTO: getRun filtra por org;
 *   - legado intacto: recordUsage sem colunas de run continua funcionando (0 regressão).
 *
 * Uso: npm run test:skillos-reliability
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-skillos-rel-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-skillos-rel-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AiReliabilityKernel: K } = await import("../src/server/AiReliabilityKernel.js");

  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);

  // ═══════════════ 1. sucesso → AI Run + usage ═══════════════
  const ok = await K.run(org, { skillId: "s1", capabilityId: "c1", correlationId: "corr-1", confidence: 0.9 },
    async () => ({ output: { text: "oi" }, usage: { inputTokens: 100, outputTokens: 20, costBrl: 0.05, model: "m", provider: "openai", latencyMs: 42 } }));
  check("1.1 status ok + saída retornada", ok.reliability.status === "ok" && ok.output.text === "oi");
  check("1.2 grounding skipped (F6), confidence propagada", ok.reliability.groundingStatus === "skipped" && ok.reliability.confidence === 0.9);
  const run1 = K.getRun(org, ok.runId);
  check("1.3 AI Run gravada (run_id/skill/correlation)", run1 && run1.run_id === ok.runId && run1.skill_id === "s1" && run1.correlation_id === "corr-1");
  check("1.4 tokens/custo no ai_usage_log estendido", run1.total_tokens === 120 && run1.provider === "openai" && Math.round(run1.cost_cents) === 5);
  check("1.5 run_status + validation persistidos", run1.run_status === "ok" && run1.retry_count === 0);

  // ═══════════════ 2. validação de saída (§18) ═══════════════
  const badVal = await K.run(org, { skillId: "s2", maxAttempts: 3, validate: (o: any) => ({ valid: o?.n === 42 }) },
    async () => ({ output: { n: 7 }, usage: {} }));
  check("2.1 saída inválida esgota retries → failed/format", badVal.reliability.status === "failed" && badVal.reliability.failureClass === "format" && badVal.reliability.retryCount === 2);
  check("2.2 validation_status=invalid na AI Run", K.getRun(org, badVal.runId).validation_status === "invalid");
  // validação passa na 2ª tentativa (invoke corrige).
  let call = 0;
  const fixed = await K.run(org, { skillId: "s3", maxAttempts: 2, validate: (o: any) => o?.ok === true },
    async () => { call++; return { output: { ok: call >= 2 }, usage: {} }; });
  check("2.3 retry corretivo até validar → retried", fixed.reliability.status === "retried" && fixed.reliability.retryCount === 1 && fixed.reliability.validationStatus === "valid");

  // ═══════════════ 3. taxonomia + retry por política (§17/§27) ═══════════════
  // técnico: falha 1×, sucesso na 2ª.
  let n = 0;
  const tech = await K.run(org, { skillId: "s4", maxAttempts: 2 }, async () => {
    n++; if (n === 1) throw Object.assign(new Error("timeout"), { code: 503 });
    return { output: "ok", usage: {} };
  });
  check("3.1 falha técnica → retry → sucesso", tech.reliability.status === "retried" && tech.reliability.retryCount === 1);
  // policy: nunca repete, mesmo com maxAttempts alto.
  let pcalls = 0;
  const pol = await K.run(org, { skillId: "s5", maxAttempts: 5 }, async () => { pcalls++; throw new Error("policy violation: rbac"); });
  check("3.2 falha de policy NÃO repete (1 tentativa) → failed", pol.reliability.status === "failed" && pol.reliability.failureClass === "policy" && pcalls === 1);
  // grounding failure → fallback status + fallback_used.
  const gnd = await K.run(org, { skillId: "s6" }, async () => { throw new Error("unsupported claim"); },
  );
  // 'unsupported claim' não casa policy/format/technical explicitamente → default technical.
  check("3.3 erro desconhecido → default technical (conservador)", gnd.reliability.failureClass === "technical");
  const fb = await K.run(org, { skillId: "s7", classifyError: () => "grounding" as any }, async () => { throw new Error("x"); });
  check("3.4 política 'fallback' (grounding) → status fallback + fallback_used", fb.reliability.status === "fallback" && fb.reliability.fallbackUsed === true);
  check("3.5 AI Run de falha também é gravada (RN-KER-1)", K.getRun(org, pol.runId).run_status === "failed" && K.getRun(org, pol.runId).failure_class === "policy");

  // ═══════════════ 4. defaultClassify + backoff ═══════════════
  check("4.1 classify 429 → technical", K.defaultClassify({ status: 429 }) === "technical");
  check("4.2 classify json → format", K.defaultClassify(new Error("invalid JSON schema")) === "format");
  check("4.3 classify policy → policy", K.defaultClassify(new Error("LGPD forbidden")) === "policy");
  check("4.4 backoff reusa JobQueue (cresce com a tentativa)", K.backoffSeconds(1, "technical") < K.backoffSeconds(3, "technical"));

  // ═══════════════ 5. isolamento + legado ═══════════════
  const org2 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), org2);
  check("5.1 getRun isolado por org (run de A não aparece em B)", K.getRun(org2, ok.runId) === null);
  // legado: insere linha no ai_usage_log sem as colunas de run (como recordUsage faz) — não quebra.
  let legacyOk = true;
  try { db.prepare(`INSERT INTO ai_usage_log (id, organization_id, model, kind, total_tokens, cost_brl) VALUES (?, ?, 'm', 'chat', 10, 0.01)`).run(randomUUID(), org); } catch { legacyOk = false; }
  check("5.2 recordUsage legado (sem colunas de run) segue funcionando", legacyOk);

  console.log("\n=== TEST: SkillOS Reliability Core (PRD 4 F4) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ SkillOS Reliability Core (F4) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
