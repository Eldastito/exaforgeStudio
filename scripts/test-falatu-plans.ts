/**
 * TEST — ADR-154 F2.2 (Fatia A): catálogo comercial B2C do FalaTu.
 *
 * Cobre: os 3 planos (Solo/Pro/Família) nascem na tabela `plans` com os preços
 * definitivos (19/29/49); `listFalatuPlans()` os devolve ordenados; o catálogo
 * B2B (`listPlans()`) NÃO os enxerga (sem vazamento no seletor B2B) mas segue
 * com a grade toda; `getCurrentPlan` resolve um plano `falatu_*`; a colisão com
 * o DELETE de legados do applyPlanGrade NÃO apaga os planos FalaTu (id `falatu_pro`
 * ≠ `pro`); e a rota pública `GET /api/public/falatu/plans` devolve o catálogo.
 *
 * Uso: npm run test:falatu-plans
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import express from "express";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-plans-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-plans-123456";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PlanService } = await import("../src/server/PlanService.js");
  const { applyPlanGrade } = await import("../src/server/plansGrade.js");
  const { isFalatuPlanId, FALATU_PLAN_IDS } = await import("../src/server/falatuPlans.js");

  // ===== 1. Seed: os 3 planos existem com os preços definitivos =====
  const byId = (id: string) => db.prepare(`SELECT * FROM plans WHERE id = ?`).get(id) as any;
  check("falatu_solo existe a R$19", byId("falatu_solo")?.price === 19 && byId("falatu_solo")?.name === "Solo");
  check("falatu_pro existe a R$29", byId("falatu_pro")?.price === 29 && byId("falatu_pro")?.name === "Pro");
  check("falatu_familia existe a R$49", byId("falatu_familia")?.price === 49 && byId("falatu_familia")?.name === "Família");

  // ===== 2. listFalatuPlans: só os 3, ordenados, com features =====
  const fp = PlanService.listFalatuPlans();
  check("listFalatuPlans devolve exatamente 3", fp.length === 3);
  check("ordenados por preço (19,29,49)", fp.map((p: any) => p.price).join(",") === "19,29,49");
  check("ids são os esperados", fp.map((p: any) => p.id).join(",") === FALATU_PLAN_IDS.join(","));
  check("todos incluem o módulo 'falatu'", fp.every((p: any) => (p.features.modules || []).includes("falatu")));
  check("todos têm cota de IA e trial (placeholder)", fp.every((p: any) => typeof p.features.ai_monthly_limit === "number" && typeof p.features.trial_days === "number"));

  // ===== 3. listPlans (B2B) NÃO vaza os planos FalaTu, mas mantém a grade =====
  const b2b = PlanService.listPlans();
  check("listPlans B2B não contém nenhum falatu_*", b2b.every((p: any) => !isFalatuPlanId(p.id)));
  const b2bIds = new Set(b2b.map((p: any) => p.id));
  check("grade B2B intacta (autonomo..enterprise + cortesia)",
    ["autonomo", "start", "growth", "scale", "enterprise", "cortesia"].every((id) => b2bIds.has(id)));

  // ===== 4. getCurrentPlan resolve um plano FalaTu =====
  const org = `org_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id) VALUES (?, ?, 'Org Solo', 'active', 'falatu_solo')`).run(org, org);
  const cur = PlanService.getCurrentPlan(org);
  check("getCurrentPlan resolve falatu_solo", cur?.id === "falatu_solo" && cur?.price === 19);
  check("isFalatuPlanId(falatu_solo) true / (growth) false", isFalatuPlanId("falatu_solo") === true && isFalatuPlanId("growth") === false);

  // ===== 5. Idempotência + colisão: re-aplicar a grade NÃO apaga os FalaTu =====
  // applyPlanGrade faz DELETE ... id IN ('starter','pro','business'); 'falatu_pro'
  // não pode ser afetado.
  applyPlanGrade(db);
  check("após re-aplicar grade, falatu_pro continua vivo", !!byId("falatu_pro"));
  check("re-seed idempotente mantém os 3", PlanService.listFalatuPlans().length === 3);

  // ===== 6. Rota pública GET /api/public/falatu/plans =====
  const falatuPublicRoutes = (await import("../src/server/routes/falatuPublic.js")).default;
  const app = express();
  app.use("/api/public/falatu", falatuPublicRoutes);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const body: any = await new Promise((resolve, reject) => {
    http.get({ port, path: "/api/public/falatu/plans" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
  check("GET /api/public/falatu/plans → 200 público", body.status === 200);
  check("rota devolve os 3 planos", Array.isArray(body.json?.plans) && body.json.plans.length === 3);
  check("rota traz Solo/Pro/Família", body.json.plans.map((p: any) => p.name).join(",") === "Solo,Pro,Família");
  await new Promise<void>((r) => server.close(() => r()));

  console.log("");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}`);
  console.log(failures === 0 ? "\nOK — 100% PASS" : `\nFALHOU — ${failures} checagem(ns)`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
});
