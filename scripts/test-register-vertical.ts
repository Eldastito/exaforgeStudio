/**
 * TEST — Vertical escolhida NO CADASTRO (self-service) configura a conta e PULA
 * o onboarding. DB-backed, determinístico. Fecha a duplicação: antes o cadastro
 * capturava um "segmento" texto-livre e a vertical era escolhida DE NOVO no 1º
 * login (OnboardingView). Agora o /register aceita `vertical`: se for chave
 * válida do catálogo → applyVertical + onboarding_status='completed'; senão cai
 * no onboarding (comportamento antigo).
 *
 * Uso: npm run test:register-vertical
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-reg-vert-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-reg-vert-123456";

let failures = 0; const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) { results.push({ name, ok, note }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const express = (await import("express")).default;
  const { default: authRoutes } = await import("../src/server/routes/auth.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { PLAN_GRADE } = await import("../src/server/plansGrade.js");

  // Semeia a grade de planos (pro caso com planId).
  const seedPlan = db.prepare(`INSERT OR IGNORE INTO plans (id, name, price, features) VALUES (?, ?, ?, ?)`);
  for (const p of PLAN_GRADE) seedPlan.run(p.id, p.name, p.price, JSON.stringify(p.features));

  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  const register = async (body: any) => {
    const r = await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  };
  const orgOf = (email: string): any => {
    const u = db.prepare(`SELECT organization_id FROM users WHERE email = ?`).get(email) as any;
    return u ? db.prepare(`SELECT * FROM organization_settings WHERE organization_id = ?`).get(u.organization_id) as any : null;
  };
  const pw = "Senha!Forte#2026";

  try {
    // ═══ 1. cadastro COM vertical válida → configura + pula onboarding ═══
    const e1 = `a_${randomUUID().slice(0, 8)}@t.com`;
    let r = await register({ name: "Escola X", email: e1, password: pw, organizationName: "Escola X", vertical: "educacao" });
    check("1.1 register 201", r.status === 201, `status=${r.status} ${JSON.stringify(r.j)}`);
    const o1 = orgOf(e1);
    check("1.2 vertical gravada = educacao", o1?.vertical === "educacao");
    check("1.3 onboarding PULADO (status=completed)", o1?.onboarding_status === "completed");
    const em1: string[] = JSON.parse(o1?.enabled_modules || "[]");
    check("1.4 preset da vertical aplicado (escola ligado; sem plano=sem teto)", em1.includes("escola") && em1.includes("agenda"));

    // ═══ 2. cadastro SEM vertical → cai no onboarding (comportamento antigo) ═══
    const e2 = `b_${randomUUID().slice(0, 8)}@t.com`;
    r = await register({ name: "Sem Ramo", email: e2, password: pw, organizationName: "Sem Ramo" });
    check("2.1 register 201", r.status === 201);
    const o2 = orgOf(e2);
    check("2.2 onboarding PENDENTE (status=pending)", o2?.onboarding_status === "pending");
    check("2.3 vertical não definida", o2?.vertical == null);

    // ═══ 3. vertical inválida → tratada como ausente (não inventa ramo) ═══
    const e3 = `c_${randomUUID().slice(0, 8)}@t.com`;
    r = await register({ name: "Ramo Falso", email: e3, password: pw, organizationName: "Ramo Falso", vertical: "ramo_inexistente_xyz" });
    check("3.1 register 201", r.status === 201);
    const o3 = orgOf(e3);
    check("3.2 vertical inválida → não grava, cai no onboarding", o3?.vertical == null && o3?.onboarding_status === "pending");

    // ═══ 4. vertical + plano → preset ∩ plano (teto respeitado) ═══
    // hospitalidade sugere `reservas` (está no Growth) mas o preset NÃO tem clinica.
    const e4 = `d_${randomUUID().slice(0, 8)}@t.com`;
    r = await register({ name: "Hotel Y", email: e4, password: pw, organizationName: "Hotel Y", vertical: "hospitalidade", planId: "growth" });
    check("4.1 register 201", r.status === 201);
    const o4 = orgOf(e4);
    check("4.2 vertical=hospitalidade + onboarding completed", o4?.vertical === "hospitalidade" && o4?.onboarding_status === "completed");
    check("4.3 plano selecionado (plan_id=growth)", o4?.plan_id === "growth");
    const em4: string[] = JSON.parse(o4?.enabled_modules || "[]");
    check("4.4 módulo do preset ∩ plano ligado (reservas ∈ Growth)", em4.includes("reservas"));
    check("4.5 módulo fora do plano NÃO ligado (advocacia/clinica ∉ Growth)", !em4.includes("advocacia") && !em4.includes("clinica"));

    // ═══ 5. catálogo público de verticais (usado pelo seletor do cadastro) ═══
    const cat = ModuleService.catalog();
    check("5.1 catálogo de verticais não-vazio e com chaves conhecidas", Array.isArray(cat) && cat.some((v: any) => v.key === "educacao") && cat.some((v: any) => v.key === "advocacia"));
  } finally {
    server.close();
  }

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}${x.note ? ` — ${x.note}` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} register-vertical: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
