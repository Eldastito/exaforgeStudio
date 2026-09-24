/**
 * TESTE — Trilha forense de login: IP + user-agent no auth_audit_logs.
 * ----------------------------------------------------------------------------
 * Antes, logAuthEvent só guardava email + timestamp. Uma investigação de
 * "login suspeito" não conseguia recuperar a ORIGEM. Esta mudança é aditiva:
 *   - colunas source_ip/user_agent existem em auth_audit_logs;
 *   - com contexto, o evento grava IP + UA (UA truncado, IP truncado);
 *   - SEM contexto (callers legados), grava null e NÃO quebra — 0-regressão.
 *
 * Uso:  npm run test:auth-audit-context
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-auth-audit-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-auth-audit-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { logAuthEvent } = await import("../src/server/auditLog.js");

  // ── 0. As colunas existem (migração aditiva rodou) ──
  const cols = (db.prepare(`PRAGMA table_info(auth_audit_logs)`).all() as any[]).map((c) => c.name);
  check("0.1 coluna source_ip existe", cols.includes("source_ip"), cols.join(","));
  check("0.2 coluna user_agent existe", cols.includes("user_agent"), cols.join(","));

  const lastFor = (event: string) =>
    db.prepare(`SELECT source_ip, user_agent, metadata_json FROM auth_audit_logs WHERE event_type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(event) as any;

  // ── 1. COM contexto: grava IP + UA ──
  logAuthEvent(null, null, null, "TEST_LOGIN_CTX", { email: "a@b.com" }, { ip: "203.0.113.9", userAgent: "Mozilla/5.0 (Teste)" });
  const withCtx = lastFor("TEST_LOGIN_CTX");
  check("1.1 grava o IP de origem", withCtx?.source_ip === "203.0.113.9", JSON.stringify(withCtx));
  check("1.2 grava o user-agent", withCtx?.user_agent === "Mozilla/5.0 (Teste)", JSON.stringify(withCtx));
  check("1.3 metadata segue intacto", JSON.parse(withCtx?.metadata_json || "{}").email === "a@b.com");

  // ── 2. SEM contexto (caller legado): null, sem quebrar ──
  logAuthEvent("org1", "u1", "u1", "TEST_LEGACY_NOCTX", { email: "c@d.com" });
  const noCtx = lastFor("TEST_LEGACY_NOCTX");
  check("2.1 caller legado ainda insere a linha", !!noCtx, JSON.stringify(noCtx));
  check("2.2 source_ip null sem contexto", noCtx?.source_ip === null, JSON.stringify(noCtx));
  check("2.3 user_agent null sem contexto", noCtx?.user_agent === null, JSON.stringify(noCtx));

  // ── 3. Truncamento (UA atacante-controlado não infla a linha) ──
  const hugeUa = "U".repeat(1000);
  const longIp = "1".repeat(300);
  logAuthEvent(null, null, null, "TEST_TRUNC", {}, { ip: longIp, userAgent: hugeUa });
  const trunc = lastFor("TEST_TRUNC");
  check("3.1 user_agent truncado em 400", trunc?.user_agent?.length === 400, `len=${trunc?.user_agent?.length}`);
  check("3.2 source_ip truncado em 100", trunc?.source_ip?.length === 100, `len=${trunc?.source_ip?.length}`);

  // ── 4. ctx vazio/parcial não vira string "undefined" ──
  logAuthEvent(null, null, null, "TEST_PARTIAL", {}, { ip: "198.51.100.1" });
  const partial = lastFor("TEST_PARTIAL");
  check("4.1 só IP: UA fica null (não 'undefined')", partial?.source_ip === "198.51.100.1" && partial?.user_agent === null, JSON.stringify(partial));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} auth-audit-context: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
