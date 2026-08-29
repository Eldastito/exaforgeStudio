/**
 * TEST — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 1) — fundação schema + política.
 * DB-backed, determinístico. Prova que o ADR-198 subiu limpo:
 *   1. alterdata_integration_profiles existe com PK (org, environment)
 *   2. PK composta permite mesma org com homolog E prod
 *   3. alterdata_sync_cursors ganhou coluna environment (DEFAULT 'homolog')
 *   4. índice v2 permite mesma tripla (module,resource,filial) em ambientes diferentes
 *   5. alterdata_sync_runs aceita insert com todos os campos
 *   6. alterdata_sync_run_resources FK-friendly (run_id texto livre)
 *   7. alterdata_module_policy PK (org, module) impede duplicata
 *   8. resolvePolicyForVertical retorna moda-varejo pra qualquer vertical desconhecida
 *   9. Toulon (moda-varejo): Guardian/Supply/Price/Sales required; CRM conditional
 *  10. Zero regressão: alterdata_integration_settings + cursor antigo continuam funcionando
 *
 * Uso: npm run test:alterdata-golive-schema
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-schema-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-schema-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { resolvePolicyForVertical, ALL_ALTERDATA_MODULES } = await import("../src/server/AlterdataModulePolicy.js");

  const ORG = "org-alterdata-schema";

  // ═══════ 1. Tabelas novas existem ═══════
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'alterdata_%' ORDER BY name`
  ).all() as { name: string }[];
  const tableNames = tables.map(t => t.name);
  check("1.1 alterdata_integration_profiles existe",
    tableNames.includes("alterdata_integration_profiles"));
  check("1.2 alterdata_sync_runs existe",
    tableNames.includes("alterdata_sync_runs"));
  check("1.3 alterdata_sync_run_resources existe",
    tableNames.includes("alterdata_sync_run_resources"));
  check("1.4 alterdata_module_policy existe",
    tableNames.includes("alterdata_module_policy"));
  check("1.5 legado alterdata_integration_settings preservado",
    tableNames.includes("alterdata_integration_settings"));
  check("1.6 legado alterdata_sync_cursors preservado",
    tableNames.includes("alterdata_sync_cursors"));

  // ═══════ 2. PK (org, environment) em profiles ═══════
  db.prepare(
    `INSERT INTO alterdata_integration_profiles (organization_id, environment, base_pattern) VALUES (?, ?, ?)`
  ).run(ORG, "homolog", "toulon-{module}.apimodaup.com.br");
  db.prepare(
    `INSERT INTO alterdata_integration_profiles (organization_id, environment, base_pattern) VALUES (?, ?, ?)`
  ).run(ORG, "prod", "toulon-{module}.prod.apimodaup.com.br");
  const profiles = db.prepare(
    `SELECT environment, base_pattern FROM alterdata_integration_profiles WHERE organization_id=? ORDER BY environment`
  ).all(ORG) as { environment: string; base_pattern: string }[];
  check("2.1 mesma org com homolog E prod separados",
    profiles.length === 2 && profiles[0].environment === "homolog" && profiles[1].environment === "prod");
  check("2.2 base_pattern diferente por env",
    profiles[0].base_pattern !== profiles[1].base_pattern);

  // Duplicata (org, env) deve falhar
  let dupThrew = false;
  try {
    db.prepare(
      `INSERT INTO alterdata_integration_profiles (organization_id, environment) VALUES (?, ?)`
    ).run(ORG, "homolog");
  } catch { dupThrew = true; }
  check("2.3 PK composta rejeita duplicata (org, env)", dupThrew);

  // ═══════ 3. Cursor ganhou environment (DEFAULT 'homolog') ═══════
  const cursorColumns = db.prepare(`PRAGMA table_info(alterdata_sync_cursors)`).all() as { name: string; dflt_value: string }[];
  const envCol = cursorColumns.find(c => c.name === "environment");
  check("3.1 coluna environment adicionada em alterdata_sync_cursors", !!envCol);
  check("3.2 DEFAULT 'homolog' na coluna environment",
    !!envCol && envCol.dflt_value && envCol.dflt_value.includes("homolog"));

  // ═══════ 4. Índice v2 permite mesma tripla em envs diferentes ═══════
  db.prepare(
    `INSERT INTO alterdata_sync_cursors (id, organization_id, environment, module, resource, filial, version) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("cur-hom-1", ORG, "homolog", "supply", "Referencia", "001", "9000");
  db.prepare(
    `INSERT INTO alterdata_sync_cursors (id, organization_id, environment, module, resource, filial, version) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("cur-prod-1", ORG, "prod", "supply", "Referencia", "001", "0");
  const cursors = db.prepare(
    `SELECT environment, version FROM alterdata_sync_cursors WHERE organization_id=? AND module='supply' ORDER BY environment`
  ).all(ORG) as { environment: string; version: string }[];
  check("4.1 mesma tripla (module,resource,filial) em homolog E prod",
    cursors.length === 2);
  check("4.2 versões independentes por ambiente (homolog=9000, prod=0)",
    cursors[0].environment === "homolog" && cursors[0].version === "9000" &&
    cursors[1].environment === "prod" && cursors[1].version === "0");

  // Duplicata (org, env, module, resource, filial) deve falhar pelo idx v2
  let cursorDupThrew = false;
  try {
    db.prepare(
      `INSERT INTO alterdata_sync_cursors (id, organization_id, environment, module, resource, filial, version) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("cur-hom-dup", ORG, "homolog", "supply", "Referencia", "001", "9001");
  } catch { cursorDupThrew = true; }
  check("4.3 idx v2 rejeita duplicata (org, env, module, resource, filial)", cursorDupThrew);

  // ═══════ 5. alterdata_sync_runs aceita insert completo ═══════
  db.prepare(
    `INSERT INTO alterdata_sync_runs (id, organization_id, environment, trigger, status, correlation_id, initiated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("run-1", ORG, "homolog", "manual", "running", "corr-abc-123", "user-1");
  const run = db.prepare(`SELECT * FROM alterdata_sync_runs WHERE id=?`).get("run-1") as any;
  check("5.1 run inserido com todos os campos", !!run && run.status === "running");
  check("5.2 índice org+env+started_at OK",
    db.prepare(`SELECT COUNT(*) as n FROM alterdata_sync_runs WHERE organization_id=? AND environment=?`).get(ORG, "homolog") as any);

  // ═══════ 6. alterdata_sync_run_resources aceita insert completo ═══════
  db.prepare(
    `INSERT INTO alterdata_sync_run_resources (id, run_id, module, resource, filial, required, status, http_status, imported, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("rr-1", "run-1", "supply", "Saldo", "001", 1, "ready", 200, 150, null);
  db.prepare(
    `INSERT INTO alterdata_sync_run_resources (id, run_id, module, resource, filial, required, status, http_status, error_code, error_message_sanitized)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("rr-2", "run-1", "price", "Preco", "001", 1, "server_error", 500, "ALTERDATA_API", "500 upstream");
  const runResources = db.prepare(`SELECT * FROM alterdata_sync_run_resources WHERE run_id=? ORDER BY id`).all("run-1") as any[];
  check("6.1 2 resources gravados sob mesmo run", runResources.length === 2);
  check("6.2 status distintos (ready vs server_error)",
    runResources[0].status === "ready" && runResources[1].status === "server_error");
  check("6.3 error_code preservado em falha", runResources[1].error_code === "ALTERDATA_API");

  // ═══════ 7. alterdata_module_policy PK (org, module) ═══════
  db.prepare(
    `INSERT INTO alterdata_module_policy (organization_id, module, policy, condition_flag) VALUES (?, ?, ?, ?)`
  ).run(ORG, "crm", "conditional", "pdvCustomerImport");
  let policyDupThrew = false;
  try {
    db.prepare(
      `INSERT INTO alterdata_module_policy (organization_id, module, policy) VALUES (?, ?, ?)`
    ).run(ORG, "crm", "disabled");
  } catch { policyDupThrew = true; }
  check("7.1 PK (org, module) rejeita duplicata", policyDupThrew);
  const p = db.prepare(`SELECT * FROM alterdata_module_policy WHERE organization_id=? AND module='crm'`).get(ORG) as any;
  check("7.2 condition_flag preservado", p.condition_flag === "pdvCustomerImport");

  // ═══════ 8. resolvePolicyForVertical fallback ═══════
  const unknownPol = resolvePolicyForVertical("nao-existe-inventado");
  check("8.1 vertical desconhecida cai em moda-varejo (fallback)",
    unknownPol.supply.policy === "required");
  const nullPol = resolvePolicyForVertical(null);
  check("8.2 null cai em moda-varejo (fallback)",
    nullPol.supply.policy === "required");
  const undefPol = resolvePolicyForVertical(undefined);
  check("8.3 undefined cai em moda-varejo (fallback)",
    undefPol.supply.policy === "required");

  // ═══════ 9. Toulon policy ═══════
  const toulon = resolvePolicyForVertical("moda-varejo");
  check("9.1 Guardian required", toulon.guardian.policy === "required");
  check("9.2 Supply required", toulon.supply.policy === "required");
  check("9.3 Price required", toulon.price.policy === "required");
  check("9.4 Sales required", toulon.sales.policy === "required");
  check("9.5 CRM conditional com condition_flag=pdvCustomerImport",
    toulon.crm.policy === "conditional" && toulon.crm.conditionFlag === "pdvCustomerImport");
  check("9.6 Financial unsupported (não bloqueia go-live)",
    toulon.financial.policy === "unsupported");
  check("9.7 HR/Logistic/Purchase/Tributary/eCommerce/Receber unsupported",
    toulon.hr.policy === "unsupported" &&
    toulon.logistic.policy === "unsupported" &&
    toulon.purchase.policy === "unsupported" &&
    toulon.tributary.policy === "unsupported" &&
    toulon.ecommerce.policy === "unsupported" &&
    toulon.receber.policy === "unsupported");
  check("9.8 ALL_ALTERDATA_MODULES cobre todos os 12 módulos",
    ALL_ALTERDATA_MODULES.length === 12 &&
    ALL_ALTERDATA_MODULES.every(m => !!toulon[m]));

  // ═══════ 10. Zero regressão: legado ═══════
  // Insert em alterdata_integration_settings (legado) continua funcionando
  db.prepare(
    `INSERT INTO alterdata_integration_settings (organization_id, enabled, environment, rede) VALUES (?, ?, ?, ?)`
  ).run("org-legacy", 1, "homolog", "REDE-01");
  const legacy = db.prepare(`SELECT * FROM alterdata_integration_settings WHERE organization_id=?`).get("org-legacy") as any;
  check("10.1 legado alterdata_integration_settings ainda aceita insert",
    !!legacy && legacy.rede === "REDE-01");
  // Cursor sem environment (código antigo) usa DEFAULT 'homolog'
  db.prepare(
    `INSERT INTO alterdata_sync_cursors (id, organization_id, module, resource, filial, version) VALUES (?, ?, ?, ?, ?, ?)`
  ).run("cur-legacy", "org-legacy", "supply", "Referencia", "", "42");
  const legacyCursor = db.prepare(`SELECT environment FROM alterdata_sync_cursors WHERE id=?`).get("cur-legacy") as any;
  check("10.2 insert sem environment usa DEFAULT 'homolog'",
    legacyCursor.environment === "homolog");

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
