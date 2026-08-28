/**
 * TEST — Smoke test da rota consolidada /api/growth (PR #1424).
 *
 * Sobe uma instância mínima de Express em porta arbitrária, monta
 * `routes/growth.ts` atrás do `requireAuth`, hita cada endpoint com
 * um JWT de owner de uma org de teste, e valida:
 *   - 401 sem auth
 *   - 403 sem role owner/admin
 *   - 200 (ou 400 semântico) com auth de owner
 *   - shape da resposta é JSON válido
 *
 * NÃO valida lógica dos services subjacentes — isso é coberto por
 * test:growth-golden-paths e afins. Este teste só prova que o wire
 * `server.ts → routes/growth.ts` responde.
 *
 * Fecha o gap "no direct test" que o bot code-review-graph reportou
 * no PR #1424 pra src/server/routes/growth.ts.
 *
 * Uso: npm run test:growth-routes
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import express from "express";
import jwt from "jsonwebtoken";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-growth-rt-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-growth-rt-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { requireAuth } = await import("../src/server/middleware/auth.js");
  const growthRoutes = (await import("../src/server/routes/growth.js")).default;
  const socialRoutes = (await import("../src/server/routes/social.js")).default;

  const ORG_ID = "org-growth-rt";

  // ═══════════════ Setup do app ═══════════════
  const app = express();
  app.use(express.json());
  app.use("/api/growth", requireAuth, growthRoutes);
  // Monta o legado pra validar que os aliases emitem Deprecation header
  app.use("/api/social", requireAuth, socialRoutes);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  const ownerToken = jwt.sign(
    { userId: "u-owner", email: "owner@test.local", role: "owner", organizationId: ORG_ID },
    process.env.JWT_SECRET!,
  );
  const viewerToken = jwt.sign(
    { userId: "u-viewer", email: "viewer@test.local", role: "viewer", organizationId: ORG_ID },
    process.env.JWT_SECRET!,
  );

  async function req(method: string, path: string, opts: { token?: string; body?: any } = {}) {
    return new Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      const bodyStr = opts.body != null ? JSON.stringify(opts.body) : undefined;
      if (bodyStr) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(bodyStr)); }
      const r = http.request({ port, path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: any = null; try { body = JSON.parse(raw); } catch { body = raw; }
          resolve({ status: res.statusCode || 0, body, headers: res.headers });
        });
      });
      r.on("error", reject);
      if (bodyStr) r.write(bodyStr);
      r.end();
    });
  }

  // ═══════════════ 1. Auth gate ═══════════════
  const noAuth = await req("GET", "/api/growth/autopilot");
  check("1.1 GET /autopilot sem token → 401", noAuth.status === 401);

  const viewerAuth = await req("GET", "/api/growth/autopilot", { token: viewerToken });
  check("1.2 GET /autopilot com role viewer → 403 (requireRole owner/admin)",
    viewerAuth.status === 403);

  // ═══════════════ 2. GET /autopilot ═══════════════
  const autopilot = await req("GET", "/api/growth/autopilot", { token: ownerToken });
  check("2.1 GET /autopilot → 200", autopilot.status === 200);
  check("2.2 GET /autopilot → payload é objeto",
    autopilot.body && typeof autopilot.body === "object");

  // ═══════════════ 3. POST /autopilot/mode ═══════════════
  const setMode = await req("POST", "/api/growth/autopilot/mode",
    { token: ownerToken, body: { mode: "shadow" } });
  check("3.1 POST /autopilot/mode {mode:shadow} → 200",
    setMode.status === 200);

  const badMode = await req("POST", "/api/growth/autopilot/mode",
    { token: ownerToken, body: { mode: "auto" } });
  check("3.2 POST /autopilot/mode {mode:auto} → 400 (RN-CG-10 shadow-first)",
    badMode.status === 400);

  const missingMode = await req("POST", "/api/growth/autopilot/mode",
    { token: ownerToken, body: {} });
  check("3.3 POST /autopilot/mode sem mode → 400",
    missingMode.status === 400);

  // ═══════════════ 4. GET /optimizations ═══════════════
  const optList = await req("GET", "/api/growth/optimizations", { token: ownerToken });
  check("4.1 GET /optimizations → 200", optList.status === 200);
  check("4.2 GET /optimizations → payload é objeto ou array",
    optList.body && (typeof optList.body === "object" || Array.isArray(optList.body)));

  // ═══════════════ 5. POST /optimizations/propose (falha esperada) ═══════════════
  // Sem kind válido, service rejeita — validamos que o handler propaga o 400.
  const badPropose = await req("POST", "/api/growth/optimizations/propose",
    { token: ownerToken, body: { kind: "", ref: "" } });
  check("5.1 POST /optimizations/propose sem kind → 400",
    badPropose.status === 400);

  // ═══════════════ 6. GET /brief ═══════════════
  const brief = await req("GET", "/api/growth/brief", { token: ownerToken });
  check("6.1 GET /brief → 200", brief.status === 200);
  check("6.2 GET /brief → payload é objeto",
    brief.body && typeof brief.body === "object");

  // ═══════════════ 7. GET /attribution/leads (400 sem correlationId) ═══════════════
  const leadsNoCid = await req("GET", "/api/growth/attribution/leads", { token: ownerToken });
  check("7.1 GET /attribution/leads sem correlationId → 400",
    leadsNoCid.status === 400 && leadsNoCid.body?.error?.includes("correlationId"));

  const leadsCid = await req("GET", "/api/growth/attribution/leads?correlationId=abc",
    { token: ownerToken });
  check("7.2 GET /attribution/leads?correlationId=abc → 200",
    leadsCid.status === 200);
  check("7.3 GET /attribution/leads → payload {correlationId, leadCount, leads}",
    leadsCid.body?.correlationId === "abc" &&
    typeof leadsCid.body?.leadCount === "number" &&
    Array.isArray(leadsCid.body?.leads));

  // ═══════════════ 8. GET /attribution/revenue (400 sem correlationId) ═══════════════
  const revNoCid = await req("GET", "/api/growth/attribution/revenue", { token: ownerToken });
  check("8.1 GET /attribution/revenue sem correlationId → 400",
    revNoCid.status === 400 && revNoCid.body?.error?.includes("correlationId"));

  const revCid = await req("GET", "/api/growth/attribution/revenue?correlationId=abc",
    { token: ownerToken });
  check("8.2 GET /attribution/revenue?correlationId=abc → 200",
    revCid.status === 200);
  check("8.3 GET /attribution/revenue → payload é objeto",
    revCid.body && typeof revCid.body === "object");

  // ═══════════════ 9. POST /attribution/lead + revenue ═══════════════
  const leadPost = await req("POST", "/api/growth/attribution/lead",
    { token: ownerToken, body: { correlationId: "cid-xyz", contactId: "c-1" } });
  check("9.1 POST /attribution/lead → 200 (mesmo sem contato real; service resolve)",
    leadPost.status === 200 || leadPost.status === 400);

  const revPost = await req("POST", "/api/growth/attribution/revenue",
    { token: ownerToken, body: { correlationId: "cid-xyz" } });
  check("9.2 POST /attribution/revenue → 200",
    revPost.status === 200);

  const revPostMissing = await req("POST", "/api/growth/attribution/revenue",
    { token: ownerToken, body: {} });
  check("9.3 POST /attribution/revenue sem correlationId → 400",
    revPostMissing.status === 400);

  // ═══════════════ 10. Rota inexistente ═══════════════
  const bogus = await req("GET", "/api/growth/does-not-exist", { token: ownerToken });
  check("10.1 GET /does-not-exist → 404",
    bogus.status === 404);

  // ═══════════════ 11. Deprecation headers no legado /api/social/* ═══════════════
  // Endpoints movidos pra /api/growth/* devem emitir header RFC 9745 no legado.
  const legacyAutopilot = await req("GET", "/api/social/growth-autopilot", { token: ownerToken });
  check("11.1 /api/social/growth-autopilot emite Deprecation: true",
    legacyAutopilot.headers.deprecation === "true");
  check("11.2 /api/social/growth-autopilot emite Link successor-version",
    typeof legacyAutopilot.headers.link === "string" &&
    (legacyAutopilot.headers.link as string).includes("/api/growth/autopilot") &&
    (legacyAutopilot.headers.link as string).includes('rel="successor-version"'));

  const legacyBrief = await req("GET", "/api/social/growth-brief", { token: ownerToken });
  check("11.3 /api/social/growth-brief emite Deprecation",
    legacyBrief.headers.deprecation === "true" &&
    (legacyBrief.headers.link as string || "").includes("/api/growth/brief"));

  const legacyLeads = await req("GET", "/api/social/attribution/leads?correlationId=abc",
    { token: ownerToken });
  check("11.4 /api/social/attribution/leads emite Deprecation",
    legacyLeads.headers.deprecation === "true" &&
    (legacyLeads.headers.link as string || "").includes("/api/growth/attribution/leads"));

  const legacyOptList = await req("GET", "/api/social/growth-optimizations", { token: ownerToken });
  check("11.5 /api/social/growth-optimizations emite Deprecation",
    legacyOptList.headers.deprecation === "true");

  // A rota nova NÃO deve emitir Deprecation (contra-prova)
  const newAutopilot = await req("GET", "/api/growth/autopilot", { token: ownerToken });
  check("11.6 /api/growth/autopilot NÃO emite Deprecation (é a atual)",
    !newAutopilot.headers.deprecation);

  // Endpoint social NÃO-deprecated (ex.: /connections) segue sem header
  const socialConnections = await req("GET", "/api/social/connections", { token: ownerToken });
  check("11.7 /api/social/connections NÃO emite Deprecation (endpoint social-native)",
    !socialConnections.headers.deprecation);

  server.close();

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
