/**
 * TEST — BEAUTY-021 (ADR-169 F20): GET/PATCH /api/beauty/settings — toggle do
 * Simulador de Cabelo (`beauty_hair_simulator_enabled`) pela UI do dono.
 *
 * Fecha o gap operacional: até aqui só Master Admin ligava a flag por
 * manipulação direta de DB; dono/admin passa a poder ligar/desligar pela
 * aba Módulos do SettingsView (F20-4).
 *
 * Checks:
 *  1. GET sem vertical=beleza → 404 (não vaza existência do toggle).
 *  2. GET com vertical=beleza + flag default OFF → { hairSimulatorEnabled: false }.
 *  3. PATCH liga → 200 + persiste em organization_settings.
 *  4. GET refletindo estado ligado.
 *  5. PATCH desliga → 200 + persiste.
 *  6. PATCH sem vertical=beleza → 404 (belt-and-suspenders).
 *  7. PATCH com role='atendente' → 403 (RN-BS-08: quem contrata é dono).
 *  8. PATCH com role='owner' + platform_role='master_admin' → 200 (Master passa).
 *  9. Isolamento multi-tenant: PATCH orgA nunca mexe orgB.
 * 10. auth_audit_logs grava ADMIN_BEAUTY_HAIR_SIMULATOR_TOGGLE com enabled.
 *
 * Padrão de teste: express minimal + fetch, mesmo do test-beauty-routes.
 *
 * Uso: npm run test:beauty-settings-toggle
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-settings-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-settings-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));

  const express = (await import("express")).default;
  const { default: beautyRoutes } = await import("../src/server/routes/beauty.js");

  const app = express();
  app.use(express.json());
  const authStub = (req: any, _res: any, next: any) => {
    req.organizationId = req.headers["x-test-org"] || null;
    req.user = {
      userId: req.headers["x-test-user"] || null,
      role: req.headers["x-test-role"] || "owner",
      platform_role: req.headers["x-test-platform"] || null,
      organizationId: req.headers["x-test-org"] || null,
    };
    next();
  };
  app.use("/api/beauty", authStub, beautyRoutes);

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  const seedOrg = (vertical: string | null) => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, ?, 'active', ?)`,
    ).run(randomUUID(), orgId, `Empresa ${orgId.slice(0, 6)}`, vertical);
    return orgId;
  };

  const call = async (method: string, url: string, opts: { orgId?: string | null; role?: string; body?: any } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.orgId !== null && opts.orgId !== undefined) headers["x-test-org"] = opts.orgId;
    if (opts.role) headers["x-test-role"] = opts.role;
    const r = await fetch(`${base}${url}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not-json */ }
    return { status: r.status, json, text };
  };

  const readFlag = (orgId: string): boolean => {
    const row = db.prepare(`SELECT beauty_hair_simulator_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return !!Number(row?.beauty_hair_simulator_enabled);
  };

  try {
    const orgVarejo = seedOrg("varejo");
    const orgBeleza = seedOrg("beleza");

    // ===== 1. GET sem vertical=beleza → 404 =====
    let r = await call("GET", "/api/beauty/settings", { orgId: orgVarejo });
    check("GET /settings com vertical=varejo → 404 (não vaza)", r.status === 404);

    // ===== 2. GET com beleza + flag OFF default =====
    r = await call("GET", "/api/beauty/settings", { orgId: orgBeleza });
    check("GET /settings com beleza → 200", r.status === 200, `status=${r.status}`);
    check("hairSimulatorEnabled=false default (0-regressão)", r.json?.hairSimulatorEnabled === false);

    // ===== 3. PATCH liga =====
    r = await call("PATCH", "/api/beauty/settings/hair-simulator", { orgId: orgBeleza, body: { enabled: true } });
    check("PATCH liga → 200", r.status === 200 && r.json?.ok === true, `status=${r.status} body=${r.text}`);
    check("PATCH devolve hairSimulatorEnabled=true", r.json?.hairSimulatorEnabled === true);
    check("DB: beauty_hair_simulator_enabled=1", readFlag(orgBeleza) === true);

    // ===== 4. GET reflete estado =====
    r = await call("GET", "/api/beauty/settings", { orgId: orgBeleza });
    check("GET reflete estado ligado", r.status === 200 && r.json?.hairSimulatorEnabled === true);

    // ===== 5. PATCH desliga =====
    r = await call("PATCH", "/api/beauty/settings/hair-simulator", { orgId: orgBeleza, body: { enabled: false } });
    check("PATCH desliga → 200", r.status === 200 && r.json?.hairSimulatorEnabled === false);
    check("DB: beauty_hair_simulator_enabled=0", readFlag(orgBeleza) === false);

    // ===== 6. PATCH sem vertical=beleza → 404 =====
    r = await call("PATCH", "/api/beauty/settings/hair-simulator", { orgId: orgVarejo, body: { enabled: true } });
    check("PATCH em vertical!=beleza → 404 (belt-and-suspenders)", r.status === 404);
    check("DB orgVarejo intocado", readFlag(orgVarejo) === false);

    // ===== 7. PATCH com role='atendente' → 403 =====
    r = await call("PATCH", "/api/beauty/settings/hair-simulator", { orgId: orgBeleza, role: "atendente", body: { enabled: true } });
    check("PATCH com role=atendente → 403 (requireRole owner/admin)", r.status === 403,
      `status=${r.status} body=${r.text}`);
    check("DB inalterado após 403", readFlag(orgBeleza) === false);

    // ===== 8. PATCH com role='admin' → 200 =====
    r = await call("PATCH", "/api/beauty/settings/hair-simulator", { orgId: orgBeleza, role: "admin", body: { enabled: true } });
    check("PATCH com role=admin → 200", r.status === 200);
    check("DB ligado por admin", readFlag(orgBeleza) === true);

    // ===== 9. Isolamento multi-tenant =====
    const orgBeleza2 = seedOrg("beleza");
    r = await call("PATCH", "/api/beauty/settings/hair-simulator", { orgId: orgBeleza2, body: { enabled: true } });
    check("PATCH orgBeleza2 → 200", r.status === 200);
    check("orgBeleza2.flag ligada", readFlag(orgBeleza2) === true);
    // desliga a 1ª e checa que a 2ª segue ligada
    await call("PATCH", "/api/beauty/settings/hair-simulator", { orgId: orgBeleza, body: { enabled: false } });
    check("orgBeleza desligada não mexe orgBeleza2 (isolamento)", readFlag(orgBeleza) === false && readFlag(orgBeleza2) === true);

    // ===== 10. Audit log =====
    await new Promise((r) => setTimeout(r, 50));
    const auditRow = db.prepare(
      `SELECT event_type, target_user_id, metadata_json FROM auth_audit_logs
       WHERE event_type='ADMIN_BEAUTY_HAIR_SIMULATOR_TOGGLE' AND target_user_id=?
       ORDER BY id DESC LIMIT 1`
    ).get(orgBeleza) as any;
    check("auth_audit_logs registra ADMIN_BEAUTY_HAIR_SIMULATOR_TOGGLE", !!auditRow, `audit=${JSON.stringify(auditRow)}`);
    check("metadata_json carrega enabled", typeof auditRow?.metadata_json === "string" && auditRow.metadata_json.includes("enabled"));
  } finally {
    server.close();
  }

  console.log("\n=== TEST — BEAUTY-021 (ADR-169 F20): beauty settings toggle ===");
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.note ? ` — ${r.note}` : ""}`);
  }
  console.log(`\n${results.length - failures}/${results.length} PASS`);
  if (failures > 0) {
    console.error(`\n${failures} FAIL`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
