/**
 * TEST — Master Admin Users Panel (ADR-090).
 *
 * Cobertura das 3 rotas do gerenciador de usuários do master admin:
 *   GET    /api/admin/users              — lista com busca, paginação, join org
 *   POST   /api/admin/users/:id/reset-password  — troca password_hash (bcrypt)
 *   DELETE /api/admin/users/:id          — soft delete (global_status='deleted')
 *
 * Regras invioláveis testadas:
 *   - Master admin NÃO pode ter senha resetada por esta rota (400)
 *   - Master admin NÃO pode ser removido (400)
 *   - Senha < 8 chars → 400
 *   - Usuário inexistente → 404
 *   - Login com senha nova funciona; login com senha antiga falha
 *
 * Uso: npm run test:admin-users
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import express from "express";
import http from "http";
import bcrypt from "bcrypt";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-admin-users-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-admin-users-1234567890ab";
process.env.MASTER_ADMIN_EMAIL = "master@zappflow.test";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function req(port: number, method: string, url: string, body?: any): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const adminRoutes = (await import("../src/server/routes/admin.js")).default;

  // Mini-servidor sem requireMasterAdmin (validado em outro lugar — aqui foco
  // é a lógica das rotas em si)
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: "master-uid", email: "master@zappflow.test", role: "owner" };
    next();
  });
  app.use("/api/admin", adminRoutes);
  const server = http.createServer(app);
  const port: number = await new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as any).port));
  });

  // Setup: master admin + 2 usuários normais em 2 orgs
  const orgA = `org_A_${randomUUID().slice(0, 6)}`;
  const orgB = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgA, "TOULON");
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgB, "Outra Loja");

  const oldHashAlice = await bcrypt.hash("senha-antiga-alice", 10);
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const masterId = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(aliceId, orgA, "Alice Silva", "alice@toulon.com", oldHashAlice, "owner");
  db.prepare(`INSERT INTO users (id, organization_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(bobId, orgB, "Bob", "bob@outra.com", await bcrypt.hash("bob-pw", 10), "agent");
  db.prepare(`INSERT INTO users (id, organization_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(masterId, orgA, "Master Admin", "master@zappflow.test", await bcrypt.hash("master-pw", 10), "owner");

  // ==== 1. Lista sem filtro ====
  console.log("\n=== 1. GET /admin/users ===");
  const all = await req(port, "GET", "/api/admin/users");
  check("1.1 200 OK", all.status === 200);
  check("1.2 total = 3 usuários", all.json.total === 3);
  check("1.3 users array com 3 registros", Array.isArray(all.json.users) && all.json.users.length === 3);
  check("1.4 join com org_name (TOULON aparece)", all.json.users.some((u: any) => u.org_name === "TOULON"));

  // ==== 2. Busca ====
  console.log("\n=== 2. Busca ===");
  const search = await req(port, "GET", "/api/admin/users?q=toulon");
  const emails = search.json.users.map((u: any) => u.email);
  check("2.1 filtro 'toulon' inclui Alice (email match) + master (org match)",
    emails.includes("alice@toulon.com") && emails.includes("master@zappflow.test") && !emails.includes("bob@outra.com"));
  const searchEmail = await req(port, "GET", "/api/admin/users?q=bob@");
  check("2.2 filtro por email parcial funciona", searchEmail.json.users.length === 1 && searchEmail.json.users[0].email === "bob@outra.com");
  const noHit = await req(port, "GET", "/api/admin/users?q=xxx-nao-existe");
  check("2.3 busca sem resultado retorna array vazio + total=0", noHit.json.users.length === 0 && noHit.json.total === 0);

  // ==== 3. Reset password ====
  console.log("\n=== 3. Reset password ===");
  const rst = await req(port, "POST", `/api/admin/users/${aliceId}/reset-password`, { password: "NovaSenha2026!" });
  check("3.1 200 ok", rst.status === 200 && rst.json.ok === true);

  // Confere que password_hash mudou e valida com bcrypt
  const aliceAfter = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(aliceId) as any;
  check("3.2 password_hash mudou", aliceAfter.password_hash !== oldHashAlice);
  const bcryptMatch = await bcrypt.compare("NovaSenha2026!", aliceAfter.password_hash);
  check("3.3 bcrypt.compare aceita a NOVA senha", bcryptMatch === true);
  const bcryptOld = await bcrypt.compare("senha-antiga-alice", aliceAfter.password_hash);
  check("3.4 bcrypt.compare NÃO aceita a senha antiga", bcryptOld === false);

  // ==== 4. Guards ====
  console.log("\n=== 4. Guards ===");
  const short = await req(port, "POST", `/api/admin/users/${aliceId}/reset-password`, { password: "curta" });
  check("4.1 senha < 8 chars → 400", short.status === 400 && short.json.error === "senha_muito_curta");

  const nope = await req(port, "POST", `/api/admin/users/nao-existe/reset-password`, { password: "TesteValida123" });
  check("4.2 user inexistente → 404", nope.status === 404 && nope.json.error === "user_not_found");

  const master = await req(port, "POST", `/api/admin/users/${masterId}/reset-password`, { password: "TesteValida123" });
  check("4.3 master admin NÃO pode ser resetado por aqui → 400", master.status === 400 && master.json.error === "cannot_reset_master_admin_here");

  // ==== 5. Soft delete ====
  console.log("\n=== 5. Soft delete ===");
  const del = await req(port, "DELETE", `/api/admin/users/${bobId}`);
  check("5.1 delete 200 ok", del.status === 200 && del.json.ok === true);
  const bobAfter = db.prepare(`SELECT global_status, password_hash, email FROM users WHERE id = ?`).get(bobId) as any;
  check("5.2 global_status = 'deleted'", bobAfter.global_status === "deleted");
  check("5.3 password_hash preservado (histórico intacto)", !!bobAfter.password_hash);
  check("5.4 email preservado (histórico intacto)", bobAfter.email === "bob@outra.com");

  const delNope = await req(port, "DELETE", `/api/admin/users/nao-existe`);
  check("5.5 delete de user inexistente → 404", delNope.status === 404);

  const delMaster = await req(port, "DELETE", `/api/admin/users/${masterId}`);
  check("5.6 master admin NÃO pode ser removido → 400", delMaster.status === 400 && delMaster.json.error === "cannot_delete_master_admin");

  server.close();

  console.log("\n=========================================");
  console.log("RELATÓRIO — Admin Users (ADR-090)");
  console.log("=========================================");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  console.log("=========================================");
  console.log(`${results.length - failures}/${results.length} passaram`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.log(`❌ ${failures} falhas`); process.exit(1); }
  console.log("✅ Todos os testes passaram");
  process.exit(0);
}

main().catch((e) => {
  console.error("💥 Teste explodiu:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
