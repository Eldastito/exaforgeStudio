/**
 * TEST — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 2) — isolamento homolog vs prod.
 * DB-backed, determinístico. Prova que a fachada AlterdataConnectorService
 * agora delega pro AlterdataProfileService com isolamento por ambiente:
 *
 *   1. Backfill on-demand: 1ª leitura popula profile a partir do legado
 *   2. Tokens isolados: homolog e prod nunca sobrescrevem um ao outro
 *   3. Cursores isolados: mesma tripla (module,resource,filial) por env
 *   4. Credenciais isoladas: authConfig por env
 *   5. base URL diferente por env
 *   6. clearCursors do env corrente não afeta o outro env
 *   7. Zero regressão: API legada (getCursor/getAccessToken sem env) continua
 *      funcionando e agora respeita o env corrente
 *   8. Trocar environment no dropdown troca tudo instantaneamente
 *   9. publicSettings sem segredos + hasToken/hasCredentials do env corrente
 *
 * Uso: npm run test:alterdata-golive-profiles-isolation
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-profiles-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-profiles-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { AlterdataConnectorService } = await import("../src/server/AlterdataConnectorService.js");
  const { AlterdataProfileService } = await import("../src/server/AlterdataProfileService.js");

  const ORG = "org-alterdata-iso";

  // ═══════ 1. Backfill on-demand ═══════
  // Semeia legado direto (simula uma org antiga, pré-PR2)
  db.prepare(
    `INSERT INTO alterdata_integration_settings (organization_id, enabled, environment, rede, filiais_json, base_pattern, price_table)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(ORG, 1, "homolog", "REDE-01", JSON.stringify(["001", "002"]), "toulon-{module}.apimodaup.com.br", "1");

  // Antes da 1ª leitura, o profile NÃO existe
  const beforeBackfill = db.prepare(
    `SELECT * FROM alterdata_integration_profiles WHERE organization_id=? AND environment=?`
  ).get(ORG, "homolog");
  check("1.1 profile homolog não existe antes de qualquer leitura", !beforeBackfill);

  // Uma leitura via ProfileService.getProfile dispara backfill
  const profileHom = AlterdataProfileService.getProfile(ORG, "homolog");
  check("1.2 backfill on-demand cria profile homolog", !!profileHom);
  check("1.3 backfill copiou rede", profileHom?.rede === "REDE-01");
  check("1.4 backfill copiou base_pattern", profileHom?.base_pattern === "toulon-{module}.apimodaup.com.br");

  // getProfile(prod) NÃO fabrica prod fantasma (legado é homolog)
  const profileProdGhost = AlterdataProfileService.getProfile(ORG, "prod");
  check("1.5 getProfile(prod) não fabrica prod fantasma quando legado é homolog", !profileProdGhost);

  // ═══════ 2. Tokens isolados ═══════
  // Configura homolog com um token
  AlterdataConnectorService.saveSettings(ORG, {
    environment: "homolog",
    authConfig: { clientId: "hom@toulon.com", clientSecret: "hom-secret" },
  });
  AlterdataConnectorService.setAccessToken(ORG, "TOKEN-HOMOLOG", new Date(Date.now() + 3600_000));

  // Troca pra prod, configura outra credencial e outro token
  AlterdataConnectorService.saveSettings(ORG, {
    environment: "prod",
    authConfig: { clientId: "prod@toulon.com", clientSecret: "prod-secret" },
    basePattern: "toulon-{module}.prod.apimodaup.com.br",
  });
  AlterdataConnectorService.setAccessToken(ORG, "TOKEN-PROD", new Date(Date.now() + 3600_000));

  const tokProdViaConnector = AlterdataConnectorService.getAccessToken(ORG);
  check("2.1 no env prod, getAccessToken devolve TOKEN-PROD", tokProdViaConnector === "TOKEN-PROD");

  // Volta pra homolog e confirma que o token de lá SOBREVIVEU (não foi sobrescrito por prod)
  AlterdataConnectorService.saveSettings(ORG, { environment: "homolog" });
  const tokHomViaConnector = AlterdataConnectorService.getAccessToken(ORG);
  check("2.2 voltando pra homolog, token TOKEN-HOMOLOG intacto",
    tokHomViaConnector === "TOKEN-HOMOLOG",
    `esperado 'TOKEN-HOMOLOG', got '${tokHomViaConnector}'`);

  // Confirma isolamento direto no profile
  const tokHomDirect = AlterdataProfileService.getAccessToken(ORG, "homolog");
  const tokProdDirect = AlterdataProfileService.getAccessToken(ORG, "prod");
  check("2.3 profile homolog: TOKEN-HOMOLOG", tokHomDirect === "TOKEN-HOMOLOG");
  check("2.4 profile prod: TOKEN-PROD", tokProdDirect === "TOKEN-PROD");
  check("2.5 tokens diferentes por env (não misturados)", tokHomDirect !== tokProdDirect);

  // ═══════ 3. Cursores isolados ═══════
  AlterdataConnectorService.saveSettings(ORG, { environment: "homolog" });
  AlterdataConnectorService.setCursor(ORG, "supply", "Referencia", "001", "9000");

  AlterdataConnectorService.saveSettings(ORG, { environment: "prod" });
  AlterdataConnectorService.setCursor(ORG, "supply", "Referencia", "001", "0");

  const curProd = AlterdataConnectorService.getCursor(ORG, "supply", "Referencia", "001");
  check("3.1 no env prod, cursor supply/Referencia/001 = '0'", curProd === "0");

  AlterdataConnectorService.saveSettings(ORG, { environment: "homolog" });
  const curHom = AlterdataConnectorService.getCursor(ORG, "supply", "Referencia", "001");
  check("3.2 no env homolog, cursor supply/Referencia/001 = '9000' (não foi sobrescrito)",
    curHom === "9000",
    `esperado '9000', got '${curHom}'`);

  const curHomDirect = AlterdataProfileService.getCursor(ORG, "homolog", "supply", "Referencia", "001");
  const curProdDirect = AlterdataProfileService.getCursor(ORG, "prod", "supply", "Referencia", "001");
  check("3.3 profile homolog cursor = 9000", curHomDirect === "9000");
  check("3.4 profile prod cursor = 0", curProdDirect === "0");

  // ═══════ 4. Credenciais isoladas ═══════
  AlterdataConnectorService.saveSettings(ORG, { environment: "homolog" });
  const authHom = AlterdataConnectorService.getAuthConfig(ORG);
  check("4.1 authConfig homolog = hom@toulon.com",
    authHom?.clientId === "hom@toulon.com",
    `got clientId '${authHom?.clientId}'`);

  AlterdataConnectorService.saveSettings(ORG, { environment: "prod" });
  const authProd = AlterdataConnectorService.getAuthConfig(ORG);
  check("4.2 authConfig prod = prod@toulon.com",
    authProd?.clientId === "prod@toulon.com",
    `got clientId '${authProd?.clientId}'`);

  check("4.3 credenciais diferentes por env",
    authHom?.clientId !== authProd?.clientId);

  // ═══════ 5. base URL por env ═══════
  AlterdataConnectorService.saveSettings(ORG, { environment: "homolog" });
  const urlHom = AlterdataConnectorService.moduleBaseUrl(ORG, "supply");
  check("5.1 url homolog aponta pra toulon-supply.apimodaup.com.br",
    urlHom === "https://toulon-supply.apimodaup.com.br",
    `got '${urlHom}'`);

  AlterdataConnectorService.saveSettings(ORG, { environment: "prod" });
  const urlProd = AlterdataConnectorService.moduleBaseUrl(ORG, "supply");
  check("5.2 url prod aponta pra toulon-supply.prod.apimodaup.com.br",
    urlProd === "https://toulon-supply.prod.apimodaup.com.br",
    `got '${urlProd}'`);
  check("5.3 URLs diferentes por env", urlHom !== urlProd);

  // ═══════ 6. clearCursors só afeta env corrente ═══════
  // Reseta um estado limpo pra este bloco
  const ORG2 = "org-alterdata-clear";
  AlterdataConnectorService.saveSettings(ORG2, {
    environment: "homolog",
    authConfig: { clientId: "x", clientSecret: "y" },
  });
  AlterdataConnectorService.setCursor(ORG2, "supply", "Referencia", "001", "1000");
  AlterdataConnectorService.saveSettings(ORG2, { environment: "prod" });
  AlterdataConnectorService.setCursor(ORG2, "supply", "Referencia", "001", "2000");
  AlterdataConnectorService.setCursor(ORG2, "price", "Preco", "001", "3000");

  // Limpa prod (env corrente)
  const cleared = AlterdataConnectorService.clearCursors(ORG2);
  check("6.1 clearCursors devolve 2 (supply + price em prod)",
    cleared === 2,
    `got ${cleared}`);

  const curProdSupplyAfter = AlterdataConnectorService.getCursor(ORG2, "supply", "Referencia", "001");
  check("6.2 cursor prod supply zerado (fallback '0')", curProdSupplyAfter === "0");

  AlterdataConnectorService.saveSettings(ORG2, { environment: "homolog" });
  const curHomSupplyAfter = AlterdataConnectorService.getCursor(ORG2, "supply", "Referencia", "001");
  check("6.3 cursor homolog PRESERVADO após clear no prod",
    curHomSupplyAfter === "1000",
    `esperado '1000', got '${curHomSupplyAfter}'`);

  // ═══════ 7. Zero regressão — API legada respeita env corrente ═══════
  // Cria uma org "legada": só linha em alterdata_integration_settings, nada em profiles
  const ORGL = "org-legacy-flow";
  db.prepare(
    `INSERT INTO alterdata_integration_settings (organization_id, enabled, environment, rede, base_pattern)
     VALUES (?, ?, ?, ?, ?)`
  ).run(ORGL, 1, "homolog", "REDE-LEGACY", "legacy-{module}.apimodaup.com.br");

  // Chamada legada (sem env) → deve funcionar e usar homolog implicitamente
  const legacyEnabled = AlterdataConnectorService.isEnabled(ORGL);
  check("7.1 isEnabled continua funcionando pra org legada", legacyEnabled === true);

  const legacyUrl = AlterdataConnectorService.moduleBaseUrl(ORGL, "supply");
  check("7.2 moduleBaseUrl da org legada resolve pelo fallback do settings",
    legacyUrl === "https://legacy-supply.apimodaup.com.br",
    `got '${legacyUrl}'`);

  // ═══════ 8. Trocar env troca tudo instantaneamente ═══════
  AlterdataConnectorService.saveSettings(ORG, { environment: "homolog" });
  const snap1 = AlterdataConnectorService.publicSettings(ORG);
  AlterdataConnectorService.saveSettings(ORG, { environment: "prod" });
  const snap2 = AlterdataConnectorService.publicSettings(ORG);

  check("8.1 environment reflete a troca", snap1.environment === "homolog" && snap2.environment === "prod");
  check("8.2 basePattern muda com o env",
    snap1.basePattern !== snap2.basePattern,
    `hom='${snap1.basePattern}' prod='${snap2.basePattern}'`);
  check("8.3 hasToken=true em ambos os envs (cada um tem seu token)",
    snap1.hasToken && snap2.hasToken);
  check("8.4 hasCredentials=true em ambos", snap1.hasCredentials && snap2.hasCredentials);

  // ═══════ 9. publicSettings não vaza segredos ═══════
  const publicView = AlterdataConnectorService.publicSettings(ORG);
  const publicJson = JSON.stringify(publicView);
  check("9.1 publicSettings não vaza TOKEN-HOMOLOG", !publicJson.includes("TOKEN-HOMOLOG"));
  check("9.2 publicSettings não vaza TOKEN-PROD", !publicJson.includes("TOKEN-PROD"));
  check("9.3 publicSettings não vaza clientSecret",
    !publicJson.includes("hom-secret") && !publicJson.includes("prod-secret"));

  // Bônus: publicProfileFor com env explícito
  const profPubHom = AlterdataProfileService.publicProfileFor(ORG, "homolog");
  const profPubProd = AlterdataProfileService.publicProfileFor(ORG, "prod");
  check("9.4 publicProfileFor(homolog) marca hasToken=true", profPubHom.hasToken === true);
  check("9.5 publicProfileFor(prod) marca hasToken=true", profPubProd.hasToken === true);
  check("9.6 publicProfileFor não vaza token",
    !JSON.stringify(profPubHom).includes("TOKEN-") && !JSON.stringify(profPubProd).includes("TOKEN-"));

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) {
    const line = `  ${r.ok ? "✓" : "✗"} ${r.name}`;
    console.log(r.ok ? line : `${line} — ${r.detail ?? ""}`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
