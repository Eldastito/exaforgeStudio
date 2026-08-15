/**
 * TEST — BEAUTY-020 (ADR-169 F19): PATCH /api/admin/organizations/:id/vertical.
 *
 * Prova que o Master Admin consegue atribuir/trocar/limpar a `vertical` de uma
 * organização — porta que fecha o gap operacional da F19: sem esta rota, o
 * dono não tinha como fazer uma org virar `vertical=beleza` e portanto a
 * BeautyView + o gate `assertBeautyOn(orgId)` de `routes/beauty.ts` nunca
 * seriam alcançados no dia-a-dia.
 *
 * Checks:
 *  1. PATCH com vertical válida do registry (`beleza`) → 200 + persiste
 *     em `organization_settings.vertical`.
 *  2. PATCH com vertical inválida (string livre) → 400 (não deixa string
 *     arbitrária, protegendo o gate — só chaves de `VERTICALS`).
 *  3. PATCH com `null` → 200, limpa a vertical (dono pode "desatribuir").
 *  4. PATCH em org inexistente → 404 (não vaza pela lateral).
 *  5. Registra `ADMIN_CHANGE_VERTICAL` no audit_log (rastreabilidade).
 *  6. Isolamento multi-tenant: PATCH de uma org NUNCA altera outra.
 *  7. Órfão de segurança: soft-deleted (`deleted_at != NULL`) → 404
 *     (a rota filtra `deleted_at IS NULL`).
 *
 * O teste boota um Express mínimo montando `adminRoutes` diretamente (sem
 * passar pelo `requireMasterAdmin` — que exige JWT+platform_role e cookie
 * — porque queremos testar a AMARRAÇÃO da rota + validação + persistência,
 * não a auth stack, já coberta em outros suites). Mesma estratégia do
 * `test-beauty-routes.ts`.
 *
 * Uso: npm run test:beauty-admin-vertical
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-admin-vertical-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-admin-vertical-1234567890";

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
  const { default: adminRoutes } = await import("../src/server/routes/admin.js");

  const app = express();
  app.use(express.json());
  // Auth stub — injeta req.user + orgId como se fosse master admin autenticado.
  const authStub = (req: any, _res: any, next: any) => {
    req.organizationId = req.headers["x-test-org"] || "master_org";
    req.user = {
      userId: req.headers["x-test-user"] || "master_user",
      role: "owner",
      platform_role: "master_admin",
      organizationId: req.headers["x-test-org"] || "master_org",
    };
    next();
  };
  app.use("/api/admin", authStub, adminRoutes);

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

  const call = async (method: string, url: string, body?: any) => {
    const r = await fetch(`${base}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not-json */ }
    return { status: r.status, json, text };
  };

  const readVertical = (orgId: string): string | null => {
    const row = db.prepare(`SELECT vertical FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return row?.vertical ?? null;
  };

  try {
    // ===== 1. PATCH válido: seta beleza =====
    const orgA = seedOrg(null);
    let r = await call("PATCH", `/api/admin/organizations/${orgA}/vertical`, { vertical: "beleza" });
    check("PATCH vertical=beleza → 200", r.status === 200 && r.json?.success === true, `status=${r.status} body=${r.text}`);
    check("PATCH vertical=beleza → devolve { vertical: 'beleza' }", r.json?.vertical === "beleza");
    check("DB: organization_settings.vertical = 'beleza'", readVertical(orgA) === "beleza");

    // ===== 2. Vertical inválida (string livre) → 400 =====
    r = await call("PATCH", `/api/admin/organizations/${orgA}/vertical`, { vertical: "veterinaria_pet_shop" });
    check("PATCH vertical inválida → 400", r.status === 400);
    check("Erro cita o registry de verticals", typeof r.json?.error === "string" && r.json.error.includes("beleza"),
      `error=${r.json?.error}`);
    check("DB preservou vertical anterior (=beleza)", readVertical(orgA) === "beleza");

    // ===== 3. Troca pra saude (registry) → 200 =====
    r = await call("PATCH", `/api/admin/organizations/${orgA}/vertical`, { vertical: "saude" });
    check("PATCH vertical=saude (troca) → 200", r.status === 200 && r.json?.vertical === "saude");
    check("DB: vertical trocada pra 'saude'", readVertical(orgA) === "saude");

    // ===== 4. PATCH null → limpa =====
    r = await call("PATCH", `/api/admin/organizations/${orgA}/vertical`, { vertical: null });
    check("PATCH vertical=null (limpa) → 200", r.status === 200 && r.json?.vertical === null);
    check("DB: vertical = NULL após limpar", readVertical(orgA) === null);

    // ===== 5. Org inexistente → 404 =====
    r = await call("PATCH", `/api/admin/organizations/nao_existe_xyz/vertical`, { vertical: "beleza" });
    check("PATCH em org inexistente → 404", r.status === 404, `status=${r.status}`);

    // ===== 6. Audit log escrito (auth_audit_logs) =====
    // `logAuthEvent` grava em `auth_audit_logs` (event_type='ADMIN_CHANGE_VERTICAL',
    // target_user_id recebe o orgId — padrão dos ADMIN_* dessa rota).
    await new Promise((r) => setTimeout(r, 50));
    const auditRow = db.prepare(
      `SELECT event_type, target_user_id, metadata_json FROM auth_audit_logs
       WHERE event_type='ADMIN_CHANGE_VERTICAL' AND target_user_id=?
       ORDER BY id DESC LIMIT 1`
    ).get(orgA) as any;
    check("auth_audit_logs registra ADMIN_CHANGE_VERTICAL na org", !!auditRow, `audit=${JSON.stringify(auditRow)}`);
    check("auth_audit_logs.metadata_json carrega a vertical", typeof auditRow?.metadata_json === "string" && auditRow.metadata_json.includes("vertical"));

    // ===== 7. Isolamento multi-tenant =====
    const orgB = seedOrg("moda");
    r = await call("PATCH", `/api/admin/organizations/${orgA}/vertical`, { vertical: "beleza" });
    check("PATCH em orgA → 200", r.status === 200);
    check("orgA.vertical mudou pra beleza", readVertical(orgA) === "beleza");
    check("orgB.vertical NÃO mudou (isolamento)", readVertical(orgB) === "moda");

    // ===== 8. Soft-deleted → 404 =====
    const orgDel = seedOrg("food");
    db.prepare(`UPDATE organization_settings SET deleted_at = CURRENT_TIMESTAMP WHERE organization_id = ?`).run(orgDel);
    r = await call("PATCH", `/api/admin/organizations/${orgDel}/vertical`, { vertical: "beleza" });
    check("PATCH em org soft-deleted → 404 (respeita deleted_at)", r.status === 404);
    check("DB soft-deleted preserva vertical antiga", readVertical(orgDel) === "food");

    // ===== 9. Todas as chaves do registry aceitas =====
    const orgC = seedOrg(null);
    const allKeys = ["varejo", "moda", "food", "servicos", "saude", "educacao", "hospitalidade", "beleza", "outro"];
    let allOk = true;
    for (const k of allKeys) {
      const rr = await call("PATCH", `/api/admin/organizations/${orgC}/vertical`, { vertical: k });
      if (rr.status !== 200 || readVertical(orgC) !== k) { allOk = false; break; }
    }
    check("PATCH aceita todas as 9 chaves do registry VERTICALS", allOk);
  } finally {
    server.close();
  }

  // ── Report ──
  console.log("\n=== TEST — BEAUTY-020 (ADR-169 F19): admin vertical ===");
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
