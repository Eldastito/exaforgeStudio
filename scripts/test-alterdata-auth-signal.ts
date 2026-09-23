/**
 * TESTE — Falha de autenticação da Alterdata VISÍVEL (caso Toulon 23/09/26).
 * ----------------------------------------------------------------------------
 * A senha da retaguarda foi trocada e o sync inteiro morreu em silêncio: todo
 * fechamento novo ficou sem system_total e ninguém soube até os números
 * divergirem. Prova:
 *   - acquireToken sem credenciais registra `_meta/lastAuthError` E publica o
 *     sinal `alterdata_auth_falha` (deduplicado) no Radar;
 *   - falha do Guardian (HTTP != 200) registra igual;
 *   - token emitido com sucesso LIMPA o marcador (o banner some);
 *   - a conferência de valores expõe `connector.authError`;
 *   - isolamento por organização.
 *
 * Uso:  npm run test:alterdata-auth-signal
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-auth-signal-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-auth-signal-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AlterdataConnectorService, __setAlterdataTokenHttpForTests } = await import("../src/server/AlterdataConnectorService.js");
  const { RetailMoneyAuditService } = await import("../src/server/RetailMoneyAuditService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const resp = (status: number, body: any) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const signal = (org: string) => db.prepare(`SELECT signal_type, severity, status FROM business_signals WHERE organization_id = ? AND signal_type = 'alterdata_auth_falha'`).get(org) as any;

  // ── 1. Credenciais AUSENTES → falha registrada + sinal publicado ──
  AlterdataConnectorService.saveSettings(A, { enabled: true, environment: "homolog", rede: "T", filiais: ["1"], basePattern: "t-{module}.x.br" });
  let threw = false;
  try { await AlterdataConnectorService.acquireToken(A); } catch { threw = true; }
  const fail1 = AlterdataConnectorService.getAuthFailure(A);
  check("1.1 acquireToken sem credenciais lança", threw);
  check("1.2 lastAuthError registrado com mensagem e timestamp", !!fail1 && /credenciais ausentes/.test(fail1.message) && !!fail1.at, JSON.stringify(fail1));
  check("1.3 sinal alterdata_auth_falha publicado (critical)", signal(A)?.signal_type === "alterdata_auth_falha" && signal(A)?.severity === "critical", JSON.stringify(signal(A)));

  // Repetir a falha NÃO duplica o sinal (dedupe por org).
  try { await AlterdataConnectorService.acquireToken(A); } catch { /* esperado */ }
  const count = (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = 'alterdata_auth_falha'`).get(A) as any).n;
  check("1.4 falha repetida não duplica o sinal", count === 1, `count=${count}`);

  // ── 2. A conferência expõe o erro (banner) ──
  const audit = RetailMoneyAuditService.day(A, "2026-09-19");
  check("2.1 money-audit devolve connector.authError", !!audit.connector?.authError && /credenciais/.test(audit.connector.authError.message), JSON.stringify(audit.connector));

  // ── 3. Guardian devolve HTTP 400 → registra a falha de token ──
  AlterdataConnectorService.saveSettings(A, { enabled: true, environment: "homolog", rede: "T", filiais: ["1"], basePattern: "t-{module}.x.br", authConfig: { clientId: "u@t", clientSecret: "errada" } });
  // O corpo devolve um segredo simulado — não pode vazar na mensagem gravada
  // nem na exceção lançada (só o código OAuth `error`, whitelist).
  __setAlterdataTokenHttpForTests(async () => resp(400, { error: "invalid_client", error_description: "senha=SUPERSECRETO123 token=abc.def" }) as any);
  threw = false; let thrownMsg = "";
  try { await AlterdataConnectorService.acquireToken(A); } catch (e: any) { threw = true; thrownMsg = String(e?.message || ""); }
  const fail3 = AlterdataConnectorService.getAuthFailure(A);
  check("3.1 falha de emissão de token também registra", threw && !!fail3 && /HTTP 400/.test(fail3.message), JSON.stringify(fail3));
  check("3.2 mensagem gravada traz só o código OAuth, sem corpo sensível", /invalid_client/.test(fail3!.message) && !/SUPERSECRETO|token=abc/.test(fail3!.message), fail3!.message);
  check("3.3 exceção lançada não vaza corpo sensível", /HTTP 400/.test(thrownMsg) && !/SUPERSECRETO|token=abc|error_description/.test(thrownMsg), thrownMsg);

  // ── 4. Token emitido com sucesso LIMPA o marcador E resolve o sinal ──
  __setAlterdataTokenHttpForTests(async () => resp(200, { access_token: "tok-ok", expires_in: 3600 }) as any);
  const tok = await AlterdataConnectorService.acquireToken(A);
  check("4.1 token emitido", tok.accessToken === "tok-ok");
  check("4.2 lastAuthError limpo — banner some", AlterdataConnectorService.getAuthFailure(A) === null, JSON.stringify(AlterdataConnectorService.getAuthFailure(A)));
  check("4.3 conferência sem authError após recuperar", RetailMoneyAuditService.day(A, "2026-09-19").connector.authError === null);
  // O sinal do Radar não pode ficar preso "open" depois que a auth volta.
  check("4.4 sinal alterdata_auth_falha resolvido (não fica preso no Radar)", signal(A)?.status === "resolved", JSON.stringify(signal(A)));

  // ── 5. Isolamento ──
  check("5.1 org B não herda a falha da A", AlterdataConnectorService.getAuthFailure(B) === null && !signal(B));

  __setAlterdataTokenHttpForTests(null);
  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} alterdata-auth-signal: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
