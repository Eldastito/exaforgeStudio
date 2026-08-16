/**
 * TESTE — FIN: conexão de Cobrança Sicredi (PRD Moda/TOULON; ADR-177)
 * ------------------------------------------------------------------
 * Prova, offline (SicrediCobrancaService), o SCAFFOLD HONESTO:
 *   - default: not_configured, desligado, capacidades INDISPONÍVEIS;
 *   - configure grava credencial cifrada, vai a awaiting_homologation (opt-in),
 *     NUNCA 'connected' (RN-177-002);
 *   - status é REDIGIDO: nunca vaza segredo (só hasCredentials + campos públicos);
 *   - config_enc no banco NÃO contém o segredo em claro;
 *   - enabled=false → estado 'disabled' (configurado, porém desligado);
 *   - issueCharge LANÇA (não emite dinheiro — RN-177-004);
 *   - disconnect limpa (reversível);
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:sicredi-cobranca
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sicredi-cobranca-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-sicredi-cobranca-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SicrediCobrancaService } = await import("../src/server/SicrediCobrancaService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;

  // ===== 1. default honesto =====
  const s0 = SicrediCobrancaService.status(A);
  check("default: not_configured + desligado", s0.state === "not_configured" && s0.enabled === false && s0.configured === false);
  check("default: capacidades TODAS indisponíveis", s0.capabilities.length === 4 && s0.capabilities.every((c: any) => c.available === false && c.reason === "awaiting_homologation"));
  check("default: sem credencial", s0.hasCredentials === false);

  // ===== 2. configure → awaiting_homologation (opt-in), nunca connected =====
  const s1 = SicrediCobrancaService.configure(A, {
    cooperativa: "0101", posto: "05", conta: "12345-6", beneficiarioNome: "TOULON MODAS LTDA", environment: "homolog",
    clientId: "cli_abc", clientSecret: "SECRETO-super-sigiloso-123", certPem: "-----BEGIN CERT-----xyz",
  }, { enabled: true }, "user1");
  check("configure: estado awaiting_homologation (nunca connected)", s1.state === "awaiting_homologation");
  check("configure: opt-in ligado + configurado", s1.enabled === true && s1.configured === true && s1.hasCredentials === true);
  check("configure: capacidades seguem indisponíveis (não homologado)", s1.capabilities.every((c: any) => c.available === false));
  check("configure: campos públicos aparecem (cooperativa/conta)", s1.account.cooperativa === "0101" && s1.account.conta === "12345-6");

  // ===== 3. status REDIGIDO + segredo cifrado no banco =====
  const statusStr = JSON.stringify(SicrediCobrancaService.status(A));
  check("status não vaza clientSecret", !statusStr.includes("SECRETO-super-sigiloso-123"));
  check("status não vaza certPem", !statusStr.includes("BEGIN CERT"));
  const rawEnc = (db.prepare(`SELECT config_enc FROM sicredi_cobranca_connections WHERE organization_id = ?`).get(A) as any)?.config_enc || "";
  check("config_enc não contém o segredo em claro", !String(rawEnc).includes("SECRETO-super-sigiloso-123") && rawEnc.length > 0);

  // ===== 4. desligar (enabled=false) → disabled, mas mantém credencial =====
  const s2 = SicrediCobrancaService.configure(A, {}, { enabled: false }, "user1");
  check("enabled=false → estado disabled (credencial mantida)", s2.state === "disabled" && s2.hasCredentials === true);

  // ===== 5. issueCharge LANÇA (não emite dinheiro) =====
  let threw = "";
  try { await SicrediCobrancaService.issueCharge(A, { kind: "pix", amount: 100, dueDate: "2026-09-01" }); }
  catch (e: any) { threw = e.message; }
  check("issueCharge lança awaiting_homologation", threw === "sicredi_awaiting_homologation", `msg=${threw}`);

  // ===== 6. disconnect limpa =====
  const s3 = SicrediCobrancaService.disconnect(A, "user1");
  check("disconnect: volta a not_configured + sem credencial", s3.state === "not_configured" && s3.hasCredentials === false && s3.configured === false);
  let threwCfg = "";
  try { await SicrediCobrancaService.issueCharge(A, {}); } catch (e: any) { threwCfg = e.message; }
  check("issueCharge sem config lança not_configured", threwCfg === "sicredi_not_configured");

  // ===== 7. isolamento =====
  SicrediCobrancaService.configure(B, { cooperativa: "0202", clientId: "x", clientSecret: "yB" }, { enabled: true }, "userB");
  check("org A não enxerga a conexão de B", SicrediCobrancaService.status(A).configured === false);
  check("org B configurada isolada", SicrediCobrancaService.status(B).account.cooperativa === "0202");

  console.log("\n=== TEST: FIN — Cobrança Sicredi (scaffold honesto, ADR-177) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
