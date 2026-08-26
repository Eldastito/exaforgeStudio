/**
 * TEST — Troca do RAMO (vertical) self-service (owner/admin). DB-backed, det.
 * Fecha o gap leigo-friendly: o onboarding só roda 1x, então uma conta já criada
 * não tinha caminho simples pra mudar o ramo e fazer a tela dedicada da vertical
 * (ex.: Advocacia) aparecer no menu. Rota nova `POST /api/analytics/settings/vertical`:
 *   - owner/admin troca o próprio ramo → 200 + preset aplicado (organization_settings.vertical);
 *   - trocar pra advocacia grava vertical='advocacia' (é o que o Sidebar lê pra ligar a tela);
 *   - trocar pra educacao grava vertical='educacao';
 *   - vertical inválida/ausente → 400 (nunca grava ramo inventado);
 *   - isolamento multi-tenant (troca em A não afeta B).
 *
 * Uso: npm run test:vertical-self-switch
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vsw-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-vsw-123456";

let failures = 0; const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) { results.push({ name, ok, note }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));

  const express = (await import("express")).default;
  const { default: analyticsRoutes } = await import("../src/server/routes/analytics.js");

  const app = express();
  app.use(express.json());
  // Auth stub — injeta req.user + orgId. Role controlável por header pra provar o gate.
  const authStub = (req: any, _res: any, next: any) => {
    req.organizationId = req.headers["x-test-org"] || "org_default";
    req.user = {
      userId: "u_test",
      role: req.headers["x-test-role"] || "owner",
      organizationId: req.organizationId,
    };
    next();
  };
  app.use("/api/analytics", authStub, analyticsRoutes);

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
  const call = async (url: string, body: any, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* not-json */ }
    return { status: r.status, json, text };
  };
  const readVertical = (orgId: string): string | null => {
    const row = db.prepare(`SELECT vertical FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return row?.vertical ?? null;
  };

  try {
    // ═══ 1. owner troca pra advocacia → 200 + tela ligada (vertical='advocacia') ═══
    const A = seedOrg(null);
    let r = await call("/api/analytics/settings/vertical", { vertical: "advocacia" }, { "x-test-org": A });
    check("1.1 owner → advocacia → 200", r.status === 200 && r.json?.success === true, `status=${r.status} body=${r.text}`);
    check("1.2 devolve { vertical:'advocacia' }", r.json?.vertical === "advocacia");
    check("1.3 DB grava vertical='advocacia' (Sidebar liga a tela Advocacia)", readVertical(A) === "advocacia");
    const enabled = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id=?`).get(A) as any).enabled_modules || "[]");
    check("1.4 preset aplicado (agenda + areas ligados)", enabled.includes("agenda") && enabled.includes("areas"));

    // ═══ 2. troca pra educacao (Escolas/Cursos) → 200 ═══
    r = await call("/api/analytics/settings/vertical", { vertical: "educacao" }, { "x-test-org": A });
    check("2.1 troca → educacao → 200", r.status === 200 && r.json?.vertical === "educacao");
    check("2.2 DB grava vertical='educacao'", readVertical(A) === "educacao");

    // ═══ 3. vertical inválida → 400 (nunca grava ramo inventado) ═══
    r = await call("/api/analytics/settings/vertical", { vertical: "ramo_que_nao_existe_xyz" }, { "x-test-org": A });
    check("3.1 vertical desconhecida → 400", r.status === 400 && r.json?.error === "vertical_desconhecida", `status=${r.status} body=${r.text}`);
    check("3.2 DB preservou o ramo anterior (=educacao)", readVertical(A) === "educacao");

    // ═══ 4. vertical ausente → 400 ═══
    r = await call("/api/analytics/settings/vertical", {}, { "x-test-org": A });
    check("4.1 vertical ausente → 400", r.status === 400 && r.json?.error === "vertical_obrigatorio");

    // ═══ 5. gate de role — viewer não troca ═══
    r = await call("/api/analytics/settings/vertical", { vertical: "advocacia" }, { "x-test-org": A, "x-test-role": "viewer" });
    check("5.1 role sem permissão → 403 (requireRole owner/admin)", r.status === 403, `status=${r.status}`);
    check("5.2 DB preservado (=educacao) após 403", readVertical(A) === "educacao");

    // ═══ 6. isolamento multi-tenant ═══
    const B = seedOrg("varejo");
    r = await call("/api/analytics/settings/vertical", { vertical: "advocacia" }, { "x-test-org": A });
    check("6.1 troca em A → 200", r.status === 200);
    check("6.2 org B intocada (=varejo)", readVertical(B) === "varejo");
  } finally {
    server.close();
  }

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}${x.note ? ` — ${x.note}` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} vertical-self-switch: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
