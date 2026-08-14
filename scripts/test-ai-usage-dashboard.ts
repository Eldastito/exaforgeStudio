/**
 * TEST — ADR-154 Fatia 1.2: AiUsageDashboardService + rotas /api/admin/ai-usage.
 *
 * Cobre:
 * - listOrgs: 1 linha por org, ordenada por custo desc, com topModule correto.
 * - listOrgs: orgs SEM consumo na janela aparecem (LEFT JOIN) — não caem.
 * - byOrg: série alinhada aos últimos N dias (dias sem consumo entram como 0).
 * - byOrg: breakdown por módulo/modelo/usuário agrega certo.
 * - Isolamento multi-tenant: byOrg(orgA) não devolve linhas de orgB.
 * - clampDays: 7..180 (piso, teto, default 30, NaN → 30).
 * - Retrocompat: custo em centavos derivado de cost_brl da F1.1 sem drift.
 * - Rota HTTP: 200 no master, 403 sem, payload shape correto.
 *
 * Popula o ledger diretamente (sem chamar OpenAI). Usa horários variados pra
 * exercitar o ALINHAMENTO da série diária.
 *
 * Uso: npm run test:ai-usage-dashboard
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import express from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-aiud-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-aiud-1234567890";
process.env.MASTER_ADMIN_EMAIL = "master@test.local";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Insere UMA linha diretamente no ledger com created_at controlado.
function insertUsage(
  db: any,
  orgId: string,
  opts: { module?: string; userId?: string | null; model?: string; kind?: string;
          inputTokens?: number; outputTokens?: number; costCents?: number; costBrl?: number;
          daysAgo?: number },
) {
  const id = randomUUID();
  const total = (opts.inputTokens || 0) + (opts.outputTokens || 0);
  const created = opts.daysAgo != null
    ? `datetime('now', '-${opts.daysAgo} days')`
    : `CURRENT_TIMESTAMP`;
  db.prepare(
    `INSERT INTO ai_usage_log (
       id, organization_id, user_id, model, kind, module, operation,
       input_tokens, output_tokens, total_tokens,
       cost_usd, cost_brl, cost_cents, latency_ms, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${created})`
  ).run(
    id, orgId, opts.userId ?? null, opts.model || "gpt-4o-mini", opts.kind || "chat",
    opts.module || "legacy", opts.kind || "chat",
    opts.inputTokens || 0, opts.outputTokens || 0, total,
    (opts.costBrl || 0) / 5.4, opts.costBrl || 0, opts.costCents ?? Math.round((opts.costBrl || 0) * 100),
    100,
  );
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AiUsageDashboardService } = await import("../src/server/AiUsageDashboardService.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const orgC = `org_${randomUUID().slice(0, 8)}`; // sem consumo — deve aparecer com zeros
  const userA1 = randomUUID();
  const userA2 = randomUUID();
  const userB = randomUUID();

  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'Org A', 'active', 'growth')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'Org B', 'active', 'starter')`).run(randomUUID(), orgB);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'Org C — sem uso', 'active', 'starter')`).run(randomUUID(), orgC);

  // ===== 1. clampDays =====
  check("clampDays default (undefined) = 30", AiUsageDashboardService.clampDays(undefined) === 30);
  check("clampDays NaN = 30", AiUsageDashboardService.clampDays(NaN) === 30);
  check("clampDays 3 → 7 (piso)", AiUsageDashboardService.clampDays(3) === 7);
  check("clampDays 500 → 180 (teto)", AiUsageDashboardService.clampDays(500) === 180);
  check("clampDays 45 preservado", AiUsageDashboardService.clampDays(45) === 45);

  // ===== 2. Popular ledger =====
  // orgA: dominância clara em FalaTu (usuário 1); alguma clínica (usuário 2)
  insertUsage(db, orgA, { module: "falatu", userId: userA1, model: "gpt-4o-mini", inputTokens: 5000, outputTokens: 1000, costBrl: 15.50, daysAgo: 0 });
  insertUsage(db, orgA, { module: "falatu", userId: userA1, model: "gpt-4o-mini", inputTokens: 3000, outputTokens: 500, costBrl: 8.20, daysAgo: 2 });
  insertUsage(db, orgA, { module: "falatu", userId: userA1, model: "gpt-4o-mini", inputTokens: 2000, outputTokens: 400, costBrl: 6.10, daysAgo: 10 });
  insertUsage(db, orgA, { module: "clinica", userId: userA2, model: "gpt-4o", inputTokens: 1200, outputTokens: 300, costBrl: 4.50, daysAgo: 1 });
  // Uma linha ANTIGA (60 dias) — não deve aparecer em janelas curtas.
  insertUsage(db, orgA, { module: "falatu", userId: userA1, model: "gpt-4o-mini", inputTokens: 999, outputTokens: 999, costBrl: 100.00, daysAgo: 60 });

  // orgB: menos gasto, módulo comigo
  insertUsage(db, orgB, { module: "comigo", userId: userB, model: "gpt-4o-mini", inputTokens: 300, outputTokens: 100, costBrl: 1.20, daysAgo: 0 });
  insertUsage(db, orgB, { module: "comigo", userId: userB, model: "gpt-4o-mini", inputTokens: 300, outputTokens: 100, costBrl: 1.20, daysAgo: 5 });

  // ===== 3. listOrgs — 30d =====
  const list30 = AiUsageDashboardService.listOrgs(30);
  check("listOrgs devolve as 3 orgs (LEFT JOIN)", list30.length === 3);
  check("orgA aparece primeiro (maior custo)", list30[0].organizationId === orgA);
  check("orgA custo agregado 30d bate", Math.round(list30[0].costBrl * 100) === Math.round((15.50 + 8.20 + 6.10 + 4.50) * 100));
  check("orgA topModule é falatu", list30[0].topModule === "falatu");
  check("orgA plan preservado", list30[0].plan === "growth");
  check("orgB topModule é comigo", list30.find((r: any) => r.organizationId === orgB).topModule === "comigo");
  check("orgC (sem consumo) aparece com zeros", list30.find((r: any) => r.organizationId === orgC).costCents === 0);
  check("orgC callCount = 0", list30.find((r: any) => r.organizationId === orgC).callCount === 0);
  check("orgC topModule null", list30.find((r: any) => r.organizationId === orgC).topModule === null);
  check("orgA callCount 30d = 4 (60d filtrado fora)", list30.find((r: any) => r.organizationId === orgA).callCount === 4);

  // ===== 4. listOrgs — 7d filtra 10d atrás pra fora =====
  const list7 = AiUsageDashboardService.listOrgs(7);
  const orgA7 = list7.find((r: any) => r.organizationId === orgA);
  check("orgA em 7d NÃO conta a linha de 10d atrás", orgA7.callCount === 3);
  check("orgA em 7d custo bate (excluindo 10d)", Math.round(orgA7.costBrl * 100) === Math.round((15.50 + 8.20 + 4.50) * 100));

  // ===== 5. byOrg orgA — 30d =====
  const drillA = AiUsageDashboardService.byOrg(orgA, 30);
  check("byOrg série tem exatamente 30 dias", drillA.series.length === 30);
  check("byOrg última data é hoje (UTC)", drillA.series[29].date === (db.prepare(`SELECT date('now') AS d`).get() as any).d);
  check("byOrg série ordenada crescente", drillA.series.every((s: any, i: number) => i === 0 || s.date > drillA.series[i - 1].date));
  const hojeBucket = drillA.series[29];
  check("byOrg bucket hoje tem tokens (5000+1000)", hojeBucket.totalTokens === 6000);
  const somaSerie = drillA.series.reduce((a: number, s: any) => a + s.totalTokens, 0);
  check("byOrg totalTokens = soma da série", drillA.totalTokens === somaSerie);
  const somaCents = drillA.series.reduce((a: number, s: any) => a + s.costCents, 0);
  check("byOrg totalCostCents = soma da série", drillA.totalCostCents === somaCents);
  check("byOrg totalCostBrl = cents/100 (sem drift)", drillA.totalCostBrl === drillA.totalCostCents / 100);

  // ===== 6. byOrg breakdown =====
  check("byOrg byModule tem falatu + clinica", drillA.byModule.length === 2 && drillA.byModule[0].module === "falatu");
  check("byOrg byModel tem gpt-4o-mini + gpt-4o", drillA.byModel.length === 2);
  check("byOrg byUser separa userA1 e userA2", drillA.byUser.length === 2);
  const userA1Row = drillA.byUser.find((r: any) => r.userId === userA1);
  check("byOrg userA1 concentra falatu (3 chamadas em 30d)", userA1Row?.callCount === 3);

  // ===== 7. byOrg — clamp de days em rota =====
  const drillClamp = AiUsageDashboardService.byOrg(orgA, 500);
  check("byOrg respeita clamp teto (180)", drillClamp.days === 180 && drillClamp.series.length === 180);

  // ===== 8. Isolamento multi-tenant =====
  const drillB = AiUsageDashboardService.byOrg(orgB, 30);
  check("byOrg orgB isolado (não vê orgA)", drillB.totalCalls === 2 && drillB.byModule.length === 1 && drillB.byModule[0].module === "comigo");
  const drillC = AiUsageDashboardService.byOrg(orgC, 30);
  check("byOrg orgC (sem dados) devolve série de zeros", drillC.series.length === 30 && drillC.totalCalls === 0 && drillC.byModule.length === 0);

  // ===== 9. Rota HTTP + master gate =====
  const { requireMasterAdmin } = await import("../src/server/middleware/auth.js");
  const adminRoutes = (await import("../src/server/routes/admin.js")).default;

  const app = express();
  app.use(express.json());
  // Simula o middleware de auth do server.ts (extrai user do JWT).
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
  db.prepare(`INSERT OR IGNORE INTO users (id, organization_id, email, role) VALUES ('u1', 'default_org', 'master@test.local', 'owner')`).run();
  const masterToken = jwt.sign({ userId: "u1", email: "master@test.local", role: "owner" }, process.env.JWT_SECRET!);
  const orgUserToken = jwt.sign({ userId: "u2", email: "org@user.local", role: "owner" }, process.env.JWT_SECRET!);

  async function get(path: string, token?: string) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request({ port, path, method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: any = null; try { body = JSON.parse(raw); } catch { body = raw; }
          resolve({ status: res.statusCode || 0, body });
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  const r1 = await get("/api/admin/ai-usage?days=30", masterToken);
  check("GET /api/admin/ai-usage: master 200", r1.status === 200);
  check("GET /api/admin/ai-usage: payload {days, items[]}", Number.isInteger(r1.body?.days) && Array.isArray(r1.body?.items));
  check("GET /api/admin/ai-usage: 3 items", r1.body?.items?.length === 3);

  const r2 = await get(`/api/admin/ai-usage/${orgA}?days=30`, masterToken);
  check("GET /api/admin/ai-usage/:orgId: master 200", r2.status === 200);
  check("GET /api/admin/ai-usage/:orgId: payload shape", Array.isArray(r2.body?.series) && Array.isArray(r2.body?.byModule) && Array.isArray(r2.body?.byModel));
  check("GET drill série tem 30 dias", r2.body?.series?.length === 30);

  const r3 = await get("/api/admin/ai-usage?days=30", orgUserToken);
  check("GET /api/admin/ai-usage: não-master 403", r3.status === 403);

  const r4 = await get("/api/admin/ai-usage?days=30");
  check("GET /api/admin/ai-usage: sem token 403", r4.status === 403);

  // Bug preview de F1.1: se rota /:orgId matchasse ANTES de /ai-usage, o
  // GET /api/admin/ai-usage (sem :orgId) pegaria "ai-usage" como orgId e
  // devolveria 200 com série vazia em vez de listOrgs. Verifica que a ordem
  // do router está certa (assertion no shape do payload já cobre isso, mas
  // deixamos explícito).
  check("ordem do router: /ai-usage devolve lista (não drilldown)", Array.isArray(r1.body?.items));

  await new Promise<void>((resolve) => server.close(() => resolve()));

  const passed = results.length - failures;
  console.log(`\n=== TEST AI USAGE DASHBOARD (ADR-154 F1.2) ===`);
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
