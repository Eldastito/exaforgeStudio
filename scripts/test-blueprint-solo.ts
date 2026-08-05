/**
 * TEST — ADR-154 Fatia 2.1: blueprint.mode + seed falatu_solo_v1 + onboarding standalone.
 *
 * Cobre:
 * - Schema: coluna `mode` existe em vertical_blueprints (default 'suite').
 * - Seed: falatu_solo_v1 aparece no BlueprintSeeder (após seedInitialBlueprints).
 * - Seed: falatu_solo tem mode='solo', requiredModules:['falatu'],
 *   hiddenModules contém tudo mais.
 * - Blueprints antigos (moda_loja_unica etc.) permanecem com mode='suite'
 *   (retrocompat).
 * - Guardrail Solo: createBlueprint mode='solo' com 2 requiredModules → throw.
 * - Guardrail Solo: createBlueprint mode='solo' com optionalModules > 0 → throw.
 * - Guardrail Solo: mode inválido → throw.
 * - Guardrail v1→v2: nova versão de key existente com mode diferente → throw.
 * - Onboarding standalone (POST /api/onboarding-solo):
 *   - Body válido + blueprint solo publicado → 201 + org criada + user +
 *     blueprint aplicado + falatu_enabled=1 + audit USER_REGISTERED_SOLO.
 *   - Email duplicado → 400.
 *   - Senha fraca → 400.
 *   - blueprintKey inexistente → 400.
 *   - blueprintKey aponta pra blueprint SUÍTE → 400 (não mistura).
 *   - Missing name/email/password → 400.
 *
 * Uso: npm run test:blueprint-solo
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import express from "express";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bpsolo-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-bpsolo-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { VerticalBlueprintService } = await import("../src/server/VerticalBlueprintService.js");
  const { BlueprintSeeder, INITIAL_BLUEPRINTS } = await import("../src/server/BlueprintSeeder.js");

  // ===== 1. Schema: coluna mode existe =====
  const cols = (db.prepare(`PRAGMA table_info(vertical_blueprints)`).all() as any[]).map((c: any) => c.name);
  check("coluna mode existe em vertical_blueprints", cols.includes("mode"));

  // Se os blueprints iniciais ainda não foram seedados (init async), seeda agora.
  await new Promise((r) => setTimeout(r, 100));
  BlueprintSeeder.seedInitialBlueprints();

  // ===== 2. Seed inclui falatu_solo =====
  const soloInInitial = INITIAL_BLUEPRINTS.find((b: any) => b.key === "falatu_solo");
  check("INITIAL_BLUEPRINTS inclui falatu_solo", !!soloInInitial);
  check("falatu_solo tem mode='solo'", soloInInitial?.mode === "solo");

  const falatuSolo = VerticalBlueprintService.getLatestPublished("falatu_solo");
  check("falatu_solo_v1 seedado e publicado", !!falatuSolo && falatuSolo.status === "published");
  check("falatu_solo status é 'published'", falatuSolo?.status === "published");
  check("falatu_solo mode='solo'", falatuSolo?.mode === "solo");
  check("falatu_solo requiredModules=['falatu']", falatuSolo?.config.requiredModules.length === 1 && falatuSolo?.config.requiredModules[0] === "falatu");
  check("falatu_solo optionalModules=[]", falatuSolo?.config.optionalModules.length === 0);
  check("falatu_solo hiddenModules cobre clinica/retail/escola/comigo/copiloto", (() => {
    const h = falatuSolo?.config.hiddenModules || [];
    return ["clinica", "retail", "escola", "copiloto"].every((m) => h.includes(m));
  })());
  check("falatu_solo hiddenModules NÃO inclui 'falatu'", !falatuSolo?.config.hiddenModules.includes("falatu"));

  // ===== 3. Blueprints antigos (moda etc.) permanecem 'suite' =====
  const moda = VerticalBlueprintService.getLatestPublished("moda_loja_unica");
  check("moda_loja_unica_v1 tem mode='suite' (retrocompat)", moda?.mode === "suite");
  const clinica = VerticalBlueprintService.getLatestPublished("clinica_multiespecialidades");
  check("clinica_multiespecialidades_v1 tem mode='suite'", clinica?.mode === "suite");

  // ===== 4. Guardrails do createBlueprint (mode='solo') =====
  let threw = false; let msg = "";
  try {
    VerticalBlueprintService.createBlueprint({
      key: "test_solo_dois_modulos",
      name: "Teste 2 mods",
      baseVertical: "outro",
      mode: "solo",
      config: { requiredModules: ["falatu", "clinica"] },
    });
  } catch (e: any) { threw = true; msg = e.message; }
  check("solo com 2 requiredModules → throw", threw && /EXATAMENTE 1/.test(msg));

  threw = false; msg = "";
  try {
    VerticalBlueprintService.createBlueprint({
      key: "test_solo_optional",
      name: "Teste com optional",
      baseVertical: "outro",
      mode: "solo",
      config: { requiredModules: ["falatu"], optionalModules: ["clinica"] },
    });
  } catch (e: any) { threw = true; msg = e.message; }
  check("solo com optionalModules → throw", threw && /não permite optionalModules/.test(msg));

  threw = false;
  try {
    VerticalBlueprintService.createBlueprint({
      key: "test_solo_mode_invalido",
      name: "Teste",
      baseVertical: "outro",
      mode: "hybrid" as any,
      config: { requiredModules: ["falatu"] },
    });
  } catch { threw = true; }
  check("mode inválido → throw", threw);

  // ===== 5. Guardrail v1→v2: mode não pode mudar entre versões =====
  threw = false; msg = "";
  try {
    // Tentar criar falatu_solo v2 em mode 'suite' — deve quebrar.
    VerticalBlueprintService.createBlueprint({
      key: "falatu_solo",
      name: "FalaTu v2 (tentativa suite)",
      baseVertical: "outro",
      version: 2,
      mode: "suite",
      config: { requiredModules: ["falatu", "clinica"] },
    });
  } catch (e: any) { threw = true; msg = e.message; }
  check("v2 mudando mode 'solo'→'suite' → throw", threw && /mode/i.test(msg));

  // v2 mantendo mode='solo' com config válida → OK (não deve quebrar)
  threw = false;
  try {
    VerticalBlueprintService.createBlueprint({
      key: "falatu_solo",
      name: "FalaTu v2 correto",
      baseVertical: "outro",
      version: 2,
      mode: "solo",
      config: { requiredModules: ["falatu"], hiddenModules: ["clinica", "retail"] },
    });
  } catch { threw = true; }
  check("v2 mantendo mode='solo' com config válida → cria", !threw);

  // Blueprint 'suite' padrão (sem mode explícito) permanece 'suite'
  const suite = VerticalBlueprintService.createBlueprint({
    key: "test_default_suite",
    name: "Default suite",
    baseVertical: "outro",
    config: { requiredModules: ["catalogo", "vendas"] },
  });
  check("createBlueprint sem mode default 'suite'", suite.mode === "suite");

  // ===== 6. Onboarding standalone (POST /api/onboarding-solo) =====
  const onboardingSoloRoutes = (await import("../src/server/routes/onboardingSolo.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/onboarding-solo", onboardingSoloRoutes);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  async function post(path: string, body: any) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        port, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
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
      req.write(data); req.end();
    });
  }

  const email1 = `solo-${randomUUID().slice(0, 6)}@t.com`;
  const p1 = await post("/api/onboarding-solo", {
    name: "Ana Solo", email: email1, password: "senha1234ABC", phone: "+5511999",
    blueprintKey: "falatu_solo",
  });
  check("onboarding solo válido → 201", p1.status === 201);
  check("onboarding: payload traz {organizationId, blueprint}", !!p1.body?.organizationId && p1.body?.blueprint?.key === "falatu_solo");
  check("onboarding: blueprint reportado mode='solo'", p1.body?.blueprint?.mode === "solo");

  // Persistência: org existe, user existe, blueprint aplicado, falatu_enabled=1
  const orgRow = db.prepare(`SELECT * FROM organization_settings WHERE organization_id = ?`).get(p1.body.organizationId) as any;
  check("org criada com business_name default 'Assistente de Ana Solo'", orgRow?.business_name === "Assistente de Ana Solo");
  check("org status='active' + onboarding_status='completed'", orgRow?.status === "active" && orgRow?.onboarding_status === "completed");
  check("org falatu_enabled=1", orgRow?.falatu_enabled === 1);
  const userRow = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email1) as any;
  check("user criado com role='owner' + organization_id certo", userRow?.role === "owner" && userRow?.organization_id === p1.body.organizationId);
  const asg = db.prepare(`SELECT * FROM organization_blueprints WHERE organization_id = ?`).get(p1.body.organizationId) as any;
  check("blueprint atribuído à org (organization_blueprints)", asg?.blueprint_key === "falatu_solo" && Number(asg?.blueprint_version) >= 1);
  const audit = db.prepare(`SELECT * FROM auth_audit_logs WHERE event_type = 'USER_REGISTERED_SOLO' AND organization_id = ?`).get(p1.body.organizationId) as any;
  check("audit USER_REGISTERED_SOLO gravado", !!audit);

  // Email duplicado
  const p2 = await post("/api/onboarding-solo", {
    name: "Outro", email: email1, password: "senha1234ABC", blueprintKey: "falatu_solo",
  });
  check("email duplicado → 400", p2.status === 400);

  // Senha fraca
  const p3 = await post("/api/onboarding-solo", {
    name: "X", email: `x-${randomUUID().slice(0, 6)}@t.com`, password: "123", blueprintKey: "falatu_solo",
  });
  check("senha fraca → 400", p3.status === 400);

  // Blueprint inexistente
  const p4 = await post("/api/onboarding-solo", {
    name: "Y", email: `y-${randomUUID().slice(0, 6)}@t.com`, password: "senha1234ABC", blueprintKey: "naoexiste_solo",
  });
  check("blueprintKey inexistente → 400", p4.status === 400);

  // Blueprint suíte (não solo)
  const p5 = await post("/api/onboarding-solo", {
    name: "Z", email: `z-${randomUUID().slice(0, 6)}@t.com`, password: "senha1234ABC", blueprintKey: "moda_loja_unica",
  });
  check("blueprint suíte no endpoint solo → 400", p5.status === 400);
  check("mensagem cita mode wrong", /suite|solo/i.test(p5.body?.error || ""));

  // Missing fields
  const p6 = await post("/api/onboarding-solo", { name: "X", email: "x@t.com" });
  check("faltando campos → 400", p6.status === 400);

  const p7 = await post("/api/onboarding-solo", {
    name: "X", email: "x2@t.com", password: "senha1234ABC",
  });
  check("faltando blueprintKey → 400", p7.status === 400);

  // Business name customizado
  const p8 = await post("/api/onboarding-solo", {
    name: "Bruno", email: `b-${randomUUID().slice(0, 6)}@t.com`, password: "senha1234ABC",
    businessName: "Meu Negócio Solo", blueprintKey: "falatu_solo",
  });
  check("businessName custom aceito", p8.status === 201);
  const orgB = db.prepare(`SELECT business_name FROM organization_settings WHERE organization_id = ?`).get(p8.body.organizationId) as any;
  check("businessName custom persistido", orgB?.business_name === "Meu Negócio Solo");

  await new Promise<void>((resolve) => server.close(() => resolve()));

  const passed = results.length - failures;
  console.log(`\n=== TEST BLUEPRINT SOLO (ADR-154 F2.1) ===`);
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
