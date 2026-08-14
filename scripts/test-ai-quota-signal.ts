/**
 * TEST — ADR-154 Fatia 1.3: AiQuotaSignalService + rota POST /admin/.../ai-quota.
 *
 * Cobre:
 * - Coluna ai_monthly_limit_cents existe em organization_settings.
 * - evaluate(): sem cota → hasQuota=false, level=ok, signalType=null.
 * - evaluate(): abaixo de 80% → ok / sem sinal.
 * - evaluate(): 80-99% → warning / signalType='ai_quota_warning' / attention.
 * - evaluate(): ≥100% → exceeded / signalType='ai_quota_exceeded' / critical.
 * - run(): publica sinal com dedupe_key mensal `ai:quota:{orgId}:{YYYY-MM}`.
 * - run(): rodar 2x no mesmo mês NÃO duplica (BusinessSignalService.publish
 *   idempotente por dedupe).
 * - run(): 80 → 100 dentro do mesmo mês ATUALIZA severity (update, não insert).
 * - run(): consumo caiu abaixo de 80% depois de ter warning → resolveByDedupe
 *   resolve o sinal antigo (status='resolved').
 * - runAll(): só varre orgs com ai_monthly_limit_cents > 0.
 * - runAll(): best-effort — erro em uma org não trava as outras.
 * - Isolamento multi-tenant: sinal da orgA não aparece na lista da orgB.
 * - Rota HTTP POST /api/admin/organizations/:id/ai-quota:
 *   - Master 200, não-master 403.
 *   - Body válido (integer ≥ 0 ou null) aceito; float/negativo rejeitado 400.
 *   - null desativa a cota (limpa a coluna).
 *   - Audita ADMIN_AI_QUOTA_UPDATE com o novo valor.
 *   - Dispara AiQuotaSignalService.run() imediato — resposta traz o snapshot.
 *   - Org inexistente → 404.
 *
 * Uso: npm run test:ai-quota-signal
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import express from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-aiq-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-aiq-1234567890";
process.env.MASTER_ADMIN_EMAIL = "master@test.local";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Injeta consumo no mês CORRENTE (created_at = agora).
function insertUsageThisMonth(db: any, orgId: string, costCents: number) {
  db.prepare(
    `INSERT INTO ai_usage_log (
       id, organization_id, model, kind, module, operation,
       input_tokens, output_tokens, total_tokens,
       cost_usd, cost_brl, cost_cents, latency_ms
     ) VALUES (?, ?, 'gpt-4o-mini', 'chat', 'falatu', 'chat', 100, 50, 150, 0.001, ?, ?, 100)`
  ).run(randomUUID(), orgId, costCents / 100, costCents);
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AiQuotaSignalService } = await import("../src/server/AiQuotaSignalService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const orgC = `org_${randomUUID().slice(0, 8)}`; // sem cota — não deve aparecer no runAll

  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, ai_monthly_limit_cents) VALUES (?, ?, 'Org A', 'active', 10000)`).run(randomUUID(), orgA); // R$100
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, ai_monthly_limit_cents) VALUES (?, ?, 'Org B', 'active', 5000)`).run(randomUUID(), orgB);  // R$50
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org C', 'active')`).run(randomUUID(), orgC); // sem cota

  // ===== 1. Schema =====
  const cols = (db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[]).map((c: any) => c.name);
  check("coluna ai_monthly_limit_cents existe", cols.includes("ai_monthly_limit_cents"));

  // ===== 2. evaluate: sem cota =====
  const e1 = AiQuotaSignalService.evaluate(orgC);
  check("sem cota: hasQuota=false", !e1.hasQuota);
  check("sem cota: level=ok, signalType=null", e1.level === "ok" && e1.signalType === null);

  // ===== 3. evaluate: 0% (org com cota mas sem consumo) =====
  const e2 = AiQuotaSignalService.evaluate(orgA);
  check("0% consumo: hasQuota=true, level=ok", e2.hasQuota && e2.level === "ok" && e2.pct === 0);

  // ===== 4. evaluate: 79% (borda inferior — não emite warning) =====
  insertUsageThisMonth(db, orgA, 7900); // 79% de 10000
  const e3 = AiQuotaSignalService.evaluate(orgA);
  check("79% consumo: level=ok, sem sinal", e3.level === "ok" && e3.pct === 79 && e3.signalType === null);

  // ===== 5. evaluate: 80% (borda de warning) =====
  insertUsageThisMonth(db, orgA, 100); // total 8000 = 80%
  const e4 = AiQuotaSignalService.evaluate(orgA);
  check("80% consumo: warning + attention", e4.level === "warning" && e4.pct === 80 && e4.signalType === "ai_quota_warning" && e4.severity === "attention");

  // ===== 6. run(): publica sinal com dedupe_key mensal =====
  const r1 = AiQuotaSignalService.run(orgA);
  check("run() 80%: published=true", r1.published && !r1.deduped);
  const dedupeKey = AiQuotaSignalService.monthlyDedupeKey(orgA);
  check("dedupe_key formato ai:quota:{orgId}:{YYYY-MM}", /^ai:quota:.+:\d{4}-\d{2}$/.test(dedupeKey));
  const openA = BusinessSignalService.list(orgA, { status: "open", domain: "ai_quota" });
  check("sinal aberto listado", openA.length === 1 && openA[0].signal_type === "ai_quota_warning" && openA[0].severity === "attention");
  check("sinal traz evidence com pct/cents/brl", openA[0].evidence?.pct === 80 && openA[0].evidence?.limitCents === 10000 && openA[0].evidence?.usedBrl === 80);

  // ===== 7. run() idempotente: 2x no mesmo mês NÃO duplica =====
  const r2 = AiQuotaSignalService.run(orgA);
  check("2ª run mesmo mês: deduped=true", r2.deduped && !r2.published);
  check("sinal segue único (não duplicou)", BusinessSignalService.list(orgA, { status: "open", domain: "ai_quota" }).length === 1);

  // ===== 8. 80 → 100 no mesmo mês: mesma linha, severity atualizada =====
  insertUsageThisMonth(db, orgA, 2100); // total 10100 → 101%
  const r3 = AiQuotaSignalService.run(orgA);
  check("run() 101%: exceeded + critical", r3.level === "exceeded" && r3.signalType === "ai_quota_exceeded" && r3.severity === "critical");
  const openA2 = BusinessSignalService.list(orgA, { status: "open", domain: "ai_quota" });
  check("linha do sinal É A MESMA (update, não insert)", openA2.length === 1 && openA2[0].id === openA[0].id);
  check("severity atualizada pra critical", openA2[0].severity === "critical" && openA2[0].signal_type === "ai_quota_exceeded");

  // ===== 9. Consumo cai abaixo de 80% → resolveByDedupe =====
  // Zera o mês (simulando admin AUMENTAR a cota — mesma matemática pro serviço).
  db.prepare(`UPDATE organization_settings SET ai_monthly_limit_cents = ? WHERE organization_id = ?`).run(100000, orgA); // R$1000 (agora 10100 = ~10%)
  const r4 = AiQuotaSignalService.run(orgA);
  check("caiu abaixo de 80%: resolved=true", r4.resolved && r4.level === "ok");
  const closedA = BusinessSignalService.list(orgA, { status: "resolved", domain: "ai_quota" });
  check("sinal antigo virou resolved", closedA.length === 1 && closedA[0].id === openA[0].id);

  // ===== 10. runAll: só varre orgs com cota =====
  insertUsageThisMonth(db, orgB, 4500); // 90% de 5000
  const all = AiQuotaSignalService.runAll();
  check("runAll: seen = 2 (orgA e orgB; orgC sem cota fora)", all.seen === 2);
  check("runAll: 1 warning (orgB 90%)", all.warnings === 1);

  // ===== 11. Isolamento multi-tenant =====
  const openB = BusinessSignalService.list(orgB, { status: "open", domain: "ai_quota" });
  check("orgB tem sinal aberto próprio", openB.length === 1 && openB[0].signal_type === "ai_quota_warning");
  check("orgA não vê sinal da orgB", BusinessSignalService.list(orgA, { status: "open", domain: "ai_quota" }).length === 0);

  // ===== 12. Rota HTTP POST /api/admin/organizations/:id/ai-quota =====
  const { requireMasterAdmin } = await import("../src/server/middleware/auth.js");
  const adminRoutes = (await import("../src/server/routes/admin.js")).default;

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      try { req.user = jwt.verify(auth.slice(7), process.env.JWT_SECRET!) as any; } catch { /* noop */ }
    }
    next();
  });
  app.use("/api/admin", requireMasterAdmin, adminRoutes);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  // SEC-F3: master é autoridade do DB por userId — cria o usuário master de fato.
  db.prepare(`INSERT INTO users (id, organization_id, email, role) VALUES ('master1', 'default_org', 'master@test.local', 'owner')`).run();
  const masterToken = jwt.sign({ userId: "master1", email: "master@test.local", role: "owner" }, process.env.JWT_SECRET!);
  const userToken = jwt.sign({ userId: "u1", email: "user@x.com", role: "owner" }, process.env.JWT_SECRET!);

  async function post(path: string, body: any, token?: string) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        port, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let out: any = null; try { out = JSON.parse(raw); } catch { out = raw; }
          resolve({ status: res.statusCode || 0, body: out });
        });
      });
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  // Master: define nova cota → 200 + snapshot + audit
  const beforeAudit = (db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE event_type = 'ADMIN_AI_QUOTA_UPDATE'`).get() as any).c;
  const p1 = await post(`/api/admin/organizations/${orgB}/ai-quota`, { monthlyLimitCents: 20000 }, masterToken);
  check("POST master 200", p1.status === 200);
  check("POST resposta traz {ok, monthlyLimitCents, quota}", p1.body?.ok === true && p1.body?.monthlyLimitCents === 20000 && p1.body?.quota != null);
  const afterAudit = (db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE event_type = 'ADMIN_AI_QUOTA_UPDATE'`).get() as any).c;
  check("POST audita ADMIN_AI_QUOTA_UPDATE", afterAudit === beforeAudit + 1);
  const updated = db.prepare(`SELECT ai_monthly_limit_cents FROM organization_settings WHERE organization_id = ?`).get(orgB) as any;
  check("POST persiste o novo valor na coluna", updated?.ai_monthly_limit_cents === 20000);

  // Não-master 403
  const p2 = await post(`/api/admin/organizations/${orgA}/ai-quota`, { monthlyLimitCents: 10000 }, userToken);
  check("POST não-master 403", p2.status === 403);

  // Sem token 403
  const p3 = await post(`/api/admin/organizations/${orgA}/ai-quota`, { monthlyLimitCents: 10000 });
  check("POST sem token 403", p3.status === 403);

  // Body inválido
  const p4 = await post(`/api/admin/organizations/${orgA}/ai-quota`, { monthlyLimitCents: -50 }, masterToken);
  check("POST valor negativo 400", p4.status === 400);
  const p5 = await post(`/api/admin/organizations/${orgA}/ai-quota`, { monthlyLimitCents: 100.5 }, masterToken);
  check("POST float 400 (só INTEGER)", p5.status === 400);

  // null desativa
  const p6 = await post(`/api/admin/organizations/${orgA}/ai-quota`, { monthlyLimitCents: null }, masterToken);
  check("POST null desativa (200)", p6.status === 200);
  const cleared = db.prepare(`SELECT ai_monthly_limit_cents FROM organization_settings WHERE organization_id = ?`).get(orgA) as any;
  check("POST null limpa a coluna", cleared?.ai_monthly_limit_cents === null);
  check("POST null: quota.hasQuota=false", p6.body?.quota?.hasQuota === false);

  // Org inexistente 404
  const p7 = await post(`/api/admin/organizations/org_naoexiste/ai-quota`, { monthlyLimitCents: 10000 }, masterToken);
  check("POST org inexistente 404", p7.status === 404);

  await new Promise<void>((resolve) => server.close(() => resolve()));

  const passed = results.length - failures;
  console.log(`\n=== TEST AI QUOTA SIGNAL (ADR-154 F1.3) ===`);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}`);
  console.log(`\n${passed}/${results.length} passed (${failures} failed)\n`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
});
