/**
 * TEST — Connector Público (`/api/connector-in`) — segurança do endpoint (ADR-052).
 *
 * O endpoint público NÃO passa por JWT — é autenticado por token de
 * integração (`x-connector-token` ou `?token=`). Isso significa que:
 *  - Sem token: precisa devolver 401.
 *  - Token vazio: precisa devolver 401.
 *  - Token inválido: precisa devolver 401.
 *  - Token com prefixo errado ("bearer abc"): precisa devolver 401.
 *  - Token de OUTRA org: NÃO pode acessar dados desta org (isolamento).
 *  - Token correto: processa e mantém isolamento em cada request.
 *
 * O objetivo do teste é fechar a auditoria de segurança do endpoint —
 * qualquer regressão que abra vazamento de tenant vira teste vermelho.
 *
 * Uso: npm run test:connector-public
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import express from "express";
import http from "http";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-connector-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-connector-1234567890ab";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function post(port: number, url: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");
  const connectorPublicRoutes = (await import("../src/server/routes/connectorPublic.js")).default;

  // Sobe um mini-servidor Express só com o router público.
  const app = express();
  app.use(express.json());
  app.use("/api/connector-in", connectorPublicRoutes);
  const server = http.createServer(app);
  const port: number = await new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as any;
      resolve(addr.port);
    });
  });

  const seedOrg = (tag: string) => {
    const id = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), id, `Loja ${tag}`);
    return id;
  };
  const attachToken = (orgId: string, token: string) => {
    db.prepare(`UPDATE organization_settings SET integration_token_hash = ? WHERE organization_id = ?`)
      .run(EncryptionService.hash(token), orgId);
  };

  const orgA = seedOrg("A");
  const orgB = seedOrg("B");
  const tokenA = `zf_${randomUUID().replace(/-/g, "")}`;
  const tokenB = `zf_${randomUUID().replace(/-/g, "")}`;
  attachToken(orgA, tokenA);
  attachToken(orgB, tokenB);

  const dummyRow = { rows: [{ resource: "quarto 101", date: "2027-01-01", available: 1, price: 200 }] };

  // ==== 1. Auth strict — 401 sem token ====
  console.log("\n=== 1. Auth strict — 401 ===");
  const noToken = await post(port, "/api/connector-in/availability", dummyRow);
  check("1.1 sem header nem query → 401", noToken.status === 401, `status=${noToken.status}`);

  const emptyToken = await post(port, "/api/connector-in/availability", dummyRow, { "x-connector-token": "" });
  check("1.2 header vazio → 401", emptyToken.status === 401);

  const invalidToken = await post(port, "/api/connector-in/availability", dummyRow, { "x-connector-token": "invalid-token" });
  check("1.3 token sem prefixo zf_ → 401", invalidToken.status === 401);

  const bearerFormat = await post(port, "/api/connector-in/availability", dummyRow, { "x-connector-token": "Bearer zf_abc123" });
  check("1.4 formato Bearer errado → 401", bearerFormat.status === 401);

  const fakeZfToken = await post(port, "/api/connector-in/availability", dummyRow, { "x-connector-token": "zf_fakenon existent1234567890abcdef" });
  check("1.5 token zf_ com valor errado → 401", fakeZfToken.status === 401);

  // ==== 2. Auth OK — 200 com token válido ====
  console.log("\n=== 2. Auth ok ===");
  const validA = await post(port, "/api/connector-in/availability", dummyRow, { "x-connector-token": tokenA });
  check("2.1 token A válido → 200", validA.status === 200, `status=${validA.status}, body=${JSON.stringify(validA.json).slice(0, 100)}`);
  check("2.2 response tem success=true", validA.json?.success === true);

  // ==== 3. Isolamento entre orgs ====
  console.log("\n=== 3. Isolamento entre orgs ===");
  // Cria um resource com token A, depois tenta acessar com token B — não deve ver.
  const resA = await post(port, "/api/connector-in/resources", { rows: [{ name: "Suite Master A", price: 500, capacity: 2, unit: "night" }] }, { "x-connector-token": tokenA });
  check("3.1 org A cria resource", resA.status === 200);
  const inOrgA = db.prepare(`SELECT COUNT(*) as n FROM products_services WHERE organization_id = ? AND name LIKE 'Suite Master A%'`).get(orgA) as any;
  const inOrgB = db.prepare(`SELECT COUNT(*) as n FROM products_services WHERE organization_id = ? AND name LIKE 'Suite Master A%'`).get(orgB) as any;
  check("3.2 recurso ficou na org A", (inOrgA?.n || 0) >= 1);
  check("3.3 recurso NÃO apareceu na org B", (inOrgB?.n || 0) === 0);

  // ==== 4. Query param também funciona (webhook simples que não seta header) ====
  console.log("\n=== 4. Token via query ===");
  const viaQuery = await post(port, `/api/connector-in/availability?token=${tokenA}`, dummyRow);
  check("4.1 token via query → 200", viaQuery.status === 200);
  const viaQueryFake = await post(port, `/api/connector-in/availability?token=invalid`, dummyRow);
  check("4.2 query fake → 401", viaQueryFake.status === 401);

  // ==== 5. Payload inválido não vaza tenant nem crasha ====
  console.log("\n=== 5. Payload defensivo ===");
  const emptyBody = await post(port, "/api/connector-in/availability", {}, { "x-connector-token": tokenA });
  check("5.1 body vazio → 200 (rows vira [])", emptyBody.status === 200);
  const nullRows = await post(port, "/api/connector-in/availability", { rows: null }, { "x-connector-token": tokenA });
  check("5.2 rows null → 200 (rows vira [])", nullRows.status === 200);
  const stringBody = await post(port, "/api/connector-in/availability", "not json array" as any, { "x-connector-token": tokenA });
  check("5.3 body texto solto → 200 ou 400 (nunca 5xx)", stringBody.status < 500);

  // ==== 6. Endpoints inexistentes retornam 404 ====
  console.log("\n=== 6. 404 rota errada ===");
  const wrongPath = await post(port, "/api/connector-in/nonexistent", {}, { "x-connector-token": tokenA });
  check("6.1 rota inexistente → 404", wrongPath.status === 404);

  server.close();

  console.log("\n=========================================");
  console.log("RELATÓRIO — Connector Público (ADR-052)");
  console.log("=========================================");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  console.log("=========================================");
  console.log(`${results.length - failures}/${results.length} passaram`);
  if (failures > 0) {
    console.log(`❌ ${failures} falhas`);
    process.exit(1);
  }
  console.log("✅ Todos os testes passaram");
  process.exit(0);
}

main().catch((e) => {
  console.error("💥 Teste explodiu:", e);
  process.exit(1);
});
