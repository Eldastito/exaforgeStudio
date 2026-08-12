/**
 * TEST — tenantTerms preenchido na anonimização (PRD 9 / ADR-166 F10). DB-backed.
 *
 * Prova (§94/§129, RN-EI-2/3):
 *   - tenantTermsFor colhe nome/CNPJ/telefone/e-mail do org;
 *   - publish com contexto de org: conteúdo LIMPO passa;
 *   - publish com nome/CNPJ do tenant vazado → LANÇA anonymize_violation (barreira);
 *   - sem contexto de org (master puro) → termos vazios, publica (0-regressão);
 *   - runManual honra os termos do tenant de origem.
 *
 * Uso: npm run test:anonymize-tenant-terms
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-att-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-att-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { VerticalIntelligenceService: VI, tenantTermsFor } = await import("../src/server/VerticalIntelligenceService.js");

  const ORG = "org-padaria-1";
  db.prepare("INSERT INTO organization_settings (id, organization_id, business_name, cnpj_cpf, phone, email, status) VALUES (?,?,?,?,?,?,'active')")
    .run(randomUUID(), ORG, "Padaria Pão Dourado", "12.345.678/0001-99", "(11) 98888-7777", "contato@paodourado.com");

  // ═══════════════ 1. tenantTermsFor colhe os identificadores ═══════════════
  const terms = tenantTermsFor(ORG);
  check("1.1 colhe nome do negócio", terms.includes("Padaria Pão Dourado"));
  check("1.2 colhe cnpj/telefone/email", terms.includes("12.345.678/0001-99") && terms.includes("contato@paodourado.com"));
  check("1.3 sem org → vazio", tenantTermsFor(null).length === 0 && tenantTermsFor("inexistente").length === 0);

  const actorOrg = { userId: "u1", organizationId: ORG };
  const actorMaster = { userId: "admin", organizationId: null };

  // ═══════════════ 2. conteúdo limpo com contexto de org → publica ═══════════════
  const clean = VI.publish(actorOrg, { vertical: "padaria", topic: "insumos", content: { summary: "Panorama do nicho de padarias.", drivers: ["farinha", "energia"] }, sources: [], confidence: 0.6, provider: "stub" });
  check("2.1 conteúdo limpo publica normalmente", !!clean && !!clean.id);

  // ═══════════════ 3. nome do tenant vazado → LANÇA (barreira endurecida) ═══════════════
  let threwName = false;
  try {
    VI.publish(actorOrg, { vertical: "padaria", topic: "custos", content: { summary: "A Padaria Pão Dourado tem custo alto.", drivers: ["farinha"] }, sources: [], confidence: 0.6, provider: "stub" });
  } catch (e: any) { threwName = /anonymize_violation/.test(String(e?.message)); }
  check("3.1 nome do tenant no pacote → anonymize_violation", threwName === true);

  // CNPJ/telefone/e-mail já são removidos pelo stripPII (PII estruturada) ANTES do
  // assert — então não lançam, são apenas anonimizados. O ganho do tenantTerms é o
  // NOME do negócio (que o regex de PII não pega). Confirma que o CNPJ é neutralizado.
  const cnpjPub = VI.publish(actorOrg, { vertical: "padaria", topic: "fiscal", content: { summary: "CNPJ 12.345.678/0001-99 no relatório.", drivers: ["x"] }, sources: [], confidence: 0.6, provider: "stub" });
  const stored = db.prepare("SELECT content_json FROM vertical_intelligence WHERE id = ?").get(cnpjPub.id) as any;
  check("3.2 CNPJ é removido pelo stripPII (publica anonimizado, sem vazar)", !!cnpjPub.id && !/12\.345\.678/.test(stored.content_json));

  // ═══════════════ 4. sem contexto de org → 0-regressão (não checa termos) ═══════════════
  const masterLeak = VI.publish(actorMaster, { vertical: "mercearia", topic: "geral", content: { summary: "Panorama sem identificar ninguém.", drivers: ["a"] }, sources: [], confidence: 0.6, provider: "stub" });
  check("4.1 master sem org publica (sem termos p/ checar)", !!masterLeak && !!masterLeak.id);
  // explicit tenantOrgId endurece mesmo com actor master
  let threwExplicit = false;
  try {
    VI.publish(actorMaster, { vertical: "padaria", topic: "z", content: { summary: "Padaria Pão Dourado de novo.", drivers: ["a"] }, sources: [], confidence: 0.6, provider: "stub", tenantOrgId: ORG });
  } catch (e: any) { threwExplicit = /anonymize_violation/.test(String(e?.message)); }
  check("4.2 tenantOrgId explícito endurece mesmo com actor master", threwExplicit === true);

  // ═══════════════ 5. runManual honra os termos ═══════════════
  let threwManual = false;
  try {
    VI.runManual(actorOrg, { vertical: "padaria", topic: "manual", summary: "Relatório da Padaria Pão Dourado colado pelo admin.", drivers: ["x"] });
  } catch (e: any) { threwManual = /anonymize_violation/.test(String(e?.message)); }
  check("5.1 runManual com nome do tenant → bloqueia", threwManual === true);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} anonymize-tenant-terms: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
