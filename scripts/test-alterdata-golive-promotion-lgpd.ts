/**
 * TEST — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 6, RF-11/16) — promoção + LGPD.
 * DB-backed, determinístico. Prova que:
 *
 *   LGPD (RF-16):
 *   1. record() insere linha com id/approvedAt
 *   2. Campos obrigatórios rejeitados (orgId/purpose/legalBasis/approvedBy)
 *   3. hasActiveApproval reflete a última linha
 *   4. Múltiplas aprovações mantêm histórico (getLatest devolve a mais recente)
 *   5. revoke marca revoked_at + hasActiveApproval passa a false
 *   6. Nova aprovação após revoke reativa
 *
 *   Promotion (RF-11):
 *   7. validate() em profile não configurado → 'blocked' com blockers residuais
 *   8. validate() ignora BACKUP_ADVISORY e PROD_NOT_VALIDATED (o promote quem cura)
 *   9. validate() em prod com CRM ligado sem LGPD → blocker LGPD_APPROVAL_MISSING
 *  10. validate() em prod com CRM ligado com LGPD ativa → sem esse blocker
 *  11. promote() sem approvedBy → throw
 *  12. promote() com residuais → outcome='blocked', profile NÃO muda
 *  13. promote() OK → outcome='promoted', profile.validation_status='validated',
 *      approved_by/approved_at preenchidos, validatedAt no retorno
 *  14. Isolamento env: promote(prod) NÃO toca profile homolog
 *
 * Uso: npm run test:alterdata-golive-promotion-lgpd
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-promo-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-promo-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { AlterdataLgpdApprovalService } = await import("../src/server/AlterdataLgpdApprovalService.js");
  const { AlterdataPromotionService } = await import("../src/server/AlterdataPromotionService.js");
  const { AlterdataConnectorService } = await import("../src/server/AlterdataConnectorService.js");
  const { AlterdataSyncLedgerService } = await import("../src/server/AlterdataSyncLedgerService.js");

  const ORG = "org-promo-1";

  // ═══════ 1. record ═══════
  const rec1 = AlterdataLgpdApprovalService.record({
    orgId: ORG, purpose: "pdvCustomerImport",
    legalBasis: "legitimo_interesse",
    approvedBy: "user-a", approvedByEmail: "user-a@example.com",
    retentionDays: 365, accessProfile: "admin,owner,dpo",
    notes: "Aprovação da diretoria em ata #123",
  });
  check("1.1 record devolve id + approvedAt",
    !!rec1.id && !!rec1.approvedAt && rec1.approvedAt.endsWith("Z"));
  const row = db.prepare(`SELECT * FROM alterdata_lgpd_approvals WHERE id=?`).get(rec1.id) as any;
  check("1.2 row salva com legal_basis correto",
    row?.legal_basis === "legitimo_interesse");
  check("1.3 retention_days preservado", row?.retention_days === 365);
  check("1.4 access_profile preservado", row?.access_profile === "admin,owner,dpo");
  check("1.5 approved_by_email preservado", row?.approved_by_email === "user-a@example.com");

  // ═══════ 2. Campos obrigatórios ═══════
  const rejects = [
    () => AlterdataLgpdApprovalService.record({ orgId: "", purpose: "x", legalBasis: "y", approvedBy: "z" }),
    () => AlterdataLgpdApprovalService.record({ orgId: "x", purpose: "", legalBasis: "y", approvedBy: "z" }),
    () => AlterdataLgpdApprovalService.record({ orgId: "x", purpose: "y", legalBasis: "", approvedBy: "z" }),
    () => AlterdataLgpdApprovalService.record({ orgId: "x", purpose: "y", legalBasis: "z", approvedBy: "" }),
  ];
  for (let i = 0; i < rejects.length; i++) {
    let threw = false;
    try { rejects[i](); } catch { threw = true; }
    check(`2.${i + 1} campo obrigatório rejeitado`, threw);
  }

  // ═══════ 3. hasActiveApproval ═══════
  check("3.1 hasActiveApproval true após record",
    AlterdataLgpdApprovalService.hasActiveApproval(ORG, "pdvCustomerImport") === true);
  check("3.2 hasActiveApproval false pra purpose distinto",
    AlterdataLgpdApprovalService.hasActiveApproval(ORG, "outraCoisa") === false);

  // ═══════ 4. Múltiplas aprovações mantêm histórico ═══════
  await new Promise(r => setTimeout(r, 10));
  const rec2 = AlterdataLgpdApprovalService.record({
    orgId: ORG, purpose: "pdvCustomerImport",
    legalBasis: "consentimento", approvedBy: "user-b",
  });
  const latest = AlterdataLgpdApprovalService.getLatest(ORG, "pdvCustomerImport");
  check("4.1 getLatest devolve a mais recente",
    latest?.id === rec2.id,
    `esperado ${rec2.id}, got ${latest?.id}`);
  const hist = AlterdataLgpdApprovalService.listHistory(ORG, "pdvCustomerImport");
  check("4.2 listHistory devolve 2 linhas", hist.length === 2);
  check("4.3 histórico ordenado desc",
    hist[0].id === rec2.id && hist[1].id === rec1.id);

  // ═══════ 5. Revoke ═══════
  const revoked = AlterdataLgpdApprovalService.revoke(rec2.id);
  check("5.1 revoke devolve true", revoked === true);
  check("5.2 hasActiveApproval passa a false",
    AlterdataLgpdApprovalService.hasActiveApproval(ORG, "pdvCustomerImport") === false);
  check("5.3 revoke em id inexistente → false",
    AlterdataLgpdApprovalService.revoke("no-such-id") === false);

  // ═══════ 6. Nova aprovação reativa ═══════
  await new Promise(r => setTimeout(r, 10));
  AlterdataLgpdApprovalService.record({
    orgId: ORG, purpose: "pdvCustomerImport",
    legalBasis: "execucao_contrato", approvedBy: "user-c",
  });
  check("6.1 nova aprovação após revoke reativa",
    AlterdataLgpdApprovalService.hasActiveApproval(ORG, "pdvCustomerImport") === true);

  // ═══════ Setup pra promotion ═══════
  const ORG_PROMO = "org-promo-flow";
  AlterdataConnectorService.saveSettings(ORG_PROMO, {
    enabled: true, environment: "homolog",
    authConfig: { clientId: "x", clientSecret: "y" },
    rede: "REDE-01", filiais: ["001"], priceTable: "1",
    basePattern: "toulon-{module}.apimodaup.com.br",
  });
  AlterdataConnectorService.setAccessToken(ORG_PROMO, "TOKEN-A", new Date(Date.now() + 3600_000));
  // Semeia run 100% verde em homolog + em prod
  for (const env of ["homolog", "prod"] as const) {
    if (env === "prod") AlterdataConnectorService.saveSettings(ORG_PROMO, { environment: "prod" });
    AlterdataConnectorService.saveSettings(ORG_PROMO, {
      environment: env,
      authConfig: { clientId: "x", clientSecret: "y" },
      rede: "REDE-01", filiais: ["001"], priceTable: "1",
      basePattern: "toulon-{module}.apimodaup.com.br",
    });
    AlterdataConnectorService.setAccessToken(ORG_PROMO, `TOKEN-${env}`, new Date(Date.now() + 3600_000));
    const h = AlterdataSyncLedgerService.begin(ORG_PROMO, env, "manual", "user-a");
    h.record({ module: "supply", resource: "Referencia", required: true, status: "ready", imported: 100 });
    h.record({ module: "supply", resource: "Saldo", filial: "001", required: true, status: "ready", imported: 50 });
    h.record({ module: "price", resource: "Preco", filial: "1", required: true, status: "ready", imported: 30 });
    h.record({ module: "sales", resource: "DataCaixa", required: true, status: "ready", imported: 10 });
    h.record({ module: "sales", resource: "VendaMalote", required: true, status: "ready", imported: 20 });
    h.finish();
  }
  // Volta pra prod (é o env corrente pra validar/promover)
  AlterdataConnectorService.saveSettings(ORG_PROMO, { environment: "prod" });

  // ═══════ 7. Profile não configurado ═══════
  const ORG_EMPTY = "org-promo-empty";
  const v7 = AlterdataPromotionService.validate(ORG_EMPTY, "prod");
  check("7.1 org sem profile → outcome=blocked", v7.outcome === "blocked");
  check("7.2 blockers residuais > 0", v7.blockers.length > 0);

  // ═══════ 8. Ignora BACKUP_ADVISORY e PROD_NOT_VALIDATED ═══════
  const v8 = AlterdataPromotionService.validate(ORG_PROMO, "prod");
  // Sem CRM ligado, e prod é apenas 'not validated' + backup advisory → deve promover
  check("8.1 blockers residuais NÃO incluem BACKUP_ADVISORY",
    !v8.blockers.some((b: any) => b.code === "BACKUP_ADVISORY"));
  check("8.2 blockers residuais NÃO incluem PROD_NOT_VALIDATED",
    !v8.blockers.some((b: any) => b.code === "PROD_NOT_VALIDATED"));
  check("8.3 outcome='promoted' (dry-run) quando só advisory pendente",
    v8.outcome === "promoted",
    `blockers residuais: ${JSON.stringify(v8.blockers.map((b:any)=>b.code))}`);

  // ═══════ 9-10. CRM ligado sem/com LGPD ═══════
  AlterdataConnectorService.setPdvCustomerImport(ORG_PROMO, true);
  const v9 = AlterdataPromotionService.validate(ORG_PROMO, "prod");
  check("9.1 CRM ligado + sem LGPD → blocker LGPD_APPROVAL_MISSING",
    v9.blockers.some((b: any) => b.code === "LGPD_APPROVAL_MISSING"));
  check("9.2 outcome=blocked", v9.outcome === "blocked");

  // Registra LGPD ativa
  AlterdataLgpdApprovalService.record({
    orgId: ORG_PROMO, purpose: "pdvCustomerImport",
    legalBasis: "legitimo_interesse", approvedBy: "user-a",
  });
  const v10 = AlterdataPromotionService.validate(ORG_PROMO, "prod");
  check("10.1 CRM ligado + LGPD ativa → sem LGPD_APPROVAL_MISSING",
    !v10.blockers.some((b: any) => b.code === "LGPD_APPROVAL_MISSING"));

  // ═══════ 11. promote sem approvedBy ═══════
  let threw11 = false;
  try { AlterdataPromotionService.promote(ORG_PROMO, "prod", { approvedBy: "" }); } catch { threw11 = true; }
  check("11.1 promote sem approvedBy → throw", threw11);

  // ═══════ 12. promote com residuais ═══════
  const v12 = AlterdataPromotionService.promote(ORG_EMPTY, "prod", { approvedBy: "user-a" });
  check("12.1 outcome=blocked em profile vazio", v12.outcome === "blocked");
  // Profile do ORG_EMPTY não existe, então nada muda
  const rowEmpty = db.prepare(`SELECT * FROM alterdata_integration_profiles WHERE organization_id=? AND environment='prod'`).get(ORG_EMPTY);
  check("12.2 nenhum profile gravado após blocked", !rowEmpty);

  // ═══════ 13. promote OK ═══════
  const v13 = AlterdataPromotionService.promote(ORG_PROMO, "prod", { approvedBy: "user-a", note: "aprovação inicial" });
  check("13.1 outcome=promoted", v13.outcome === "promoted",
    `blockers residuais: ${JSON.stringify(v13.blockers.map(b => b.code))}`);
  check("13.2 validatedAt preenchido", !!v13.validatedAt);
  check("13.3 approvedBy no retorno", v13.approvedBy === "user-a");
  const prod = db.prepare(`SELECT * FROM alterdata_integration_profiles WHERE organization_id=? AND environment='prod'`).get(ORG_PROMO) as any;
  check("13.4 profile.validation_status='validated'", prod?.validation_status === "validated");
  check("13.5 profile.approved_by preenchido", prod?.approved_by === "user-a");
  check("13.6 profile.approved_at preenchido", !!prod?.approved_at);

  // ═══════ 14. Isolamento env ═══════
  const hom = db.prepare(`SELECT * FROM alterdata_integration_profiles WHERE organization_id=? AND environment='homolog'`).get(ORG_PROMO) as any;
  check("14.1 profile homolog NÃO ficou 'validated' após promote de prod",
    hom?.validation_status !== "validated",
    `got: ${hom?.validation_status}`);
  check("14.2 profile homolog sem approved_by",
    !hom?.approved_by);

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
