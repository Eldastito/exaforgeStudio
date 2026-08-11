/**
 * TEST — PRD 4 F9 (Observability + Admin Master): observabilidade OPERACIONAL das
 * AI Runs pro tenant na Central de Saúde + invariante §30/D5 (custo só Admin Master).
 * DB-backed, isolado por tmpDir. Determinístico. Prova:
 *
 *   - aiRuns() agrega por query (status/validação/grounding/failure/fallback/confiança/
 *     top skills/provider health) SÓ das AI Runs (run_id != null) — ignora legado;
 *   - §30/D5: assertTenantSafe passa no payload de tenant e LANÇA em qualquer objeto
 *     com custo (inclusive o payload do AiUsageDashboardService, que é admin-only);
 *   - o payload de tenant NÃO contém nenhuma chave de custo (R$/US$/cents/token);
 *   - indicators() ganhou os contadores de IA (aditivo, sem quebrar os antigos);
 *   - saúde de provider REUSA o SkillOsProviderHealthService (F5);
 *   - ISOLAMENTO por org.
 *
 * Uso: npm run test:skillos-observability
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-skillos-obs-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-skillos-obs-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SkillOsObservabilityService: OBS } = await import("../src/server/SkillOsObservabilityService.js");
  const { AiUsageDashboardService: DASH } = await import("../src/server/AiUsageDashboardService.js");
  const { RuntimeExceptionsService: RX } = await import("../src/server/RuntimeExceptionsService.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [orgA, orgB]) {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  }

  // Insere uma AI Run rica (run_id != null) OU uma linha legada (run_id null).
  const run = (orgId: string, r: {
    provider?: string | null; skill?: string | null; status?: string | null;
    validation?: string | null; grounding?: string | null; fallback?: number;
    conf?: number | null; failureClass?: string | null; retry?: number; legacy?: boolean;
    costCents?: number;
  }) => {
    db.prepare(`
      INSERT INTO ai_usage_log
        (id, organization_id, model, kind, total_tokens, cost_cents, cost_brl,
         run_id, skill_id, provider, validation_status, grounding_status, confidence,
         failure_class, retry_count, fallback_used, run_status)
      VALUES (?, ?, 'm', 'k', 100, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), orgId, r.costCents ?? 0, (r.costCents ?? 0) / 100,
      r.legacy ? null : randomUUID(), r.skill ?? null, r.provider ?? null,
      r.validation ?? null, r.grounding ?? null, r.conf ?? null,
      r.failureClass ?? null, r.retry ?? 0, r.fallback ?? 0, r.legacy ? null : (r.status ?? null),
    );
  };

  // ─ org A: 9 AI Runs + 1 legado (com custo, deve ser ignorado) ─
  for (let i = 0; i < 3; i++) run(orgA, { provider: "anthropic", skill: "sk-alpha", status: "ok", validation: "valid", grounding: "grounded", conf: 0.9 });
  run(orgA, { provider: "anthropic", skill: "sk-alpha", status: "retried", validation: "valid", grounding: "grounded", conf: 0.8, retry: 1 });
  run(orgA, { provider: "anthropic", skill: "sk-alpha", status: "fallback", validation: "valid", grounding: "unsupported", conf: 0.3, fallback: 1, failureClass: "grounding" });
  run(orgA, { provider: "anthropic", skill: "sk-alpha", status: "failed", validation: "invalid", grounding: "skipped", conf: null, failureClass: "technical" });
  run(orgA, { provider: "anthropic", skill: "sk-alpha", status: "blocked", validation: "skipped", grounding: "skipped", conf: null, failureClass: "policy" });
  run(orgA, { provider: "openai", skill: "sk-beta", status: "ok", validation: "valid", grounding: "skipped", conf: 0.7 });
  run(orgA, { provider: "openai", skill: "sk-beta", status: "ok", validation: "valid", grounding: "skipped", conf: 0.7 });
  run(orgA, { legacy: true, costCents: 5000, provider: "anthropic", skill: "sk-alpha" }); // legado — NÃO conta

  // ─ org B: 2 AI Runs (isolamento) ─
  run(orgB, { provider: "openai", skill: "sk-gamma", status: "ok", validation: "valid", grounding: "grounded", conf: 0.5 });
  run(orgB, { provider: "openai", skill: "sk-gamma", status: "failed", validation: "invalid", grounding: "skipped", conf: null, failureClass: "technical" });

  // ═══════════════ 1. agregação (RN-OBS-1/3) ═══════════════
  const a = OBS.aiRuns(orgA);
  check("1.1 totalRuns só AI Runs (ignora legado)", a.totalRuns === 9);
  check("1.2 byStatus", a.byStatus.ok === 5 && a.byStatus.retried === 1 && a.byStatus.fallback === 1 && a.byStatus.failed === 1 && a.byStatus.blocked === 1);
  check("1.3 byValidation", a.byValidation.valid === 7 && a.byValidation.invalid === 1 && a.byValidation.skipped === 1);
  check("1.4 byGrounding", a.byGrounding.grounded === 4 && a.byGrounding.unsupported === 1 && a.byGrounding.skipped === 4);
  check("1.5 byFailureClass", a.byFailureClass.grounding === 1 && a.byFailureClass.technical === 1 && a.byFailureClass.policy === 1 && a.byFailureClass.format === 0);
  check("1.6 fallback count/rate", a.fallbackCount === 1 && approx(a.fallbackRate, 1 / 9));
  check("1.7 retried/blocked/failed counts", a.retriedCount === 1 && a.blockedCount === 1 && a.failedCount === 1);
  check("1.8 successRate = (ok+retried)/total", approx(a.successRate, 6 / 9));
  check("1.9 avgConfidence (só runs com confidence)", a.avgConfidence !== null && approx(a.avgConfidence!, (0.9 * 3 + 0.8 + 0.3 + 0.7 * 2) / 7));

  // ═══════════════ 2. top skills + provider health (RN-OBS-4) ═══════════════
  check("2.1 topSkills ordenado por runs desc", a.topSkills.length === 2 && a.topSkills[0].skillId === "sk-alpha" && a.topSkills[0].runs === 7 && a.topSkills[0].failures === 1 && a.topSkills[0].fallbacks === 1);
  const anth = a.providers.find((p) => p.provider === "anthropic");
  const oai = a.providers.find((p) => p.provider === "openai");
  check("2.2 provider anthropic: ok=4 failed=2 (fallback conta como falha do breaker)", !!anth && anth!.ok === 4 && anth!.failed === 2 && approx(anth!.failureRate, 2 / 6));
  check("2.3 provider openai: ok=2 failed=0", !!oai && oai!.ok === 2 && oai!.failed === 0);
  check("2.4 provider state é enum válido de saúde", a.providers.every((p) => ["healthy", "watch", "degraded", "open", "half_open"].includes(p.state)));

  // ═══════════════ 3. §30 / D5 — invariante de custo ═══════════════
  // 3a: o payload de tenant passa no guarda (auto-guardado + reconfirmado).
  let tenantSafe = true;
  try { OBS.assertTenantSafe(a); } catch { tenantSafe = false; }
  check("3.1 payload de tenant passa no assertTenantSafe (sem custo)", tenantSafe);
  // 3b: serializa e varre — ZERO chave de custo (R$/US$/cents/token/price/...).
  const json = JSON.stringify(a).toLowerCase();
  check("3.2 payload não contém chaves de custo", !/(cost|brl|usd|cents|price|spend|"[^"]*token[^"]*":|reais|monetary)/.test(json));
  // 3c: o guarda LANÇA em objetos com custo (várias formas).
  const throws = (fn: () => any) => { try { fn(); return false; } catch { return true; } };
  check("3.3 guarda lança em { costCents }", throws(() => OBS.assertTenantSafe({ costCents: 10 })));
  check("3.4 guarda lança em custo aninhado { a: { totalCostBrl } }", throws(() => OBS.assertTenantSafe({ a: { totalCostBrl: 1 } })));
  check("3.5 guarda lança em token (proxy de custo)", throws(() => OBS.assertTenantSafe({ totalTokens: 100 })));
  check("3.6 guarda lança dentro de array", throws(() => OBS.assertTenantSafe({ items: [{ ok: 1 }, { priceUsd: 2 }] })));
  // 3d: o payload do dashboard ADMIN carrega custo → o guarda o barraria numa rota de tenant.
  const admin = DASH.byOrg(orgA);
  check("3.7 AiUsageDashboardService.byOrg carrega custo (é admin-only)", admin.totalCostCents !== undefined && admin.totalCostBrl !== undefined);
  check("3.8 assertTenantSafe LANÇA no payload admin (prova a fronteira §30)", throws(() => OBS.assertTenantSafe(admin)));

  // ═══════════════ 4. indicators() estendido (aditivo) ═══════════════
  const ind = RX.indicators(orgA);
  check("4.1 indicators.aiRunsTotal = 9", ind.aiRunsTotal === 9);
  check("4.2 indicators.aiRunsFailed = 1", ind.aiRunsFailed === 1);
  check("4.3 indicators.aiRunsFallback = 1", ind.aiRunsFallback === 1);
  check("4.4 indicators.aiRunsUnsupportedGrounding = 1", ind.aiRunsUnsupportedGrounding === 1);
  check("4.5 indicators antigos preservados (0 regressão)", ind.processesTotal !== undefined && ind.jobsFailed !== undefined);

  // ═══════════════ 5. isolamento (RN-OBS-5) ═══════════════
  const b = OBS.aiRuns(orgB);
  check("5.1 org B independente", b.totalRuns === 2 && b.byStatus.ok === 1 && b.byStatus.failed === 1);
  check("5.2 org A inalterada por org B", OBS.aiRuns(orgA).totalRuns === 9);
  check("5.3 indicators de org B isolado", RX.indicators(orgB).aiRunsTotal === 2);

  // ═══════════════ 6. janela + org vazia ═══════════════
  const empty = OBS.aiRuns(`org_${randomUUID().slice(0, 8)}`);
  check("6.1 org sem runs → zeros, sem throw", empty.totalRuns === 0 && empty.avgConfidence === null && empty.successRate === 0 && empty.providers.length === 0);
  check("6.2 clampDays limita 1..180", OBS.clampDays(0) === 1 && OBS.clampDays(9999) === 180 && OBS.clampDays(undefined) === 30);

  console.log("\n=== TEST: SkillOS Observability (PRD 4 F9) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ SkillOS Observability (F9) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
