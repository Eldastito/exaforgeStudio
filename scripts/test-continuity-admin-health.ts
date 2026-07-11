/**
 * TESTE — Saúde cross-tenant da Continuity Layer (ADR-082, rollout)
 * ----------------------------------------------------------------
 * GET /api/admin/continuity/health (master-admin). Prova, offline:
 *   - master-admin recebe 200 com o agregado global (flags, fila, eventos, edge);
 *   - não-master-admin recebe 403;
 *   - os números agregam TODAS as organizações (cross-tenant).
 *
 * Uso:  npm run test:continuity-admin-health
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import http from "http";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-adminhealth-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-adminhealth-1234567890";
process.env.MASTER_ADMIN_EMAIL = "boss@zappflow.test";
process.env.CONTINUITY_EVENTS_ENABLED = "true";
process.env.CONTINUITY_DELIVERY_QUEUE_ENABLED = "true";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const express = (await import("express")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { default: db } = await import("../src/server/db.js");
  const { requireAuth, requireMasterAdmin } = await import("../src/server/middleware/auth.js");
  const adminRoutes = (await import("../src/server/routes/admin.js")).default;

  // Dados de DUAS orgs para provar a agregação cross-tenant.
  const A = `org_${randomUUID().slice(0, 6)}`, B = `org_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const mkDeliv = (org: string, status: string) => db.prepare(
    `INSERT INTO message_deliveries (id, organization_id, message_id, channel_id, recipient, content, status) VALUES (?, ?, ?, 'c', 'r', 'x', ?)`
  ).run(randomUUID(), org, randomUUID(), status);
  mkDeliv(A, "queued"); mkDeliv(A, "sent"); mkDeliv(B, "delivered"); mkDeliv(B, "failed");

  const app = express(); app.use(express.json());
  const p = express.Router(); p.use(requireAuth);
  p.use("/admin", requireMasterAdmin, adminRoutes);
  app.use("/api", (req, res, next) => (p as any)(req, res, next));
  const server = app.listen(0); await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;

  const call = (tokenEmail: string): Promise<{ status: number; json: any }> => {
    const tok = jwt.sign({ userId: "u", organizationId: A, role: "owner", email: tokenEmail }, process.env.JWT_SECRET!);
    return new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "/api/admin/continuity/health", headers: { Authorization: `Bearer ${tok}` } }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j: any = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode || 0, json: j }); });
      });
    });
  };

  // ---- 1. Não-master-admin → 403 ----
  const forbidden = await call("qualquer@user.com");
  check("Não-master-admin → 403", forbidden.status === 403);

  // ---- 2. Master-admin → 200 + agregado cross-tenant ----
  const ok = await call("boss@zappflow.test");
  check("Master-admin → 200", ok.status === 200);
  check("Flags refletem o ambiente", ok.json?.flags?.events === true && ok.json?.flags?.deliveryQueue === true && ok.json?.flags?.edgeSync === false, JSON.stringify(ok.json?.flags));
  const d = ok.json?.delivery;
  check("Fila agrega as DUAS orgs (queued/sent/delivered/failed = 1 cada)", d?.queued === 1 && d?.sent === 1 && d?.delivered === 1 && d?.failed === 1, JSON.stringify(d));
  check("Traz sinais de rollout (oldestQueuedAt + stuckQueued)", "oldestQueuedAt" in (d || {}) && typeof d?.stuckQueued === "number");
  check("Traz seções events e edge", typeof ok.json?.events?.total === "number" && typeof ok.json?.edge?.devices === "number");

  server.close();
  console.log("\n=== Saúde cross-tenant da Continuity Layer (ADR-082) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
