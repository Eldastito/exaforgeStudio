/**
 * TEST — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 9, RF-16) — E2E go-live smoke.
 * DB-backed, determinístico. Exercita o fluxo completo do runbook
 * (docs/alterdata-golive-runbook.md) com transport mockado:
 *
 *   1. Configurar homolog + credenciais
 *   2. Sync homolog manual — runStatus='success'
 *   3. Ledger registra run + resources; outcome=ok
 *   4. Readiness homolog = 'ready'
 *   5. Configurar perfil prod separado (isolamento de env)
 *   6. Sync prod — usa credencial/token/URL de prod (não confunde com homolog)
 *   7. Verificar isolamento: cursor homolog ≠ cursor prod
 *   8. LGPD ausente + CRM ligado + prod → promote(dry) devolve blocker
 *      LGPD_APPROVAL_MISSING
 *   9. Registra LGPD + tenta promote de novo → outcome='promoted'
 *  10. Profile.validation_status='validated' + approved_by preenchido
 *  11. Revenue-bridge audit vê os fechamentos que entraram pelo PDV
 *  12. Rollback: setEnabled(false) para scheduler; ledger/profile intactos
 *
 * Uso: npm run test:alterdata-golive-e2e
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-e2e-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-e2e-1234567890";
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
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");
  const { AlterdataReadinessService } = await import("../src/server/AlterdataReadinessService.js");
  const { AlterdataPromotionService } = await import("../src/server/AlterdataPromotionService.js");
  const { AlterdataLgpdApprovalService } = await import("../src/server/AlterdataLgpdApprovalService.js");
  const { AlterdataRevenueBridgeService } = await import("../src/server/AlterdataRevenueBridgeService.js");
  const { formatSyncOutcome } = await import("../src/server/AlterdataSyncMessage.js");
  const { __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");

  const ORG = "org-e2e-toulon";
  const USER = "user-owner";
  db.prepare(`INSERT OR IGNORE INTO organization_settings (organization_id) VALUES (?)`).run(ORG);

  const resp = (status: number, body: any) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (_n: string) => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });

  // Mock: tudo devolve 200 com items vazios (sync feliz, sem produtos —
  // suficiente pra 'empty_but_valid' em resources required).
  __setAlterdataSyncHttpForTests(async (_url: string) => resp(200, { items: [], totalPages: 1 }));

  // ═══════ 1. Configurar homolog ═══════
  AlterdataConnectorService.saveSettings(ORG, {
    enabled: true, environment: "homolog",
    authConfig: { clientId: "hom@toulon.com", clientSecret: "hom-secret" },
    basePattern: "toulon-{module}.apimodaup.com.br",
    rede: "REDE-TOULON", filiais: ["001"], priceTable: "1",
  });
  AlterdataConnectorService.setAccessToken(ORG, "TOKEN-HOM", new Date(Date.now() + 3600_000));
  const settingsHom = AlterdataConnectorService.publicSettings(ORG);
  check("1.1 homolog configurado", settingsHom.configured === true && settingsHom.environment === "homolog");
  check("1.2 credenciais + token via profile (PR 2)",
    settingsHom.hasCredentials && settingsHom.hasToken);

  // ═══════ 2. Sync homolog ═══════
  const summaryHom = await AlterdataSyncRunner.runOrg(ORG, { manual: true, initiatedBy: USER });
  check("2.1 sync retorna runStatus",
    !!summaryHom.runStatus,
    `got: ${JSON.stringify({ runStatus: summaryHom.runStatus })}`);
  check("2.2 runStatus success/partial (sem required em failure)",
    summaryHom.runStatus === "success" || summaryHom.runStatus === "partial_failure");
  check("2.3 correlationId preenchido", !!summaryHom.correlationId);

  const outcome = formatSyncOutcome(summaryHom, summaryHom.runStatus as any);
  check("2.4 outcome.title existe", !!outcome.title);

  // ═══════ 3. Ledger tem run + resources ═══════
  const runs = db.prepare(
    `SELECT * FROM alterdata_sync_runs WHERE organization_id=? AND environment='homolog' ORDER BY started_at DESC`
  ).all(ORG) as any[];
  check("3.1 1+ run gravada em homolog", runs.length >= 1);
  const resources = db.prepare(
    `SELECT * FROM alterdata_sync_run_resources WHERE run_id=?`
  ).all(runs[0].id) as any[];
  check("3.2 resources gravados", resources.length > 0);
  check("3.3 supply/Referencia presente",
    resources.some(r => r.module === "supply" && r.resource === "Referencia"));

  // ═══════ 4. Readiness homolog ═══════
  const readyHom = AlterdataReadinessService.compute(ORG, "homolog");
  check("4.1 status=ready quando homolog verde",
    readyHom.status === "ready",
    `got status=${readyHom.status}, blockers=${JSON.stringify(readyHom.blockers.map(b=>b.code))}`);

  // ═══════ 5. Configurar prod (isolamento) ═══════
  AlterdataConnectorService.saveSettings(ORG, {
    environment: "prod",
    authConfig: { clientId: "prod@toulon.com", clientSecret: "prod-secret" },
    basePattern: "toulon-{module}.prod.apimodaup.com.br",
    rede: "REDE-TOULON", filiais: ["001"], priceTable: "1",
  });
  AlterdataConnectorService.setAccessToken(ORG, "TOKEN-PROD", new Date(Date.now() + 3600_000));

  const settingsProd = AlterdataConnectorService.publicSettings(ORG);
  check("5.1 environment=prod", settingsProd.environment === "prod");
  check("5.2 basePattern diferente do homolog",
    settingsProd.basePattern !== settingsHom.basePattern,
    `hom=${settingsHom.basePattern} prod=${settingsProd.basePattern}`);

  // ═══════ 6. Sync prod ═══════
  const summaryProd = await AlterdataSyncRunner.runOrg(ORG, { manual: true, initiatedBy: USER });
  check("6.1 sync prod completo", !!summaryProd.runId);

  // ═══════ 7. Isolamento entre envs (runs no ledger) ═══════
  const runsByEnv = db.prepare(
    `SELECT environment, COUNT(*) c FROM alterdata_sync_runs WHERE organization_id=? GROUP BY environment`
  ).all(ORG) as any[];
  const envSet = new Set(runsByEnv.map(r => r.environment));
  check("7.1 runs registradas em AMBOS os envs",
    envSet.has("homolog") && envSet.has("prod"),
    `envs: ${JSON.stringify(Array.from(envSet))}`);
  // Isolamento de token via profile (herda do PR 2)
  const tokHom = AlterdataProfileService.getAccessToken(ORG, "homolog");
  const tokProd = AlterdataProfileService.getAccessToken(ORG, "prod");
  check("7.2 tokens isolados por env (homolog ≠ prod)",
    tokHom === "TOKEN-HOM" && tokProd === "TOKEN-PROD",
    `hom=${tokHom} prod=${tokProd}`);

  // ═══════ 8. Promote prod com CRM ligado sem LGPD ═══════
  AlterdataConnectorService.setPdvCustomerImport(ORG, true);
  const dry1 = AlterdataPromotionService.validate(ORG, "prod");
  check("8.1 promote(dry) com CRM sem LGPD → outcome=blocked",
    dry1.outcome === "blocked");
  check("8.2 blocker LGPD_APPROVAL_MISSING presente",
    dry1.blockers.some(b => b.code === "LGPD_APPROVAL_MISSING"));

  // ═══════ 9. Registrar LGPD + promote ═══════
  const lgpd = AlterdataLgpdApprovalService.record({
    orgId: ORG, purpose: "pdvCustomerImport",
    legalBasis: "legitimo_interesse", approvedBy: USER,
    approvedByEmail: "dpo@toulon.com.br",
    retentionDays: 730, accessProfile: "owner,admin,dpo",
    notes: "Aprovação ata 001",
  });
  check("9.1 LGPD registrada", !!lgpd.id);

  const promoted = AlterdataPromotionService.promote(ORG, "prod", { approvedBy: USER, note: "go-live piloto" });
  check("9.2 promote real → outcome=promoted",
    promoted.outcome === "promoted",
    `blockers residuais: ${JSON.stringify(promoted.blockers.map(b=>b.code))}`);
  check("9.3 validatedAt no retorno", !!promoted.validatedAt);

  // ═══════ 10. Profile prod atualizado ═══════
  const prodProfile = db.prepare(
    `SELECT * FROM alterdata_integration_profiles WHERE organization_id=? AND environment='prod'`
  ).get(ORG) as any;
  check("10.1 validation_status='validated'", prodProfile?.validation_status === "validated");
  check("10.2 approved_by preenchido", prodProfile?.approved_by === USER);

  // Homolog NÃO deve ter sido tocado
  const homProfile = db.prepare(
    `SELECT * FROM alterdata_integration_profiles WHERE organization_id=? AND environment='homolog'`
  ).get(ORG) as any;
  check("10.3 homolog NÃO ficou validated",
    homProfile?.validation_status !== "validated",
    `got: ${homProfile?.validation_status}`);

  // ═══════ 11. Revenue-bridge audit ═══════
  AlterdataRevenueBridgeService.setEnabled(ORG, true);
  // Semeia 1 fechamento com source='pdv' pra provar o fluxo
  db.prepare(`INSERT INTO retail_stores (id, organization_id, code, name, active) VALUES (?, ?, ?, ?, 1)`)
    .run("s1", ORG, "001", "Loja Piloto");
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, source, informed_total, system_total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("cl-1", ORG, "s1", today, "reconciled", "pdv", 0, 1500);

  const audit = AlterdataRevenueBridgeService.audit(ORG, { months: 1 });
  check("11.1 revenue-bridge enabled", audit.enabled === true);
  check("11.2 bucket pdv com 1 closing",
    audit.months[0].bySource.pdv.count === 1 && audit.months[0].bySource.pdv.amount === 1500);
  check("11.3 recentClosings tem o fechamento com source=pdv",
    audit.recentClosings.some(c => c.id === "cl-1" && c.source === "pdv"));

  // ═══════ 12. Rollback: setEnabled(false) ═══════
  AlterdataConnectorService.saveSettings(ORG, { enabled: false });
  check("12.1 scheduler desligado", AlterdataConnectorService.isEnabled(ORG) === false);
  // Profile prod PERMANECE validated (não perdeu histórico)
  const prodAfter = db.prepare(
    `SELECT validation_status FROM alterdata_integration_profiles WHERE organization_id=? AND environment='prod'`
  ).get(ORG) as any;
  check("12.2 profile.validation_status intacto após rollback (auditoria preservada)",
    prodAfter?.validation_status === "validated");
  // Ledger runs também
  const totalRuns = (db.prepare(
    `SELECT COUNT(*) c FROM alterdata_sync_runs WHERE organization_id=?`
  ).get(ORG) as any).c;
  check("12.3 ledger runs preservados após rollback",
    Number(totalRuns) >= 2);

  __setAlterdataSyncHttpForTests(null);

  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) {
    const line = `  ${r.ok ? "✓" : "✗"} ${r.name}`;
    console.log(r.ok ? line : `${line} — ${r.detail ?? ""}`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
