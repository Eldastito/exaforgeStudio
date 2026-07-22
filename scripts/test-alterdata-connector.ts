/**
 * TEST — Fundação do conector Alterdata/ModaUp (ADR-105).
 *
 * Cobre AlterdataConnectorService: config por org com SEGREDOS CIFRADOS
 * (auth_config e token nunca em texto na coluna nem no publicSettings),
 * resolução de base URL por módulo, cursor do delta-sync, e o guard de que
 * a emissão de token ainda não está implementada (aguarda contrato da Alterdata).
 *
 * Uso: npm run test:alterdata-connector
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef"; // 32 bytes p/ AES-256

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AlterdataConnectorService, ALTERDATA_MODULES, GUARDIAN_TOKEN_URL, GUARDIAN_DEFAULT_SCOPE, __setAlterdataTokenHttpForTests } = await import("../src/server/AlterdataConnectorService.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;

  // ===== estado inicial: não configurado, desligado =====
  check("sem config: isEnabled falso", AlterdataConnectorService.isEnabled(orgId) === false);
  const p0 = AlterdataConnectorService.publicSettings(orgId);
  check("sem config: publicSettings.configured=false", p0.configured === false && p0.enabled === false);
  check("publicSettings lista os módulos", Array.isArray(p0.modules) && p0.modules.includes("supply") && p0.modules.includes("price"));

  // ===== salvar config com credencial (cifrada) =====
  AlterdataConnectorService.saveSettings(orgId, {
    enabled: true, environment: "homolog", rede: "TOULON", filiais: ["1", "2"],
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "abc", clientSecret: "s3cr3t" },
    syncIntervalMinutes: 10,
  });
  check("isEnabled verdadeiro após salvar", AlterdataConnectorService.isEnabled(orgId) === true);

  // A credencial está CIFRADA na coluna (não em texto).
  const rawRow = db.prepare(`SELECT auth_config_enc FROM alterdata_integration_settings WHERE organization_id=?`).get(orgId) as any;
  check("auth_config gravado CIFRADO (prefixo enc)", EncryptionService.isEncrypted(rawRow.auth_config_enc) === true);
  check("coluna NÃO contém o segredo em texto", !String(rawRow.auth_config_enc).includes("s3cr3t"));
  check("getAuthConfig decifra corretamente", AlterdataConnectorService.getAuthConfig(orgId)?.clientSecret === "s3cr3t");

  // publicSettings nunca vaza segredo.
  const p1 = AlterdataConnectorService.publicSettings(orgId);
  check("publicSettings expõe hasCredentials, não a credencial", p1.hasCredentials === true && !JSON.stringify(p1).includes("s3cr3t"));
  check("publicSettings traz rede/filiais/intervalo", p1.rede === "TOULON" && p1.filiais.length === 2 && p1.syncIntervalMinutes === 10);

  // ===== base URL por módulo =====
  check("moduleBaseUrl supply", AlterdataConnectorService.moduleBaseUrl(orgId, "supply") === "https://toulon-supply.apimodaup.com.br");
  check("moduleBaseUrl tributario usa subdomínio 'tributary'", AlterdataConnectorService.moduleBaseUrl(orgId, "tributario") === "https://toulon-tributary.apimodaup.com.br");
  check("moduleBaseUrl módulo inválido = null", AlterdataConnectorService.moduleBaseUrl(orgId, "xpto") === null);

  // override explícito de base URL tem prioridade
  AlterdataConnectorService.saveSettings(orgId, { moduleBaseUrls: { supply: "https://homolog-supply.example.com/" } });
  check("override de base URL respeitado (sem barra final)", AlterdataConnectorService.moduleBaseUrl(orgId, "supply") === "https://homolog-supply.example.com");
  check("credencial preservada após novo saveSettings parcial", AlterdataConnectorService.getAuthConfig(orgId)?.clientId === "abc");

  // ===== token: gravado cifrado, expira, sem renovação automática =====
  check("sem token ainda", AlterdataConnectorService.getAccessToken(orgId) === null);
  AlterdataConnectorService.setAccessToken(orgId, "tok-123", new Date(Date.now() + 60_000));
  const tokRow = db.prepare(`SELECT access_token_enc FROM alterdata_integration_settings WHERE organization_id=?`).get(orgId) as any;
  check("token gravado CIFRADO", EncryptionService.isEncrypted(tokRow.access_token_enc) && !String(tokRow.access_token_enc).includes("tok-123"));
  check("getAccessToken decifra token válido", AlterdataConnectorService.getAccessToken(orgId) === "tok-123");
  AlterdataConnectorService.setAccessToken(orgId, "tok-exp", new Date(Date.now() - 1000));
  check("token expirado retorna null", AlterdataConnectorService.getAccessToken(orgId) === null);
  const p2 = AlterdataConnectorService.publicSettings(orgId);
  check("publicSettings.hasToken=true mas não expõe o token", p2.hasToken === true && !JSON.stringify(p2).includes("tok-"));

  // ===== cursor do delta-sync =====
  check("cursor inicial = '0'", AlterdataConnectorService.getCursor(orgId, "supply", "Saldo", "1") === "0");
  AlterdataConnectorService.setCursor(orgId, "supply", "Saldo", "1", 42);
  check("cursor persiste por (org,módulo,recurso,filial)", AlterdataConnectorService.getCursor(orgId, "supply", "Saldo", "1") === "42");
  check("cursor isolado por filial", AlterdataConnectorService.getCursor(orgId, "supply", "Saldo", "2") === "0");
  AlterdataConnectorService.setCursor(orgId, "supply", "Saldo", "1", 99);
  check("cursor atualiza (não duplica)", AlterdataConnectorService.getCursor(orgId, "supply", "Saldo", "1") === "99");
  const cnt = (db.prepare(`SELECT COUNT(*) c FROM alterdata_sync_cursors WHERE organization_id=? AND module='supply' AND resource='Saldo' AND filial='1'`).get(orgId) as any).c;
  check("uma linha só por chave (upsert)", cnt === 1);

  // ===== emissão de token pelo GUARDIAN (OAuth2 client_credentials) =====
  // Credenciais ausentes → erro claro (org nova, sem authConfig).
  const orgNoCreds = `org_${randomUUID().slice(0, 8)}`;
  AlterdataConnectorService.saveSettings(orgNoCreds, { enabled: true });
  let credErr = false;
  try { await AlterdataConnectorService.acquireToken(orgNoCreds); } catch (e: any) { credErr = /credenci/i.test(String(e.message)); }
  check("acquireToken sem credenciais → erro claro", credErr === true);

  // Sucesso: HTTP mockado devolve access_token + expires_in. Captura a requisição.
  let captured: any = null;
  __setAlterdataTokenHttpForTests(async (url: string, init: any) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => ({ access_token: "guardian-XYZ", token_type: "Bearer", expires_in: 3600 }), text: async () => "" };
  });
  const issued = await AlterdataConnectorService.acquireToken(orgId);
  check("acquireToken devolve access_token", issued.accessToken === "guardian-XYZ");
  check("POST vai para o endpoint do Guardian", captured?.url === GUARDIAN_TOKEN_URL);
  check("body usa grant_type=client_credentials", /grant_type=client_credentials/.test(String(captured?.init?.body)));
  check("body inclui o scope padrão (módulos)", String(captured?.init?.body).includes(encodeURIComponent("APISupplyModule")) || String(captured?.init?.body).includes("APISupplyModule"));
  check("scope padrão cobre Supply/Price/CRM/eCommerce", ["APISupplyModule", "APIPriceModule", "APICRMModule", "APIeCommerceModule"].every((s) => GUARDIAN_DEFAULT_SCOPE.includes(s)));
  check("token do Guardian gravado e recuperável", AlterdataConnectorService.getAccessToken(orgId) === "guardian-XYZ");
  const tokRow2 = db.prepare(`SELECT access_token_enc FROM alterdata_integration_settings WHERE organization_id=?`).get(orgId) as any;
  check("token do Guardian gravado CIFRADO", EncryptionService.isEncrypted(tokRow2.access_token_enc) && !String(tokRow2.access_token_enc).includes("guardian-XYZ"));

  // getOrRefreshToken reaproveita o token válido (não chama o Guardian de novo).
  captured = null;
  const reused = await AlterdataConnectorService.getOrRefreshToken(orgId);
  check("getOrRefreshToken reaproveita token válido (sem novo POST)", reused === "guardian-XYZ" && captured === null);

  // Falha do Guardian (401) → erro amigável com o status.
  __setAlterdataTokenHttpForTests(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "invalid_client" }));
  let httpErr = "";
  try { await AlterdataConnectorService.acquireToken(orgNoCreds); } catch { /* credErr antes */ }
  // orgNoCreds não tem credencial; use org com credencial para exercitar o 401.
  try { db.prepare(`UPDATE alterdata_integration_settings SET token_expires_at=? WHERE organization_id=?`).run(new Date(Date.now() - 1000).toISOString(), orgId); } catch { /* noop */ }
  try { await AlterdataConnectorService.acquireToken(orgId); } catch (e: any) { httpErr = String(e.message); }
  check("falha do Guardian propaga HTTP 401", /401/.test(httpErr));
  __setAlterdataTokenHttpForTests(null);

  // sanity: mapa de módulos cobre os 4 prioritários
  check("ALTERDATA_MODULES cobre supply/price/crm/ecommerce", ["supply", "price", "crm", "ecommerce"].every((m) => m in ALTERDATA_MODULES));

  // --- Relatório ---
  console.log("\n=== TEST: Fundação do conector Alterdata (ADR-105) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Conector Alterdata (fundação) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
