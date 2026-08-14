/**
 * TEST — Security program hardening / production readiness (SEC-F18). DB-backed, determinístico.
 *
 * Doc-of-record executável de dupla função:
 *  (A) CODIFICA os guardrails SEC-01..06 como REGRESSÃO tocando os serviços REAIS das fatias F1–F11.
 *  (B) verifica a FIAÇÃO de produção — serviços importáveis, headers/tenant wired no server, testes
 *      de regressão wired no package.json, runbook + baseline + workflow de CI presentes.
 *
 * Uso: npm run test:security-program-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const ROOT = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sec-prog-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-sec-prog-1";
process.env.MASTER_ADMIN_EMAIL = "master@prog.test";
delete process.env.WEBHOOK_SECRET; delete process.env.WEBHOOK_STRICT; delete process.env.CSP_ENFORCE;

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const crypto = (await import("crypto")).default;
  const { EncryptionService: ENC, EncryptionUnavailableError } = await import("../src/server/EncryptionService.js");
  const { SecurityConfigurationService: SC } = await import("../src/server/SecurityConfigurationService.js");
  const { resolveTokenOrg, isPlatformMaster } = await import("../src/server/middleware/auth.js");
  const whk = await import("../src/server/webhookSecurity.js");
  const { validateImageBase64 } = await import("../src/server/mediaValidation.js");
  const { buildSecurityHeaders } = await import("../src/server/securityHeaders.js");
  const jwt = (await import("jsonwebtoken")).default;

  // ═══ SEC-01 — cifra fail-closed (nunca plaintext) ═══
  const enc = ENC.encrypt("segredo-x")!;
  check("SEC-01 encrypt nunca devolve plaintext", enc !== "segredo-x" && ENC.isEncrypted(enc));
  const realCipher = crypto.createCipheriv;
  (crypto as any).createCipheriv = () => { throw new Error("boom"); };
  let threw = false; try { ENC.encrypt("outro"); } catch (e) { threw = e instanceof EncryptionUnavailableError; }
  (crypto as any).createCipheriv = realCipher;
  check("SEC-01 falha de cifra → LANÇA (fail-closed)", threw);

  // ═══ SEC-04 — validação de segredos no boot ═══
  check("SEC-04 sem segredo nenhum → crítico (chave hardcoded)", SC.validateBoot({ NODE_ENV: "production" }).hasCritical === true);
  check("SEC-04 chaves distintas e longas → ok", SC.validateBoot({ NODE_ENV: "production", ENCRYPTION_KEY: "a".repeat(64), JWT_SECRET: "b".repeat(64) }).ok === true);

  // ═══ SEC-02 — tenant só do token verificado ═══
  const tok = jwt.sign({ userId: "u", organizationId: "orgA", email: "x@y.com" }, process.env.JWT_SECRET!);
  check("SEC-02 tenant vem do token, header forjado ignorado", resolveTokenOrg({ headers: { authorization: `Bearer ${tok}`, "x-organization-id": "orgB" } } as any) === "orgA");
  check("SEC-02 só header (sem token) → null", resolveTokenOrg({ headers: { "x-organization-id": "orgB" } } as any) === null);

  // ═══ SEC-03 — master é autoridade do DB, não do claim ═══
  const masterId = randomUUID(); const regId = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, email, role) VALUES (?, 'default_org', 'master@prog.test', 'owner')`).run(masterId);
  db.prepare(`INSERT INTO users (id, organization_id, email, role) VALUES (?, 'default_org', 'reg@loja.com', 'owner')`).run(regId);
  check("SEC-03 master real (validado no DB) → true", isPlatformMaster({ user: { userId: masterId, email: "master@prog.test" } } as any) === true);
  check("SEC-03 claim forjado (email master, userId comum) → false", isPlatformMaster({ user: { userId: regId, email: "master@prog.test" } } as any) === false);

  // ═══ SEC-05 — webhook: strict switch + anti-replay ═══
  process.env.WEBHOOK_STRICT = "1";
  check("SEC-05 WEBHOOK_STRICT=1 → exige", whk.isWebhookEnforced() === true);
  delete process.env.WEBHOOK_STRICT;
  const evt = `e_${randomUUID().slice(0, 8)}`;
  check("SEC-05 replay: 1ª vez processa", whk.claimWebhookEvent("evolution", evt) === true);
  check("SEC-05 replay: repetição ignora", whk.claimWebhookEvent("evolution", evt) === false);

  // ═══ SEC-06 (A9) — upload valida conteúdo ═══
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString("base64");
  check("SEC-06 imagem real → aceita (ext derivada)", validateImageBase64(PNG)?.ext === "png");
  check("SEC-06 script/HTML → rejeitado", validateImageBase64(Buffer.from("<script>x</script>").toString("base64")) === null);

  // ═══ Headers — CSP report-only + Permissions-Policy ═══
  const h = buildSecurityHeaders({});
  check("Headers CSP report-only por padrão", !!h["Content-Security-Policy-Report-Only"] && !h["Content-Security-Policy"]);
  check("Headers Permissions-Policy presente", typeof h["Permissions-Policy"] === "string");

  // ═══════════════ FIAÇÃO DE PRODUÇÃO ═══════════════
  const SERVICES = [
    "EncryptionService", "SecurityConfigurationService", "webhookSecurity", "mediaValidation",
    "securityHeaders", "middleware/auth",
  ];
  for (const s of SERVICES) {
    let ok = false; try { const m = await import(`../src/server/${s}.js`); ok = !!m && Object.keys(m).length > 0; } catch { ok = false; }
    check(`serviço importável: ${s}`, ok);
  }
  const server = read("server.ts");
  check("server: headers centralizados (buildSecurityHeaders)", /buildSecurityHeaders\(\)/.test(server));
  check("server: boot valida segredos (enforceBoot)", /SecurityConfigurationService\.enforceBoot\(\)/.test(server));
  check("server: tenant do token no middleware financeiro (resolveTokenOrg)", /resolveTokenOrg\(req\)/.test(server));
  check("server: anti-replay wired (claimWebhookEvent)", /claimWebhookEvent\("evolution"/.test(server));

  const pkg = JSON.parse(read("package.json"));
  const TESTS = ["security-encryption", "security-config", "security-master", "security-tenant", "security-webhook", "security-media-upload", "security-headers"];
  for (const t of TESTS) check(`test wired: test:${t}`, typeof pkg.scripts[`test:${t}`] === "string");

  check("baseline presente", fs.existsSync(path.join(ROOT, "docs/security/SECURITY-BASELINE.md")));
  check("threat model presente", fs.existsSync(path.join(ROOT, "docs/security/THREAT-MODEL.md")));
  check("runbook de segurança presente", fs.existsSync(path.join(ROOT, "docs/runbook/security-operacao.md")));
  check("workflow security-review presente", fs.existsSync(path.join(ROOT, ".github/workflows/security-review.yml")));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} security-program-hardening: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
